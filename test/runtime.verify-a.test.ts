// Adversarial verification of the script runtime against spec 3.3, the determinism rule, the meta block,
// the Host API and the null/throw table (schema, parallel, pipeline, script throw rows), plus ADR-2.
// Tests assert SPEC behaviour; any that fail point at a spec violation in src/runtime.ts / src/schema.ts.
import { describe, expect, it, vi } from 'vitest';
import { type HostHooks, makeParallel, makePipeline, parseScript, runScript } from '../src/runtime.js';
import { assertSatisfiableSchema } from '../src/schema.js';
import type { AgentOpts } from '../src/types.js';

const META = "export const meta = { name: 'verify', description: 'd' };\n";
const META_PHASES =
  "export const meta = { name: 'verify', description: 'd', phases: [{ title: 'Find' }] };\n";

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

async function run(src: string, args: unknown = {}, hooks = makeHooks()) {
  return { result: await runScript(parseScript(src), args, hooks), hooks };
}

/** Evaluates `expr` (awaited) inside the context; returns { value } or the error's { name, message, code }. */
async function probe(expr: string, args: unknown = {}, meta = META) {
  const { result } = await run(
    `${meta}try { return { value: await (${expr}) } } catch (e) { return { name: e && e.name, message: String(e && e.message), code: e && e.code } }`,
    args,
  );
  return result as { value?: unknown; name?: string; message?: string; code?: string };
}

function metaCode(src: string): string | undefined {
  try {
    parseScript(src);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('null/throw table: parallel (spec Level 1, brief "not a function → that slot null")', () => {
  it('a hole in the thunk array is "not a function": its slot is null, not undefined', async () => {
    const parallel = makeParallel();
    // biome-ignore lint/suspicious/noSparseArray: the hole is the input under test
    const out = await parallel([, async () => 1] as unknown as Array<() => Promise<unknown>>);
    expect(out[1]).toBe(1);
    expect(out[0]).toBeNull();
  });

  it('parallel(Array(n).map(...)) from a script returns n nulls, never undefined', async () => {
    const { result } = await run(
      `${META}const r = await parallel(Array(3).map((_, i) => () => agent('p' + i)));\nreturn r.map((x) => x === null ? 'null' : typeof x);`,
    );
    expect(result).toEqual(['null', 'null', 'null']);
  });

  it('never rejects for throwing (sync/async) or non-function thunks', async () => {
    const parallel = makeParallel();
    const out = await parallel([
      () => {
        throw new Error('sync');
      },
      async () => {
        throw new Error('async');
      },
      42 as unknown as () => Promise<unknown>,
      undefined as unknown as () => Promise<unknown>,
      async () => 'ok',
    ]);
    expect(out).toEqual([null, null, null, null, 'ok']);
  });

  it('4096 items pass, 4097 reject with item_limit before any thunk runs', async () => {
    const parallel = makeParallel();
    const ok = await parallel(Array.from({ length: 4096 }, () => async () => 1));
    expect(ok.length).toBe(4096);
    const thunk = vi.fn(async () => 1);
    await expect(parallel(Array.from({ length: 4097 }, () => thunk))).rejects.toMatchObject({
      code: 'item_limit',
    });
    expect(thunk).not.toHaveBeenCalled();
  });

  it('an invalid schema inside a thunk nulls that slot only (thunk throw row)', async () => {
    const hooks = makeHooks();
    const { result } = await run(
      `${META}return await parallel([() => agent('a', { schema: { type: 'string' } }), () => agent('b')]);`,
      {},
      hooks,
    );
    expect(result).toEqual([null, 'r:b']);
    expect(hooks.agent).toHaveBeenCalledTimes(1);
  });
});

describe('null/throw table: pipeline + ADR-2', () => {
  it('a hole in items still runs its stage chain (stage gets (undefined, undefined, index))', async () => {
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

  it('stage 1 receives (item, item, index); later stages (prev, item, index)', async () => {
    const pipeline = makePipeline();
    const out = await pipeline(
      ['x', 'y'],
      async (prev, item, i) => `${prev}${item}${i}`,
      async (prev, item, i) => `${prev}/${item}/${i}`,
    );
    expect(out).toEqual(['xx0/x/0', 'yy1/y/1']);
  });

  it('a throwing stage nulls only that item and skips its remaining stages', async () => {
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

  it('a stage returning null passes null to the next stage as a normal value', async () => {
    const pipeline = makePipeline();
    const out = await pipeline(
      [1],
      async () => null,
      async (prev) => (prev === null ? 'got-null' : 'other'),
    );
    expect(out).toEqual(['got-null']);
  });

  it('no barrier: a fast item finishes all stages while a slow item is still in stage 1', async () => {
    const pipeline = makePipeline();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const events: string[] = [];
    const p = pipeline(
      ['slow', 'fast'],
      async (_p, item) => {
        if (item === 'slow') await slow;
        events.push(`s1:${item}`);
        return item;
      },
      async (prev) => {
        events.push(`s2:${prev}`);
        return prev;
      },
    );
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual(['s1:fast', 's2:fast']);
    releaseSlow();
    expect(await p).toEqual(['slow', 'fast']);
  });

  it('4097 items reject with item_limit before any stage runs', async () => {
    const pipeline = makePipeline();
    const stage = vi.fn(async () => 1);
    await expect(
      pipeline(
        Array.from({ length: 4097 }, (_, i) => i),
        stage,
      ),
    ).rejects.toMatchObject({
      code: 'item_limit',
    });
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('null/throw table: schema + phase throw synchronously at the call site', () => {
  it('unsatisfiable schema throws synchronously (not a rejected promise) and never reaches hooks.agent', async () => {
    const hooks = makeHooks();
    const { result } = await run(
      `${META}let sync = false;\ntry { agent('x', { schema: { type: 'object', properties: {}, required: ['a'] } }) } catch (e) { sync = e.code }\nreturn sync;`,
      {},
      hooks,
    );
    expect(result).toBe('schema_invalid');
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('unknown opts.phase throws unknown_phase synchronously when meta.phases is declared', async () => {
    const r = await probe(
      `(() => { try { agent('x', { phase: 'Nope' }); return 'no-throw' } catch (e) { return e.code } })()`,
      {},
      META_PHASES,
    );
    expect(r.value).toBe('unknown_phase');
  });

  it('meta.phases: [] makes every phase() call throw unknown_phase', async () => {
    const meta = "export const meta = { name: 'v', description: 'd', phases: [] };\n";
    const r = await probe(
      `(() => { try { phase('Any'); return 'no-throw' } catch (e) { return e.code } })()`,
      {},
      meta,
    );
    expect(r.value).toBe('unknown_phase');
  });

  it('unguarded schema throw kills the run (script throw row)', async () => {
    await expect(
      run(`${META}await agent('x', { schema: { type: 'array' } });\nreturn 1;`),
    ).rejects.toMatchObject({
      code: 'schema_invalid',
    });
  });

  it('nested required ⊄ properties via items and anyOf is schema_invalid', () => {
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
});

describe('determinism rule (spec Level 1, 3.3)', () => {
  it('eval and new Function inside the context still hit the overrides', async () => {
    expect((await probe('eval("Date.now()")')).code).toBe('determinism');
    expect((await probe('new Function("return Math.random()")()')).code).toBe('determinism');
  });

  it('argless construction via spread / Reflect.construct throws; Date() without new is TypeError', async () => {
    expect((await probe('new Date(...[])')).code).toBe('determinism');
    expect((await probe('Reflect.construct(Date, [])')).code).toBe('determinism');
    expect((await probe('Date()')).name).toBe('TypeError');
  });

  it('new Date(args.ts) works; Intl format without a date throws, even without new', async () => {
    expect((await probe('new Date(args.ts).toISOString()', { ts: 0 })).value).toBe(
      '1970-01-01T00:00:00.000Z',
    );
    expect((await probe('Intl.DateTimeFormat().format()')).code).toBe('determinism');
    expect((await probe('new Intl.DateTimeFormat().formatToParts()')).code).toBe('determinism');
  });

  it('process, require, fetch, console, setTimeout are ReferenceError; JSON and Math.floor work', async () => {
    for (const g of ['process', 'require', 'fetch', 'console', 'setTimeout']) {
      expect((await probe(g)).name, g).toBe('ReferenceError');
    }
    expect((await probe('JSON.stringify({ a: Math.floor(1.5) })')).value).toBe('{"a":1}');
  });

  it('host-realm Math.random and Date stay intact after a run', async () => {
    await probe('1');
    expect(typeof Math.random()).toBe('number');
    expect(typeof Date.now()).toBe('number');
  });
});

describe('meta block (spec Level 1 "Meta bloğu", 3.3 Hata halleri)', () => {
  const base = "name: 'a', description: 'd'";
  it.each([
    ['missing meta', 'const x = 1;'],
    ['meta not first', `const x = 1;\nexport const meta = { ${base} };`],
    ['variable', `const n = 'a';\nexport const meta = { name: n, description: 'd' };`],
    ['call', `export const meta = { ${base}, x: String(1) };`],
    ['spread', `export const meta = { ${base}, ...{} };`],
    ['void 0', `export const meta = { ${base}, x: void 0 };`],
    ['undefined identifier', `export const meta = { ${base}, x: undefined };`],
    ['template with expression', `export const meta = { ${base}, x: \`a\${1}\` };`],
    ['maxAgents 0', `export const meta = { ${base}, maxAgents: 0 };`],
    ['maxAgents 1.5', `export const meta = { ${base}, maxAgents: 1.5 };`],
    ['maxAgents -1', `export const meta = { ${base}, maxAgents: -1 };`],
    ['export default', `export const meta = { ${base} };\nexport default 1;`],
    ['dynamic import', `export const meta = { ${base} };\nawait import('node:fs');`],
    ['import.meta', `export const meta = { ${base} };\nimport.meta.url;`],
    ['missing description', "export const meta = { name: 'a' };"],
  ])('%s → meta_invalid', (_why, src) => {
    expect(metaCode(src)).toBe('meta_invalid');
  });

  it('syntax error throws a SyntaxError with location before any hook runs', async () => {
    const hooks = makeHooks();
    let err: unknown;
    try {
      await run(`${META}agent('x');\nconst = ;`, {}, hooks);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as { loc?: { line: number } }).loc?.line).toBe(3);
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('the script can read meta; maxAgents is exposed on the parsed meta', async () => {
    const src =
      "export const meta = { name: 'm', description: 'd', maxAgents: 7 };\nreturn meta.name + meta.maxAgents;";
    expect(parseScript(src).meta.maxAgents).toBe(7);
    expect((await run(src)).result).toBe('m7');
  });

  it('a runtime error reports the original source line', async () => {
    const r = await probe('(() => { try { null.x } catch (e) { return e.stack } })()');
    expect(String(r.value)).toMatch(/verify\.workflow\.js:2:/);
  });
});
