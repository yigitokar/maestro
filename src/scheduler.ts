// Scheduler (spec 3.4): FIFO semaphore around the live runner call, lifetime agent cap and the
// per-call item limit for parallel()/pipeline(). Nested workflows share one instance, so they share
// the same slots and the same agent counter; the scheduler itself knows nothing about workflows.
import { availableParallelism } from 'node:os';
import { LIMITS, MaestroError } from './types.js';

/** Semaphore size: max(1, min(16, cpus - 2)) (spec 3.4). */
export function defaultConcurrency(cpus: number = availableParallelism()): number {
  return Math.max(1, Math.min(LIMITS.maxConcurrency, cpus - 2));
}

interface Waiter {
  grant(): void;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`Scheduler: ${name} must be a positive integer, got ${value}`);
  }
}

export class Scheduler {
  readonly concurrency: number;
  readonly maxAgents: number;
  private admittedCount = 0;
  private activeCount = 0;
  private peak = 0;
  private readonly waiters: Waiter[] = [];

  constructor(opts: { concurrency?: number; maxAgents?: number } = {}) {
    this.concurrency = opts.concurrency ?? defaultConcurrency();
    this.maxAgents = opts.maxAgents ?? LIMITS.defaultMaxAgents;
    assertPositiveInt('concurrency', this.concurrency);
    assertPositiveInt('maxAgents', this.maxAgents);
  }

  /** Counts one live agent against the lifetime cap; returns its 0-based ordinal (spec 3.4, flow step 3). */
  admit(): number {
    if (this.admittedCount >= this.maxAgents) {
      throw new MaestroError(
        `agent cap reached: ${this.maxAgents} agents already admitted in this run`,
        'agent_cap',
      );
    }
    return this.admittedCount++;
  }

  admitted(): number {
    return this.admittedCount;
  }

  active(): number {
    return this.activeCount;
  }

  queued(): number {
    return this.waiters.length;
  }

  peakActive(): number {
    return this.peak;
  }

  /** A single parallel()/pipeline() call may carry at most 4096 items; overflow is an explicit error. */
  checkItems(count: number, where: 'parallel' | 'pipeline'): void {
    if (count > LIMITS.maxItemsPerCall) {
      throw new MaestroError(
        `${where}() got ${count} items; the limit per call is ${LIMITS.maxItemsPerCall}`,
        'item_limit',
      );
    }
  }

  /**
   * Runs fn while holding one slot. Only the live runner call goes through here (spec 3.4: scripts,
   * parallel/pipeline waits and workflow() never hold a slot). If fn has not started when the signal
   * aborts, the call rejects with an AbortError and never takes (or keeps) a slot. Aborting a running fn
   * is fn's business (it sees the same signal); the slot is released when fn settles.
   */
  async withSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();
    await this.acquire(signal);
    try {
      // Granted, but aborted before fn could start: give the slot back unused.
      if (signal?.aborted) throw abortError();
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.activeCount < this.concurrency) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(abortError());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private take(): void {
    this.activeCount++;
    if (this.activeCount > this.peak) this.peak = this.activeCount;
  }

  // Direct hand-off to the queue head keeps grants strictly FIFO: a newcomer only finds a free slot
  // when nobody is waiting.
  private release(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.activeCount--;
  }
}
