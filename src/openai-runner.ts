// OpenAIRunner: runs one agent end to end on the OpenAI Responses API with an OpenAI API key. It keeps
// the AnthropicRunner contract (tool loop, structured modes, live follow-ups, writer commit reminder, turn
// cap, one continuation after the output limit) over plain fetch, so no OpenAI SDK dependency is added.
// Requests are stateless (store: false): the transcript stays local, and reasoning items are passed back
// in their encrypted form so a reasoning model keeps its chain across tool calls.

import {
  Aborted,
  COMMIT_REMINDER_MESSAGE,
  CONTINUE_MESSAGE,
  hasUncommittedChanges,
  LiveMessages,
  RunState,
  SCHEMA_MESSAGE,
  type StructuredMode,
  SUBMIT_REMINDER_MESSAGE,
  SUBMIT_RESULT_TOOL_NAME,
  SUBMIT_SYSTEM_INSTRUCTION,
  sleep,
  stripSyntheticNulls,
  toStrictToolInputSchema,
  validateValue,
} from './runner.js';
import {
  type AgentRunner,
  type Effort,
  type JSONSchema,
  LIMITS,
  MaestroError,
  type RunRequest,
  type RunResult,
  type ToolContext,
  type Usage,
} from './types.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIRunnerOptions {
  /** OpenAI API key. Defaults only to OPENAI_API_KEY; blank keys are rejected. */
  apiKey?: string;
  /** API root, default https://api.openai.com/v1 (requests go to `${baseURL}/responses`). */
  baseURL?: string;
  maxTurns?: number;
  /** max_output_tokens of one request. */
  maxTokens?: number;
  /** First wait before retrying a 429, 5xx or connection error; doubles on each retry. */
  retryDelayMs?: number;
  /** Retries of one request after a transient error (default 2). */
  maxRetries?: number;
  /** Default 'submit-tool', as for GatewayRunner. */
  structuredMode?: StructuredMode;
}

/** One Responses API input or output item; the runner reads only the fields it needs. */
type Item = Record<string, unknown> & { type?: string };

interface ResponseBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output?: Item[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}

interface FunctionCall {
  call_id: string;
  name: string;
  arguments: string;
}

class OpenAIAPIError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** `openai/gpt-5.4` (a Gateway-style ID) and `gpt-5.4` both mean the OpenAI model `gpt-5.4`. */
export function openaiModelId(model: string): string {
  const m = model.trim();
  return m.startsWith('openai/') ? m.slice('openai/'.length) : m;
}

/** Maestro effort → Responses `reasoning.effort`; `max` has no OpenAI equivalent above `xhigh`. */
function openaiEffort(effort: Effort): string {
  return effort === 'max' ? 'xhigh' : effort;
}

/** OpenAI reports cached tokens inside input_tokens; Maestro's input_tokens is the uncached part. */
function toUsage(u: ResponseBody['usage']): Usage {
  const input = u?.input_tokens ?? 0;
  const cached = Math.min(u?.input_tokens_details?.cached_tokens ?? 0, input);
  return {
    input_tokens: input - cached,
    output_tokens: u?.output_tokens ?? 0,
    cache_read_input_tokens: cached,
  };
}

function parts(output: Item[], type: 'output_text' | 'refusal'): string[] {
  const out: string[] = [];
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Item[]) {
      if (part.type === type) out.push(String(type === 'refusal' ? part.refusal : part.text));
    }
  }
  return out;
}

const textOf = (output: Item[]) => parts(output, 'output_text').join('');

function functionCalls(output: Item[]): FunctionCall[] {
  return output
    .filter((i) => i.type === 'function_call')
    .map((i) => ({ call_id: String(i.call_id), name: String(i.name), arguments: String(i.arguments ?? '') }));
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || e instanceof Aborted || (e as { name?: unknown })?.name === 'AbortError';
}

/** 429 (except an exhausted quota), 5xx and connection failures (fetch throws a TypeError). */
function isTransient(e: unknown): boolean {
  if (e instanceof OpenAIAPIError) {
    if (e.code === 'insufficient_quota') return false;
    return e.status === 429 || (e.status !== undefined && e.status >= 500);
  }
  return e instanceof TypeError;
}

function errorText(e: unknown): string {
  if (e instanceof OpenAIAPIError && e.status === 400) return `400 bad request: ${e.message}`;
  if (e instanceof OpenAIAPIError && e.status !== undefined) return `API error ${e.status}: ${e.message}`;
  return `error: ${e instanceof Error ? e.message : String(e)}`;
}

function textFormat(schema: JSONSchema) {
  return {
    format: { type: 'json_schema', name: 'result', schema: toStrictToolInputSchema(schema), strict: true },
  };
}

/** A structured reply: JSON parse, synthetic nulls removed, checked against the script's own schema. */
function parseStructured(schema: JSONSchema, text: string): { value: unknown } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ['not valid JSON'] };
  }
  if (parsed === null || parsed === undefined) return { errors: ['empty result'] };
  const value = stripSyntheticNulls(schema, parsed);
  const errors = validateValue(schema, value);
  return errors.length === 0 ? { value } : { errors };
}

export class OpenAIRunner implements AgentRunner {
  readonly maxTurns: number;
  readonly maxTokens: number;
  /** Largest max_output_tokens of any single request: the raised stage-2 retry. */
  readonly maxRequestTokens: number;
  readonly retryDelayMs: number;
  readonly maxRetries: number;
  readonly structuredMode: StructuredMode;
  readonly baseURL: string;
  readonly #apiKey: string;
  /** Set when the model refused `include: reasoning.encrypted_content`; later requests leave it out. */
  #noEncryptedReasoning = false;

  constructor(opts: OpenAIRunnerOptions = {}) {
    this.#apiKey = (opts.apiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
    this.baseURL = (opts.baseURL ?? OPENAI_BASE_URL).replace(/\/+$/, '');
    this.maxTurns = opts.maxTurns ?? LIMITS.maxTurns;
    this.maxTokens = opts.maxTokens ?? LIMITS.maxTokensPerTurn;
    this.maxRequestTokens = Math.max(
      this.maxTokens,
      Math.min(2 * this.maxTokens, LIMITS.maxTokensPerTurnRaised),
    );
    this.retryDelayMs = opts.retryDelayMs ?? 5_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.structuredMode = opts.structuredMode ?? 'submit-tool';
  }

  async run(req: RunRequest): Promise<RunResult> {
    const writers = req.tools.filter((t) => t.write).map((t) => t.name);
    if (writers.length > 0 && !req.isolated) {
      throw new MaestroError(
        `write tools (${writers.join(', ')}) require isolation: 'worktree'`,
        'write_tool_without_isolation',
      );
    }
    const model = openaiModelId(req.model);
    if (!req.signal.aborted && (/^claude-/i.test(model) || model.includes('/'))) {
      throw new Error(
        `The openai runner needs an OpenAI model ID, got "${req.model}". Set --model, run({ model }), or agent ` +
          'opts.model (for example gpt-5.4); the default Claude model is not an OpenAI model.',
      );
    }
    // A remote error may echo credentials; keep them out of logs and persisted error diagnostics.
    const redact = (text: string) => (this.#apiKey ? text.replaceAll(this.#apiKey, '[REDACTED]') : text);
    const r: RunRequest = { ...req, model, log: (message) => req.log(redact(message)) };
    const st = new RunState(r);
    let inbox: LiveMessages | undefined;
    let result: RunResult;
    try {
      if (req.signal.aborted) throw new Aborted();
      if (!this.#apiKey) {
        throw new Error(
          'OPENAI_API_KEY is missing or blank. Set it or pass apiKey to OpenAIRunner; use --dry-run for offline runs.',
        );
      }
      inbox = new LiveMessages(r);
      result = await this.#run(r, st, writers.length > 0, inbox);
    } catch (e) {
      result = isAbort(e, req.signal)
        ? st.done(null, 'skipped', { error: 'aborted' })
        : st.fail(errorText(e));
    } finally {
      inbox?.close();
    }
    if (result.error !== undefined) result.error = redact(result.error);
    return result;
  }

  async #run(req: RunRequest, st: RunState, hasWriters: boolean, inbox: LiveMessages): Promise<RunResult> {
    const ctx: ToolContext = { cwd: req.cwd, signal: req.signal };
    const schema = req.schema;
    const mode: StructuredMode = schema ? this.structuredMode : 'two-stage';
    const submitMode = mode === 'submit-tool' && schema !== undefined;

    const tools: Item[] = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: true,
    }));
    if (submitMode) {
      tools.push({
        type: 'function',
        name: SUBMIT_RESULT_TOOL_NAME,
        description: 'Submit the final structured return value of this task.',
        parameters: toStrictToolInputSchema(schema),
        strict: true,
      });
    }
    const instructions = submitMode ? `${req.system}\n\n${SUBMIT_SYSTEM_INSTRUCTION}` : req.system;
    const base = {
      model: req.model,
      instructions,
      store: false,
      ...(tools.length > 0 ? { tools } : {}),
      ...(req.effort ? { reasoning: { effort: openaiEffort(req.effort) } } : {}),
    };
    const stage1Format = mode === 'single-stage' && schema ? { text: textFormat(schema) } : {};

    let commitReminded = false;
    const dirtyWriter = async () =>
      req.isolated && hasWriters && !commitReminded && (await hasUncommittedChanges(req.cwd, req.signal));

    /** Validates a submit-tool call; returns the value, or the error text the model sees. */
    const checkSubmit = async (args: unknown): Promise<{ value: unknown } | { error: string }> => {
      if (await dirtyWriter()) {
        commitReminded = true;
        req.log('writer called submit tool with uncommitted changes; prompting once to commit');
        return { error: COMMIT_REMINDER_MESSAGE };
      }
      const value = stripSyntheticNulls(schema, args);
      const errors = validateValue(schema, value);
      if (errors.length > 0) {
        req.log(`submit tool validation failed: ${errors.slice(0, 5).join('; ')}`);
        return {
          error: `Output failed schema validation: ${errors.join('; ')}. Fix and call ${SUBMIT_RESULT_TOOL_NAME} again.`,
        };
      }
      return { value };
    };

    const runCall = async (
      call: FunctionCall,
    ): Promise<{ output: string; submitted?: { value: unknown } }> => {
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        st.toolCall(call.name, call.arguments);
        return { output: `Error: the arguments of ${call.name} were not valid JSON.` };
      }
      if (submitMode && call.name === SUBMIT_RESULT_TOOL_NAME) {
        const call_ = st.toolCall(call.name, args);
        const checked = await checkSubmit(args);
        if ('error' in checked) return { output: `Error: ${checked.error}` };
        call_.ok = true;
        return { output: 'Submitted.', submitted: checked };
      }
      const tool = req.tools.find((t) => t.name === call.name);
      const trace = st.toolCall(call.name, args);
      if (!tool) return { output: `Error: unknown tool ${call.name}.` };
      req.onProgress?.({
        activity: 'tool',
        summary: `Running ${tool.name}`,
        tool: tool.name,
        turns: st.turns,
      });
      try {
        const output = await tool.run(args, ctx);
        trace.ok = true;
        return { output };
      } catch (e) {
        if (isAbort(e, req.signal)) throw new Aborted();
        return { output: `Error: ${e instanceof Error ? e.message : String(e)}` };
      } finally {
        req.onProgress?.({
          activity: 'tool',
          summary: `${tool.name} ${trace.ok ? 'completed' : 'failed'}`,
          tool: tool.name,
          turns: st.turns,
        });
      }
    };

    // ---- Stage 1: tool loop -------------------------------------------------------------
    const input: Item[] = [{ role: 'user', content: req.prompt }];
    let carry = ''; // text of a reply cut by the output limit, prefixed to its continuation
    let lastText = '';
    let continued = false;
    let submitReminded = false;
    let submitted: { value: unknown } | undefined;
    let stillCalling = false;

    for (;;) {
      if (inbox.appendTo(input)) {
        carry = '';
        submitted = undefined;
        submitReminded = false;
      }
      if (submitted !== undefined) return st.done(submitted.value, 'ok');
      if (st.turns >= this.maxTurns) {
        return st.fail(
          stillCalling
            ? `turn cap: agent still calling tools after ${this.maxTurns} turns`
            : `turn cap: ${this.maxTurns} turns used`,
        );
      }
      req.onProgress?.({ activity: 'model', summary: 'Waiting for model response', turns: st.turns });
      const res = await this.#create(req, {
        ...base,
        ...stage1Format,
        input,
        max_output_tokens: this.maxTokens,
      });
      st.turn(toUsage(res.usage));
      const output = res.output ?? [];
      const refusal = parts(output, 'refusal');
      if (refusal.length > 0) return st.fail(`refusal: ${refusal.join(' ')}`);
      if (res.status === 'incomplete' && res.incomplete_details?.reason === 'content_filter') {
        return st.fail('refusal (category: content_filter)');
      }
      const said = textOf(output);
      lastText = carry + said;
      if (said !== '') st.finalText = lastText;

      if (res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens') {
        if (continued) return st.fail('max_tokens reached again after one continuation');
        continued = true;
        carry = lastText;
        stillCalling = false;
        // A cut-off function call has no output; drop it so the transcript stays valid.
        input.push(...output.filter((i) => i.type !== 'function_call'), {
          role: 'user',
          content: CONTINUE_MESSAGE,
        });
        continue;
      }
      input.push(...output);

      const calls = functionCalls(output);
      stillCalling = calls.length > 0;
      if (calls.length > 0) {
        carry = '';
        for (const call of calls) {
          const done = await runCall(call);
          input.push({ type: 'function_call_output', call_id: call.call_id, output: done.output });
          if (done.submitted) submitted = done.submitted;
        }
        continue;
      }

      if (inbox.hasPending) continue;
      if (await dirtyWriter()) {
        commitReminded = true;
        req.log('writer ended turn with uncommitted changes; prompting once to commit');
        input.push({ role: 'user', content: COMMIT_REMINDER_MESSAGE });
        continue;
      }
      if (submitMode) {
        const parsed = parseStructured(schema, lastText);
        if ('value' in parsed) return st.done(parsed.value, 'ok');
        if (!submitReminded) {
          submitReminded = true;
          req.log(`agent ended turn without calling ${SUBMIT_RESULT_TOOL_NAME}; prompting once`);
          input.push({ role: 'user', content: SUBMIT_REMINDER_MESSAGE });
          continue;
        }
        const error = 'schema parse failed twice';
        req.log(error);
        return st.done(null, 'null', { raw: lastText, error });
      }
      break;
    }

    if (!schema) return st.done(lastText, 'ok');

    let startAttempt = 1;
    let raw = lastText;
    if (mode === 'single-stage') {
      const parsed = parseStructured(schema, lastText);
      if ('value' in parsed) return st.done(parsed.value, 'ok');
      req.log(`schema parse attempt 1: ${parsed.errors.slice(0, 5).join('; ')}`);
      startAttempt = 2;
    }

    // ---- Stage 2: structured final ------------------------------------------------------
    const parseInput: Item[] = [...input, { role: 'user', content: SCHEMA_MESSAGE }];
    let maxTokens = this.maxTokens;
    for (let attempt = startAttempt; attempt <= 2; attempt++) {
      req.onProgress?.({ activity: 'model', summary: 'Formatting structured result', turns: st.turns });
      inbox.appendTo(parseInput);
      const res = await this.#create(req, {
        ...base,
        // The history may hold function calls, so the tools stay listed, but none may be called now.
        ...(tools.length > 0 ? { tool_choice: 'none' } : {}),
        text: textFormat(schema),
        input: parseInput,
        max_output_tokens: maxTokens,
      });
      st.turn(toUsage(res.usage));
      const output = res.output ?? [];
      raw = textOf(output);
      const refusal = parts(output, 'refusal');
      if (refusal.length > 0) {
        req.log(`refusal: ${refusal.join(' ')}`);
        return st.done(null, 'null', { raw, error: 'refusal' });
      }
      const parsed = parseStructured(schema, raw);
      if ('value' in parsed) return st.done(parsed.value, 'ok');
      req.log(
        `schema parse attempt ${attempt}: ${parsed.errors.slice(0, 5).join('; ')} (status: ${res.status})`,
      );
      const cut = res.status === 'incomplete' && res.incomplete_details?.reason === 'max_output_tokens';
      if (attempt < 2 && cut && this.maxRequestTokens > maxTokens) {
        maxTokens = this.maxRequestTokens;
        req.log(`schema parse attempt ${attempt} cut by max_tokens; retrying with max_tokens ${maxTokens}`);
      }
    }
    const error = 'schema parse failed twice';
    req.log(error);
    return st.done(null, 'null', { raw, error });
  }

  /** POST /responses with retries for transient errors; a failed response is an error. */
  async #create(req: RunRequest, body: Record<string, unknown>): Promise<ResponseBody> {
    for (let attempt = 0; ; attempt++) {
      if (req.signal.aborted) throw new Aborted();
      const payload = this.#noEncryptedReasoning
        ? body
        : { ...body, include: ['reasoning.encrypted_content'] };
      try {
        return await this.#post(req, payload);
      } catch (e) {
        if (isAbort(e, req.signal)) throw new Aborted();
        if (
          !this.#noEncryptedReasoning &&
          e instanceof OpenAIAPIError &&
          e.status === 400 &&
          /encrypted_content|include/i.test(e.message)
        ) {
          // Models without reasoning may refuse the include; they have no reasoning items to pass back.
          this.#noEncryptedReasoning = true;
          req.log(`${errorText(e)}; retrying without reasoning.encrypted_content`);
          attempt--;
          continue;
        }
        if (!isTransient(e) || attempt >= this.maxRetries) throw e;
        const delay = this.retryDelayMs * 2 ** attempt;
        req.log(`${errorText(e)}; retrying in ${delay} ms`);
        await sleep(delay, req.signal);
      }
    }
  }

  async #post(req: RunRequest, body: Record<string, unknown>): Promise<ResponseBody> {
    const res = await fetch(`${this.baseURL}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    const text = await res.text();
    let json: (ResponseBody & { error?: { message?: string; code?: string } | null }) | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      throw new OpenAIAPIError(
        res.status,
        json?.error?.message ?? (text.slice(0, 500) || res.statusText),
        json?.error?.code,
      );
    }
    if (!json || typeof json !== 'object') throw new OpenAIAPIError(res.status, 'response body was not JSON');
    if (json.status === 'failed') {
      throw new OpenAIAPIError(undefined, `response failed: ${json.error?.message ?? 'unknown error'}`);
    }
    return json;
  }
}
