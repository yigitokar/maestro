// Adversarial edge-case regression suite for src/budget.ts (spec 3.5, flow steps 3 and 6, the two budget
// rows of the null/throw table): exact-equality boundaries, abort re-entrancy, lease leaks, cross-realm use.

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Budget, type BudgetLease, parseBudgetDirective } from '../src/budget.js';
import { MaestroError } from '../src/types.js';

function budgetCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof MaestroError ? e.code : `foreign:${String(e)}`;
  }
  return undefined;
}

describe('numeric boundaries (strict > everywhere)', () => {
  it('spent + (inflight+1) × reserve === total is admitted; one token more is not', () => {
    const b = new Budget({ total: 20_000, reserveFloor: 5_000 });
    const l = b.enter();
    l.report(4_999);
    // 4999 + 3 × 5000 = 19_999 → fits; then 4999 + 4 × 5000 > total → no.
    b.enter();
    b.enter();
    expect(budgetCode(() => b.enter())).toBe('budget_exceeded');
    expect(b.inflight()).toBe(3);
  });

  it('spent === total exactly never aborts; total + 1 aborts every active lease', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 1 });
    const a = b.enter();
    const c = b.enter();
    a.report(5_000);
    c.report(5_000);
    expect(b.spent()).toBe(10_000);
    expect(a.signal.aborted).toBe(false);
    expect(c.signal.aborted).toBe(false);
    expect(b.remaining()).toBe(0);
    a.report(1);
    expect(a.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(b.remaining()).toBe(0);
  });

  it('reserveFloor 0 still refuses entry once spent > total (explicit spent check)', () => {
    const b = new Budget({ total: 100, reserveFloor: 0 });
    b.report(100);
    expect(b.enter()).toBeDefined(); // spent === total, reservation 0 fits
    b.report(1);
    expect(budgetCode(() => b.enter())).toBe('budget_exceeded');
  });

  it('total 0 admits nobody with a positive floor', () => {
    const b = new Budget({ total: 0 });
    expect(budgetCode(() => b.enter())).toBe('budget_exceeded');
    expect(b.inflight()).toBe(0);
  });

  it('spec 3.5 test case: 16 agents, 20k, each reports 5k → 4 in, 12 throw, no overrun beyond total', () => {
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
    for (const l of leases) l.report(5_000);
    expect(b.spent()).toBe(20_000);
    expect(leases.every((l) => !l.signal.aborted)).toBe(true);
  });

  it('mid-turn overrun aborts on that report with a budget_exceeded reason', () => {
    const b = new Budget({ total: 20_000 });
    const l = b.enter();
    l.report(19_000);
    expect(l.signal.aborted).toBe(false);
    l.report(2_000);
    expect(l.signal.aborted).toBe(true);
    expect(l.signal.reason).toBeInstanceOf(MaestroError);
    expect((l.signal.reason as MaestroError).code).toBe('budget_exceeded');
  });
});

describe('abort path re-entrancy and resource accounting', () => {
  it('abort listeners that release (or report on) leases mid-loop still abort every lease', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 1 });
    const leases = Array.from({ length: 5 }, () => b.enter());
    for (const l of leases) {
      l.signal.addEventListener('abort', () => {
        l.report(10); // a runner flushing its last turn synchronously
        l.release(false);
        for (const other of leases) other.release(false);
      });
    }
    const first = leases[0];
    if (!first) throw new Error('expected a lease');
    first.report(1_001);
    expect(leases.every((l) => l.signal.aborted)).toBe(true);
    expect(b.inflight()).toBe(0);
    expect(b.spent()).toBe(1_001 + 5 * 10);
  });

  it('enter() from inside an abort listener throws and does not leak inflight', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 1 });
    const l = b.enter();
    let code: string | undefined;
    l.signal.addEventListener('abort', () => {
      code = budgetCode(() => b.enter());
    });
    l.report(2_000);
    expect(code).toBe('budget_exceeded');
    expect(b.inflight()).toBe(1);
    l.release(false);
    expect(b.inflight()).toBe(0);
  });

  it('a lease released before the crossing keeps an un-aborted signal; late reports still count as spent', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 1, window: 5 });
    const early = b.enter();
    early.report(100);
    early.release(true);
    const live = b.enter();
    early.report(950); // late usage from a released lease is still real spend
    expect(b.spent()).toBe(1_050);
    expect(live.signal.aborted).toBe(true);
    expect(early.signal.aborted).toBe(false);
    // Late tokens do not enter the moving window: reserve = max(1, 100).
    expect(b.reserve()).toBe(100);
  });

  it('enter/release churn never drifts inflight (no slot leak, no negative)', () => {
    const b = new Budget({ total: 1_000_000 });
    for (let i = 0; i < 500; i++) {
      const l = b.enter();
      l.release(i % 2 === 0);
      l.release(true);
      l.release(false);
    }
    expect(b.inflight()).toBe(0);
    // Window capped at the default 20: every completed lease reported 0 → floor.
    expect(b.reserve()).toBe(5_000);
  });

  it('released (completed) lease frees its reservation immediately for the next entrant', () => {
    const b = new Budget({ total: 10_000 });
    const a = b.enter();
    const c = b.enter();
    expect(budgetCode(() => b.enter())).toBe('budget_exceeded');
    a.release(true);
    c.release(false);
    expect(() => b.enter()).not.toThrow();
  });

  it('unbounded budget: huge spend never aborts and remaining stays Infinity', () => {
    const b = new Budget({ total: null });
    const l = b.enter();
    l.report(Number.MAX_SAFE_INTEGER);
    expect(l.signal.aborted).toBe(false);
    expect(b.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(b.overrunCeiling()).toBeNull();
  });
});

describe('cross-realm and script view', () => {
  it('a vm-context script reads the live view; total/spent/remaining are frozen and correct', () => {
    const b = new Budget({ total: 50_000 });
    const ctx = vm.createContext({ budget: b.view() });
    b.report(1_234);
    const out = vm.runInContext(
      `(() => { try { budget.total = 1; } catch {} return [budget.total, budget.spent(), budget.remaining(), Object.keys(budget).sort().join(',')]; })()`,
      ctx,
    );
    expect(Array.from(out as unknown[])).toEqual([50_000, 1_234, 48_766, 'remaining,spent,total']);
  });

  it('unbounded view in a vm context reports null total and Infinity remaining', () => {
    const b = new Budget({ total: null });
    const ctx = vm.createContext({ budget: b.view() });
    expect(vm.runInContext('budget.total === null && budget.remaining() === Infinity', ctx)).toBe(true);
  });
});

describe('parseBudgetDirective boundaries', () => {
  it('handles the spec directive forms and rejects zero / overflow', () => {
    expect(parseBudgetDirective('+500k')).toBe(500_000);
    expect(parseBudgetDirective('+1.5M')).toBe(1_500_000);
    expect(parseBudgetDirective('9'.repeat(400))).toBeNull();
    expect(parseBudgetDirective('+0.0001k')).toBeNull();
  });
});
