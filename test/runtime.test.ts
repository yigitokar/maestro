// Script runtime tests (spec 3.3, determinism rule, meta block, null/throw table, ADR-2).

import { describe, expect, it, vi } from 'vitest';
import { type HostHooks, makeParallel, makePipeline, parseScript, runScript } from '../src/runtime.js';
import type { AgentOpts } from '../src/types.js';
import { MaestroError } from '../src/types.js';

const META = "export const meta = { name: 'test', description: 'd' };\n";
const META_PHASES =
  "export const meta = { name: 'test', description: 'd', phases: [{ title: 'Find' }, { title: 'Verify', detail: 'x' }] };\n";

function makeHooks(over: Partial<HostHooks> = {}) {
  const logs: string[] = [];
  const hooks = {
    agent: vi.fn(async (prompt: string, _opts?: AgentOpts) => `r:${prompt}`),
    log: vi.fn((m: string) => {
      logs.push(m);
    }),
    onPhase: vi.fn(),
    workflow: vi.fn(async () => 'wf'),
    budget: { total: 1000, spent: () => 10, remaining: () => 990 },
    ...over,
  };
  return { hooks, logs };
}

async function run(src: string, args: unknown = {}, over: Partial<HostHooks> = {}) {
  const { hooks, logs } = makeHooks(over);
  const result = await runScript(parseScript(src), args, hooks);
  return { result, hooks, logs };
}

/** Runs `expr` in the context and returns how it failed: { name, message, code } or { value }. */
async function probe(expr: string, args: unknown = {}) {
  const { result } = await run(
    `${META}try { return { value: (${expr}) } } catch (e) { return { name: e.name, message: e.message, code: e.code } }`,
    args,
  );
  return result as { value?: unknown; name?: string; message?: string; code?: string };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('determinism overrides', () => {
  it('Date.now() throws', async () => {
    const r = await probe('Date.now()');
    expect(r.message).toMatch(/^determinism: Date\.now\(\)/);
    expect(r.code).toBe('determinism');
  });

  it('new Date() throws', async () => {
    const r = await probe('new Date()');
    expect(r.message).toMatch(/^determinism: new Date\(\)/);
  });

  it('Date() without new throws TypeError', async () => {
    const r = await probe('Date()');
    expect(r.name).toBe('TypeError');
  });

  it('new Date(args.ts) works and gives the right time', async () => {
    const ts = Date.UTC(2026, 9, 25, 12, 30);
    const r = await probe('[new Date(args.ts).getTime(), new Date(args.ts).toISOString()]', { ts });
    expect(r.value).toEqual([ts, '2026-10-25T12:30:00.000Z']);
    const r2 = await probe("new Date('2026-10-25T00:00:00Z').getUTCDate()");
    expect(r2.value).toBe(25);
  });

  it('Date.parse and Date.UTC work', async () => {
    const r = await probe("[Date.parse('2026-10-25T00:00:00Z'), Date.UTC(2026, 9, 25)]");
    expect(r.value).toEqual([Date.parse('2026-10-25T00:00:00Z'), Date.UTC(2026, 9, 25)]);
  });

  it('Math.random() throws, Math.floor works', async () => {
    const r = await probe('Math.random()');
    expect(r.message).toMatch(/^determinism: Math\.random\(\)/);
    expect((await probe('Math.floor(2.7)')).value).toBe(2);
  });

  it('Intl.DateTimeFormat#format without a date throws, with a date works', async () => {
    const r = await probe("new Intl.DateTimeFormat('en-US').format()");
    expect(r.message).toMatch(/^determinism:/);
    const ok = await probe("new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(new Date(0))");
    expect(ok.value).toBe('1/1/1970');
    expect((await probe("new Intl.DateTimeFormat('en-US').formatToParts()")).message).toMatch(
      /^determinism:/,
    );
  });

  it.each(['process', 'require', 'fetch', 'console', 'setTimeout'])(
    '%s is a ReferenceError',
    async (name) => {
      expect((await probe(name)).name).toBe('ReferenceError');
      expect((await probe(`typeof ${name}`)).value).toBe('undefined');
    },
  );

  it('JSON.stringify works', async () => {
    expect((await probe('JSON.stringify({ a: [1, 2] })')).value).toBe('{"a":[1,2]}');
  });

  it('the host realm Math.random and Date are not affected', async () => {
    await probe('Math.random()');
    await probe('Date.now()');
    expect(typeof Math.random()).toBe('number');
    expect(typeof Date.now()).toBe('number');
    expect(new Date()).toBeInstanceOf(Date);
    expect(typeof new Intl.DateTimeFormat('en-US').format()).toBe('string');
    expect(typeof console.log).toBe('function');
  });

  it('only the host API is injected as globals', async () => {
    const r = await probe(
      "['agent','parallel','pipeline','phase','log','args','budget','workflow'].map((n) => typeof globalThis[n])",
    );
    expect(r.value).toEqual([
      'function',
      'function',
      'function',
      'function',
      'function',
      'object',
      'object',
      'function',
    ]);
  });
});

describe('script execution', () => {
  it('reads args and meta', async () => {
    const { result } = await run(`${META}return { x: args.x, name: meta.name, d: meta.description }`, {
      x: 42,
    });
    expect(result).toEqual({ x: 42, name: 'test', d: 'd' });
  });

  it('supports top-level await and top-level return', async () => {
    const { result, hooks } = await run(`${META}const a = await agent('p1');\nreturn [a, 'done'];`);
    expect(result).toEqual(['r:p1', 'done']);
    expect(hooks.agent).toHaveBeenCalledWith('p1', undefined);
  });

  it('passes log, phase, budget and workflow through to the hooks', async () => {
    const { result, hooks, logs } = await run(
      `${META}log('hi'); phase('anything'); const w = await workflow('child', { a: 1 });\n` +
        'return [w, budget.total, budget.spent(), budget.remaining()];',
    );
    expect(result).toEqual(['wf', 1000, 10, 990]);
    expect(logs).toEqual(['hi']);
    expect(hooks.onPhase).toHaveBeenCalledWith('anything');
    expect(hooks.workflow).toHaveBeenCalledWith('child', { a: 1 });
  });

  it('script throw rejects runScript', async () => {
    await expect(run(`${META}throw new Error('boom')`)).rejects.toThrow('boom');
  });

  it('syntax error rejects before any hook is called', async () => {
    const { hooks } = makeHooks();
    const src = `${META}agent('x');\nconst = 1;`;
    await expect(async () => runScript(parseScript(src), {}, hooks)).rejects.toThrow(SyntaxError);
    expect(() => parseScript(src)).toThrow(/\(3:6\)/);
    expect(hooks.agent).not.toHaveBeenCalled();
    expect(hooks.log).not.toHaveBeenCalled();
  });

  it('error line numbers point at the original source line', async () => {
    const src = `${META}\nconst x = 1;\nthrow new Error('line four');\n`;
    let stack = '';
    try {
      await runScript(parseScript(src), {}, makeHooks().hooks, { filename: 'wf.js' });
    } catch (e) {
      stack = String((e as Error).stack);
    }
    expect(stack).toMatch(/wf\.js:4:7/);
  });

  it('runtime errors on the meta line keep their columns', async () => {
    const src = "export const meta = { name: 'n', description: 'd' }; null.x;";
    let stack = '';
    try {
      await runScript(parseScript(src), {}, makeHooks().hooks, { filename: 'm.js' });
    } catch (e) {
      stack = String((e as Error).stack);
    }
    expect(stack).toMatch(/m\.js:1:/);
  });
});

describe('meta block', () => {
  const invalid = (src: string) => {
    try {
      parseScript(src);
    } catch (e) {
      return e instanceof MaestroError ? e.code : `other:${String(e)}`;
    }
    return 'parsed';
  };

  it('accepts a valid meta and returns it', () => {
    const p = parseScript(`${META_PHASES}return 1`);
    expect(p.meta).toEqual({
      name: 'test',
      description: 'd',
      phases: [{ title: 'Find' }, { title: 'Verify', detail: 'x' }],
    });
    expect(p.body.split('\n').length).toBe(p.source.split('\n').length);
    expect(p.body).toMatch(/^ {6} const meta/);
  });

  it('accepts nested arrays of literal objects, templates without expressions, negative numbers', () => {
    const p = parseScript(
      "export const meta = { name: `n`, description: 'd', 'maxAgents': 3, phases: [{ title: 'A', detail: `x` }], " +
        'whenToUse: "w" };\nconst x = [[{ a: -1 }]];',
    );
    expect(p.meta.maxAgents).toBe(3);
    const nested = parseScript(
      "export const meta = { name: 'n', description: 'd', extra: [[{ a: [1, -2, `t`] }, { b: null }], []] };",
    );
    expect((nested.meta as unknown as Record<string, unknown>).extra).toEqual([
      [{ a: [1, -2, 't'] }, { b: null }],
      [],
    ]);
    expect(invalid("export const meta = { name: 'n', description: 'd', extra: [[{ a: [x] }]] };")).toBe(
      'meta_invalid',
    );
    expect(p.meta.phases).toEqual([{ title: 'A', detail: 'x' }]);
    expect(
      invalid(
        "export const meta = { name: 'n', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }",
      ),
    ).toBe('parsed');
  });

  it.each([
    ['missing meta', 'const x = 1;'],
    ['empty source', ''],
    ['meta not first', "const y = 1;\nexport const meta = { name: 'n', description: 'd' };"],
    ['let instead of const', "export let meta = { name: 'n', description: 'd' };"],
    ['not an object', "export const meta = 'x';"],
    ['identifier value', "const N = 'n';\nexport const meta = { name: N, description: 'd' };"],
    ['identifier value (first)', "export const meta = { name: N, description: 'd' };"],
    ['call', "export const meta = { name: String('n'), description: 'd' };"],
    ['spread', "export const meta = { ...{ name: 'n' }, description: 'd' };"],
    ['array spread', "export const meta = { name: 'n', description: 'd', phases: [...[]] };"],
    ['template with expression', 'export const meta = { name: `n$' + "{1}`, description: 'd' };"],
    ['computed key', "export const meta = { ['name']: 'n', description: 'd' };"],
    ['shorthand', "const name = 'n';\nexport const meta = { name, description: 'd' };"],
    ['method', "export const meta = { name: 'n', description: 'd', f() {} };"],
    ['getter', "export const meta = { get name() { return 'n' }, description: 'd' };"],
    ['regex', "export const meta = { name: 'n', description: 'd', r: /x/ };"],
    ['array hole', "export const meta = { name: 'n', description: 'd', phases: [, { title: 'A' }] };"],
    ['missing name', "export const meta = { description: 'd' };"],
    ['empty name', "export const meta = { name: '', description: 'd' };"],
    ['missing description', "export const meta = { name: 'n' };"],
    ['bad phases', "export const meta = { name: 'n', description: 'd', phases: [{ detail: 'x' }] };"],
    ['phases not array', "export const meta = { name: 'n', description: 'd', phases: { title: 'A' } };"],
    ['maxAgents zero', "export const meta = { name: 'n', description: 'd', maxAgents: 0 };"],
    ['maxAgents fraction', "export const meta = { name: 'n', description: 'd', maxAgents: 1.5 };"],
    ['maxAgents negative', "export const meta = { name: 'n', description: 'd', maxAgents: -2 };"],
    ['extra export', `${META}export const other = 1;`],
    ['export default', `${META}export default 1;`],
    ['import statement', `${META}import fs from 'node:fs';`],
    ['dynamic import', `${META}const m = await import('node:fs');`],
    ['import.meta', `${META}const u = import.meta.url;`],
  ])('%s → meta_invalid', (_name, src) => {
    expect(invalid(src)).toBe('meta_invalid');
  });
});

describe('phase validation', () => {
  it('phase() with an undeclared title throws unknown_phase when meta.phases exists', async () => {
    const { hooks } = makeHooks();
    const p = runScript(parseScript(`${META_PHASES}phase('Find'); phase('Nope');`), {}, hooks);
    expect(await codeOf(p)).toBe('unknown_phase');
    expect(hooks.onPhase).toHaveBeenCalledTimes(1);
    expect(hooks.onPhase).toHaveBeenCalledWith('Find');
  });

  it('phase() accepts any title when meta.phases is absent', async () => {
    const { hooks } = await run(`${META}phase('Whatever'); phase('Else');`);
    expect(hooks.onPhase).toHaveBeenCalledTimes(2);
  });

  it('agent opts.phase is validated the same way, synchronously', async () => {
    const { result, hooks } = await run(
      `${META_PHASES}let sync = false;\ntry { agent('p', { phase: 'Nope' }) } catch (e) { sync = e.code }\n` +
        "await agent('ok', { phase: 'Verify' });\nreturn sync;",
    );
    expect(result).toBe('unknown_phase');
    expect(hooks.agent).toHaveBeenCalledTimes(1);
    expect(hooks.agent).toHaveBeenCalledWith('ok', { phase: 'Verify' });
    const free = await run(`${META}return agent('p', { phase: 'Anything' })`);
    expect(free.result).toBe('r:p');
  });
});

describe('agent schema check', () => {
  it.each([
    ['root not object', "{ type: 'array', items: { type: 'string' } }"],
    [
      'required not subset',
      "{ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'] }",
    ],
    [
      'nested required not subset',
      "{ type: 'object', properties: { x: { type: 'object', properties: {}, required: ['q'] } } }",
    ],
  ])('%s → throws synchronously at call, hook not called', async (_n, schema) => {
    const { result, hooks } = await run(
      `${META}let code = null;\ntry { agent('p', { schema: ${schema} }) } catch (e) { code = e.code }\nreturn code;`,
    );
    expect(result).toBe('schema_invalid');
    expect(hooks.agent).not.toHaveBeenCalled();
  });

  it('a satisfiable schema reaches the hook', async () => {
    const { hooks } = await run(
      `${META}await agent('p', { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } })`,
    );
    expect(hooks.agent).toHaveBeenCalledTimes(1);
  });

  it('an unguarded schema throw kills the run', async () => {
    const { hooks } = makeHooks();
    const p = runScript(parseScript(`${META}await agent('p', { schema: { type: 'string' } })`), {}, hooks);
    expect(await codeOf(p)).toBe('schema_invalid');
  });
});

describe('parallel', () => {
  it('throwing thunks (sync and async) and non-functions become null; never rejects', async () => {
    const parallel = makeParallel();
    const out = await parallel([
      async () => 1,
      () => {
        throw new Error('sync');
      },
      async () => {
        throw new Error('async');
      },
      () => Promise.reject(new Error('rejected')),
      'nope' as unknown as () => Promise<unknown>,
      async () => null,
      async () => 'last',
    ]);
    expect(out).toEqual([1, null, null, null, null, null, 'last']);
  });

  it('works from a script, including agent() inside thunks', async () => {
    const { result } = await run(
      `${META}return parallel([() => agent('a'), () => { throw new Error('x') }, async () => { await null; throw 1 }, () => agent('b')])`,
    );
    expect(result).toEqual(['r:a', null, null, 'r:b']);
  });

  it('4097 items reject with item_limit (thunks not called)', async () => {
    const thunk = vi.fn(async () => 1);
    const parallel = makeParallel();
    expect(await codeOf(parallel(Array.from({ length: 4097 }, () => thunk)))).toBe('item_limit');
    expect(thunk).not.toHaveBeenCalled();
    expect((await parallel(Array.from({ length: 4096 }, () => thunk))).length).toBe(4096);
  });

  it('uses hooks.checkItems inside scripts', async () => {
    const checkItems = vi.fn((n: number, where: 'parallel' | 'pipeline') => {
      if (n > 2) throw new MaestroError(`too many for ${where}`, 'item_limit');
    });
    const { hooks } = makeHooks({ checkItems });
    const p = runScript(parseScript(`${META}await parallel([() => 1, () => 2, () => 3])`), {}, hooks);
    expect(await codeOf(p)).toBe('item_limit');
    expect(checkItems).toHaveBeenCalledWith(3, 'parallel');
  });
});

describe('pipeline', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('4097 items reject with item_limit (stages not called)', async () => {
    const stage = vi.fn(async () => 1);
    const pipeline = makePipeline();
    expect(
      await codeOf(
        pipeline(
          Array.from({ length: 4097 }, (_, i) => i),
          stage,
        ),
      ),
    ).toBe('item_limit');
    expect(stage).not.toHaveBeenCalled();
  });

  it('has no barrier: item A reaches stage 2 while item B is still in stage 1', async () => {
    const events: string[] = [];
    const agent = vi.fn(async (prompt: string) => {
      events.push(`start:${prompt}`);
      await sleep(prompt === 's1:B' ? 120 : 10);
      events.push(`done:${prompt}`);
      return prompt;
    });
    const { result } = await run(
      `${META}return pipeline(['A', 'B'], (x) => agent('s1:' + x), (prev, x) => agent('s2:' + x))`,
      {},
      { agent },
    );
    expect(result).toEqual(['s2:A', 's2:B']);
    expect(events.indexOf('start:s2:A')).toBeGreaterThan(-1);
    expect(events.indexOf('start:s2:A')).toBeLessThan(events.indexOf('done:s1:B'));
    expect(events.indexOf('done:s2:A')).toBeLessThan(events.indexOf('done:s1:B'));
  });

  it('passes (prev, item, index); stage 1 gets the item as prev', async () => {
    const pipeline = makePipeline();
    const seen: unknown[] = [];
    const out = await pipeline(
      ['x', 'y'],
      async (prev, item, index) => {
        seen.push(['s1', prev, item, index]);
        return `${String(prev)}1`;
      },
      async (prev, item, index) => {
        seen.push(['s2', prev, item, index]);
        return `${String(prev)}2`;
      },
    );
    expect(out).toEqual(['x12', 'y12']);
    expect(seen).toContainEqual(['s1', 'x', 'x', 0]);
    expect(seen).toContainEqual(['s1', 'y', 'y', 1]);
    expect(seen).toContainEqual(['s2', 'x1', 'x', 0]);
    expect(seen).toContainEqual(['s2', 'y1', 'y', 1]);
  });

  it('a throwing stage nulls the item and skips its later stages; other items continue', async () => {
    const pipeline = makePipeline();
    const stage3 = vi.fn(async (prev: unknown) => `${String(prev)}!`);
    const out = await pipeline(
      [1, 2, 3],
      async (prev) => prev,
      (prev) => {
        if (prev === 2) throw new Error('sync');
        if (prev === 3) return Promise.reject(new Error('async'));
        return prev;
      },
      stage3,
    );
    expect(out).toEqual(['1!', null, null]);
    expect(stage3).toHaveBeenCalledTimes(1);
    expect(stage3).toHaveBeenCalledWith(1, 1, 0);
  });

  it('a stage that returns null passes null to the next stage, which runs', async () => {
    const pipeline = makePipeline();
    const next = vi.fn(async (prev: unknown, item: unknown) =>
      prev === null ? `recovered:${String(item)}` : prev,
    );
    const out = await pipeline(['a'], async () => null, next);
    expect(next).toHaveBeenCalledWith(null, 'a', 0);
    expect(out).toEqual(['recovered:a']);
  });

  it('works from a script with the spec example shape', async () => {
    const { result } = await run(
      `${META}const r = await pipeline([{ k: 'a' }, { k: 'b' }],\n` +
        "  (d) => agent('find:' + d.k),\n" +
        "  async (found, d, i) => found === 'r:find:b' ? null : found + '|' + d.k + '|' + i);\nreturn r;",
    );
    expect(result).toEqual(['r:find:a|a|0', null]);
  });
});
