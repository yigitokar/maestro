// Script runtime edge cases and failure modes, checked against docs/spec.md 3.3 (plus the meta block, the
// determinism rule, the null/throw table and ADR-2): sparse and boundary inputs, numeric limits,
// cross-realm objects, compile-before-run and line mapping. The everyday behaviour is in runtime.test.ts.

import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { type HostHooks, makeParallel, makePipeline, parseScript, runScript } from '../src/runtime.js';
import { assertSatisfiableSchema } from '../src/schema.js';
import type { AgentOpts } from '../src/types.js';

const META = "export const meta = { name: 'test', description: 'd' };\n";
const HOST_API = ['agent', 'args', 'budget', 'log', 'parallel', 'phase', 'pipeline', 'workflow'];

function makeHooks(over: Partial<HostHooks> = {}) {
  return {
    agent: vi.fn(async (prompt: string, _opts?: AgentOpts) => `r:${prompt}`),
    log: vi.fn(),
    onPhase: vi.fn(),
    workflow: vi.fn(async () => 'wf'),
    budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
    ...over,
  };
}

async function run(src: string, args: unknown = {}, over: Partial<HostHooks> = {}) {
  const hooks = makeHooks(over);
  const result = await runScript(parseScript(src), args, hooks);
  return { result: result as any, hooks };
}

/** Resolves with what `p` rejected with; fails when it does not reject. */
async function failure(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

/** Evaluates `expr` (awaited) inside the context; returns { value } or { name, message, code } of the throw. */
async function probe(expr: string, args: unknown = {}) {
  const { result } = await run(
    `${META}try { return { value: await (${expr}) } } catch (e) { return { name: e.name, message: e.message, code: e.code } }`,
    args,
  );
  return result as { value?: unknown; name?: string; message?: string; code?: string };
}

/** `expr` must throw the determinism error: both the code and the message prefix. */
async function expectDeterminismError(expr: string) {
  const r = await probe(expr);
  expect(r.code, expr).toBe('determinism');
  expect(r.message, expr).toMatch(/^determinism: /);
}

function metaCode(src: string): string | undefined {
  try {
    parseScript(src);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('parallel: holes, non-functions and swallowed throws (null/throw table)', () => {
  it('a hole is a "not a function" slot: null, like an explicit undefined', async () => {
    const parallel = makeParallel();
    expect(await parallel([undefined as any, () => Promise.resolve(1)])).toEqual([null, 1]);
    // biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
    const r = await parallel([, () => Promise.resolve(1)] as any);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeNull();
    expect(r[1]).toBe(1);
  });

  it('a hole inside a workflow script yields null', async () => {
    const { result } = await run(`${META}return await parallel([, () => 'b'])`);
    expect(result).toEqual([null, 'b']);
  });

  it('parallel(Array(n).map(...)) from a script returns n nulls, never undefined, and runs no thunk', async () => {
    const { result, hooks } = await run(
      `${META}const r = await parallel(Array(3).map((_, i) => () => agent('p' + i)));\nreturn r.map((x) => x === null ? 'null' : typeof x);`,
    );
    expect(result).toEqual(['null', 'null', 'null']);
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('sync throw, async throw, rejection, non-functions and a thrown non-Error all become null', async () => {
    const parallel = makeParallel();
    const r = await parallel([
      () => {
        throw new Error('sync');
      },
      async () => {
        throw new Error('async');
      },
      () => Promise.reject(new Error('rejected')),
      42 as any,
      undefined as any,
      () => {
        throw undefined;
      },
      () => Promise.resolve('ok'),
    ]);
    expect(r).toEqual([null, null, null, null, null, null, 'ok']);
  });

  it.each([
    ['root is not an object', "{ type: 'string' }"],
    ['required is not in properties', "{ type: 'object', properties: {}, required: ['x'] }"],
  ])(
    'an unsatisfiable schema (%s) inside a thunk nulls that slot only; the host agent is not called for it',
    async (_why, schema) => {
      const { result, hooks } = await run(
        `${META}return await parallel([() => agent('bad', { schema: ${schema} }), () => agent('good')]);`,
      );
      expect(result).toEqual([null, 'r:good']);
      expect(hooks.agent).toHaveBeenCalledTimes(1);
      expect(hooks.agent).toHaveBeenCalledWith('good', undefined);
    },
  );

  it('host results are usable as arrays inside the script', async () => {
    const { result } = await run(
      `${META}const r = await parallel([() => 1, () => { throw 0 }, () => 3]);
       return { isArr: Array.isArray(r), kept: r.filter(Boolean), json: JSON.stringify(r) }`,
    );
    expect(result).toEqual({ isArr: true, kept: [1, 3], json: '[1,null,3]' });
  });

  it('parallel([]) resolves [] and pipeline(items) with zero stages returns the items', async () => {
    const { result } = await run(
      `${META}return { p: await parallel([]), q: await pipeline([1, null, 'x']) }`,
    );
    expect(result.p).toEqual([]);
    expect(result.q).toEqual([1, null, 'x']);
  });
});

describe('pipeline: holes, no barrier, null passes, throw skips (ADR-2)', () => {
  it('a hole in items still runs its stage chain: the stage gets (undefined, undefined, index)', async () => {
    const pipeline = makePipeline();
    const seen: unknown[] = [];
    // biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
    const out = await pipeline([, 'b'] as unknown[], async (prev, item, index) => {
      seen.push(index);
      return `${String(prev)}|${String(item)}|${index}`;
    });
    expect(seen.sort()).toEqual([0, 1]);
    expect(out).toEqual(['undefined|undefined|0', 'b|b|1']);
  });

  it('no barrier: item 1 finishes every stage while item 0 is still blocked in stage 1', async () => {
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
        return prev;
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['s1:1', 's2:1']);
    release();
    expect(await p).toEqual([0, 1]);
    expect(order).toEqual(['s1:1', 's2:1', 's1:0', 's2:0']);
  });

  it('an async stage-1 throw nulls only that item; the later stage runs for the other two', async () => {
    const pipeline = makePipeline();
    const later = vi.fn(async (p: unknown) => `L:${String(p)}`);
    const out = await pipeline(
      [0, 1, 2],
      async (_p, item) => {
        if (item === 1) throw new Error('boom');
        return item;
      },
      later,
    );
    expect(out).toEqual(['L:0', null, 'L:2']);
    expect(later).toHaveBeenCalledTimes(2);
  });

  it('a stage returning null feeds null to the next stage; a stage-1 throw skips the rest for that item', async () => {
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
});

describe('item limit (spec 3.4: 4096 per call, overflow is an explicit error)', () => {
  it('the default limit rejects the whole script (not a silent null) when raised inside the vm', async () => {
    const e = await failure(
      run(`${META}await parallel(new Array(4097).fill(() => 1)); return 'unreachable'`),
    );
    expect(e.code).toBe('item_limit');
  });

  it('hooks.checkItems replaces the default for pipeline() too', async () => {
    const checkItems = vi.fn((n: number) => {
      if (n > 2) throw Object.assign(new Error('cap'), { code: 'item_limit' });
    });
    const e = await failure(run(`${META}return await pipeline([1, 2, 3], (x) => x)`, {}, { checkItems }));
    expect(e.code).toBe('item_limit');
    expect(e.message).toBe('cap');
    expect(checkItems).toHaveBeenCalledWith(3, 'pipeline');
  });
});

describe('meta block: boundaries', () => {
  const metaWith = (extra: string) =>
    `export const meta = { name: 'n', description: 'd'${extra} };\nreturn 1`;

  it.each([
    ['no meta, only a top-level return', 'return 1'],
    ['call in an extra key', metaWith(', x: String(1)')],
    ['trailing spread of an empty object', metaWith(', ...{}')],
    ['void 0', metaWith(', x: void 0')],
    ['the identifier undefined', metaWith(', x: undefined')],
    ['maxAgents: -1', metaWith(', maxAgents: -1')],
    ['maxAgents: -0', metaWith(', maxAgents: -0')],
    ['maxAgents: true', metaWith(', maxAgents: true')],
    ["maxAgents: '3'", metaWith(", maxAgents: '3'")],
    ['maxAgents: 1e400 (Infinity)', metaWith(', maxAgents: 1e400')],
  ])('%s → meta_invalid', (_why, src) => {
    expect(metaCode(src)).toBe('meta_invalid');
  });

  it.each([
    ['1', 1],
    ['1e3', 1000],
    ['1_000', 1000],
    ['1.0', 1],
  ])('maxAgents: %s is accepted as %d', (literal, value) => {
    expect(parseScript(metaWith(`, maxAgents: ${literal}`)).meta.maxAgents).toBe(value);
  });

  it('phases: [] declared means every phase title is unknown, for phase() and agent opts.phase', async () => {
    const src = "export const meta = { name: 'n', description: 'd', phases: [] };\n";
    const hooks = makeHooks();
    expect((await failure(runScript(parseScript(`${src}phase('A')`), {}, hooks))).code).toBe('unknown_phase');
    expect(
      (await failure(runScript(parseScript(`${src}await agent('p', { phase: 'A' })`), {}, hooks))).code,
    ).toBe('unknown_phase');
    expect(hooks.onPhase).not.toHaveBeenCalled();
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('a script that is only the meta line resolves undefined', async () => {
    expect((await run(META)).result).toBeUndefined();
  });
});

describe('compile before run, re-parse, line mapping', () => {
  it('runScript compiles first: a body with a syntax error rejects and no script code or hook runs', async () => {
    // parseScript would already reject this source, so hand runScript the parsed shape directly.
    const body = "agent('x');\nlog('y');\nconst = 1;";
    const hooks = makeHooks();
    const e = await failure(
      runScript({ meta: { name: 'test', description: 'd' }, body, source: body }, {}, hooks),
    );
    expect(e.name).toBe('SyntaxError');
    expect(String(e.stack)).toMatch(/test\.workflow\.js:3\n/);
    expect(hooks.agent).not.toHaveBeenCalled();
    expect(hooks.log).not.toHaveBeenCalled();
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

  it('parsing the same source twice (resume) is identical; a hashbang keeps the body length', () => {
    const src = `#!/usr/bin/env maestro\n${META}return 1`;
    const a = parseScript(src);
    const b = parseScript(src);
    expect(a.body).toBe(b.body);
    expect(a.meta).toEqual(b.meta);
    expect(a.body.length).toBe(src.length);
    expect(a.body.split('\n')[0]).toBe(' '.repeat('#!/usr/bin/env maestro'.length));
  });

  it('stack lines match the original file with a hashbang and with CRLF line endings', async () => {
    const lf = `#!/usr/bin/env maestro\n${META}const x = 1;\nthrow new Error('boom');`;
    const e1 = await failure(run(lf));
    expect(String(e1.stack)).toMatch(/test\.workflow\.js:4:7/);
    const crlf = lf.replace(/\n/g, '\r\n');
    const e2 = await failure(run(crlf));
    expect(String(e2.stack)).toMatch(/test\.workflow\.js:4:7/);
  });

  it('a script-thrown error (context realm) rejects runScript and keeps its own fields', async () => {
    const e = await failure(run(`${META}const err = new Error('x'); err.code = 'mine'; throw err`));
    expect(e.code).toBe('mine');
    expect(e.message).toBe('x');
    expect(e instanceof Error).toBe(false); // context realm: never rely on host instanceof
  });
});

describe('determinism rule (spec 3.3): edge cases', () => {
  it('new Date(undefined) has an argument: allowed (Invalid Date, no clock read)', async () => {
    expect((await probe('String(new Date(undefined).getTime())')).value).toBe('NaN');
  });

  it.each([
    ['spread of an empty array', 'new Date(...[])'],
    ['Reflect.construct', 'Reflect.construct(Date, [])'],
    ['a subclass', '(() => { class D extends Date {}; return new D() })()'],
    ['an instance constructor', 'new (new Date(0).constructor)()'],
  ])('argless Date construction via %s throws the determinism error', async (_why, expr) => {
    await expectDeterminismError(expr);
  });

  it.each([
    ['format() called without new', 'Intl.DateTimeFormat().format()'],
    ['format(undefined)', 'new Intl.DateTimeFormat().format(undefined)'],
    ['formatToParts()', 'new Intl.DateTimeFormat().formatToParts()'],
  ])('Intl.DateTimeFormat %s throws the determinism error', async (_why, expr) => {
    await expectDeterminismError(expr);
  });

  it('toLocaleDateString on an explicit date works', async () => {
    expect((await probe("new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' })")).value).toBe(
      '1/1/1970',
    );
  });

  it.each([
    ['eval', "eval('Date.now()')"],
    ['Function()', "Function('return Math.random()')()"],
    ['new Function()', "new Function('return Math.random()')()"],
  ])('code built with %s inside the context sees the overridden builtins', async (_why, expr) => {
    await expectDeterminismError(expr);
  });

  it.each(['setImmediate', 'queueMicrotask', 'structuredClone', 'performance', 'crypto', 'Buffer'])(
    'host-only global %s is a ReferenceError',
    async (name) => {
      expect((await probe(name)).name).toBe('ReferenceError');
      expect((await probe(`typeof ${name}`)).value).toBe('undefined');
    },
  );

  it('the context adds exactly the eight host API names to a bare vm global and removes console', async () => {
    const leaks = ['process', 'require', 'console', 'setTimeout', 'fetch'];
    const { result } = await run(
      `${META}return { names: Object.getOwnPropertyNames(globalThis), types: args.leaks.map((n) => typeof globalThis[n]) }`,
      { leaks },
    );
    const names = Array.from(result.names as string[]);
    const bare = Array.from(vm.runInNewContext('Object.getOwnPropertyNames(globalThis)') as string[]);
    expect(names.filter((k) => !bare.includes(k)).sort()).toEqual(HOST_API);
    expect(bare.filter((k) => !names.includes(k))).toEqual(['console']);
    expect(result.types).toEqual(leaks.map(() => 'undefined'));
    for (const name of leaks) expect(names, name).not.toContain(name);
  });
});

describe('schemas: cross-realm and nested (null/throw table)', () => {
  it.each([
    [
      'required not in properties',
      "{ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }",
    ],
    ['required with empty properties', "{ type: 'object', properties: {}, required: ['a'] }"],
    [
      'nested via items',
      "{ type: 'object', properties: { xs: { type: 'array', items: { type: 'object', properties: {}, required: ['z'] } } } }",
    ],
    [
      'nested via anyOf',
      "{ type: 'object', properties: { u: { anyOf: [{ type: 'object', properties: { k: {} }, required: ['q'] }] } } }",
    ],
    ['array root', "{ type: 'array', items: {} }"],
  ])(
    'a schema literal authored inside the vm (%s) throws schema_invalid at the call site, not as a rejection',
    async (_why, schema) => {
      const { result, hooks } = await run(
        `${META}let p;\ntry { p = agent('x', { schema: ${schema} }) } catch (e) { return e.code }\nawait p;\nreturn 'no-throw';`,
      );
      expect(result).toBe('schema_invalid');
      expect(hooks.agent).not.toHaveBeenCalled();
    },
  );

  it('host-realm schemas: nested required not in properties via items and anyOf is schema_invalid', () => {
    const viaItems = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { a: {} }, required: ['b'] } },
      },
    };
    const viaAnyOf = {
      type: 'object',
      properties: { v: { anyOf: [{ type: 'object', properties: {}, required: ['z'] }] } },
    };
    expect(() => assertSatisfiableSchema(viaItems)).toThrow(/schema_invalid/);
    expect(() => assertSatisfiableSchema(viaAnyOf)).toThrow(/schema_invalid/);
  });

  it('a valid vm-realm schema with shared (non-cyclic) subschemas is accepted', async () => {
    const { hooks } = await run(
      `${META}const S = { type: 'string' };
       await agent('x', { schema: { type: 'object', properties: { a: S, b: S }, required: ['a', 'b'] } })`,
    );
    expect(hooks.agent).toHaveBeenCalledTimes(1);
  });
});
