// <runDir>/events.jsonl: every WorkflowEvent of a run with the wall-clock time it happened, plus a few
// file-only lines (run_start, agent_prompt, run_end). The journal stays the source of truth for results
// and resume; this file only answers "when" and "what was asked", for `maestro viz`. It is audit-only:
// a write failure is reported once and never fails the run. Each start or resume appends, so one file
// can hold several attempts, each opened by its own run_start line.

import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowEvent } from './types.js';

export const EVENT_LOG_FILE = 'events.jsonl';

/** Prompts are cut to this many characters in the log; the full prompt is never needed for a view. */
export const EVENT_LOG_PROMPT_CHARS = 4_000;

/** Lines that exist only in the file (the event emitter never sends them). */
export type EventLogExtra =
  | {
      type: 'run_start';
      resume: boolean;
      name: string;
      description: string;
      phases: string[];
      runner: string;
      model: string;
      concurrency: number;
      budget: number | null;
    }
  | {
      type: 'agent_prompt';
      id: number;
      prompt: string;
      /** True when the prompt was longer than EVENT_LOG_PROMPT_CHARS. */
      truncated?: true;
      model?: string;
      effort?: string;
      isolation?: 'worktree';
      tools: string[];
      schema: boolean;
    }
  /** The agent got a concurrency slot and its runner call starts; agent_start → here is queue time. */
  | { type: 'agent_running'; id: number }
  | { type: 'run_end'; ok: boolean; error?: string };

/** WorkflowEvents lose their runId in the file: the file belongs to one run. */
type Stripped<E> = E extends { runId: string } ? Omit<E, 'runId'> : E;

/** One line of events.jsonl. `t` is milliseconds since the epoch. */
export type EventLogLine = { t: number } & (Stripped<WorkflowEvent> | EventLogExtra);

export class EventLog {
  private fh: FileHandle | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Lines recorded before open(): the first events of a run come before its directory exists. */
  private pending: string[] = [];
  private closed = false;
  private failed = false;

  constructor(
    private readonly onError: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Opens (appends to) <runDir>/events.jsonl. `first` (the run_start line) is written before what was
   * recorded so far, so every attempt in the file begins with its own run_start.
   */
  async open(runDir: string, first?: { line: EventLogExtra; t?: number }): Promise<void> {
    if (this.closed || this.fh) return;
    try {
      this.fh = await open(join(runDir, EVENT_LOG_FILE), 'a');
    } catch (err) {
      this.fail(err);
      return;
    }
    const lines = this.pending.splice(0);
    if (first) lines.unshift(this.format(first.line, first.t));
    if (lines.length > 0) this.enqueue(lines.join(''));
  }

  record(line: Stripped<WorkflowEvent> | WorkflowEvent | EventLogExtra): void {
    if (this.closed || this.failed) return;
    const text = this.format(line);
    if (this.fh) this.enqueue(text);
    else this.pending.push(text);
  }

  private format(line: Stripped<WorkflowEvent> | WorkflowEvent | EventLogExtra, t = this.now()): string {
    const { runId: _runId, ...rest } = line as { runId?: string };
    return `${JSON.stringify({ t, ...rest })}\n`;
  }

  /** Flushes and closes. Lines recorded afterwards are dropped. */
  async close(): Promise<void> {
    if (this.closed) return this.chain;
    this.closed = true;
    this.pending = [];
    const fh = this.fh;
    this.fh = null;
    this.chain = this.chain.then(async () => {
      await fh?.close().catch(() => {});
    });
    return this.chain;
  }

  private enqueue(text: string): void {
    const fh = this.fh;
    if (!fh) return;
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        await fh.write(text);
      } catch (err) {
        this.fail(err);
      }
    });
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.onError(`event log disabled: ${message}`);
    } catch {
      // Reporting must not break the run either.
    }
  }
}
