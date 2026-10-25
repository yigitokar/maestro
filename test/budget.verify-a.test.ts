// Adversarial spec-contract regression suite for src/budget.ts (spec 3.5, flow steps 3 and 6,
// the two budget rows of the null/throw table).

import { describe, expect, it } from 'vitest';
import { Budget, type BudgetLease, type BudgetTick, parseBudgetDirective } from '../src/budget.js';
import { MaestroError } from '../src/types.js';

function budgetThrow(fn: () => unknown): MaestroError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MaestroError);
    expect((e as MaestroError).code).toBe('budget_exceeded');
    return e as MaestroError;
  }
  throw new Error('expected budget_exceeded throw');
}

describe('spec 3.5 test: 16 agents, budget 20k, 5k each', () => {
  it('exactly 4 enter, 12 throw budget_exceeded, inflight stays 4', () => {
    const b = new Budget({ total: 20_000 });
    const leases: BudgetLease[] = [];
    let thrown = 0;
    for (let i = 0; i < 16; i++) {
      try {
        leases.push(b.enter());
      } catch (e) {
        expect((e as MaestroError).code).toBe('budget_exceeded');
        thrown++;
      }
    }
    expect(leases).toHaveLength(4);
    expect(thrown).toBe(12);
    expect(b.inflight()).toBe(4);
  });

  it('the 4 leases each spending 5k land exactly on total: no abort, but no further entry', () => {
    const b = new Budget({ total: 20_000 });
    const leases = [b.enter(), b.enter(), b.enter(), b.enter()];
    for (const l of leases) l.report(5_000);
    expect(b.spent()).toBe(20_000);
    for (const l of leases) expect(l.signal.aborted).toBe(false);
    for (const l of leases) l.release(true);
    budgetThrow(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('sequential agents of 5k each: at most 4 total ever enter', () => {
    const b = new Budget({ total: 20_000 });
    let entered = 0;
    for (let i = 0; i < 16; i++) {
      try {
        const l = b.enter();
        entered++;
        l.report(5_000);
        l.release(true);
      } catch {
        // budget_exceeded
      }
    }
    expect(entered).toBe(4);
  });
});

describe('per-turn abort (flow step 6, null/throw row "bütçe ajan koşarken aşıldı")', () => {
  it('crossing total by one token aborts ALL active leases with budget_exceeded reason', () => {
    const b = new Budget({ total: 20_000 });
    const leases = [b.enter(), b.enter(), b.enter()];
    leases[0]?.report(10_000);
    leases[1]?.report(10_000);
    for (const l of leases) expect(l.signal.aborted).toBe(false);
    leases[2]?.report(1);
    for (const l of leases) {
      expect(l.signal.aborted).toBe(true);
      expect(l.signal.reason).toBeInstanceOf(MaestroError);
      expect((l.signal.reason as MaestroError).code).toBe('budget_exceeded');
    }
  });

  it('after the overrun, new entries throw even once every lease has released', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 0 });
    const l = b.enter();
    l.report(10_001);
    l.release(false);
    expect(b.inflight()).toBe(0);
    budgetThrow(() => b.enter());
  });

  it('released leases are not aborted later; still-active ones are', () => {
    const b = new Budget({ total: 20_000 });
    const done = b.enter();
    const live = b.enter();
    done.report(1_000);
    done.release(true);
    live.report(19_500);
    expect(done.signal.aborted).toBe(false);
    expect(live.signal.aborted).toBe(true);
  });

  it('external spend (main loop) shares the pool and triggers the same abort', () => {
    const b = new Budget({ total: 20_000 });
    const l = b.enter();
    b.report(15_000);
    expect(l.signal.aborted).toBe(false);
    b.report(5_001);
    expect(l.signal.aborted).toBe(true);
    expect(b.spent()).toBe(20_001);
    expect(b.remaining()).toBe(0);
  });

  it('abort listener that reports/releases re-entrantly does not skip other leases', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 1_000 });
    const a = b.enter();
    const c = b.enter();
    const d = b.enter();
    a.signal.addEventListener('abort', () => {
      a.report(500);
      a.release(false);
    });
    c.report(10_001);
    expect(a.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(d.signal.aborted).toBe(true);
    expect(b.spent()).toBe(10_501);
    expect(b.inflight()).toBe(2);
  });

  it('a throwing tick listener does not prevent abort or other listeners', () => {
    const b = new Budget({ total: 100, reserveFloor: 10 });
    const l = b.enter();
    const seen: BudgetTick[] = [];
    b.onTick(() => {
      throw new Error('boom');
    });
    const off = b.onTick((t) => seen.push(t));
    l.report(101);
    expect(l.signal.aborted).toBe(true);
    expect(seen).toEqual([{ spent: 101, total: 100, remaining: 0 }]);
    off();
    l.report(1);
    expect(seen).toHaveLength(1);
  });
});

describe('entry reservation details (flow step 3)', () => {
  it('a throwing enter() does not touch inflight', () => {
    const b = new Budget({ total: 4_999 });
    budgetThrow(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('16 agents entering with 1k left cannot slip in', () => {
    const b = new Budget({ total: 20_000 });
    b.report(19_000);
    for (let i = 0; i < 16; i++) budgetThrow(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('reserve: floor first, then max(floor, mean of last `window` completed leases only)', () => {
    const b = new Budget({ total: null, reserveFloor: 5_000, window: 3 });
    expect(b.reserve()).toBe(5_000);
    const failed = b.enter();
    failed.report(100_000);
    failed.release(false);
    expect(b.reserve()).toBe(5_000);
    for (const n of [9_000, 12_000, 3_000, 6_000]) {
      const l = b.enter();
      l.report(n);
      l.release(true);
    }
    // window of 3 drops the 9k: mean(12k, 3k, 6k) = 7k
    expect(b.reserve()).toBe(7_000);
    for (const n of [1_000, 1_000, 1_000]) {
      const l = b.enter();
      l.report(n);
      l.release(true);
    }
    expect(b.reserve()).toBe(5_000);
  });

  it('a larger moving average tightens entry', () => {
    const b = new Budget({ total: 100_000, reserveFloor: 5_000 });
    const l = b.enter();
    l.report(40_000);
    l.release(true);
    // spent 40k + 1 × reserve 40k = 80k ≤ 100k → ok; second: 40k + 2 × 40k = 120k > 100k → throw
    const ok = b.enter();
    budgetThrow(() => b.enter());
    expect(b.inflight()).toBe(1);
    ok.release(false);
  });

  it('release is idempotent and the first completed flag wins', () => {
    const b = new Budget({ total: null, reserveFloor: 0 });
    const l = b.enter();
    l.report(8_000);
    l.release(false);
    l.release(true);
    l.release(true);
    expect(b.inflight()).toBe(0);
    expect(b.reserve()).toBe(0);
  });

  it('report after release still spends from the pool but does not alter the window', () => {
    const b = new Budget({ total: null, reserveFloor: 0 });
    const l = b.enter();
    l.report(2_000);
    l.release(true);
    l.report(50_000);
    expect(b.spent()).toBe(52_000);
    expect(b.reserve()).toBe(2_000);
  });
});

describe('unbounded budget (total null)', () => {
  it('remaining Infinity, never throws, never aborts, no overrun ceiling', () => {
    const b = new Budget({ total: null });
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
    const leases: BudgetLease[] = [];
    for (let i = 0; i < 100; i++) leases.push(b.enter());
    b.report(1e12);
    for (const l of leases) expect(l.signal.aborted).toBe(false);
    expect(b.overrunCeiling()).toBeNull();
    expect(b.inflight()).toBe(100);
  });
});

describe('overrun allowance and script view', () => {
  it('overrun ceiling defaults to total + 16 × 32000', () => {
    expect(new Budget({ total: 500_000 }).overrunCeiling()).toBe(500_000 + 16 * 32_000);
  });

  it('view is frozen, live and works detached', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 1 });
    const v = b.view();
    const { spent, remaining } = v;
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.keys(v).sort()).toEqual(['remaining', 'spent', 'total']);
    b.report(300);
    expect(spent()).toBe(300);
    expect(remaining()).toBe(700);
    expect(v.total).toBe(1_000);
    b.report(5_000);
    expect(remaining()).toBe(0);
  });
});

describe('parseBudgetDirective', () => {
  it('parses the spec directive forms', () => {
    expect(parseBudgetDirective('+500k')).toBe(500_000);
    expect(parseBudgetDirective('1.5m')).toBe(1_500_000);
    expect(parseBudgetDirective('20000')).toBe(20_000);
    expect(parseBudgetDirective('+300K')).toBe(300_000);
  });

  it('rejects non-directives', () => {
    for (const s of ['', 'abc', '-5k', '0k', 'k', '5x']) expect(parseBudgetDirective(s)).toBeNull();
  });
});
