// GeminiRunner: runs one agent end to end over the official @google/genai Interactions API.
// Client-side step history preserves thought signatures and keeps repo code off server-side retention
// by default (`store: false`). Supports built-in and custom tools, all three structured output modes
// (`two-stage`, `submit-tool`, `single-stage`), live follow-up messages, per-turn usage with prompt cache
// accounting, worktree commit reminders, and runner-level transient retries.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError, GoogleGenAI, type GoogleGenAIRequestOptions, type Interactions } from '@google/genai';
import { childGitEnv } from './git-env.js';
import { checkPdfInputs } from './pdf-input.js';
import {
  COMMIT_REMINDER_MESSAGE,
  type StructuredMode,
  SUBMIT_RESULT_TOOL_NAME,
  stripSyntheticNulls,
  toStrictToolInputSchema,
  toStructuredOutputSchema,
  validateValue,
} from './runner.js';
import {
  type AgentRunner,
  type Effort,
  type EntryStatus,
  type JSONSchema,
  LIMITS,
  MaestroError,
  type RunRequest,
  type RunResult,
  type ToolContext,
  type TraceToolCall,
  type Usage,
} from './types.js';
import { addUsage } from './usage.js';

/** Default Gemini model when `--runner gemini` is used without `--model` (or given Maestro's Claude default). */
export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

const execFileAsync = promisify(execFile);
const TRACE_INPUT_CHARS = 200;
const TRACE_TEXT_CHARS = 2_000;

const CONTINUE_MESSAGE =
  'Continue: your previous reply was cut off by the output limit. Continue exactly where you ' +
  'stopped, without repeating what you already wrote.';
const SCHEMA_MESSAGE = 'Return your findings in the required schema.';
const SUBMIT_SYSTEM_INSTRUCTION = `When you have your final answer, call \`${SUBMIT_RESULT_TOOL_NAME}\` with an input matching its schema.`;
const SUBMIT_REMINDER_MESSAGE = `Call \`${SUBMIT_RESULT_TOOL_NAME}\` now with your final structured findings.`;

/** Structural client interface so callers and tests can inject a mock without subclassing GoogleGenAI. */
export interface GeminiInteractionsClient {
  interactions: {
    create(
      params: Interactions.InteractionCreateParams.CreateModelInteractionParamsNonStreaming,
      options?: GoogleGenAIRequestOptions,
    ): Promise<GeminiInteractionResponse>;
  };
}

export type GeminiInteractionResponse = {
  id?: string;
  status?: Interactions.Interaction['status'];
  steps?: Interactions.Step[];
  output_text?: string | null;
  usage?: Interactions.Usage;
  errors?: Interactions.Error[];
};

export interface GeminiRunnerOptions {
  /** Pre-built `@google/genai` `GoogleGenAI` client (or compatible mock). */
  client?: GeminiInteractionsClient;
  /** Gemini API key. Defaults to `GEMINI_API_KEY` or `GOOGLE_API_KEY`. */
  apiKey?: string;
  /** Overrides the workflow model for every agent handled by this runner. */
  model?: string;
  /** Optional API version override (defaults to the SDK's stable `v1`). */
  apiVersion?: string;
  maxTurns?: number;
  maxTokens?: number;
  retryDelayMs?: number;
  structuredMode?: StructuredMode;
  /** Whether to store interactions server-side. Defaults to `false` so client-side history stays self-contained. */
  store?: boolean;
}

/** Thrown internally to unwind when the run's signal fires. */
class Aborted extends Error {}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Maps Maestro `Effort` to Gemini `ThinkingLevel` (`minimal | low | medium | high`). */
export function toGeminiThinkingLevel(effort: Effort | undefined): Interactions.ThinkingLevel | undefined {
  if (effort === undefined) return undefined;
  if (effort === 'low' || effort === 'medium' || effort === 'high') return effort;
  // `xhigh` and `max` map to Gemini's highest thinking tier.
  return 'high';
}

/**
 * Resolves the model ID to send to the Gemini API. Strips an optional `google/` prefix; when no
 * runner-level override was set and the request carries Maestro's default Claude ID, falls back to
 * `DEFAULT_GEMINI_MODEL`.
 */
export function resolveGeminiModel(requestModel: string, override?: string): string {
  const raw = (override ?? requestModel).trim();
  const stripped = raw.replace(/^google\//i, '');
  if (!override && (!stripped || /^(?:claude-|anthropic\/)/i.test(stripped))) {
    return DEFAULT_GEMINI_MODEL;
  }
  return stripped || DEFAULT_GEMINI_MODEL;
}

/** Converts Gemini Interactions usage to Maestro's `Usage` contract (uncached input + cache_read + total output). */
export function geminiUsageOf(u: Interactions.Usage | undefined): Usage {
  const totalIn = finite(u?.total_input_tokens);
  const cached = finite(u?.total_cached_tokens);
  const usage: Usage = {
    input_tokens: Math.max(0, totalIn - cached),
    // Thought tokens are generated output tokens billed against max_output_tokens.
    output_tokens: finite(u?.total_output_tokens) + finite(u?.total_thought_tokens),
  };
  if (typeof u?.total_cached_tokens === 'number') {
    usage.cache_read_input_tokens = cached;
  }
  return usage;
}

/** Extracts concatenated text from a Gemini Interaction response (`output_text` or trailing `model_output` steps). */
function textOf(response: GeminiInteractionResponse): string {
  if (typeof response.output_text === 'string') return response.output_text;
  const steps = response.steps ?? [];
  const parts: string[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.type !== 'model_output') {
      if (parts.length > 0) break;
      continue;
    }
    const content = step.content ?? [];
    const stepText = content
      .filter(
        (c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text' && typeof c.text === 'string',
      )
      .map((c) => c.text)
      .join('');
    if (stepText) parts.unshift(stepText);
  }
  return parts.join('');
}

function functionCallsOf(steps: Interactions.Step[] | undefined): Interactions.FunctionCallStep[] {
  return (steps ?? []).filter((s): s is Interactions.FunctionCallStep => s.type === 'function_call');
}

function errorStatus(e: unknown): number | undefined {
  if (e instanceof ApiError) return e.status;
  if (e && typeof e === 'object') {
    const status =
      (e as { status?: unknown; statusCode?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function isAbortError(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || e instanceof Aborted) return true;
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) return true;
  return false;
}

/** 429, 5xx, and transient connection/network failures: retried once by the runner. */
function isTransient(e: unknown): boolean {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) return false;
  const status = errorStatus(e);
  if (status !== undefined) return status === 429 || status >= 500;
  if (e instanceof Error) {
    if (e.name === 'APIConnectionError' || e.name === 'ConnectionError' || e.name === 'FetchError') {
      return true;
    }
    if (/\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network)\b/i.test(e.message)) return true;
  }
  return false;
}

function errorText(e: unknown): string {
  const status = errorStatus(e);
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 400) return `400 bad request: ${msg}`;
  if (status !== undefined) return `API error ${status}: ${msg}`;
  return `error: ${msg}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function hasUncommittedChanges(cwd: string, signal: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      signal,
      timeout: 10_000,
      env: childGitEnv(),
      encoding: 'utf8',
    });
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

class RunState {
  usage: Usage = { input_tokens: 0, output_tokens: 0 };
  turns = 0;
  readonly toolCalls: TraceToolCall[] = [];
  finalText = '';
  constructor(
    private readonly req: RunRequest,
    private readonly redact: (s: string) => string,
    /** The model ID every request of this run carries; with an override it is not `req.model`. */
    readonly model: string,
  ) {}

  turn(u: Interactions.Usage | undefined): void {
    const usage = geminiUsageOf(u);
    this.turns++;
    addUsage(this.usage, usage);
    this.req.onUsage(usage);
    this.req.onProgress?.({ activity: 'model', summary: 'Model response received', turns: this.turns });
    if (this.req.signal.aborted) throw new Aborted();
  }

  done(result: unknown, status: EntryStatus, extra: { raw?: string; error?: string } = {}): RunResult {
    const out: RunResult = {
      result,
      status,
      usage: { ...this.usage },
      turns: this.turns,
      trace: { toolCalls: this.toolCalls.slice(), finalText: this.finalText.slice(0, TRACE_TEXT_CHARS) },
      model: this.model,
    };
    if (extra.raw !== undefined) out.raw = extra.raw;
    if (extra.error !== undefined) out.error = this.redact(extra.error);
    return out;
  }

  toolCall(tool: string, input: unknown): TraceToolCall {
    let summary: string;
    try {
      summary = JSON.stringify(input) ?? String(input);
    } catch {
      summary = String(input);
    }
    const call = { tool, inputSummary: summary.slice(0, TRACE_INPUT_CHARS), ok: false };
    this.toolCalls.push(call);
    return call;
  }

  fail(error: string): RunResult {
    const clean = this.redact(error);
    this.req.log(clean);
    return this.done(null, 'null', { error: clean });
  }
}

class LiveMessages {
  private readonly pending: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  private closed = false;
  private readonly unregister: (() => void) | undefined;

  constructor(private readonly req: RunRequest) {
    this.unregister = req.registerMessageHandler?.((text) => {
      if (this.closed || req.signal.aborted) {
        return Promise.reject(new Error('Agent is no longer accepting messages'));
      }
      const delivery = new Promise<void>((resolve, reject) => this.pending.push({ text, resolve, reject }));
      delivery.catch(() => {});
      return delivery;
    });
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  appendTo(steps: Interactions.Step[]): boolean {
    if (!this.hasPending) return false;
    if (this.req.signal.aborted) throw new Aborted();
    const batch = this.pending.splice(0);
    for (const item of batch) {
      steps.push({ type: 'user_input', content: [{ type: 'text', text: item.text }] });
      item.resolve();
    }
    this.req.onProgress?.({
      activity: 'message',
      summary: 'Follow-up instruction added to the model context',
    });
    return true;
  }

  close(): void {
    this.closed = true;
    this.unregister?.();
    for (const item of this.pending.splice(0)) {
      item.reject(new Error('Agent finished before the follow-up could be delivered'));
    }
  }
}

function userStep(text: string): Interactions.UserInputStep {
  return { type: 'user_input', content: [{ type: 'text', text }] };
}

/** The opening turn: each PDF as its own document block, in the order given, then the prompt. */
function firstUserStep(prompt: string, pdfs: readonly string[] | undefined): Interactions.UserInputStep {
  const documents: Interactions.DocumentContent[] = (pdfs ?? []).map((data) => ({
    type: 'document',
    mime_type: 'application/pdf',
    data,
  }));
  return { type: 'user_input', content: [...documents, { type: 'text', text: prompt }] };
}

/** Strips dangling function_call steps from an incomplete turn before requesting continuation. */
function withoutDanglingFunctionCalls(steps: Interactions.Step[]): Interactions.Step[] {
  let end = steps.length;
  while (end > 0 && steps[end - 1]?.type === 'function_call') end--;
  return end === steps.length ? steps : steps.slice(0, end);
}

function responseFormatFor(schema: JSONSchema): Interactions.TextResponseFormat {
  return {
    type: 'text',
    mime_type: 'application/json',
    schema: toStructuredOutputSchema(schema),
  };
}

export class GeminiRunner implements AgentRunner {
  #client: GeminiInteractionsClient | undefined;
  readonly #explicitApiKey: string | undefined;
  readonly #hasExplicitApiKey: boolean;
  readonly #apiVersion: string | undefined;
  readonly #modelOverride: string | undefined;
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly maxRequestTokens: number;
  readonly retryDelayMs: number;
  readonly structuredMode: StructuredMode;
  readonly store: boolean;

  constructor(opts: GeminiRunnerOptions = {}) {
    this.#client = opts.client;
    this.#hasExplicitApiKey = opts.apiKey !== undefined;
    this.#explicitApiKey = opts.apiKey?.trim();
    this.#apiVersion = opts.apiVersion;
    this.#modelOverride = opts.model?.trim() || undefined;
    this.maxTurns = opts.maxTurns ?? LIMITS.maxTurns;
    this.maxTokens = opts.maxTokens ?? LIMITS.maxTokensPerTurn;
    this.maxRequestTokens = Math.max(
      this.maxTokens,
      Math.min(2 * this.maxTokens, LIMITS.maxTokensPerTurnRaised),
    );
    this.retryDelayMs = opts.retryDelayMs ?? 5_000;
    this.structuredMode = opts.structuredMode ?? 'two-stage';
    this.store = opts.store ?? false;
  }

  private resolvedApiKey(): string {
    if (this.#hasExplicitApiKey) return this.#explicitApiKey ?? '';
    return (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '').trim();
  }

  /** Lazily instantiated so MCP servers and dry runs can start without credentials. */
  get client(): GeminiInteractionsClient {
    if (this.#client) return this.#client;
    const apiKey = this.resolvedApiKey();
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY (or GOOGLE_API_KEY) is missing or blank. Set it or pass apiKey to GeminiRunner; use --dry-run for offline runs.',
      );
    }
    this.#client = new GoogleGenAI({
      apiKey,
      ...(this.#apiVersion ? { apiVersion: this.#apiVersion } : {}),
    });
    return this.#client;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const writers = req.tools.filter((t) => t.write).map((t) => t.name);
    if (writers.length > 0 && !req.isolated) {
      throw new MaestroError(
        `write tools (${writers.join(', ')}) require isolation: 'worktree'`,
        'write_tool_without_isolation',
      );
    }
    const key = this.resolvedApiKey();
    const redact = (text: string) => (key ? text.replaceAll(key, '[REDACTED]') : text);
    // Resolved before anything can fail, so a failed call also reports the model it was sent to.
    const st = new RunState(req, redact, resolveGeminiModel(req.model, this.#modelOverride));
    let inbox: LiveMessages | undefined;
    try {
      if (req.signal.aborted) throw new Aborted();
      checkPdfInputs(req.pdfs, true);
      inbox = new LiveMessages(req);
      return await this.#run(req, st, writers.length > 0, inbox);
    } catch (e) {
      if (isAbortError(e, req.signal)) return st.done(null, 'skipped', { error: 'aborted' });
      return st.fail(errorText(e));
    } finally {
      inbox?.close();
    }
  }

  async #run(req: RunRequest, st: RunState, hasWriters: boolean, inbox: LiveMessages): Promise<RunResult> {
    const client = this.client;
    const model = st.model;
    const ctx: ToolContext = { cwd: req.cwd, signal: req.signal };
    const mode: StructuredMode = req.schema ? this.structuredMode : 'two-stage';
    const thinkingLevel = toGeminiThinkingLevel(req.effort);

    const apiTools: Interactions.Tool[] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
    const toolMap = new Map(req.tools.map((t) => [t.name, t]));

    let submitted: { value: unknown } | undefined;
    let commitReminded = false;
    let submitReminded = false;

    if (mode === 'submit-tool' && req.schema) {
      apiTools.push({
        type: 'function',
        name: SUBMIT_RESULT_TOOL_NAME,
        description: 'Submit the final structured return value of this task.',
        parameters: toStrictToolInputSchema(req.schema),
      });
    }

    const systemText = mode === 'submit-tool' ? `${req.system}\n\n${SUBMIT_SYSTEM_INSTRUCTION}` : req.system;
    const history: Interactions.Step[] = [firstUserStep(req.prompt, req.pdfs)];

    let loopTurns = 0;
    let continued = false;
    let last: GeminiInteractionResponse | undefined;
    let carry = '';

    // ---- Stage 1: tool loop -------------------------------------------------------------
    for (;;) {
      if (req.signal.aborted) throw new Aborted();
      if (loopTurns >= this.maxTurns) {
        return st.fail(`turn cap: ${this.maxTurns} turns used`);
      }
      if (inbox.appendTo(history)) carry = '';

      req.onProgress?.({ activity: 'model', summary: 'Waiting for model response', turns: st.turns });
      const genConfig: Interactions.GenerationConfig = {
        max_output_tokens: this.maxTokens,
        ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
      };
      const response = await this.#withRetry(req, () =>
        client.interactions.create(
          {
            model,
            input: history,
            system_instruction: systemText,
            ...(apiTools.length > 0 ? { tools: apiTools } : {}),
            generation_config: genConfig,
            store: this.store,
            ...(mode === 'single-stage' && req.schema
              ? { response_format: responseFormatFor(req.schema) }
              : {}),
          },
          { signal: req.signal },
        ),
      );
      loopTurns++;
      last = response;
      st.turn(response.usage);

      const responseSteps = response.steps ?? [];
      if (responseSteps.length > 0) history.push(...responseSteps);

      const said = textOf(response);
      if (said !== '') st.finalText = carry + said;

      if (
        response.status === 'failed' ||
        response.status === 'cancelled' ||
        response.status === 'budget_exceeded'
      ) {
        const details = response.errors
          ?.map((err) => [err.code, err.message].filter(Boolean).join(': '))
          .filter(Boolean)
          .join('; ');
        return st.fail(`interaction ${response.status}${details ? `: ${details}` : ''}`);
      }

      const calls = functionCallsOf(responseSteps);
      if (calls.length > 0) {
        carry = '';
        // Fast path for submit-tool: finish without another model turn when the lone call validates cleanly.
        if (
          mode === 'submit-tool' &&
          req.schema &&
          calls.length === 1 &&
          calls[0]!.name === SUBMIT_RESULT_TOOL_NAME
        ) {
          const dirty =
            req.isolated &&
            hasWriters &&
            !commitReminded &&
            (await hasUncommittedChanges(req.cwd, req.signal));
          if (!dirty) {
            const cleaned = stripSyntheticNulls(req.schema, calls[0]!.arguments);
            if (validateValue(req.schema, cleaned).length === 0 && !inbox.hasPending) {
              return st.done(cleaned, 'ok');
            }
          }
        }

        for (const call of calls) {
          if (req.signal.aborted) throw new Aborted();
          if (mode === 'submit-tool' && req.schema && call.name === SUBMIT_RESULT_TOOL_NAME) {
            const out = await this.#runSubmitTool(req, call.arguments, hasWriters, commitReminded, () => {
              commitReminded = true;
            });
            if (out.ok) {
              submitted = { value: out.value };
              history.push({
                type: 'function_result',
                call_id: call.id,
                name: call.name,
                result: 'Submitted.',
              });
            } else {
              history.push({
                type: 'function_result',
                call_id: call.id,
                name: call.name,
                result: out.error,
                is_error: true,
              });
            }
            continue;
          }

          const tool = toolMap.get(call.name);
          const traceCall = st.toolCall(call.name, call.arguments);
          if (!tool) {
            history.push({
              type: 'function_result',
              call_id: call.id,
              name: call.name,
              result: `unknown tool: ${call.name}`,
              is_error: true,
            });
            continue;
          }
          req.onProgress?.({
            activity: 'tool',
            summary: `Running ${tool.name}`,
            tool: tool.name,
            turns: st.turns,
          });
          try {
            const out = await tool.run(call.arguments, ctx);
            traceCall.ok = true;
            history.push({
              type: 'function_result',
              call_id: call.id,
              name: call.name,
              result: out,
            });
          } catch (err) {
            if (isAbortError(err, req.signal)) throw err;
            history.push({
              type: 'function_result',
              call_id: call.id,
              name: call.name,
              result: err instanceof Error ? err.message : String(err),
              is_error: true,
            });
          } finally {
            req.onProgress?.({
              activity: 'tool',
              summary: `${tool.name} ${traceCall.ok ? 'completed' : 'failed'}`,
              tool: tool.name,
              turns: st.turns,
            });
          }
        }

        // If a live follow-up arrived while tools ran, keep going so the model sees it.
        if (submitted !== undefined && !inbox.hasPending) {
          return st.done(submitted.value, 'ok');
        }
        if (inbox.hasPending) {
          submitted = undefined;
          submitReminded = false;
        }
        if (loopTurns >= this.maxTurns) {
          return st.fail(`turn cap: agent still calling tools after ${this.maxTurns} turns`);
        }
        continue;
      }

      if (response.status === 'incomplete') {
        if (continued) return st.fail('max_tokens reached again after one continuation');
        continued = true;
        carry = said;
        const cleaned = withoutDanglingFunctionCalls(history);
        history.length = 0;
        history.push(...cleaned, userStep(CONTINUE_MESSAGE));
        if (loopTurns >= this.maxTurns) return st.fail(`turn cap: ${this.maxTurns} turns used`);
        continue;
      }

      if (inbox.hasPending && loopTurns < this.maxTurns) {
        submitReminded = false;
        continue;
      }

      if (
        req.isolated &&
        hasWriters &&
        !commitReminded &&
        (await hasUncommittedChanges(req.cwd, req.signal))
      ) {
        commitReminded = true;
        if (loopTurns >= this.maxTurns) {
          return st.fail(`turn cap: ${this.maxTurns} turns used with uncommitted changes`);
        }
        req.log('writer ended turn with uncommitted changes; prompting once to commit');
        history.push(userStep(COMMIT_REMINDER_MESSAGE));
        continue;
      }

      if (mode === 'submit-tool' && req.schema) {
        const textCandidate = carry + said;
        try {
          const parsedCandidate = JSON.parse(textCandidate);
          if (
            parsedCandidate !== null &&
            parsedCandidate !== undefined &&
            validateValue(req.schema, parsedCandidate).length === 0
          ) {
            return st.done(parsedCandidate, 'ok');
          }
        } catch {
          // Not valid raw JSON either; remind once to call the submit tool.
        }
        if (!submitReminded) {
          submitReminded = true;
          if (loopTurns >= this.maxTurns) return st.fail(`turn cap: ${this.maxTurns} turns used`);
          req.log(`agent ended turn without calling ${SUBMIT_RESULT_TOOL_NAME}; prompting once`);
          history.push(userStep(SUBMIT_REMINDER_MESSAGE));
          continue;
        }
        const error = 'schema parse failed twice';
        req.log(error);
        return st.done(null, 'null', { raw: textCandidate, error });
      }

      break;
    }

    if (!last) return st.fail('error: tool loop produced no response');
    const finalText = carry + textOf(last);
    if (finalText !== '') st.finalText = finalText;
    if (!req.schema) return st.done(finalText, 'ok');

    let startAttempt = 1;
    let raw = '';
    if (mode === 'single-stage') {
      raw = finalText;
      let parsedStage1: unknown = null;
      try {
        parsedStage1 = JSON.parse(finalText);
      } catch {
        parsedStage1 = null;
      }
      if (parsedStage1 !== null && parsedStage1 !== undefined) {
        const errors = validateValue(req.schema, parsedStage1);
        if (errors.length === 0) return st.done(parsedStage1, 'ok');
        req.log(`schema parse attempt 1: ${errors.slice(0, 5).join('; ')}`);
      } else {
        req.log(
          `schema parse attempt 1: no parsable structured output (status: ${last.status ?? 'unknown'})`,
        );
      }
      startAttempt = 2;
    }

    // ---- Stage 2: structured final ------------------------------------------------------
    const parseSteps: Interactions.Step[] = [...history, userStep(SCHEMA_MESSAGE)];
    let maxTokens = this.maxTokens;
    const responseFormat = responseFormatFor(req.schema);
    for (let attempt = startAttempt; attempt <= 2; attempt++) {
      req.onProgress?.({ activity: 'model', summary: 'Formatting structured result', turns: st.turns });
      inbox.appendTo(parseSteps);
      const response = await this.#withRetry(req, () =>
        client.interactions.create(
          {
            model,
            input: parseSteps,
            system_instruction: systemText,
            ...(apiTools.length > 0 ? { tools: apiTools } : {}),
            generation_config: {
              max_output_tokens: maxTokens,
              ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
              ...(apiTools.length > 0 ? { tool_choice: 'none' } : {}),
            },
            response_format: responseFormat,
            store: this.store,
          },
          { signal: req.signal },
        ),
      );
      st.turn(response.usage);
      raw = textOf(response);
      if (response.status === 'failed' || response.status === 'cancelled') {
        const details = response.errors
          ?.map((err) => [err.code, err.message].filter(Boolean).join(': '))
          .filter(Boolean)
          .join('; ');
        req.log(`interaction ${response.status}${details ? `: ${details}` : ''}`);
        return st.done(null, 'null', { raw, error: `interaction ${response.status}` });
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed !== null && parsed !== undefined) {
        const errors = validateValue(req.schema, parsed);
        if (errors.length === 0) return st.done(parsed, 'ok');
        req.log(`schema parse attempt ${attempt}: ${errors.slice(0, 5).join('; ')}`);
      } else {
        req.log(
          `schema parse attempt ${attempt}: no parsable structured output (status: ${response.status ?? 'unknown'})`,
        );
      }
      if (attempt < 2 && response.status === 'incomplete' && this.maxRequestTokens > maxTokens) {
        maxTokens = this.maxRequestTokens;
        req.log(`schema parse attempt ${attempt} cut by max_tokens; retrying with max_tokens ${maxTokens}`);
      }
    }
    const error = 'schema parse failed twice';
    req.log(error);
    return st.done(null, 'null', { raw, error });
  }

  async #runSubmitTool(
    req: RunRequest,
    input: unknown,
    hasWriters: boolean,
    commitReminded: boolean,
    markCommitReminded: () => void,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    if (req.isolated && hasWriters && !commitReminded && (await hasUncommittedChanges(req.cwd, req.signal))) {
      markCommitReminded();
      req.log('writer called submit tool with uncommitted changes; prompting once to commit');
      return { ok: false, error: COMMIT_REMINDER_MESSAGE };
    }
    const schema = req.schema!;
    const cleaned = stripSyntheticNulls(schema, input);
    const errors = validateValue(schema, cleaned);
    if (errors.length > 0) {
      req.log(`submit tool validation failed: ${errors.slice(0, 5).join('; ')}`);
      return {
        ok: false,
        error: `Output failed schema validation: ${errors.join('; ')}. Fix and call ${SUBMIT_RESULT_TOOL_NAME} again.`,
      };
    }
    return { ok: true, value: cleaned };
  }

  async #withRetry<T>(req: RunRequest, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isAbortError(e, req.signal) || !isTransient(e)) throw e;
      req.log(`${errorText(e)}; retrying once in ${this.retryDelayMs} ms`);
      await sleep(this.retryDelayMs, req.signal);
      return await fn();
    }
  }
}
