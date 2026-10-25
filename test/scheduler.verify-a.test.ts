// Adversarial verification of the Scheduler against spec 3.4, Level 2 (Scheduler row), data flow
// steps 3 and 5, the null/throw table (agent cap) and 3.2 "Runner içinde alt ajan yoktur".
// Tests assert SPEC behaviour; any that fail point at a spec violation in src/scheduler.ts.
import { describe, expect, it } from 'vitest';
import { defaultConcurrency, Scheduler } from '../src/scheduler.js';
import { LIMITS, MaestroError } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => setImmediate(r));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function expectCode(fn: () => unknown, code: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MaestroError);
  expect((caught as MaestroError).code).toBe(code);
}

describe('spec 3.4: semaphore size min(16, cpus - 2)', () => {
  it('defaultConcurrency follows max(1, min(16, cpus - 2)) at the boundaries', () => {
    expect(defaultConcurrency(0)).toBe(1);
    expect(defaultConcurrency(3)).toBe(1);
    expect(defaultConcurrency(17)).toBe(15);
    expect(defaultConcurrency(18)).toBe(16);
    expect(defaultConcurrency(1024)).toBe(16);
  });

  it('defaultConcurrency never exceeds 16 and never drops below 1', () => {
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
});

describe('spec 3.4 test item: 32-agent parallel, 16 slots, never 17 live', () => {
  it('holds at most 16 live calls and drains completely', async () => {
    const s = new Scheduler({ concurrency: 16 });
    let live = 0;
    let maxLive = 0;
    const out = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        s.withSlot(async () => {
          live++;
          maxLive = Math.max(maxLive, live);
          await sleep(2 + (i % 4));
          live--;
          return i;
        }),
      ),
    );
    expect(out).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(maxLive).toBe(16);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
  });
});

describe('spec 3.4 test item: nested workflow, 16 parent + child agents, no deadlock', () => {
  it('parent holding no slot while awaiting a child workflow completes within the time bound', async () => {
    const s = new Scheduler({ concurrency: 16 });
    const agent = (ms: number) => s.withSlot(() => sleep(ms));
    // Parent fans out 16 agents and concurrently awaits a child workflow (which fans out 16 more).
    // Neither the parent script nor workflow() takes a slot (spec 3.4), and no agent waits on another
    // (spec 3.2), so total time is about 2 * agent time.
    const child = async () => Promise.all(Array.from({ length: 16 }, () => agent(20)));
    const parent = async () => Promise.all([...Array.from({ length: 16 }, () => agent(20)), child()]);
    const t0 = performance.now();
    await withTimeout(parent(), 2000);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(s.peakActive()).toBe(16);
    expect(s.active()).toBe(0);
  });
});

describe('null/throw table: agent cap reached -> agent() throws', () => {
  it('default lifetime cap is 1000 and the 1001st admit throws agent_cap', async () => {
    const s = new Scheduler({ concurrency: 1 });
    expect(s.maxAgents).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(s.admit()).toBe(i);
    await expectCode(() => s.admit(), 'agent_cap');
    // A refused admit does not consume the counter and keeps refusing.
    expect(s.admitted()).toBe(1000);
    await expectCode(() => s.admit(), 'agent_cap');
  });

  it('meta.maxAgents replaces the default cap', async () => {
    const s = new Scheduler({ concurrency: 1, maxAgents: 3 });
    s.admit();
    s.admit();
    s.admit();
    await expectCode(() => s.admit(), 'agent_cap');
  });

  it('cap is lifetime: finishing agents does not free admissions', async () => {
    const s = new Scheduler({ concurrency: 2, maxAgents: 2 });
    s.admit();
    await s.withSlot(async () => 1);
    s.admit();
    await s.withSlot(async () => 2);
    await expectCode(() => s.admit(), 'agent_cap');
  });
});

describe('spec 3.4: 4096 items per parallel/pipeline call, overflow is an explicit error', () => {
  it('4096 is allowed, 4097 throws item_limit for both call sites', async () => {
    const s = new Scheduler({ concurrency: 1 });
    expect(() => s.checkItems(4096, 'parallel')).not.toThrow();
    expect(() => s.checkItems(4096, 'pipeline')).not.toThrow();
    expect(() => s.checkItems(0, 'parallel')).not.toThrow();
    await expectCode(() => s.checkItems(4097, 'parallel'), 'item_limit');
    await expectCode(() => s.checkItems(4097, 'pipeline'), 'item_limit');
  });
});

describe('abort while queued (iptal sinyali)', () => {
  it('aborting a queued call removes it, never runs fn, and does not leak a slot', async () => {
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

  it('already-aborted signal rejects immediately without taking a slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(
      s.withSlot(async () => {
        ran = true;
      }, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ran).toBe(false);
    expect(s.active()).toBe(0);
    expect(s.peakActive()).toBe(0);
  });

  it('abort around the grant never runs fn and never leaks a slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const holder = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    let ran = false;
    const victim = s.withSlot(async () => {
      ran = true;
    }, ac.signal);
    const next = s.withSlot(async () => 'next');
    // Release the holder and abort in the same synchronous turn: grant has happened, fn not started.
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    await holder;
    await expect(victim).rejects.toMatchObject({ name: 'AbortError' });
    await expect(next).resolves.toBe('next');
    expect(ran).toBe(false);
    expect(s.active()).toBe(0);
  });

  it('slot is released when fn throws synchronously or rejects', async () => {
    const s = new Scheduler({ concurrency: 1 });
    await expect(
      s.withSlot((() => {
        throw new Error('sync');
      }) as () => Promise<void>),
    ).rejects.toThrow('sync');
    await expect(s.withSlot(async () => Promise.reject(new Error('async')))).rejects.toThrow('async');
    expect(s.active()).toBe(0);
    await expect(s.withSlot(async () => 7)).resolves.toBe(7);
  });

  it('FIFO order is preserved when a middle waiter aborts', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const order: number[] = [];
    const holder = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    const ps = [0, 1, 2, 3].map((i) =>
      s.withSlot(
        async () => {
          order.push(i);
          await tick();
        },
        i === 1 ? ac.signal : undefined,
      ),
    );
    ac.abort();
    gate.resolve();
    await holder;
    const settled = await Promise.allSettled(ps);
    expect(settled[1]?.status).toBe('rejected');
    expect(order).toEqual([0, 2, 3]);
  });
});

describe('spec 3.4: slot held only around the live call', () => {
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
});
