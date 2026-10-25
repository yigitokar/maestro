// HostHooks.onSwallowed (spec Seviye 1 "kaç öğe düştüğünü log() ile söyler", Seviye 4 "No silent caps"):
// parallel()/pipeline() still turn throws into null, but the host hears about every swallowed slot.

import { describe, expect, it, vi } from 'vitest';
import { type HostHooks, makeParallel, makePipeline, parseScript, runScript } from '../src/runtime.js';

const META = "export const meta = { name: 'swallow', description: 'd' };\n";

function hooks(onSwallowed?: HostHooks['onSwallowed']): HostHooks {
  return {
    agent: async (p: string) => {
      if (p === 'boom') throw new Error('agent boom');
      return `r:${p}`;
    },
    log: () => {},
    workflow: async () => null,
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    ...(onSwallowed ? { onSwallowed } : {}),
  };
}

describe('makeParallel onSwallowed', () => {
  it('reports each thrown or non-function slot with its index and error', async () => {
    const seen: Array<[string, number, string]> = [];
    const parallel = makeParallel(undefined, (where, i, e) => seen.push([where, i, (e as Error).message]));
    const out = await parallel([
      async () => 1,
      () => {
        throw new Error('sync');
      },
      async () => {
        throw new Error('async');
      },
      'nope' as any,
      async () => null,
    ]);
    expect(out).toEqual([1, null, null, null, null]);
    // Settle order is timing-dependent; the index identifies the slot.
    seen.sort((a, b) => a[1] - b[1]);
    expect(seen.map(([w, i]) => [w, i])).toEqual([
      ['parallel', 1],
      ['parallel', 2],
      ['parallel', 3],
    ]);
    expect(seen[0]![2]).toBe('sync');
    expect(seen[1]![2]).toBe('async');
    expect(seen[2]![2]).toMatch(/not a function/);
  });

  it('a thunk that returns null is not reported', async () => {
    const fn = vi.fn();
    await makeParallel(undefined, fn)([async () => null]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a throwing observer does not make parallel reject', async () => {
    const parallel = makeParallel(undefined, () => {
      throw new Error('observer broke');
    });
    await expect(
      parallel([
        async () => {
          throw new Error('x');
        },
      ]),
    ).resolves.toEqual([null]);
  });

  it('checkItems errors still reject and are not reported as swallowed', async () => {
    const fn = vi.fn();
    const parallel = makeParallel(() => {
      throw new Error('item_limit');
    }, fn);
    await expect(parallel([async () => 1])).rejects.toThrow('item_limit');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('makePipeline onSwallowed', () => {
  it('reports the item index of a throwing stage; a null-returning stage is not reported', async () => {
    const seen: Array<[string, number]> = [];
    const pipeline = makePipeline(undefined, (where, i) => seen.push([where, i]));
    const out = await pipeline(
      [0, 1, 2],
      async (x) => {
        if (x === 1) throw new Error('stage1');
        return x === 2 ? null : x;
      },
      async (prev) => (prev === null ? 'gotNull' : prev),
    );
    expect(out).toEqual([0, null, 'gotNull']);
    expect(seen).toEqual([['pipeline', 1]]);
  });

  it('a non-function stage is reported', async () => {
    const fn = vi.fn();
    const out = await makePipeline(undefined, fn)([5], 42 as any);
    expect(out).toEqual([null]);
    expect(fn).toHaveBeenCalledWith('pipeline', 0, expect.anything());
  });
});

describe('runScript wires hooks.onSwallowed', () => {
  it('vm-realm errors thrown inside script thunks reach the hook', async () => {
    const seen: Array<[string, number, string]> = [];
    const result = await runScript(
      parseScript(
        `${META}const a = await parallel([() => agent('ok'), () => agent('boom'), () => { throw new Error('inside') }]);\n` +
          `const b = await pipeline([1, 2], (x) => { if (x === 2) throw new RangeError('two'); return x; });\n` +
          'return { a, b };',
      ),
      {},
      hooks((where, i, e) => seen.push([where, i, String((e as { message?: unknown })?.message)])),
    );
    expect(result).toEqual({ a: ['r:ok', null, null], b: [1, null] });
    seen.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
    expect(seen).toEqual([
      ['parallel', 1, 'agent boom'],
      ['parallel', 2, 'inside'],
      ['pipeline', 1, 'two'],
    ]);
  });

  it('without the hook behaviour is unchanged', async () => {
    const result = await runScript(
      parseScript(`${META}return await parallel([() => { throw new Error('x') }, () => agent('y')]);`),
      {},
      hooks(),
    );
    expect(result).toEqual([null, 'r:y']);
  });
});
