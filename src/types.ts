// Shared contracts between components. Every component imports its cross-component
// types from here so the parallel implementations line up. See docs/spec.md, Levels 1 and 3.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A JSON Schema object as written by script authors (plain data, no zod). */
export type JSONSchema = { [key: string]: unknown };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** Journal status. Only 'ok' is a cache hit (spec 3.1). */
export type EntryStatus = 'ok' | 'null' | 'skipped';

/** One journal row (spec 3.1). Extra fields are audit-only and never affect the key. */
export interface Entry {
  index: number;
  hash: string;
  n: number;
  key: string;
  label?: string;
  phase?: string;
  /** Inline result, or `{ blob: key }` when `blob` is true (result > 64 KB lives in blobs/<key>.json). */
  result: unknown | null;
  /** True when `result` is a `{ blob: key }` reference (disambiguates from a real `{ blob }` result). */
  blob?: true;
  usage: Usage;
  status: EntryStatus;
  /** Raw final text when schema parsing failed twice (spec 3.2). */
  raw?: string;
  /** Error message / reason for a null or skipped row, for audit. */
  error?: string;
  /** Dirty worktree left behind by a writer (spec 3.6), for audit and `maestro gc`. */
  worktree?: { path: string; diffStat: string };
}

/** Options accepted by the script-facing `agent()` (spec Level 1). */
export interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: JSONSchema;
  model?: string;
  effort?: Effort;
  isolation?: 'worktree';
  tools?: string[];
}

/** Context handed to a tool implementation. */
export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

/**
 * A runner-side tool. `inputSchema` must be strict: root `type: 'object'`,
 * `additionalProperties: false` on every object, `required` listing every property.
 * Throwing from `run` produces a `tool_result` with `is_error: true`; the agent continues.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  /** True for tools that can mutate the working tree (write_file, edit_file, shell, git_commit). */
  write: boolean;
  run(input: any, ctx: ToolContext): Promise<string>;
}

export interface RunRequest {
  prompt: string;
  /** Return contract + project CLAUDE.md (+ commit instruction for writers). */
  system: string;
  tools: ToolDef[];
  schema?: JSONSchema;
  model: string;
  effort?: Effort;
  /** Worktree path when isolated, otherwise the run's cwd. */
  cwd: string;
  signal: AbortSignal;
  /** True when the agent runs in an isolation worktree; write tools are only legal then. */
  isolated: boolean;
  /** Called after EVERY model turn with that turn's usage, immediately (spec 3.2 invariant). */
  onUsage(usage: Usage): void;
  /** Diagnostic log line ("turn cap", refusal category, 400 text, ...). */
  log(message: string): void;
}

export interface RunResult {
  /** Validated object when schema given, final text otherwise; null on failure. */
  result: unknown | null;
  status: EntryStatus;
  usage: Usage;
  turns: number;
  raw?: string;
  error?: string;
}

/** Spec 3.2. Implementations: AnthropicRunner (src/runner.ts), FakeRunner (src/testing/fake-runner.ts). */
export interface AgentRunner {
  run(req: RunRequest): Promise<RunResult>;
}

/** The script-facing budget view (spec Level 1). */
export interface BudgetView {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; detail?: string }>;
  maxAgents?: number;
  whenToUse?: string;
}

/** Observability events (spec 3.7). */
export type WorkflowEvent =
  | {
      type: 'agent_start';
      runId: string;
      id: number;
      key: string;
      label?: string;
      phase?: string;
      /** Name of the nested workflow this agent belongs to ("▸ name" group). */
      group?: string;
    }
  | {
      type: 'agent_end';
      runId: string;
      id: number;
      key: string;
      label?: string;
      phase?: string;
      group?: string;
      status: EntryStatus;
      cached: boolean;
      usage: Usage;
    }
  | { type: 'phase'; runId: string; title: string; group?: string }
  | { type: 'log'; runId: string; message: string; group?: string }
  | { type: 'budget_tick'; runId: string; spent: number; total: number | null; remaining: number };

/** Hard limits from the spec. */
export const LIMITS = {
  /** Lifetime agent cap when meta.maxAgents is absent (spec 3.4). */
  defaultMaxAgents: 1000,
  /** Items per single parallel()/pipeline() call (spec 3.4). */
  maxItemsPerCall: 4096,
  /** Upper bound on the semaphore size; actual = min(16, cpus - 2), at least 1. */
  maxConcurrency: 16,
  /** Default model-turn cap for the tool loop (spec 3.2). */
  maxTurns: 40,
  /** Results above this many bytes go to blobs/ (spec 3.1). */
  blobThresholdBytes: 64 * 1024,
  /** Floor for the budget entry reservation (spec 3.5). */
  reserveFloor: 5000,
} as const;

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Script-level errors (thrown into the script; never silently null). */
export class MaestroError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'schema_invalid'
      | 'budget_exceeded'
      | 'agent_cap'
      | 'item_limit'
      | 'write_tool_without_isolation'
      | 'unknown_tool'
      | 'unknown_phase'
      | 'meta_invalid'
      | 'determinism'
      | 'nested_workflow'
      | 'run_stopped'
      | 'journal_unwritable'
      | 'duplicate_writer_branch',
  ) {
    super(message);
    this.name = 'MaestroError';
  }
}
