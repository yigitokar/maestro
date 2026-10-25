// Scheduler tests (spec 3.4): slot bound, FIFO, abort handling, agent cap, item limit, nested no-deadlock.
import { describe, expect, it } from 'vitest';
import { defaultConcurrency, Scheduler } from '../src/scheduler.js';
import { abortableSleep } from '../src/testing/fake-runner.js';
import { MaestroError } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => setImmediate(r));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

describe('defaultConcurrency', () => {
  it('is max(1, min(16, cpus - 2))', () => {
    expect(defaultConcurrency(1)).toBe(1);
    expect(defaultConcurrency(2)).toBe(1);
    expect(defaultConcurrency(4)).toBe(2);
    expect(defaultConcurrency(18)).toBe(16);
    expect(defaultConcurrency(64)).toBe(16);
  });

  it('defaults to the machine and is used by the constructor', () => {
    const c = defaultConcurrency();
    expect(c).toBeGreaterThanOrEqual(1);
    expect(c).toBeLessThanOrEqual(16);
    expect(new Scheduler().concurrency).toBe(c);
  });
});

describe('Scheduler.withSlot', () => {
  it('runs 32 tasks with concurrency 16 and never exceeds 16 live tasks', async () => {
    const s = new Scheduler({ concurrency: 16 });
    let inside = 0;
    let maxInside = 0;
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        s.withSlot(async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          expect(s.active()).toBeLessThanOrEqual(16);
          await sleep(5 + (i % 3));
          inside--;
          return i;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(maxInside).toBe(16);
    expect(s.peakActive()).toBe(16);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
  });

  it('grants slots in FIFO order', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const order: number[] = [];
    const first = s.withSlot(() => gate.promise);
    const rest = Array.from({ length: 8 }, (_, i) =>
      s.withSlot(async () => {
        order.push(i);
        await tick();
      }),
    );
    expect(s.active()).toBe(1);
    expect(s.queued()).toBe(8);
    gate.resolve();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('does not let a newcomer jump the queue when a slot is handed over', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const order: string[] = [];
    const a = s.withSlot(() => gate.promise);
    const b = s.withSlot(async () => {
      order.push('b');
    });
    gate.resolve();
    await a;
    const c = s.withSlot(async () => {
      order.push('c');
    });
    await Promise.all([b, c]);
    expect(order).toEqual(['b', 'c']);
  });

  it('releases the slot when the task throws (async or sync)', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const err = new Error('boom');
    await expect(s.withSlot(() => Promise.reject(err))).rejects.toBe(err);
    expect(s.active()).toBe(0);
    await expect(
      s.withSlot(() => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(s.active()).toBe(0);
    await expect(s.withSlot(async () => 'ok')).resolves.toBe('ok');
    expect(s.active()).toBe(0);
  });

  it('a queued task aborted leaves the queue with AbortError and the slot count stays intact', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const a = s.withSlot(() => gate.promise);
    const ac = new AbortController();
    let bRan = false;
    const b = s.withSlot(async () => {
      bRan = true;
    }, ac.signal);
    expect(s.queued()).toBe(1);
    ac.abort();
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(bRan).toBe(false);
    expect(s.queued()).toBe(0);
    expect(s.active()).toBe(1);
    gate.resolve();
    await a;
    expect(s.active()).toBe(0);
    await expect(s.withSlot(async () => 'c')).resolves.toBe('c');
    expect(s.active()).toBe(0);
    expect(s.peakActive()).toBe(1);
  });

  it('aborting one queued task does not disturb the others', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const gate = deferred();
    const order: number[] = [];
    const a = s.withSlot(() => gate.promise);
    const acs = [new AbortController(), new AbortController(), new AbortController()];
    const qs = acs.map((ac, i) =>
      s.withSlot(async () => {
        order.push(i);
      }, ac.signal),
    );
    acs[1]!.abort();
    await expect(qs[1]).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.queued()).toBe(2);
    gate.resolve();
    await Promise.all([a, qs[0], qs[2]]);
    expect(order).toEqual([0, 2]);
    expect(s.active()).toBe(0);
  });

  it('an already-aborted signal rejects immediately without taking a slot', async () => {
    const s = new Scheduler({ concurrency: 2 });
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

  it('aborting a running task does not leak its slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const ac = new AbortController();
    const started = deferred();
    const running = s.withSlot(async () => {
      started.resolve();
      await abortableSleep(10_000, ac.signal);
      return ac.signal.aborted ? 'skipped' : 'ok';
    }, ac.signal);
    await started.promise;
    expect(s.active()).toBe(1);
    ac.abort();
    await expect(withTimeout(running, 2000)).resolves.toBe('skipped');
    expect(s.active()).toBe(0);
    await expect(s.withSlot(async () => 'next')).resolves.toBe('next');
    expect(s.active()).toBe(0);
  });

  it('a running task that rejects after abort also releases its slot', async () => {
    const s = new Scheduler({ concurrency: 1 });
    const ac = new AbortController();
    const running = s.withSlot(async () => {
      await abortableSleep(10_000, ac.signal);
      throw new Error('aborted mid-flight');
    }, ac.signal);
    await tick();
    ac.abort();
    await expect(running).rejects.toThrow('aborted mid-flight');
    expect(s.active()).toBe(0);
  });

  it('does not accumulate abort listeners on a shared signal', async () => {
    const s = new Scheduler({ concurrency: 2 });
    const ac = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((type: string, l: any, o?: any) => {
      added.push(l);
      origAdd(type, l, o);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((type: string, l: any, o?: any) => {
      removed.push(l);
      origRemove(type, l, o);
    }) as typeof ac.signal.removeEventListener;
    await Promise.all(Array.from({ length: 10 }, () => s.withSlot(() => sleep(1), ac.signal)));
    expect(added.length).toBe(8);
    expect(removed.length).toBe(8);
  });
});

describe('Scheduler.admit', () => {
  it('defaults to 1000 and throws agent_cap exactly at the cap', () => {
    const s = new Scheduler({ concurrency: 4 });
    expect(s.maxAgents).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(s.admit()).toBe(i);
    expect(s.admitted()).toBe(1000);
    let caught: unknown;
    try {
      s.admit();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MaestroError);
    expect((caught as MaestroError).code).toBe('agent_cap');
    expect(s.admitted()).toBe(1000);
  });

  it('honours a meta.maxAgents override', () => {
    const s = new Scheduler({ concurrency: 4, maxAgents: 3 });
    expect(s.maxAgents).toBe(3);
    expect([s.admit(), s.admit(), s.admit()]).toEqual([0, 1, 2]);
    expect(() => s.admit()).toThrow(MaestroError);
    expect(() => s.admit()).toThrow(expect.objectContaining({ code: 'agent_cap' }));
    expect(s.admitted()).toBe(3);
  });

  it('rejects a non-positive concurrency or maxAgents', () => {
    expect(() => new Scheduler({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new Scheduler({ concurrency: 1.5 })).toThrow(RangeError);
    expect(() => new Scheduler({ maxAgents: 0 })).toThrow(RangeError);
  });
});

describe('Scheduler.checkItems', () => {
  it('allows 4096 items and rejects 4097 with item_limit', () => {
    const s = new Scheduler({ concurrency: 1 });
    expect(() => s.checkItems(4096, 'parallel')).not.toThrow();
    expect(() => s.checkItems(0, 'pipeline')).not.toThrow();
    for (const where of ['parallel', 'pipeline'] as const) {
      let caught: unknown;
      try {
        s.checkItems(4097, where);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MaestroError);
      expect((caught as MaestroError).code).toBe('item_limit');
      expect((caught as MaestroError).message).toContain(where);
    }
  });
});

describe('nested workflow (spec 3.4)', () => {
  it('16 outer agents holding every slot plus a workflow awaiting 16 inner agents: no deadlock', async () => {
    const s = new Scheduler({ concurrency: 16 });
    let inside = 0;
    let maxInside = 0;
    let outerDone = 0;
    let innerStartedBeforeOuterDone = false;
    const gates = Array.from({ length: 16 }, () => deferred());

    const outer = gates.map((g, i) =>
      s.withSlot(async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await g.promise;
        inside--;
        outerDone++;
        return `outer${i}`;
      }),
    );
    expect(s.active()).toBe(16);

    // The nested workflow is plain script code: it holds no slot while it awaits its agents.
    const workflow = (async () => {
      const inner = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          s.withSlot(async () => {
            if (outerDone === 0) innerStartedBeforeOuterDone = true;
            inside++;
            maxInside = Math.max(maxInside, inside);
            await sleep(2);
            inside--;
            return `inner${i}`;
          }),
        ),
      );
      return inner.length;
    })();

    await tick();
    expect(s.active()).toBe(16);
    expect(s.queued()).toBe(16);

    for (const g of gates) g.resolve();
    const [outerResults, innerCount] = await withTimeout(Promise.all([Promise.all(outer), workflow]), 2000);
    expect(outerResults).toHaveLength(16);
    expect(innerCount).toBe(16);
    expect(innerStartedBeforeOuterDone).toBe(false);
    expect(maxInside).toBeLessThanOrEqual(16);
    expect(s.peakActive()).toBe(16);
    expect(s.active()).toBe(0);
    expect(s.queued()).toBe(0);
  });
});
