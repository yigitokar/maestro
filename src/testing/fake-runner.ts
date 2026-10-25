// In-memory AgentRunner for tests and `--dry-run`. Never touches the network.
// Simulates turns: each turn optionally waits, reports usage via req.onUsage, and
// checks the abort signal, so budget aborts and slot accounting behave like the real runner.

import type { AgentRunner, EntryStatus, JSONSchema, RunRequest, RunResult, Usage } from '../types.js';

export interface FakeResponse {
  /** Result value, or a function of the request. Omitted: a stub derived from req.schema (or a text). */
  result?: unknown | ((req: RunRequest) => unknown);
  /** Forced status. Default: 'ok' when result is non-null, else 'null'. */
  status?: EntryStatus;
  /** Simulated model turns. Default 1. */
  turns?: number;
  /** Output tokens reported per turn. Default 100. */
  outputTokensPerTurn?: number;
  /** Input tokens reported per turn. Default 50. */
  inputTokensPerTurn?: number;
  /** Wait per turn in ms (abortable). Default 0. */
  delayMs?: number;
  error?: string;
  /** Raw model text returned on a non-ok status (spec 3.2: schema parse failed twice → raw in the journal). */
  raw?: string;
  /** Side effect run inside the "agent" before the result is computed (e.g. write + commit in req.cwd). */
  effect?: (req: RunRequest) => void | Promise<void>;
}

export interface FakeRule {
  match: string | RegExp | ((req: RunRequest) => boolean);
  respond: FakeResponse | ((req: RunRequest, call: number) => FakeResponse | Promise<FakeResponse>);
}

export type FakeHandler = (req: RunRequest, call: number) => FakeResponse | Promise<FakeResponse>;

export class FakeRunner implements AgentRunner {
  /** Every request seen, in arrival order. */
  readonly calls: RunRequest[] = [];
  active = 0;
  maxConcurrent = 0;
  private readonly handler: FakeHandler;

  constructor(handler: FakeHandler | FakeRule[] = () => ({})) {
    this.handler = Array.isArray(handler) ? rulesHandler(handler) : handler;
  }

  /** Number of live (non-cached) agent runs so far. */
  get liveCalls(): number {
    return this.calls.length;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const call = this.calls.length;
    this.calls.push(req);
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let turns = 0;
    try {
      const r = await this.handler(req, call);
      const total = r.turns ?? 1;
      for (let t = 0; t < total; t++) {
        if (req.signal.aborted) return { result: null, status: 'skipped', usage, turns, error: 'aborted' };
        if (r.delayMs) await abortableSleep(r.delayMs, req.signal);
        if (req.signal.aborted) return { result: null, status: 'skipped', usage, turns, error: 'aborted' };
        turns++;
        const turnUsage = {
          input_tokens: r.inputTokensPerTurn ?? 50,
          output_tokens: r.outputTokensPerTurn ?? 100,
        };
        usage.input_tokens += turnUsage.input_tokens;
        usage.output_tokens += turnUsage.output_tokens;
        req.onUsage(turnUsage);
      }
      if (req.signal.aborted) return { result: null, status: 'skipped', usage, turns, error: 'aborted' };
      if (r.effect) await r.effect(req);
      const result =
        typeof r.result === 'function'
          ? (r.result as (q: RunRequest) => unknown)(req)
          : r.result !== undefined
            ? r.result
            : req.schema
              ? stubFromSchema(req.schema, req.prompt)
              : `fake result for: ${req.prompt.slice(0, 60)}`;
      const status: EntryStatus = r.status ?? (result === null ? 'null' : 'ok');
      return {
        result: status === 'ok' ? result : null,
        status,
        usage,
        turns,
        ...(r.error ? { error: r.error } : {}),
        ...(r.raw !== undefined && status !== 'ok' ? { raw: r.raw } : {}),
      };
    } finally {
      this.active--;
    }
  }
}

function rulesHandler(rules: FakeRule[]): FakeHandler {
  return (req, call) => {
    for (const rule of rules) {
      const m = rule.match;
      const hit =
        typeof m === 'string' ? req.prompt.includes(m) : m instanceof RegExp ? m.test(req.prompt) : m(req);
      if (hit) return typeof rule.respond === 'function' ? rule.respond(req, call) : rule.respond;
    }
    return {};
  };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Deterministic minimal instance of a JSON Schema; strings are derived from `seed`. */
export function stubFromSchema(schema: JSONSchema, seed = 'stub'): unknown {
  const s = schema as Record<string, any>;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, JSONSchema>;
      for (const [k, v] of Object.entries(props)) out[k] = stubFromSchema(v, `${seed}.${k}`);
      return out;
    }
    case 'array':
      return s.items ? [stubFromSchema(s.items as JSONSchema, `${seed}[0]`)] : [];
    case 'string':
      return seed;
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 1;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return null;
  }
}
