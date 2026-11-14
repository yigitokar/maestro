// Adversarial verification of the script runtime (spec 3.3, meta block, determinism rule, null/throw table,
// ADR-2). Lens: edge cases and failure modes (sparse/boundary inputs, numeric limits, cross-realm objects,
// parse-before-run, line mapping). Tests marked SPEC-VIOLATION assert the spec behaviour; they failed when written and pass since the fixes.

import { describe, expect, it, vi } from 'vitest';
import { type HostHooks, makeParallel, makePipeline, parseScript, runScript } from '../src/runtime.js';
import type { AgentOpts } from '../src/types.js';

const META = "export const meta = { name: 'test', description: 'd' };\n";

function makeHooks(over: Partial<HostHooks> = {}) {
  const hooks = {
    agent: vi.fn(async (prompt: string, _opts?: AgentOpts) => `r:${prompt}`),
    log: vi.fn(),
    onPhase: vi.fn(),
    workflow: vi.fn(async () => 'wf'),
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    ...over,
  };
  return hooks;
}

async function run(src: string, args: unknown = {}, over: Partial<HostHooks> = {}) {
  const hooks = makeHooks(over);
  const result = await runScript(parseScript(src), args, hooks);
  return { result: result as any, hooks };
}

async function failure(p: Promise<unknown> | (() => unknown)): Promise<any> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

/** Runs `expr` inside the context; returns { value } or { name, message, code } of what it threw. */
async function probe(expr: string) {
  const { result } = await run(
    `${META}try { return { value: (${expr}) } } catch (e) { return { name: e.name, message: e.message, code: e.code } }`,
  );
  return result as { value?: unknown; name?: string; message?: string; code?: string };
}

// ---------------------------------------------------------------------------------------------------------
// SPEC-VIOLATION: sparse arrays (holes) in parallel/pipeline

describe('parallel/pipeline with holes (null/throw table, ADR-2)', () => {
  it('SPEC-VIOLATION: parallel slot for a hole (not a function) is null, like an explicit undefined', async () => {
    const parallel = makeParallel();
    // An explicit non-function is null today ...
    expect(await parallel([undefined as any, () => Promise.resolve(1)])).toEqual([null, 1]);
    // ... but a hole is the same "not a function" slot and must be null too (Array<any | null>).
    // biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
    const r = await parallel([, () => Promise.resolve(1)] as any);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeNull();
    expect(r[1]).toBe(1);
  });

  it('SPEC-VIOLATION: parallel hole from inside a workflow script yields null', async () => {
    const { result } = await run(`${META}return await parallel([, () => 'b'])`);
    expect(result[0]).toBeNull();
  });

  it('SPEC-VIOLATION: pipeline runs every counted item through its stages, including a hole', async () => {
    const pipeline = makePipeline();
    const stage = vi.fn(async (_prev: unknown, _item: unknown, index: number) => `ran:${index}`);
    // biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
    const r = await pipeline([, 'b'] as any, stage);
    // checkItems counted 2 items, so both items must go stage1 -> ... (brief: each item runs its chain).
    expect(stage).toHaveBeenCalledTimes(2);
    expect(r).toEqual(['ran:0', 'ran:1']);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Regression probes that currently pass

describe('item limit boundary (spec 3.4: 4096 per call, overflow is an explicit error)', () => {
  it('parallel: exactly 4096 resolves, 4097 rejects item_limit without invoking any thunk', async () => {
    const parallel = makeParallel();
    const ok = await parallel(Array.from({ length: 4096 }, (_, i) => () => Promise.resolve(i)));
    expect(ok).toHaveLength(4096);
    const thunk = vi.fn(async () => 1);
    const e = await failure(parallel(Array.from({ length: 4097 }, () => thunk)));
    expect(e.code).toBe('item_limit');
    expect(thunk).not.toHaveBeenCalled();
  });

  it('pipeline: exactly 4096 resolves, 4097 rejects item_limit without invoking any stage', async () => {
    const pipeline = makePipeline();
    expect(await pipeline(Array.from({ length: 4096 }, (_, i) => i))).toHaveLength(4096);
    const stage = vi.fn(async () => 1);
    const e = await failure(
      pipeline(
        Array.from({ length: 4097 }, (_, i) => i),
        stage,
      ),
    );
    expect(e.code).toBe('item_limit');
    expect(stage).not.toHaveBeenCalled();
  });

  it('item_limit rejects the script (not a silent null) when raised inside the vm', async () => {
    const e = await failure(
      run(`${META}await parallel(new Array(4097).fill(() => 1)); return 'unreachable'`),
    );
    expect(e.code).toBe('item_limit');
  });

  it('host checkItems hook is used instead of the default', async () => {
    const checkItems = vi.fn((n: number) => {
      if (n > 2) throw Object.assign(new Error('cap'), { code: 'item_limit' });
    });
    const e = await failure(run(`${META}return await pipeline([1, 2, 3], (x) => x)`, {}, { checkItems }));
    expect(e.code).toBe('item_limit');
    expect(checkItems).toHaveBeenCalledWith(3, 'pipeline');
  });
});

describe('meta numeric and empty boundaries', () => {
  const metaWith = (extra: string) =>
    `export const meta = { name: 'n', description: 'd'${extra} };\nreturn 1`;

  it.each(['0', '-1', '1.5', '-0', 'true', "'3'", '1e400'])('maxAgents: %s is meta_invalid', (v) => {
    const e = (() => {
      try {
        parseScript(metaWith(`, maxAgents: ${v}`));
      } catch (err) {
        return err as any;
      }
    })();
    expect(e?.code).toBe('meta_invalid');
  });

  it.each(['1', '1e3', '1_000', '1.0'])('maxAgents: %s is accepted', (v) => {
    expect(parseScript(metaWith(`, maxAgents: ${v}`)).meta.maxAgents).toBeGreaterThan(0);
  });

  it('empty source, empty name, missing description are meta_invalid', () => {
    for (const src of [
      '',
      'return 1',
      "export const meta = { name: '', description: 'd' }",
      "export const meta = { name: 'x' }",
    ]) {
      expect(() => parseScript(src)).toThrow(expect.objectContaining({ code: 'meta_invalid' }));
    }
  });

  it('phases: [] declared means every phase title is unknown', async () => {
    const src = "export const meta = { name: 'n', description: 'd', phases: [] };\n";
    expect((await failure(run(`${src}phase('A')`))).code).toBe('unknown_phase');
    expect((await failure(run(`${src}await agent('p', { phase: 'A' })`))).code).toBe('unknown_phase');
  });

  it('a script that is only the meta line resolves undefined', async () => {
    expect((await run(META)).result).toBeUndefined();
  });

  it('parallel([]) and pipeline(items) with zero stages', async () => {
    const { result } = await run(
      `${META}return { p: await parallel([]), q: await pipeline([1, null, 'x']) }`,
    );
    expect(result.p).toEqual([]);
    expect(result.q).toEqual([1, null, 'x']);
  });
});

describe('parse before run / reopen', () => {
  it('syntax error throws from parseScript with a location; no hook is ever called', () => {
    const hooks = makeHooks();
    let err: any;
    try {
      const parsed = parseScript(`${META}await agent('a');\nconst = 1;`);
      runScript(parsed, {}, hooks);
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe('SyntaxError');
    expect(err?.loc?.line).toBe(3);
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('import() and a second export are rejected before anything runs', () => {
    expect(() => parseScript(`${META}await import('node:fs')`)).toThrow(
      expect.objectContaining({ code: 'meta_invalid' }),
    );
    expect(() => parseScript(`${META}export const x = 1`)).toThrow(
      expect.objectContaining({ code: 'meta_invalid' }),
    );
  });

  it('dynamic import smuggled through eval/Function cannot reach the file system', async () => {
    const { result } = await run(
      `${META}const out = [];
       for (const f of [() => eval('import("node:fs")'), () => Function('return import("node:fs")')()]) {
         try { await f(); out.push('resolved') } catch (e) { out.push('rejected') }
       }
       return out`,
    );
    expect(result).toEqual(['rejected', 'rejected']);
  });

  it('parsing the same source twice (resume) is identical', () => {
    const src = `#!/usr/bin/env maestro\n${META}return 1`;
    const a = parseScript(src);
    const b = parseScript(src);
    expect(a.body).toBe(b.body);
    expect(a.meta).toEqual(b.meta);
    expect(a.body.length).toBe(src.length);
  });

  it('stack lines match the original file with a hashbang and with CRLF line endings', async () => {
    const lf = `#!/usr/bin/env maestro\n${META}const x = 1;\nthrow new Error('boom');`;
    const e1 = await failure(run(lf));
    expect(String(e1.stack)).toMatch(/test\.workflow\.js:4:7/);
    const crlf = lf.replace(/\n/g, '\r\n');
    const e2 = await failure(run(crlf));
    expect(String(e2.stack)).toMatch(/test\.workflow\.js:4:7/);
  });
});

describe('determinism rule (spec 3.3) edge cases', () => {
  it('new Date(undefined) has an argument: allowed (Invalid Date, no clock read)', async () => {
    expect((await probe('String(new Date(undefined).getTime())')).value).toBe('NaN');
  });

  it('Date() without new is a TypeError; Reflect.construct and subclasses still throw', async () => {
    expect((await probe('Date()')).name).toBe('TypeError');
    expect((await probe('Reflect.construct(Date, [])')).message).toMatch(/^determinism:/);
    expect((await probe('(() => { class D extends Date {}; return new D() })()')).message).toMatch(
      /^determinism:/,
    );
    expect((await probe('new (new Date(0).constructor)()')).message).toMatch(/^determinism:/);
    expect((await probe('new Date(...[])')).message).toMatch(/^determinism:/);
  });

  it('Intl.DateTimeFormat format/formatToParts without a date throw; with a date they work', async () => {
    expect((await probe('Intl.DateTimeFormat().format()')).message).toMatch(/^determinism:/);
    expect((await probe('new Intl.DateTimeFormat().format(undefined)')).message).toMatch(/^determinism:/);
    expect((await probe('new Intl.DateTimeFormat().formatToParts()')).message).toMatch(/^determinism:/);
    const ok = await probe("new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(new Date(0))");
    expect(ok.value).toBe('1/1/1970');
    expect((await probe("new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' })")).value).toBe(
      '1/1/1970',
    );
  });

  it('eval/Function inside the context see the overridden builtins', async () => {
    expect((await probe("eval('Date.now()')")).message).toMatch(/^determinism:/);
    expect((await probe("Function('return Math.random()')()")).message).toMatch(/^determinism:/);
  });

  it('host-only globals are ReferenceErrors', async () => {
    for (const g of [
      'process',
      'require',
      'fetch',
      'console',
      'setTimeout',
      'setImmediate',
      'queueMicrotask',
      'structuredClone',
      'performance',
      'crypto',
      'Buffer',
    ]) {
      expect((await probe(g)).name, g).toBe('ReferenceError');
    }
  });

  it('the only non-builtin globals are the eight host API names', async () => {
    const { result } = await run(`${META}return Object.getOwnPropertyNames(globalThis)`);
    const host = (result as string[]).filter((k) => !/^[A-Z]/.test(k) && !Object.hasOwn(globalThis, k));
    expect(host.sort()).toEqual([
      'agent',
      'args',
      'budget',
      'log',
      'parallel',
      'phase',
      'pipeline',
      'workflow',
    ]);
  });
});

describe('cross-realm schemas and the null/throw table', () => {
  it('schema literal authored inside the vm: required not in properties throws at the call site', async () => {
    const { result, hooks } = await run(
      `${META}const out = [];
       for (const s of [
         { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
         { type: 'object', properties: { xs: { type: 'array', items: { type: 'object', properties: {}, required: ['z'] } } } },
         { type: 'object', properties: { u: { anyOf: [{ type: 'object', properties: { k: {} }, required: ['q'] }] } } },
         { type: 'array', items: {} },
       ]) {
         let p;
         try { p = agent('x', { schema: s }); out.push('no-throw') } catch (e) { out.push(e.code) }
         if (p) await p;
       }
       return out`,
    );
    expect(result).toEqual(['schema_invalid', 'schema_invalid', 'schema_invalid', 'schema_invalid']);
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('a valid vm-realm schema with shared (non-cyclic) subschemas is accepted', async () => {
    const { hooks } = await run(
      `${META}const S = { type: 'string' };
       await agent('x', { schema: { type: 'object', properties: { a: S, b: S }, required: ['a', 'b'] } })`,
    );
    expect(hooks.agent).toHaveBeenCalledTimes(1);
  });

  it('inside parallel an unsatisfiable schema makes that slot null; the host agent is never called', async () => {
    const { result, hooks } = await run(
      `${META}return await parallel([
         () => agent('bad', { schema: { type: 'object', properties: {}, required: ['x'] } }),
         () => agent('good'),
       ])`,
    );
    expect(result).toEqual([null, 'r:good']);
    expect(hooks.agent).toHaveBeenCalledTimes(1);
  });

  it('host results are usable as arrays inside the script', async () => {
    const { result } = await run(
      `${META}const r = await parallel([() => 1, () => { throw 0 }, () => 3]);
       return { isArr: Array.isArray(r), kept: r.filter(Boolean), json: JSON.stringify(r) }`,
    );
    expect(result).toEqual({ isArr: true, kept: [1, 3], json: '[1,null,3]' });
  });

  it('a script-thrown error (context realm) rejects runScript and keeps its own fields', async () => {
    const e = await failure(run(`${META}const err = new Error('x'); err.code = 'mine'; throw err`));
    expect(e.code).toBe('mine');
    expect(e.message).toBe('x');
    expect(e instanceof Error).toBe(false); // context realm: never rely on host instanceof
  });
});

describe('pipeline: no barrier, null passes, throw skips (ADR-2)', () => {
  it('item 1 finishes all stages while item 0 is still in stage 1', async () => {
    const pipeline = makePipeline();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    const p = pipeline(
      [0, 1],
      async (_prev, item) => {
        if (item === 0) await gate;
        order.push(`s1:${item}`);
        return item;
      },
      async (prev) => {
        order.push(`s2:${prev}`);
        if (prev === 1) release();
        return prev;
      },
    );
    expect(await p).toEqual([0, 1]);
    expect(order).toEqual(['s1:1', 's2:1', 's1:0', 's2:0']);
  });

  it('stage returning null feeds null to the next stage; a throwing stage skips the rest', async () => {
    const pipeline = makePipeline();
    const s2 = vi.fn(async (prev: unknown, item: unknown, index: number) => ({ prev, item, index }));
    const r = await pipeline(
      ['a', 'b'],
      (_p, item) => {
        if (item === 'b') throw new Error('x');
        return null as any;
      },
      s2,
    );
    expect(r).toEqual([{ prev: null, item: 'a', index: 0 }, null]);
    expect(s2).toHaveBeenCalledTimes(1);
  });

  it('parallel: sync throw, async reject, non-function and thrown non-Error all become null', async () => {
    const parallel = makeParallel();
    const r = await parallel([
      () => {
        throw new Error('sync');
      },
      () => Promise.reject(new Error('async')),
      42 as any,
      () => {
        throw undefined;
      },
      () => Promise.resolve('ok'),
    ]);
    expect(r).toEqual([null, null, null, null, 'ok']);
  });
});
