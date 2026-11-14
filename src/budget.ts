// Output-token budget (spec 3.5): one shared pool for the main loop and every workflow, an entry
// reservation so N parallel agents cannot all slip in at the edge, and per-turn abort of every
// active lease the moment spent crosses total.

import { type BudgetView, LIMITS, MaestroError } from './types.js';

export interface BudgetLease {
  /** Aborted as soon as spent > total while this lease is active. */
  readonly signal: AbortSignal;
  /** Per-turn, immediate: adds to spent; if spent > total aborts ALL active leases. */
  report(outputTokens: number): void;
  /** Idempotent; inflight--; when completed, this lease's output total enters the moving window. */
  release(completed: boolean): void;
}

export interface BudgetTick {
  spent: number;
  total: number | null;
  remaining: number;
}

export interface BudgetOptions {
  total: number | null;
  reserveFloor?: number;
  window?: number;
  concurrency?: number;
  maxTokensPerTurn?: number;
}

const DIRECTIVE = /^\+?(\d+(?:\.\d+)?|\.\d+)([km])?$/i;

/** "+500k" → 500000, "1.5m" → 1500000, "20000" → 20000; anything else (or ≤ 0) → null. */
export function parseBudgetDirective(s: string): number | null {
  const m = DIRECTIVE.exec(s.trim());
  if (!m) return null;
  const suffix = m[2]?.toLowerCase();
  const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  const value = Math.round(Number(m[1]) * mult);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export class Budget implements BudgetView {
  readonly total: number | null;
  private readonly reserveFloor: number;
  private readonly window: number;
  private readonly concurrency: number;
  private readonly maxTokensPerTurn: number;
  private spentTokens = 0;
  private inflightCount = 0;
  private readonly completed: number[] = [];
  private readonly active = new Set<AbortController>();
  private readonly listeners = new Set<(s: BudgetTick) => void>();

  constructor(opts: BudgetOptions) {
    // NaN compares false with everything: such a total would never be exceeded, a silent unlimited run.
    if (opts.total !== null && (typeof opts.total !== 'number' || Number.isNaN(opts.total))) {
      throw new RangeError(`Budget: total must be a number of output tokens or null, got ${opts.total}`);
    }
    this.total = opts.total;
    this.reserveFloor = opts.reserveFloor ?? LIMITS.reserveFloor;
    this.window = Math.max(1, opts.window ?? 20);
    this.concurrency = opts.concurrency ?? LIMITS.maxConcurrency;
    // Default: the largest single request of the default runner (its raised stage-2 retry, spec 3.2).
    this.maxTokensPerTurn = opts.maxTokensPerTurn ?? LIMITS.maxTokensPerTurnRaised;
  }

  spent(): number {
    return this.spentTokens;
  }

  remaining(): number {
    return this.total === null ? Number.POSITIVE_INFINITY : Math.max(0, this.total - this.spentTokens);
  }

  /** max(floor, mean output tokens of the last `window` completed leases); floor when none (spec 3.5). */
  reserve(): number {
    if (this.completed.length === 0) return this.reserveFloor;
    const mean = this.completed.reduce((a, b) => a + b, 0) / this.completed.length;
    return Math.max(this.reserveFloor, mean);
  }

  inflight(): number {
    return this.inflightCount;
  }

  /**
   * Entry reservation (spec 3.5, flow step 3): the entering agent counts itself, so with total 20k and
   * a 5k reserve exactly 4 leases fit. Throws before inflight is touched.
   */
  enter(): BudgetLease {
    if (this.total !== null) {
      const total = this.total;
      if (this.spentTokens > total || this.spentTokens + (this.inflightCount + 1) * this.reserve() > total) {
        throw new MaestroError(
          `budget exceeded: spent ${this.spentTokens} + ${this.inflightCount + 1} × reserve ${this.reserve()} > total ${total}`,
          'budget_exceeded',
        );
      }
    }
    this.inflightCount++;
    const controller = new AbortController();
    this.active.add(controller);
    let leaseTokens = 0;
    let released = false;
    return {
      signal: controller.signal,
      report: (outputTokens: number) => {
        const n = sanitize(outputTokens);
        if (!released) leaseTokens += n;
        this.add(n);
      },
      release: (completed: boolean) => {
        if (released) return;
        released = true;
        this.active.delete(controller);
        this.inflightCount = Math.max(0, this.inflightCount - 1);
        if (completed) {
          this.completed.push(leaseTokens);
          if (this.completed.length > this.window)
            this.completed.splice(0, this.completed.length - this.window);
        }
      },
    };
  }

  /** External spend into the shared pool (main loop); same abort check as a lease report. */
  report(tokens: number): void {
    this.add(sanitize(tokens));
  }

  /** total + concurrency × max_tokens_per_turn (spec 3.5 overrun allowance); null when unbounded. */
  overrunCeiling(): number | null {
    return this.total === null ? null : this.total + this.concurrency * this.maxTokensPerTurn;
  }

  onTick(fn: (s: BudgetTick) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The script-facing view: only total / spent() / remaining(), live. */
  view(): BudgetView {
    return Object.freeze({
      total: this.total,
      spent: () => this.spent(),
      remaining: () => this.remaining(),
    });
  }

  private add(tokens: number): void {
    this.spentTokens += tokens;
    // spec 3.5: strictly spent > total aborts every registered signal; new entries then throw.
    if (this.total !== null && this.spentTokens > this.total) {
      const reason = new MaestroError(
        `budget exceeded: spent ${this.spentTokens} > total ${this.total}`,
        'budget_exceeded',
      );
      for (const c of this.active) if (!c.signal.aborted) c.abort(reason);
    }
    const tick: BudgetTick = { spent: this.spentTokens, total: this.total, remaining: this.remaining() };
    for (const fn of [...this.listeners]) {
      try {
        fn(tick);
      } catch {
        // A broken observer must not break the runner's per-turn usage report.
      }
    }
  }
}

function sanitize(tokens: number): number {
  return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
}
