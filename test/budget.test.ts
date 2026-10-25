// Unit tests for src/budget.ts (spec 3.5, flow steps 3 and 6, the two budget rows of the null/throw table).

import { describe, expect, it } from 'vitest';
import { Budget, type BudgetLease, parseBudgetDirective } from '../src/budget.js';
import { LIMITS, MaestroError } from '../src/types.js';

function expectBudgetThrow(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MaestroError);
    expect((e as MaestroError).code).toBe('budget_exceeded');
    return;
  }
  throw new Error('expected budget_exceeded throw');
}

describe('parseBudgetDirective', () => {
  it('parses suffixed and plain directives', () => {
    expect(parseBudgetDirective('+500k')).toBe(500_000);
    expect(parseBudgetDirective('1.5m')).toBe(1_500_000);
    expect(parseBudgetDirective('20000')).toBe(20_000);
    expect(parseBudgetDirective('+2M')).toBe(2_000_000);
    expect(parseBudgetDirective('  300K ')).toBe(300_000);
    expect(parseBudgetDirective('.5k')).toBe(500);
  });

  it('rejects garbage and non-positive values', () => {
    for (const s of [
      'garbage',
      '',
      '+',
      'k',
      '500kk',
      '5g',
      '-500k',
      '1e5',
      '1,000',
      '500 tokens',
      '0',
      '+0k',
    ]) {
      expect(parseBudgetDirective(s)).toBeNull();
    }
  });
});

describe('Budget entry reservation', () => {
  it('16 simultaneous enter() with total 20k, floor 5k → exactly 4 leases, 12 throw', () => {
    const b = new Budget({ total: 20_000, reserveFloor: 5_000 });
    const leases: BudgetLease[] = [];
    const errors: unknown[] = [];
    for (let i = 0; i < 16; i++) {
      try {
        leases.push(b.enter());
      } catch (e) {
        errors.push(e);
      }
    }
    expect(leases).toHaveLength(4);
    expect(errors).toHaveLength(12);
    for (const e of errors) {
      expect(e).toBeInstanceOf(MaestroError);
      expect((e as MaestroError).code).toBe('budget_exceeded');
    }
    expect(b.inflight()).toBe(4);
  });

  it('a failed enter() does not touch inflight', () => {
    const b = new Budget({ total: 5_000, reserveFloor: 5_000 });
    b.enter();
    expectBudgetThrow(() => b.enter());
    expect(b.inflight()).toBe(1);
  });

  it('released leases free their reservation', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 5_000 });
    const a = b.enter();
    b.enter();
    expectBudgetThrow(() => b.enter());
    a.release(false);
    expect(() => b.enter()).not.toThrow();
  });

  it('spent === total does not abort, but enter() still throws because the reservation does not fit', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 5_000 });
    const lease = b.enter();
    lease.report(10_000);
    expect(b.spent()).toBe(10_000);
    expect(lease.signal.aborted).toBe(false);
    expect(b.remaining()).toBe(0);
    expectBudgetThrow(() => b.enter());
  });
});

describe('Budget turn-level abort', () => {
  it('crossing total aborts the reporter AND every other active lease; further enter() throws', () => {
    const b = new Budget({ total: 20_000, reserveFloor: 5_000 });
    const [l1, l2, l3] = [b.enter(), b.enter(), b.enter()];
    l1.report(15_000);
    expect([l1, l2, l3].some((l) => l.signal.aborted)).toBe(false);
    l2.report(6_000);
    expect(b.spent()).toBe(21_000);
    for (const l of [l1, l2, l3]) {
      expect(l.signal.aborted).toBe(true);
      expect(l.signal.reason).toBeInstanceOf(MaestroError);
      expect((l.signal.reason as MaestroError).code).toBe('budget_exceeded');
    }
    expectBudgetThrow(() => b.enter());
    // Still throws after everyone released (spent > total clause).
    for (const l of [l1, l2, l3]) l.release(false);
    expect(b.inflight()).toBe(0);
    expectBudgetThrow(() => b.enter());
  });

  it('aborts on the report that crosses the line, not before', () => {
    const b = new Budget({ total: 20_000, reserveFloor: 5_000 });
    const lease = b.enter();
    let turn = 0;
    let abortedAtTurn: number | null = null;
    lease.signal.addEventListener('abort', () => {
      abortedAtTurn = turn;
    });
    for (const tokens of [5_000, 5_000, 5_000, 5_000]) {
      turn++;
      lease.report(tokens);
      expect(lease.signal.aborted).toBe(false);
    }
    expect(b.spent()).toBe(20_000);
    turn++;
    lease.report(1);
    expect(lease.signal.aborted).toBe(true);
    expect(abortedAtTurn).toBe(5);
  });

  it('abort is idempotent: a second crossing report does not throw and signals stay aborted', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 500 });
    const lease = b.enter();
    let aborts = 0;
    lease.signal.addEventListener('abort', () => aborts++);
    lease.report(2_000);
    expect(() => lease.report(2_000)).not.toThrow();
    expect(lease.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
    expect(b.spent()).toBe(4_000);
  });

  it('releasing after abort keeps inflight non-negative and does not un-abort', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 500 });
    const lease = b.enter();
    lease.report(1_500);
    lease.release(false);
    lease.release(true);
    expect(b.inflight()).toBe(0);
    expect(lease.signal.aborted).toBe(true);
  });

  it('a lease released before the crossing is not aborted', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 1_000 });
    const done = b.enter();
    done.report(1_000);
    done.release(true);
    const running = b.enter();
    running.report(20_000);
    expect(running.signal.aborted).toBe(true);
    expect(done.signal.aborted).toBe(false);
  });

  it('external report() (main loop shared pool) counts toward spent and can trigger the abort', () => {
    const b = new Budget({ total: 20_000, reserveFloor: 5_000 });
    const lease = b.enter();
    b.report(12_000);
    expect(b.spent()).toBe(12_000);
    expect(lease.signal.aborted).toBe(false);
    lease.report(3_000);
    expect(b.spent()).toBe(15_000);
    b.report(5_001);
    expect(b.spent()).toBe(20_001);
    expect(lease.signal.aborted).toBe(true);
    expectBudgetThrow(() => b.enter());
  });

  it('ignores negative and non-finite token reports', () => {
    const b = new Budget({ total: 1_000 });
    b.report(-500);
    b.report(Number.NaN);
    b.report(Number.POSITIVE_INFINITY);
    expect(b.spent()).toBe(0);
  });
});

describe('Budget reserve()', () => {
  it('is the floor before any completion', () => {
    const b = new Budget({ total: 100_000, reserveFloor: 5_000 });
    expect(b.reserve()).toBe(5_000);
    const l = b.enter();
    l.report(9_000);
    expect(b.reserve()).toBe(5_000); // not completed yet
  });

  it('becomes the moving average of completed leases, never below the floor', () => {
    const b = new Budget({ total: null, reserveFloor: 5_000 });
    const run = (tokens: number[], completed = true) => {
      const l = b.enter();
      for (const t of tokens) l.report(t);
      l.release(completed);
    };
    run([4_000, 4_000]); // 8k
    expect(b.reserve()).toBe(8_000);
    run([12_000]); // mean(8k, 12k) = 10k
    expect(b.reserve()).toBe(10_000);
    run([100], true); // mean ≈ 6.7k
    expect(b.reserve()).toBeCloseTo((8_000 + 12_000 + 100) / 3);
    const low = new Budget({ total: null, reserveFloor: 5_000 });
    const l = low.enter();
    l.report(100);
    l.release(true);
    expect(low.reserve()).toBe(5_000);
  });

  it('uses only the last `window` completed leases', () => {
    const b = new Budget({ total: null, reserveFloor: 1, window: 3 });
    for (const t of [100, 200, 300, 400, 500]) {
      const l = b.enter();
      l.report(t);
      l.release(true);
    }
    expect(b.reserve()).toBe(400); // mean(300, 400, 500)
  });

  it('release(false) does not feed the average', () => {
    const b = new Budget({ total: null, reserveFloor: 1_000 });
    const ok = b.enter();
    ok.report(3_000);
    ok.release(true);
    const skipped = b.enter();
    skipped.report(50_000);
    skipped.release(false);
    expect(b.reserve()).toBe(3_000);
    expect(b.spent()).toBe(53_000);
  });

  it('release is idempotent and inflight never goes negative', () => {
    const b = new Budget({ total: null, reserveFloor: 1_000 });
    const l = b.enter();
    l.report(2_000);
    l.release(true);
    l.release(true);
    l.release(false);
    expect(b.inflight()).toBe(0);
    expect(b.reserve()).toBe(2_000); // pushed once
    const other = b.enter();
    l.release(true);
    expect(b.inflight()).toBe(1);
    other.release(true);
    expect(b.inflight()).toBe(0);
  });

  it('the moving reserve drives the entry check', () => {
    const b = new Budget({ total: 100_000, reserveFloor: 5_000 });
    const l = b.enter();
    l.report(30_000);
    l.release(true);
    // spent 30k, reserve 30k: 30k + 2 × 30k = 90k fits, 30k + 3 × 30k = 120k does not.
    b.enter();
    b.enter();
    expectBudgetThrow(() => b.enter());
  });
});

describe('Budget with total null', () => {
  it('remaining() is Infinity, enter never throws, signals never abort', () => {
    const b = new Budget({ total: null });
    expect(b.total).toBeNull();
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
    const leases: BudgetLease[] = [];
    for (let i = 0; i < 100; i++) leases.push(b.enter());
    for (const l of leases) l.report(1_000_000);
    b.report(1e9);
    expect(b.spent()).toBe(100_000_000 + 1e9);
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(leases.every((l) => !l.signal.aborted)).toBe(true);
    expect(b.overrunCeiling()).toBeNull();
  });
});

describe('Budget view() and onTick()', () => {
  it('view() exposes only total/spent/remaining and reflects live values', () => {
    const b = new Budget({ total: 50_000 });
    const v = b.view();
    expect(Object.keys(v).sort()).toEqual(['remaining', 'spent', 'total']);
    expect(v.total).toBe(50_000);
    expect(v.spent()).toBe(0);
    expect(v.remaining()).toBe(50_000);
    b.report(1_234);
    expect(v.spent()).toBe(1_234);
    expect(v.remaining()).toBe(48_766);
    b.report(100_000);
    expect(v.remaining()).toBe(0);
    expect(Object.isFrozen(v)).toBe(true);
    expect('enter' in v).toBe(false);
  });

  it('onTick fires on every report with {spent,total,remaining}; unsubscribe stops it', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 1_000 });
    const ticks: Array<{ spent: number; total: number | null; remaining: number }> = [];
    const off = b.onTick((s) => ticks.push(s));
    const l = b.enter();
    l.report(4_000);
    b.report(0);
    b.report(3_000);
    l.report(5_000);
    expect(ticks).toEqual([
      { spent: 4_000, total: 10_000, remaining: 6_000 },
      { spent: 4_000, total: 10_000, remaining: 6_000 },
      { spent: 7_000, total: 10_000, remaining: 3_000 },
      { spent: 12_000, total: 10_000, remaining: 0 },
    ]);
    off();
    b.report(1);
    expect(ticks).toHaveLength(4);
  });

  it('tick remaining is Infinity when total is null; a throwing listener does not break reports', () => {
    const b = new Budget({ total: null });
    const seen: number[] = [];
    b.onTick(() => {
      throw new Error('observer bug');
    });
    b.onTick((s) => seen.push(s.remaining));
    expect(() => b.report(10)).not.toThrow();
    expect(seen).toEqual([Number.POSITIVE_INFINITY]);
  });
});

describe('Budget overrunCeiling()', () => {
  it('is total + concurrency × maxTokensPerTurn', () => {
    expect(new Budget({ total: 20_000 }).overrunCeiling()).toBe(20_000 + 16 * 32_000);
    expect(new Budget({ total: 100_000, concurrency: 4, maxTokensPerTurn: 8_000 }).overrunCeiling()).toBe(
      100_000 + 4 * 8_000,
    );
  });
});

describe('Budget default maxTokensPerTurn (spec 3.5 aşım payı)', () => {
  it('is the largest single request of the default runner (its raised stage-2 retry)', () => {
    expect(new Budget({ total: 1_000, concurrency: 2 }).overrunCeiling()).toBe(
      1_000 + 2 * LIMITS.maxTokensPerTurnRaised,
    );
    expect(LIMITS.maxTokensPerTurnRaised).toBe(2 * LIMITS.maxTokensPerTurn);
  });
});
