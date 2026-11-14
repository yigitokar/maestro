// Edge cases and failure modes of src/scheduler.ts, checked against docs/spec.md (3.4, flow steps 3 and 5,
// the agent-cap row of the null/throw table): races at the slot hand-off, abort paths, listener and slot
// leaks, numeric boundaries. The everyday behaviour lives in scheduler.test.ts.
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { defaultConcurrency, Scheduler } from '../src/scheduler.js';
import { LIMITS, MaestroError } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Outcome of p as a value. A hang is not an outcome: the timeout is rethrown and fails the test. */
async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await withTimeout(p) };
  } catch (error) {
    if (error instanceof TimeoutError) throw error;
    return { ok: false, error };
  }
}

function expectAbortError(r: Settled<unknown>): void {
  expect(r.ok).toBe(false);
  expect((r as { error?: { name?: unknown } }).error?.name).toBe('AbortError');
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MaestroError);
  expect((caught as MaestroError).code).toBe(code);
}

describe('semaphore size', () => {
  it('defaultConcurrency follows max(1, min(16, cpus - 2)) at the boundaries', () => {
    expect(defaultConcurrency(0)).toBe(1);
    expect(defaultConcurrency(3)).toBe(1);
    expect(defaultConcurrency(17)).toBe(15);
    expect(defaultConcurrency(18)).toBe(16);
    expect(defaultConcurrency(1024)).toBe(16);
  });

  it('defaultConcurrency stays within 1..16 for every cpu count from 0 to 256', () => {
    for (let n = 0; n <= 256; n++) {
      const c = defaultConcurrency(n);
      expect(c).toBeGreaterThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(LIMITS.maxConcurrency);
    }
  });

  it('an injected concurrency is the exact live-slot bound', async () => {
    const s = new Scheduler({ concurrency: 3 });
    expect(s.concurrency).toBe(3);
    const gate = deferred();
    const running = Array.from({ length: 10 }, () => s.withSlot(() => gate.promise));
    await tick();
    expect(s.active()).toBe(3);
    expect(s.queued()).toBe(7);
    gate.resolve();
    await Promise.all(running);
    expect(s.peakActive()).toBe(3);
    expect(s.active()).toBe(0);
  });

  it('rejects zero, negative, fractional and NaN concurrency or maxAgents with a RangeError', () => {
    expect(() => new Scheduler({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: 1.5 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: Number.NaN })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: 1, maxAgents: 0 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: 1, maxAgents: -3 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: -1 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: 1, maxAgents: 2.5 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: 1, maxAgents: Number.NaN })).toThrow(RangeError);
  });
});

describe('slot hand-off races', () => {
  it('a waiter aborted after the hand-off but before its continuation never runs and passes the slot on', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gateA = deferred();
    let bRan = false;
    let cRan = false;
    const a = s.withSlot(() => gateA.promise);
    const acB = new AbortController();
    const b = s.withSlot(async () => {
      bRan = true;
    }, acB.signal);
    const c = s.withSlot(async () => {
      cRan = true;
      return 'c';
    });
    await tick(); // A is inside fn, B and C are queued
    expect(s.queued()).toBe(2);
    gateA.resolve();
    await Promise.resolve(); // A's finally has handed the slot to B; B's continuation has not run yet
    expect(s.queued()).toBe(1);
    expect(getEventListeners(acB.signal, 'abort')).toHaveLength(0);
    expect(bRan).toBe(false);
    acB.abort();
    const [ra, rb, rc] = await Promise.all([settle(a), settle(b), settle(c)]);
    expect(ra.ok).toBe(true);
    expectAbortError(rb);
    expect(bRan).toBe(false);
    expect(rc).toEqual({ ok: true, value: 'c' });
    expect(cRan).toBe(true);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
    expect(s.peakActive()).toBe(1);
  });

  it('fast path: abort in the microtask gap after acquiring a free slot means fn never runs', async () => {
    const s = new Scheduler({ concurrency: 2 });
    const ac = new AbortController();
    let ran = false;
    const p = s.withSlot(async () => {
      ran = true;
    }, ac.signal);
    expect(s.active()).toBe(1); // slot taken synchronously, fn not started
    ac.abort();
    expectAbortError(await settle(p));
    expect(ran).toBe(false);
    expect(s.active()).toBe(0);
  });

  it('a newcomer cannot jump the queue while a hand-off is pending', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const order: string[] = [];
    const a = s.withSlot(() => gate.promise);
    const b = s.withSlot(async () => {
      order.push('b');
    });
    await tick(); // A is inside fn, B is queued
    gate.resolve();
    await Promise.resolve(); // A has released straight to B; B's continuation has not run yet
    expect(s.queued()).toBe(0);
    expect(s.active()).toBe(1);
    expect(order).toEqual([]);
    const c = s.withSlot(async () => {
      order.push('c');
    });
    expect(s.queued()).toBe(1);
    await withTimeout(Promise.all([a, b, c]));
    expect(order).toEqual(['b', 'c']);
    expect(s.active()).toBe(0);
  });
});

describe('abort while queued', () => {
  it('aborting a queued call removes it synchronously, never runs fn, and does not leak a slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    let ran = false;
    const queued = s.withSlot(async () => {
      ran = true;
    }, ac.signal);
    const after = s.withSlot(async () => 'after');
    expect(s.queued()).toBe(2);
    ac.abort();
    expect(s.queued()).toBe(1);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await holder;
    await expect(after).resolves.toBe('after');
    expect(ran).toBe(false);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
  });

  it('an already-aborted signal rejects without taking or queueing a slot, even when slots are full', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    ac.abort();
    expectAbortError(await settle(s.withSlot(async () => 1, ac.signal)));
    expect(s.queued()).toBe(0);
    expect(s.active()).toBe(1);
    gate.resolve();
    await withTimeout(holder);
    expect(s.active()).toBe(0);
  });

  it('aborting one shared signal rejects every queued waiter and leaves the holder untouched', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred<string>();
    const holder = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    let ran = 0;
    const waiters = Array.from({ length: 50 }, () =>
      s.withSlot(async () => {
        ran++;
      }, ac.signal),
    );
    expect(s.queued()).toBe(50);
    ac.abort();
    const results = await Promise.all(waiters.map(settle));
    for (const r of results) expectAbortError(r);
    expect(ran).toBe(0);
    expect(s.queued()).toBe(0);
    expect(s.active()).toBe(1);
    gate.resolve('h');
    expect(await withTimeout(holder)).toBe('h');
    expect(s.active()).toBe(0);
  });

  it('keeps FIFO order among the remaining waiters after two middle waiters abort', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const order: number[] = [];
    const holder = s.withSlot(() => gate.promise);
    const acs = Array.from({ length: 6 }, () => new AbortController());
    const ps = acs.map((ac, i) =>
      s.withSlot(async () => {
        order.push(i);
        await tick();
      }, ac.signal),
    );
    acs[2]?.abort();
    acs[4]?.abort();
    expect(s.queued()).toBe(4);
    gate.resolve();
    const [, ...results] = await Promise.all([withTimeout(holder), ...ps.map(settle)]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true, false, true]);
    expect(order).toEqual([0, 1, 3, 5]);
    expect(s.active()).toBe(0);
  });

  it('a composed signal (AbortSignal.any) aborts a queued call', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const run = new AbortController();
    const skip = new AbortController();
    const composed = AbortSignal.any([run.signal, skip.signal]);
    let ran = false;
    const p = s.withSlot(async () => {
      ran = true;
    }, composed);
    skip.abort();
    expectAbortError(await settle(p));
    expect(ran).toBe(false);
    expect(s.queued()).toBe(0);
    gate.resolve();
    await withTimeout(holder);
    expect(s.active()).toBe(0);
  });
});

describe('abort listener hygiene', () => {
  it('leaves no abort listener after fast-path grant, queued grant, or queued abort', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const run = new AbortController();

    // (a) fast path
    await withTimeout(s.withSlot(async () => 1, run.signal));
    expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);

    // (b) queued then granted
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const queued = s.withSlot(async () => 2, run.signal);
    expect(getEventListeners(run.signal, 'abort')).toHaveLength(1);
    gate.resolve();
    await withTimeout(Promise.all([holder, queued]));
    expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);

    // (c) queued then aborted
    const gate2 = deferred();
    const holder2 = s.withSlot(() => gate2.promise);
    const own = new AbortController();
    const q2 = s.withSlot(async () => 3, own.signal);
    expect(getEventListeners(own.signal, 'abort')).toHaveLength(1);
    own.abort();
    expectAbortError(await settle(q2));
    expect(getEventListeners(own.signal, 'abort')).toHaveLength(0);
    gate2.resolve();
    await withTimeout(holder2);
    expect(s.active()).toBe(0);
  });
});

describe('fn failure modes release the slot', () => {
  it('a synchronously throwing fn releases its slot and the next waiter runs', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const bad = s.withSlot((() => {
      throw new Error('sync boom');
    }) as () => Promise<never>);
    const next = s.withSlot(async () => 'next');
    gate.resolve();
    const rb = await settle(bad);
    expect(rb.ok).toBe(false);
    expect((rb as { error?: Error }).error?.message).toBe('sync boom');
    expect(await withTimeout(next)).toBe('next');
    await withTimeout(holder);
    expect(s.active()).toBe(0);
  });

  it('a non-function fn rejects with a TypeError and releases its slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const r = await settle(s.withSlot(null as unknown as () => Promise<void>));
    expect(r.ok).toBe(false);
    expect((r as { error?: unknown }).error).toBeInstanceOf(TypeError);
    expect(s.active()).toBe(0);
    expect(await withTimeout(s.withSlot(async () => 7))).toBe(7);
  });

  it('a rejection with a non-Error value propagates the same value and releases the slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const thrown = { name: 'Error', message: 'foreign realm' }; // not instanceof Error
    const r = await settle(s.withSlot(() => Promise.reject(thrown)));
    expect(r.ok).toBe(false);
    expect((r as { error?: unknown }).error).toBe(thrown);
    expect(s.active()).toBe(0);
  });

  it('abort while fn is running does not release the slot early (slot held for the live call)', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const ac = new AbortController();
    const gate = deferred<string>();
    const running = s.withSlot(() => gate.promise, ac.signal);
    await tick();
    ac.abort();
    let nextRan = false;
    const next = s.withSlot(async () => {
      nextRan = true;
    });
    await tick();
    expect(s.active()).toBe(1);
    expect(nextRan).toBe(false);
    gate.resolve('done');
    expect(await withTimeout(running)).toBe('done');
    await withTimeout(next);
    expect(nextRan).toBe(true);
    expect(s.active()).toBe(0);
  });
});

describe('slot lifetime and bounds under load', () => {
  it('a caller awaiting something else between calls holds no slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    // A "script" that awaits a long-running external promise between agent calls must not block others.
    const external = deferred();
    const script = (async () => {
      await s.withSlot(async () => 1);
      await external.promise; // e.g. parallel()/workflow() wait
      return s.withSlot(async () => 2);
    })();
    await tick();
    expect(s.active()).toBe(0);
    await expect(
      withTimeout(
        s.withSlot(async () => 'other'),
        500,
      ),
    ).resolves.toBe('other');
    external.resolve();
    await expect(script).resolves.toBe(2);
  });

  it('300 fast tasks with every fifth aborted: never more than 4 live, aborted ones reject, the rest return their value', async () => {
    const s = new Scheduler({ concurrency: 4 });
    let inside = 0;
    let maxInside = 0;
    const acs = Array.from({ length: 300 }, () => new AbortController());
    const ps = acs.map((ac, i) =>
      s.withSlot(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        if (i % 7 === 0) await tick();
        else await Promise.resolve();
        inside--;
        return i;
      }, ac.signal),
    );
    // Aborted before any fn has started, so none of these may run (i = 0 already holds a slot).
    for (let i = 0; i < acs.length; i += 5) acs[i]?.abort();
    const results = await Promise.all(ps.map(settle));
    expect(maxInside).toBeLessThanOrEqual(4);
    expect(s.peakActive()).toBeLessThanOrEqual(4);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
    results.forEach((r, i) => {
      if (i % 5 === 0) expectAbortError(r);
      else expect(r).toEqual({ ok: true, value: i });
    });
  });

  it('nested-workflow shape: 16 parent agents plus a child workflow of 16 on the same scheduler finish without deadlock', async () => {
    const s = new Scheduler({ concurrency: 16 });
    let inside = 0;
    let maxInside = 0;
    const agent = (i: number) =>
      s.withSlot(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await tick();
        inside--;
        return i;
      });
    const parent = Array.from({ length: 16 }, (_, i) => agent(i));
    // workflow() waits without a slot; child agents queue behind the parent ones.
    const child = (async () => Promise.all(Array.from({ length: 16 }, (_, i) => agent(100 + i))))();
    expect(s.active()).toBe(16);
    expect(s.queued()).toBe(16);
    const all = await withTimeout(Promise.all([Promise.all(parent), child]));
    expect(all[0]).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(all[1]).toEqual(Array.from({ length: 16 }, (_, i) => 100 + i));
    expect(maxInside).toBe(16);
    expect(s.peakActive()).toBe(16);
    expect(s.active()).toBe(0);
  });
});

describe('agent cap', () => {
  it('the cap is lifetime: finished agents do not free admissions', async () => {
    const s = new Scheduler({ concurrency: 2, maxAgents: 2 });
    s.admit();
    await s.withSlot(async () => 1);
    s.admit();
    await s.withSlot(async () => 2);
    expectCode(() => s.admit(), 'agent_cap');
  });

  it('maxAgents 1: the second admit throws agent_cap, and repeated refusals do not move the counter', () => {
    const s = new Scheduler({ concurrency: 1, maxAgents: 1 });
    expect(s.admit()).toBe(0);
    expect(s.admitted()).toBe(1);
    for (let i = 0; i < 3; i++) expectCode(() => s.admit(), 'agent_cap');
    expect(s.admitted()).toBe(1);
  });

  it('admission and slots are independent counters', async () => {
    const s = new Scheduler({ concurrency: 1, maxAgents: 2 });
    await withTimeout(s.withSlot(async () => 1));
    await withTimeout(s.withSlot(async () => 2));
    await withTimeout(s.withSlot(async () => 3));
    expect(s.admitted()).toBe(0);
    s.admit();
    s.admit();
    expectCode(() => s.admit(), 'agent_cap');
    // Cap reached does not affect slot use.
    expect(await withTimeout(s.withSlot(async () => 'still ok'))).toBe('still ok');
  });
});
