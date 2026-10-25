// Adversarial verification of the Scheduler (spec 3.4, Seviye 2 Scheduler row, flow steps 3 and 5).
// Lens: races at the slot hand-off, abort paths, listener/slot leaks and numeric boundaries.
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.js';
import { MaestroError } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function withTimeout<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await withTimeout(p) };
  } catch (error) {
    return { ok: false, error };
  }
}

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
    expect(s.queued()).toBe(2);
    // Resolve A and abort B in the same synchronous turn: A's finally hands the slot to B, B must give it back.
    gateA.resolve();
    queueMicrotask(() => acB.abort());
    const [ra, rb, rc] = await Promise.all([settle(a), settle(b), settle(c)]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(isAbortError(rb.error)).toBe(true);
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
    ac.abort();
    const r = await settle(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(isAbortError(r.error)).toBe(true);
    expect(ran).toBe(false);
    expect(s.active()).toBe(0);
  });

  it('an already-aborted signal rejects without taking or queueing a slot, even when slots are full', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    ac.abort();
    const r = await settle(s.withSlot(async () => 1, ac.signal));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(isAbortError(r.error)).toBe(true);
    expect(s.queued()).toBe(0);
    expect(s.active()).toBe(1);
    gate.resolve();
    await withTimeout(holder);
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
    gate.resolve();
    // Arrives after A released but (possibly) before B's continuation ran.
    await Promise.resolve();
    const c = s.withSlot(async () => {
      order.push('c');
    });
    await withTimeout(Promise.all([a, b, c]));
    expect(order).toEqual(['b', 'c']);
    expect(s.active()).toBe(0);
  });
});

describe('abort listener hygiene (no leaks on long-lived run signals)', () => {
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
    expect((await settle(q2)).ok).toBe(false);
    expect(getEventListeners(own.signal, 'abort')).toHaveLength(0);
    gate2.resolve();
    await withTimeout(holder2);
    expect(s.active()).toBe(0);
  });

  it('many sequential calls with one shared run signal do not accumulate listeners', async () => {
    const s = new Scheduler({ concurrency: 2 });
    const run = new AbortController();
    await withTimeout(
      Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          s.withSlot(async () => {
            await tick();
            return i;
          }, run.signal),
        ),
      ),
    );
    expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
  });
});

describe('shared signal across many waiters', () => {
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
    expect(results.every((r) => !r.ok && isAbortError(r.error))).toBe(true);
    expect(ran).toBe(0);
    expect(s.queued()).toBe(0);
    expect(s.active()).toBe(1);
    gate.resolve('h');
    expect(await withTimeout(holder)).toBe('h');
    expect(s.active()).toBe(0);
  });

  it('keeps FIFO order after a middle waiter is aborted', async () => {
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
    await Promise.all([withTimeout(holder), ...ps.map(settle)]);
    expect(order).toEqual([0, 1, 3, 5]);
    expect(s.active()).toBe(0);
  });

  it('works with composed signals (AbortSignal.any)', async () => {
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
    const r = await settle(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(isAbortError(r.error)).toBe(true);
    expect(ran).toBe(false);
    expect(s.queued()).toBe(0);
    gate.resolve();
    await withTimeout(holder);
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
    if (!rb.ok) expect((rb.error as Error).message).toBe('sync boom');
    expect(await withTimeout(next)).toBe('next');
    await withTimeout(holder);
    expect(s.active()).toBe(0);
  });

  it('a non-function fn releases its slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const r = await settle(s.withSlot(null as unknown as () => Promise<void>));
    expect(r.ok).toBe(false);
    expect(s.active()).toBe(0);
    expect(await withTimeout(s.withSlot(async () => 7))).toBe(7);
  });

  it('a rejecting fn and a cross-realm-like thrown value propagate unchanged and release', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const thrown = { name: 'Error', message: 'foreign realm' }; // not instanceof Error
    const r = await settle(s.withSlot(() => Promise.reject(thrown)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(thrown);
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

describe('bounds under hand-off storms', () => {
  it('peakActive never exceeds concurrency with immediately-resolving tasks and random aborts', async () => {
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
    for (let i = 0; i < acs.length; i += 5) acs[i]?.abort();
    const results = await Promise.all(ps.map(settle));
    expect(maxInside).toBeLessThanOrEqual(4);
    expect(s.peakActive()).toBeLessThanOrEqual(4);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
    // Every non-aborted call completed with its own value.
    results.forEach((r, i) => {
      if (i % 5 === 0) return;
      expect(r).toEqual({ ok: true, value: i });
    });
  });

  it('nested-workflow shape: 16 parent agents + child agents on the same scheduler finish without deadlock', async () => {
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
    const all = await withTimeout(Promise.all([Promise.all(parent), child]));
    expect(all[0]).toHaveLength(16);
    expect(all[1]).toHaveLength(16);
    expect(maxInside).toBe(16);
    expect(s.active()).toBe(0);
  });
});

describe('numeric boundaries', () => {
  it('checkItems allows exactly 4096 and rejects 4097 with item_limit for both call sites', () => {
    const s = new Scheduler({ concurrency: 1 });
    expect(() => s.checkItems(0, 'parallel')).not.toThrow();
    expect(() => s.checkItems(4096, 'parallel')).not.toThrow();
    expect(() => s.checkItems(4096, 'pipeline')).not.toThrow();
    for (const where of ['parallel', 'pipeline'] as const) {
      try {
        s.checkItems(4097, where);
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(MaestroError);
        expect((e as MaestroError).code).toBe('item_limit');
      }
    }
  });

  it('maxAgents is a hard cap at exact equality and admission is not consumed by failed admits', () => {
    const s = new Scheduler({ concurrency: 1, maxAgents: 1 });
    expect(s.admit()).toBe(0);
    expect(s.admitted()).toBe(1);
    for (let i = 0; i < 3; i++) {
      try {
        s.admit();
        expect.unreachable('should throw');
      } catch (e) {
        expect((e as MaestroError).code).toBe('agent_cap');
      }
    }
    expect(s.admitted()).toBe(1);
  });

  it('default cap is 1000: the 1000th admit succeeds, the 1001st throws agent_cap', () => {
    const s = new Scheduler({ concurrency: 1 });
    expect(s.maxAgents).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(s.admit()).toBe(i);
    expect(() => s.admit()).toThrow(MaestroError);
  });

  it('admission and slots are independent counters', async () => {
    const s = new Scheduler({ concurrency: 1, maxAgents: 2 });
    await withTimeout(s.withSlot(async () => 1));
    await withTimeout(s.withSlot(async () => 2));
    await withTimeout(s.withSlot(async () => 3));
    expect(s.admitted()).toBe(0);
    s.admit();
    s.admit();
    expect(() => s.admit()).toThrow(MaestroError);
    // Cap reached does not affect slot use.
    expect(await withTimeout(s.withSlot(async () => 'still ok'))).toBe('still ok');
  });

  it('rejects non-positive / non-integer concurrency and maxAgents at construction', () => {
    expect(() => new Scheduler({ concurrency: 0 })).toThrow();
    expect(() => new Scheduler({ concurrency: 1.5 })).toThrow();
    expect(() => new Scheduler({ concurrency: Number.NaN })).toThrow();
    expect(() => new Scheduler({ concurrency: 1, maxAgents: 0 })).toThrow();
    expect(() => new Scheduler({ concurrency: 1, maxAgents: -3 })).toThrow();
  });
});
