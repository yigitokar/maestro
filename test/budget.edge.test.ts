// Edge cases and failure modes of src/budget.ts, checked against docs/spec.md (3.5, flow steps 3 and 6,
// the two budget rows of the null/throw table): exact-equality boundaries, abort re-entrancy, lease
// accounting and the script view across realms. The everyday behaviour lives in budget.test.ts.

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Budget, type BudgetLease, type BudgetTick, parseBudgetDirective } from '../src/budget.js';
import { MaestroError } from '../src/types.js';

function expectBudgetExceeded(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MaestroError);
  expect((caught as MaestroError).code).toBe('budget_exceeded');
}

function expectAbortedByBudget(lease: BudgetLease): void {
  expect(lease.signal.aborted).toBe(true);
  expect(lease.signal.reason).toBeInstanceOf(MaestroError);
  expect((lease.signal.reason as MaestroError).code).toBe('budget_exceeded');
}

describe('entry reservation boundaries (flow step 3)', () => {
  it('spent + (inflight+1) × reserve === total is admitted; one token more is refused', () => {
    // 5000 + 3 × 5000 === 20_000: the third lease lands exactly on total and gets in.
    const exact = new Budget({ total: 20_000, reserveFloor: 5_000 });
    exact.enter().report(5_000);
    exact.enter();
    expect(() => exact.enter()).not.toThrow();
    expect(exact.inflight()).toBe(3);
    expectBudgetExceeded(() => exact.enter());
    expect(exact.inflight()).toBe(3);

    // 5001 + 3 × 5000 === 20_001: the same third lease is one token over and stays out.
    const over = new Budget({ total: 20_000, reserveFloor: 5_000 });
    over.enter().report(5_001);
    over.enter();
    expectBudgetExceeded(() => over.enter());
    expect(over.inflight()).toBe(2);
  });

  it('reserveFloor 0: entry is admitted at spent === total and refused once spent > total', () => {
    const b = new Budget({ total: 100, reserveFloor: 0 });
    b.report(100);
    expect(() => b.enter()).not.toThrow(); // spent === total, a zero reservation fits
    expect(b.inflight()).toBe(1);
    b.report(1);
    expectBudgetExceeded(() => b.enter());
    expect(b.inflight()).toBe(1);
  });

  it('reserveFloor 0: after an overrun, entry is refused even once every lease has released', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 0 });
    const l = b.enter();
    l.report(10_001);
    l.release(false);
    expect(b.inflight()).toBe(0);
    expectBudgetExceeded(() => b.enter());
  });

  it('total 0 admits nobody with a positive floor', () => {
    const b = new Budget({ total: 0 });
    expectBudgetExceeded(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('a total one token under the floor refuses the first enter() and leaves inflight at 0', () => {
    const b = new Budget({ total: 4_999 });
    expectBudgetExceeded(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('with 1k left, none of 16 entering agents is admitted', () => {
    const b = new Budget({ total: 20_000 });
    b.report(19_000);
    for (let i = 0; i < 16; i++) expectBudgetExceeded(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('16 agents, 20k, default floor: 4 enter and 12 are refused; 5k each lands on total without abort, then nobody enters', () => {
    const b = new Budget({ total: 20_000 });
    const leases: BudgetLease[] = [];
    let refused = 0;
    for (let i = 0; i < 16; i++) {
      try {
        leases.push(b.enter());
      } catch (e) {
        expect((e as MaestroError).code).toBe('budget_exceeded');
        refused++;
      }
    }
    expect(leases).toHaveLength(4);
    expect(refused).toBe(12);
    expect(b.inflight()).toBe(4);
    for (const l of leases) l.report(5_000);
    expect(b.spent()).toBe(20_000);
    for (const l of leases) expect(l.signal.aborted).toBe(false);
    for (const l of leases) l.release(true);
    expectBudgetExceeded(() => b.enter());
    expect(b.inflight()).toBe(0);
  });

  it('16 sequential agents of 5k each: exactly 4 enter, the other 12 are refused with budget_exceeded', () => {
    const b = new Budget({ total: 20_000 });
    let entered = 0;
    let refused = 0;
    for (let i = 0; i < 16; i++) {
      let lease: BudgetLease;
      try {
        lease = b.enter();
      } catch (e) {
        expect(e).toBeInstanceOf(MaestroError);
        expect((e as MaestroError).code).toBe('budget_exceeded');
        refused++;
        continue;
      }
      entered++;
      lease.report(5_000);
      lease.release(true);
    }
    expect(entered).toBe(4);
    expect(refused).toBe(12);
    expect(b.spent()).toBe(20_000);
  });

  it('a lease released as completed frees its reservation for the next entrant', () => {
    const b = new Budget({ total: 10_000 });
    const a = b.enter();
    const c = b.enter();
    expectBudgetExceeded(() => b.enter());
    a.release(true);
    c.release(false);
    expect(() => b.enter()).not.toThrow();
  });
});

describe('per-turn abort and re-entrancy (flow step 6)', () => {
  it('spent === total never aborts; one token more aborts every active lease with a budget_exceeded reason', () => {
    const b = new Budget({ total: 10_000, reserveFloor: 1 });
    const a = b.enter();
    const c = b.enter();
    const idle = b.enter();
    a.report(5_000);
    c.report(5_000);
    expect(b.spent()).toBe(10_000);
    for (const l of [a, c, idle]) expect(l.signal.aborted).toBe(false);
    expect(b.remaining()).toBe(0);
    a.report(1);
    for (const l of [a, c, idle]) expectAbortedByBudget(l);
    expect(b.remaining()).toBe(0);
  });

  it('an abort listener that reports and releases its own lease does not make the loop skip other leases', () => {
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

  it('abort listeners that report and release every lease mid-loop still see every lease aborted', () => {
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

  it('enter() from inside an abort listener throws budget_exceeded and does not leak inflight', () => {
    const b = new Budget({ total: 1_000, reserveFloor: 1 });
    const l = b.enter();
    let code: string | undefined;
    l.signal.addEventListener('abort', () => {
      try {
        b.enter();
        code = 'admitted';
      } catch (e) {
        code = e instanceof MaestroError ? e.code : `foreign:${String(e)}`;
      }
    });
    l.report(2_000);
    expect(code).toBe('budget_exceeded');
    expect(b.inflight()).toBe(1);
    l.release(false);
    expect(b.inflight()).toBe(0);
  });

  it('a late report from a released lease counts as spend and aborts live leases, but not its own signal or the window', () => {
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

  it('a throwing tick listener prevents neither the abort nor the other listeners', () => {
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

describe('reserve window and lease accounting', () => {
  it('reserve: floor first, then max(floor, mean of the last `window` completed leases only)', () => {
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

  it('500 rounds of enter and triple release leave inflight at 0 and the reserve at the floor', () => {
    const b = new Budget({ total: 1_000_000 });
    for (let i = 0; i < 500; i++) {
      const l = b.enter();
      l.release(i % 2 === 0);
      l.release(true);
      l.release(false);
    }
    expect(b.inflight()).toBe(0);
    // Every completed lease reported 0 tokens, so the mean stays under the default floor.
    expect(b.reserve()).toBe(5_000);
  });
});

describe('script view', () => {
  it('is frozen and live, and its methods work when detached from the object', () => {
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

  it('a vm-context script reads live values and cannot overwrite total', () => {
    const b = new Budget({ total: 50_000 });
    const ctx = vm.createContext({ budget: b.view() });
    b.report(1_234);
    const out = vm.runInContext(
      `(() => { try { budget.total = 1; } catch {} return [budget.total, budget.spent(), budget.remaining(), Object.keys(budget).sort().join(',')]; })()`,
      ctx,
    );
    expect(Array.from(out as unknown[])).toEqual([50_000, 1_234, 48_766, 'remaining,spent,total']);
  });

  it('an unbounded view in a vm context reports null total and Infinity remaining', () => {
    const b = new Budget({ total: null });
    const ctx = vm.createContext({ budget: b.view() });
    expect(vm.runInContext('budget.total === null && budget.remaining() === Infinity', ctx)).toBe(true);
  });
});

describe('parseBudgetDirective boundaries', () => {
  it('accepts upper-case suffixes with a sign; rejects zero, sub-token, overflow and unknown-suffix values', () => {
    expect(parseBudgetDirective('+300K')).toBe(300_000);
    expect(parseBudgetDirective('+1.5M')).toBe(1_500_000);
    for (const s of ['abc', '-5k', '0k', '5x', '+0.0001k', '9'.repeat(400)]) {
      expect(parseBudgetDirective(s)).toBeNull();
    }
  });
});
