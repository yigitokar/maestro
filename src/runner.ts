// AnthropicRunner (spec 3.2): runs one agent end to end over @anthropic-ai/sdk. Stage 1 is the SDK
// tool runner (client.beta.messages.toolRunner); stage 2, only when a schema is given, appends
// "return your findings in the schema" to the same transcript and calls client.beta.messages.parse
// with output_config.format. Agent-level failures become null (null/throw table); only the
// write-tool-without-isolation configuration error throws.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { childGitEnv } from './git-env.js';
import {
  type AgentRunner,
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

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;

/** Prompt-cache breakpoint (5-minute TTL; agents of one run reuse each other's prefix well within it). */
const EPHEMERAL = { type: 'ephemeral' } as const;

/**
 * The system prompt as one text block carrying an explicit cache breakpoint. Tools render before system,
 * so the breakpoint caches tools + system: the stable prefix shared by every agent with the same tool
 * list and CLAUDE.md. Volatile content (the prompt with its args, the transcript) comes after it.
 */
export function cachedSystem(system: string): BetaTextBlockParam[] {
  return [{ type: 'text', text: system, cache_control: EPHEMERAL }];
}

/** Return contract (spec Level 1, the return contract). */
export const RETURN_CONTRACT =
  'Your final message IS the return value of this call: it is raw data for the program that called you, ' +
  'not a message to a human. Do not add greetings, explanations or summaries around it.';

/** The commit sentence of WRITER_INSTRUCTION; a runner that commits for the agent replaces it. */
export const WRITER_COMMIT_INSTRUCTION =
  'When finished, commit your changes with git_commit. Uncommitted work is not handed off.';

export const WRITER_INSTRUCTION =
  'You are on a branch prepared for you; work only in the current working directory. ' +
  `${WRITER_COMMIT_INSTRUCTION}\n` +
  // spec 3.6: node_modules and build artifacts are not copied into the worktree; the agent does not install.
  'Do not run npm install or any other package install (npm/pnpm/yarn/bun/pip install, npm ci): ' +
  'node_modules and build artifacts are not copied into this worktree (at most symlinked from the main checkout).';

const execFileAsync = promisify(execFile);

const CONTINUE_MESSAGE =
  'Continue: your previous reply was cut off by the output limit. Continue exactly where you ' +
  'stopped, without repeating what you already wrote.';
const SCHEMA_MESSAGE = 'Return your findings in the required schema.';

/** Sent once when an isolated writer ends its turn with uncommitted changes in the worktree. */
export const COMMIT_REMINDER_MESSAGE =
  'Uncommitted changes remain in the working tree (`git status --porcelain` is non-empty). ' +
  'Commit your finished work with `git_commit` (or revert temporary edits) before ending your turn; ' +
  'uncommitted changes are not handed off.';

/** Synthetic strict tool used by `structuredMode: 'submit-tool'` so the transcript cache stays intact. */
export const SUBMIT_RESULT_TOOL_NAME = '__maestro_submit_result';

const SUBMIT_SYSTEM_INSTRUCTION = `When you have your final answer, call \`${SUBMIT_RESULT_TOOL_NAME}\` with an input matching its schema.`;
const SUBMIT_REMINDER_MESSAGE = `Call \`${SUBMIT_RESULT_TOOL_NAME}\` now with your final structured findings.`;

/**
 * How `AnthropicRunner` obtains a schema-validated result:
 * - `'two-stage'` (default): Stage 1 tool loop, then Stage 2 `messages.parse` with `output_config.format`.
 * - `'submit-tool'`: adds a strict `__maestro_submit_result` tool in Stage 1 so every turn shares the same
 *   tools, system and `output_config`, preserving Anthropic prompt cache on the full transcript.
 * - `'single-stage'`: passes `output_config.format` directly on Stage 1 turns, falling back to one Stage 2
 *   retry only if client-side validation fails.
 */
export type StructuredMode = 'two-stage' | 'submit-tool' | 'single-stage';

/** System prompt: return contract + project CLAUDE.md (when present) + commit instruction for writers. */
export function systemPrompt(opts: { cwd: string; writer: boolean }): string {
  const parts = [RETURN_CONTRACT];
  if (opts.writer) parts.push(WRITER_INSTRUCTION);
  try {
    const md = readFileSync(path.join(opts.cwd, 'CLAUDE.md'), 'utf8').trim();
    if (md !== '') parts.push(`Project instructions (CLAUDE.md):\n\n${md}`);
  } catch {
    // no CLAUDE.md
  }
  return parts.join('\n\n');
}

export interface AnthropicRunnerOptions {
  client?: Anthropic;
  maxTurns?: number;
  maxTokens?: number;
  retryDelayMs?: number;
  structuredMode?: StructuredMode;
}

/** Thrown internally to unwind when the run's signal fires. */
class Aborted extends Error {}

/** Trace limits: input summary per tool call, final text per agent. */
const TRACE_INPUT_CHARS = 200;
const TRACE_TEXT_CHARS = 2_000;

/** Per-run bookkeeping: summed usage, turn count, onUsage per turn (spec 3.2 invariant), trace. */
class RunState {
  usage: Usage = { input_tokens: 0, output_tokens: 0 };
  turns = 0;
  readonly toolCalls: TraceToolCall[] = [];
  /** Last non-empty assistant text of stage 1 (the final text once the loop ends). */
  finalText = '';
  constructor(private readonly req: RunRequest) {}

  turn(u: Partial<Record<keyof Usage, number | null>> | null | undefined): void {
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    addUsage(usage, u);
    this.turns++;
    addUsage(this.usage, usage);
    this.req.onUsage(usage); // immediately, per turn
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
      // Every request of this run carries req.model unchanged, so it is the model that ran.
      model: this.req.model,
    };
    if (extra.raw !== undefined) out.raw = extra.raw;
    if (extra.error !== undefined) out.error = extra.error;
    return out;
  }

  /** Records a tool call before it runs (call order); `ok` turns true once it returns. */
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
    this.req.log(error);
    return this.done(null, 'null', { error });
  }
}

/** Follow-ups wait for a model boundary; finishing a run must settle every delivery promise. */
class LiveMessages {
  private readonly pending: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
  private closed = false;
  private readonly unregister: (() => void) | undefined;

  constructor(private readonly req: RunRequest) {
    this.unregister = req.registerMessageHandler?.((text) => {
      if (this.closed || req.signal.aborted)
        return Promise.reject(new Error('Agent is no longer accepting messages'));
      const delivery = new Promise<void>((resolve, reject) => this.pending.push({ text, resolve, reject }));
      // The host normally handles rejection immediately, but an external caller may attach later.
      delivery.catch(() => {});
      return delivery;
    });
  }

  get enabled(): boolean {
    return this.req.registerMessageHandler !== undefined;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  appendTo(messages: MessageParam[], apply?: () => void): boolean {
    if (!this.hasPending) return false;
    if (this.req.signal.aborted) throw new Aborted();
    const batch = this.pending.splice(0);
    for (const item of batch) messages.push({ role: 'user', content: item.text });
    try {
      apply?.();
    } catch (error) {
      for (const item of batch) item.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    for (const item of batch) item.resolve();
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

function textOf(message: { content: Array<{ type: string }> } | undefined): string {
  if (!message) return '';
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function isAbortError(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || e instanceof Anthropic.APIUserAbortError || e instanceof Aborted;
}

/** 429, 5xx (incl. 529) and connection errors: retried by the SDK, then once more by the runner. */
function isTransient(e: unknown): boolean {
  if (e instanceof Anthropic.APIUserAbortError) return false;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    const status = e.status as number | undefined;
    return status === 429 || (typeof status === 'number' && status >= 500);
  }
  return false;
}

function errorText(e: unknown): string {
  if (e instanceof Anthropic.BadRequestError) return `400 bad request: ${e.message}`;
  if (e instanceof Anthropic.APIError && e.status !== undefined) return `API error ${e.status}: ${e.message}`;
  return `error: ${e instanceof Error ? e.message : String(e)}`;
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

/** A transcript cut off by max_tokens may end in an incomplete tool_use; drop those blocks before continuing. */
function withoutDanglingToolUse(messages: MessageParam[]): MessageParam[] {
  const last = messages[messages.length - 1];
  if (last?.role !== 'assistant' || typeof last.content === 'string') return messages;
  const content = last.content.filter((b) => b.type !== 'tool_use' && b.type !== 'server_tool_use');
  if (content.length === last.content.length) return messages;
  const head = messages.slice(0, -1);
  return content.length > 0 ? [...head, { ...last, content }] : head;
}

// ---------------------------------------------------------------------------------------------
// Schema helpers for stage 2

const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
]);

/**
 * A COPY of the script's schema made acceptable to structured outputs: additionalProperties:false on
 * every object, oneOf → anyOf, unsupported constraints moved into the description (they are still
 * enforced client-side by validateValue against the original schema).
 */
export function toStructuredOutputSchema(schema: unknown): JSONSchema {
  return strictify(schema) as JSONSchema;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const moved: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if ((k === 'properties' || k === '$defs' || k === 'definitions') && v && typeof v === 'object') {
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, strictify(s)]),
      );
    } else if (k === 'items' || k === 'not') {
      out[k] = strictify(v);
    } else if (k === 'anyOf' || k === 'allOf' || k === 'prefixItems') {
      out[k] = strictify(v);
    } else if (k === 'oneOf') {
      // With an anyOf next to it the node means "one of these AND one of those". Structured outputs
      // cannot say that (allOf over anyOf is refused), so the model is held to the anyOf and told the
      // oneOf in the description; validateValue checks both.
      if ('anyOf' in src) moved.push(`oneOf: ${JSON.stringify(v)}`);
      else out.anyOf = strictify(v);
    } else if (k === 'additionalProperties') {
      // replaced below for objects
    } else if (UNSUPPORTED_KEYWORDS.has(k) || (k === 'minItems' && typeof v === 'number' && v > 1)) {
      moved.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      out[k] = v;
    }
  }
  const type = src.type;
  const isObject =
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    (type === undefined && 'properties' in src);
  if (isObject) out.additionalProperties = false;
  if (moved.length > 0) {
    const desc = typeof out.description === 'string' ? `${out.description}\n\n` : '';
    out.description = `${desc}{${moved.join(', ')}}`;
  }
  return out;
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return true;
  }
}

/** Small structural validator against the script's ORIGINAL schema (final check of stage 2). */
export function validateValue(schema: unknown, value: unknown, at = '$'): string[] {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${at}: not allowed`];
  if (schema === null || typeof schema !== 'object') return [];
  const s = schema as Record<string, any>;
  const errs: string[] = [];
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, value))) return [`${at}: expected ${types.join('|')}`];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${at}: not in enum`);
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) errs.push(`${at}: const mismatch`);
  // oneOf is checked like anyOf: structured outputs gets it as anyOf (toStructuredOutputSchema).
  for (const alts of [s.anyOf, s.oneOf]) {
    if (Array.isArray(alts) && !alts.some((alt) => validateValue(alt, value, at).length === 0)) {
      errs.push(`${at}: matches no alternative`);
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf) errs.push(...validateValue(sub, value, at));
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength)
      errs.push(`${at}: shorter than minLength`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength)
      errs.push(`${at}: longer than maxLength`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) errs.push(`${at}: pattern`);
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errs.push(`${at}: below minimum`);
    if (typeof s.maximum === 'number' && value > s.maximum) errs.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errs.push(`${at}: fewer than minItems`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errs.push(`${at}: more than maxItems`);
    if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
      value.forEach((item, i) => {
        errs.push(...validateValue(s.items, item, `${at}[${i}]`));
      });
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) if (!Object.hasOwn(obj, key)) errs.push(`${at}.${key}: required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, key)) errs.push(...validateValue(props[key], v, `${at}.${key}`));
      else if (s.additionalProperties === false) errs.push(`${at}.${key}: additional property`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        errs.push(...validateValue(s.additionalProperties, v, `${at}.${key}`));
      }
    }
  }
  return errs;
}

async function hasUncommittedChanges(cwd: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) throw new Aborted();
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      env: childGitEnv(),
      signal,
      encoding: 'utf8',
    });
    return stdout.trim().length > 0;
  } catch (e) {
    if (signal.aborted || (e as { name?: unknown })?.name === 'AbortError') throw new Aborted();
    // Non-git directories (e.g. unit tests without git init) have no git commit hand-off.
    return false;
  }
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null'))) return true;
  if (s.const === null || (Array.isArray(s.enum) && s.enum.includes(null))) return true;
  if (Array.isArray(s.anyOf) && s.anyOf.some(schemaAllowsNull)) return true;
  if (Array.isArray(s.oneOf) && s.oneOf.some(schemaAllowsNull)) return true;
  return false;
}

function makeNullableSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  if (schemaAllowsNull(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (typeof s.type === 'string') return { ...s, type: [s.type, 'null'] };
  if (Array.isArray(s.type)) return { ...s, type: [...s.type, 'null'] };
  return { anyOf: [s, { type: 'null' }] };
}

/**
 * Converts a workflow output schema into a strict tool `input_schema` (every object property listed in
 * `required`; optional properties wrapped as nullable and stripped back out by `stripSyntheticNulls`).
 */
export function toStrictToolInputSchema(schema: unknown): JSONSchema {
  return strictToolNode(toStructuredOutputSchema(schema), schema) as JSONSchema;
}

function strictToolNode(node: unknown, orig: unknown): unknown {
  if (Array.isArray(node))
    return node.map((item, i) => strictToolNode(item, Array.isArray(orig) ? orig[i] : undefined));
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const origObj =
    orig && typeof orig === 'object' && !Array.isArray(orig) ? (orig as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  if (src.items && typeof src.items === 'object') out.items = strictToolNode(src.items, origObj.items);
  for (const kw of ['anyOf', 'allOf', 'prefixItems'] as const) {
    if (Array.isArray(src[kw])) {
      const origList = Array.isArray(origObj[kw]) ? (origObj[kw] as unknown[]) : [];
      out[kw] = (src[kw] as unknown[]).map((sub, i) => strictToolNode(sub, origList[i]));
    }
  }
  for (const defsKey of ['$defs', 'definitions'] as const) {
    if (src[defsKey] && typeof src[defsKey] === 'object') {
      const origDefs = (origObj[defsKey] as Record<string, unknown> | undefined) ?? {};
      out[defsKey] = Object.fromEntries(
        Object.entries(src[defsKey] as Record<string, unknown>).map(([k, v]) => [
          k,
          strictToolNode(v, origDefs[k]),
        ]),
      );
    }
  }
  const type = src.type;
  const isObject =
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    (type === undefined && 'properties' in src);
  if (isObject) {
    const props = (src.properties ?? {}) as Record<string, unknown>;
    const origProps = (origObj.properties ?? {}) as Record<string, unknown>;
    const origReq = new Set(Array.isArray(origObj.required) ? (origObj.required as string[]) : []);
    const nextProps: Record<string, unknown> = {};
    for (const [k, propSchema] of Object.entries(props)) {
      const converted = strictToolNode(propSchema, origProps[k]);
      nextProps[k] = origReq.has(k) ? converted : makeNullableSchema(converted);
    }
    out.properties = nextProps;
    out.required = Object.keys(nextProps);
    out.additionalProperties = false;
  }
  return out;
}

/** Drops `null` values introduced only to satisfy strict-tool `required` on optional properties. */
export function stripSyntheticNulls(origSchema: unknown, value: unknown): unknown {
  if (!origSchema || typeof origSchema !== 'object' || Array.isArray(origSchema)) return value;
  const s = origSchema as Record<string, unknown>;
  if (Array.isArray(value)) {
    if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) {
      return value.map((el) => stripSyntheticNulls(s.items, el));
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const reqSet = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props[k];
      if (v === null && k in props && !reqSet.has(k) && !schemaAllowsNull(propSchema)) continue;
      out[k] = propSchema !== undefined ? stripSyntheticNulls(propSchema, v) : v;
    }
    return out;
  }
  return value;
}

function buildOutputFormat(schema: JSONSchema) {
  const base = betaJSONSchemaOutputFormat(toStructuredOutputSchema(schema) as { type: 'object' }, {
    transform: false,
  });
  // Invalid JSON must not throw (the SDK's parse would lose the response): treat it as null.
  return {
    ...base,
    parse: (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------

export class AnthropicRunner implements AgentRunner {
  #client: Anthropic | undefined;
  readonly maxTurns: number;
  readonly maxTokens: number;
  /** Largest max_tokens of any single request: the raised stage-2 retry (spec 3.5 max_tokens_per_turn). */
  readonly maxRequestTokens: number;
  readonly retryDelayMs: number;
  readonly structuredMode: StructuredMode;

  constructor(opts: AnthropicRunnerOptions = {}) {
    this.#client = opts.client;
    this.maxTurns = opts.maxTurns ?? LIMITS.maxTurns;
    this.maxTokens = opts.maxTokens ?? LIMITS.maxTokensPerTurn;
    this.maxRequestTokens = Math.max(
      this.maxTokens,
      Math.min(2 * this.maxTokens, LIMITS.maxTokensPerTurnRaised),
    );
    this.retryDelayMs = opts.retryDelayMs ?? 5_000;
    this.structuredMode = opts.structuredMode ?? 'two-stage';
  }

  /** Default client built lazily: SDK default maxRetries (2) is the spec's "SDK retry". */
  get client(): Anthropic {
    this.#client ??= new Anthropic();
    return this.#client;
  }

  async run(req: RunRequest): Promise<RunResult> {
    // spec 3.2 / 3.6: without isolation the tool list is read-only, enforced here too.
    const writers = req.tools.filter((t) => t.write).map((t) => t.name);
    if (writers.length > 0 && !req.isolated) {
      throw new MaestroError(
        `write tools (${writers.join(', ')}) require isolation: 'worktree'`,
        'write_tool_without_isolation',
      );
    }
    const st = new RunState(req);
    let messages: LiveMessages | undefined;
    try {
      if (req.signal.aborted) throw new Aborted();
      messages = new LiveMessages(req);
      return await this.#run(req, st, writers.length > 0, messages);
    } catch (e) {
      if (isAbortError(e, req.signal)) return st.done(null, 'skipped', { error: 'aborted' });
      return st.fail(errorText(e));
    } finally {
      messages?.close();
    }
  }

  async #run(req: RunRequest, st: RunState, hasWriters: boolean, inbox: LiveMessages): Promise<RunResult> {
    const client = this.client;
    const ctx: ToolContext = { cwd: req.cwd, signal: req.signal };
    const mode: StructuredMode = req.schema ? this.structuredMode : 'two-stage';
    const format = req.schema ? buildOutputFormat(req.schema) : undefined;

    const apiTools: BetaTool[] = req.tools.map((t) => ({
      type: 'custom',
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool['input_schema'],
      strict: true,
    }));
    const runnable: BetaRunnableTool<any>[] = req.tools.map((t, i) => ({
      ...apiTools[i]!,
      // A throw becomes tool_result is_error:true in the SDK (runRunnableTool); the agent continues.
      run: async (input: unknown) => {
        const call = st.toolCall(t.name, input);
        req.onProgress?.({ activity: 'tool', summary: `Running ${t.name}`, tool: t.name, turns: st.turns });
        try {
          const out = await t.run(input, ctx);
          call.ok = true;
          return out;
        } finally {
          req.onProgress?.({
            activity: 'tool',
            summary: `${t.name} ${call.ok ? 'completed' : 'failed'}`,
            tool: t.name,
            turns: st.turns,
          });
        }
      },
      parse: (input: unknown) => input,
    }));

    let submitted: { value: unknown } | undefined;
    let commitReminded = false;
    let submitReminded = false;

    if (mode === 'submit-tool' && req.schema) {
      const schema = req.schema;
      const submitApiTool: BetaTool = {
        type: 'custom',
        name: SUBMIT_RESULT_TOOL_NAME,
        description: 'Submit the final structured return value of this task.',
        input_schema: toStrictToolInputSchema(schema) as BetaTool['input_schema'],
        strict: true,
      };
      apiTools.push(submitApiTool);
      runnable.push({
        ...submitApiTool,
        run: async (input: unknown) => {
          if (
            req.isolated &&
            hasWriters &&
            !commitReminded &&
            (await hasUncommittedChanges(req.cwd, req.signal))
          ) {
            commitReminded = true;
            req.log('writer called submit tool with uncommitted changes; prompting once to commit');
            throw new Error(COMMIT_REMINDER_MESSAGE);
          }
          const cleaned = stripSyntheticNulls(schema, input);
          const errors = validateValue(schema, cleaned);
          if (errors.length > 0) {
            req.log(`submit tool validation failed: ${errors.slice(0, 5).join('; ')}`);
            throw new Error(
              `Output failed schema validation: ${errors.join('; ')}. Fix and call ${SUBMIT_RESULT_TOOL_NAME} again.`,
            );
          }
          submitted = { value: cleaned };
          return 'Submitted.';
        },
        parse: (input: unknown) => input,
      });
    }

    const systemText = mode === 'submit-tool' ? `${req.system}\n\n${SUBMIT_SYSTEM_INSTRUCTION}` : req.system;
    const outputConfig =
      mode === 'single-stage' && format
        ? { output_config: { format, ...(req.effort ? { effort: req.effort } : {}) } }
        : req.effort
          ? { output_config: { effort: req.effort } }
          : {};

    // ---- Stage 1: tool loop -------------------------------------------------------------
    let messages: MessageParam[] = [{ role: 'user', content: req.prompt }];
    let loopTurns = 0;
    let continued = false;
    let retried = false;
    let last: BetaMessage | undefined;
    let carry = ''; // text of a reply cut by max_tokens, prefixed to its continuation

    for (;;) {
      req.onProgress?.({ activity: 'model', summary: 'Waiting for model response', turns: st.turns });
      if (inbox.appendTo(messages)) carry = '';
      const runner = client.beta.messages.toolRunner(
        {
          model: req.model,
          max_tokens: this.maxTokens,
          system: cachedSystem(systemText),
          messages,
          tools: runnable,
          // Automatic breakpoint on the last block: it walks forward with the transcript, so every turn
          // reads the previous turn's prefix from the cache instead of paying for it again.
          cache_control: EPHEMERAL,
          max_iterations: Math.max(1, this.maxTurns - loopTurns),
          // Full history each turn: the transcript stays local, so a runner-level retry or the
          // stage-2 parse continues from it without re-running finished tool calls.
          thread: false,
          ...outputConfig,
        },
        { signal: req.signal },
      );
      let failure: unknown;
      try {
        for await (const message of runner) {
          loopTurns++;
          last = message;
          retried = false;
          const said = textOf(message);
          if (said !== '') st.finalText = carry + said;
          st.turn(message.usage);
          if (message.stop_reason === 'refusal') {
            const d = message.stop_details;
            const why = d?.explanation ? `: ${d.explanation}` : '';
            return st.fail(`refusal (category: ${d?.category ?? 'none'})${why}`);
          }
          if (message.stop_reason === 'tool_use') {
            carry = '';
            if (mode === 'submit-tool' && req.schema) {
              const toolUses = message.content.filter(
                (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use',
              );
              if (toolUses.length === 1 && toolUses[0]!.name === SUBMIT_RESULT_TOOL_NAME) {
                const dirty =
                  req.isolated &&
                  hasWriters &&
                  !commitReminded &&
                  (await hasUncommittedChanges(req.cwd, req.signal));
                if (!dirty) {
                  const cleaned = stripSyntheticNulls(req.schema, toolUses[0]!.input);
                  if (validateValue(req.schema, cleaned).length === 0 && !inbox.hasPending) {
                    submitted = { value: cleaned };
                    break;
                  }
                }
              }
            }
          }
          if (inbox.enabled) {
            // Complete tools before adding user instructions. The SDK caches this response, so the
            // automatic loop will not repeat tools if there is no follow-up to append.
            const toolResponse =
              message.stop_reason === 'tool_use' ? await runner.generateToolResponse() : null;
            if (inbox.hasPending && loopTurns < this.maxTurns && message.stop_reason !== 'max_tokens') {
              const next: MessageParam[] = [
                ...runner.params.messages,
                { role: 'assistant', content: message.content },
                ...(toolResponse ? [toolResponse] : []),
              ];
              inbox.appendTo(next, () => runner.setMessagesParams({ ...runner.params, messages: next }));
              submitted = undefined;
              carry = '';
              submitReminded = false;
            }
            req.onProgress?.({ activity: 'model', summary: 'Waiting for model response', turns: st.turns });
          }
        }
      } catch (e) {
        failure = e;
      }
      messages = [...runner.params.messages];
      if (failure !== undefined) {
        if (isAbortError(failure, req.signal)) throw failure;
        if (isTransient(failure) && !retried) {
          retried = true;
          req.log(`${errorText(failure)}; retrying once in ${this.retryDelayMs} ms`);
          await sleep(this.retryDelayMs, req.signal);
          continue;
        }
        throw failure;
      }
      if (!last) return st.fail('error: tool loop produced no message');
      if (submitted !== undefined) return st.done(submitted.value, 'ok');
      if (last.stop_reason === 'max_tokens') {
        if (continued) return st.fail('max_tokens reached again after one continuation');
        continued = true;
        carry = textOf(last);
        messages = [...withoutDanglingToolUse(messages), { role: 'user', content: CONTINUE_MESSAGE }];
        if (loopTurns >= this.maxTurns) return st.fail(`turn cap: ${this.maxTurns} turns used`);
        continue;
      }
      if (last.stop_reason === 'tool_use') {
        return st.fail(`turn cap: agent still calling tools after ${this.maxTurns} turns`);
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
        messages = [...messages, { role: 'user', content: COMMIT_REMINDER_MESSAGE }];
        continue;
      }
      if (mode === 'submit-tool' && req.schema) {
        const textCandidate = carry + textOf(last);
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
          // Not raw JSON either; remind once to call the submit tool.
        }
        if (!submitReminded) {
          submitReminded = true;
          if (loopTurns >= this.maxTurns) return st.fail(`turn cap: ${this.maxTurns} turns used`);
          req.log(`agent ended turn without calling ${SUBMIT_RESULT_TOOL_NAME}; prompting once`);
          messages = [...messages, { role: 'user', content: SUBMIT_REMINDER_MESSAGE }];
          continue;
        }
        const error = 'schema parse failed twice';
        req.log(error);
        return st.done(null, 'null', { raw: textCandidate, error });
      }
      break;
    }

    const finalText = carry + textOf(last);
    if (finalText !== '') st.finalText = finalText;
    if (!req.schema || !format) return st.done(finalText, 'ok');

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
        req.log(`schema parse attempt 1: no parsable structured output (stop: ${last.stop_reason})`);
      }
      startAttempt = 2;
    }

    // ---- Stage 2: structured final ------------------------------------------------------
    const parseMessages: MessageParam[] = [...messages, { role: 'user', content: SCHEMA_MESSAGE }];
    let maxTokens = this.maxTokens;
    for (let attempt = startAttempt; attempt <= 2; attempt++) {
      req.onProgress?.({ activity: 'model', summary: 'Formatting structured result', turns: st.turns });
      const response = await this.#withRetry(req, () => {
        inbox.appendTo(parseMessages);
        return client.beta.messages.parse(
          {
            model: req.model,
            max_tokens: maxTokens,
            // Only the tools + system breakpoint here: tool_choice and the output format differ from
            // stage 1, which invalidates the messages cache, and an automatic breakpoint would write the
            // whole transcript at the write premium for a request that is not repeated.
            system: cachedSystem(systemText),
            messages: parseMessages,
            // History with tool_use blocks needs the tool definitions; never force a tool (400 on current models).
            ...(apiTools.length > 0 ? { tools: apiTools, tool_choice: { type: 'none' as const } } : {}),
            output_config: { format, ...(req.effort ? { effort: req.effort } : {}) },
          },
          // The SDK refuses a non-streaming request whose max_tokens implies > 10 min (about 21k tokens)
          // unless a timeout is given; the raised retry sets the SDK's own expected-time estimate.
          maxTokens > this.maxTokens
            ? { signal: req.signal, timeout: Math.max(600_000, (3_600_000 * maxTokens) / 128_000) }
            : { signal: req.signal },
        );
      });
      st.turn(response.usage);
      raw = textOf(response);
      if (response.stop_reason === 'refusal') {
        const d = response.stop_details;
        req.log(`refusal (category: ${d?.category ?? 'none'})${d?.explanation ? `: ${d.explanation}` : ''}`);
        return st.done(null, 'null', { raw, error: 'refusal' });
      }
      const parsed = response.parsed_output as unknown;
      if (parsed !== null && parsed !== undefined) {
        const errors = validateValue(req.schema, parsed);
        if (errors.length === 0) return st.done(parsed, 'ok');
        req.log(`schema parse attempt ${attempt}: ${errors.slice(0, 5).join('; ')}`);
      } else {
        req.log(
          `schema parse attempt ${attempt}: no parsable structured output (stop: ${response.stop_reason})`,
        );
      }
      // spec 3.2 "max_tokens → bir kez devam et": a "continue" turn cannot resume an output_config.format
      // reply (the continuation would be a fresh JSON document, not the rest of the cut one), so a
      // max_tokens-truncated structured reply counts as a failed parse and its one retry gets a raised
      // max_tokens instead of the identical request.
      if (attempt < 2 && response.stop_reason === 'max_tokens' && this.maxRequestTokens > maxTokens) {
        maxTokens = this.maxRequestTokens;
        req.log(`schema parse attempt ${attempt} cut by max_tokens; retrying with max_tokens ${maxTokens}`);
      }
    }
    const error = 'schema parse failed twice';
    req.log(error);
    return st.done(null, 'null', { raw, error });
  }

  /** One runner-level wait-and-retry after the SDK's own retries (spec 3.2 Hata halleri). */
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
