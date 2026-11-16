// Workflow tool surface through run() (spec Seviye 1 null/throw table + determinism, Seviye 2 data flow
// steps 1-7, 3.7 events). FakeRunner only; never the network.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicRunner } from '../src/runner.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { Entry, WorkflowEvent } from '../src/types.js';
import { type RunHandle, type RunOptions, run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-wf-'));
  dirs.push(d);
  return d;
}

const META = (extra = '') => `export const meta = { name: 'wf', description: 'd'${extra} };\n`;

function start(dir: string, opts: RunOptions): { handle: RunHandle; events: WorkflowEvent[] } {
  const handle = run({ cwd: dir, stateDir: path.join(dir, 'state'), concurrency: 4, ...opts });
  const events: WorkflowEvent[] = [];
  handle.events.on('event', (e: WorkflowEvent) => events.push(e));
  return { handle, events };
}

function rows(runDir: string): Entry[] {
  const p = path.join(runDir, 'journal.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Entry);
}

const logs = (events: WorkflowEvent[]) =>
  events.filter((e): e is Extract<WorkflowEvent, { type: 'log' }> => e.type === 'log').map((e) => e.message);

describe('scheduler through run()', () => {
  it('32 agents in parallel with an explicit concurrency of 16: exactly 16 live runner calls at the peak', async () => {
    const dir = await tmp();
    // Explicit, never the machine default (min(16, cpus - 2)).
    const concurrency = 16;
    const runner = new FakeRunner(() => ({ delayMs: 25 }));
    const { handle } = start(dir, {
      runner,
      concurrency,
      script: `${META()}const r = await parallel(Array.from({ length: 32 }, (_, i) => () => agent('task ' + i)));
return r.filter(Boolean).length;`,
    });
    expect(await handle.promise).toBe(32);
    expect(runner.liveCalls).toBe(32);
    expect(runner.maxConcurrent).toBe(concurrency);
  });
});

describe('null/throw table', () => {
  it('16 agents, budget 20k, floor 5k: exactly 4 runner calls, 12 null slots, the drops are logged', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ delayMs: 10 }));
    const { handle, events } = start(dir, {
      runner,
      concurrency: 16,
      budget: 20_000,
      script: `${META()}const r = await parallel(Array.from({ length: 16 }, (_, i) => () => agent('task ' + i)));
log('dropped ' + r.filter((x) => x === null).length + '/16');
return r;`,
    });
    const r = (await handle.promise) as unknown[];
    expect(runner.liveCalls).toBe(4);
    expect(r.filter((x) => x === null)).toHaveLength(12);
    const slotLogs = logs(events).filter((m) => /^parallel slot \d+ null: .*budget exceeded/.test(m));
    expect(slotLogs).toHaveLength(12);
    expect(logs(events)).toContain('dropped 12/16');
    expect(logs(events)[0]).toMatch(/^budget: total 20000, overrun ceiling \d+/);
    // Budget throws are script-level: no journal row for them.
    expect(rows(handle.runDir)).toHaveLength(4);
  });

  it('meta.maxAgents 3: the 4th live agent() throws agent_cap; cached hits do not count', async () => {
    const dir = await tmp();
    const body = `const out = [];
for (const p of args.prompts) {
  try { out.push(await agent(p)); } catch (e) { out.push(e.code); }
}
return out;`;
    const r1 = new FakeRunner();
    const first = start(dir, {
      runner: r1,
      script: `${META(', maxAgents: 3')}${body}`,
      args: { prompts: ['a', 'b', 'c', 'd'] },
    });
    const v1 = (await first.handle.promise) as unknown[];
    expect(v1[3]).toBe('agent_cap');
    expect(r1.liveCalls).toBe(3);

    // Resume: a, b, c are cached and free; x, y, z are the 3 live ones; w is the 4th live → throws.
    const r2 = new FakeRunner();
    const second = start(dir, {
      runner: r2,
      resumeFromRunId: first.handle.runId,
      args: { prompts: ['a', 'b', 'c', 'x', 'y', 'z', 'w'] },
    });
    const v2 = (await second.handle.promise) as unknown[];
    expect(v2.slice(0, 3)).toEqual(v1.slice(0, 3));
    expect(v2.slice(3, 6).every((v) => typeof v === 'string' && v.startsWith('fake result'))).toBe(true);
    expect(v2[6]).toBe('agent_cap');
    expect(r2.liveCalls).toBe(3);
  });

  it('an invalid or unsatisfiable schema throws schema_invalid; the runner is never called', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      script: `${META()}const codes = [];
try { await agent('x', { schema: { type: 'array' } }); } catch (e) { codes.push(e.code); }
try { await agent('y', { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }); }
catch (e) { codes.push(e.code); }
return codes;`,
    });
    expect(await handle.promise).toEqual(['schema_invalid', 'schema_invalid']);
    expect(runner.liveCalls).toBe(0);
    expect(rows(handle.runDir)).toHaveLength(0);

    const uncaught = start(dir, {
      runner,
      script: `${META()}return await agent('x', { schema: { type: 'string' } });`,
    });
    await expect(uncaught.handle.promise).rejects.toMatchObject({ code: 'schema_invalid' });
    expect(runner.liveCalls).toBe(0);
  });

  it('a write tool without isolation, an unknown tool and a bad isolation value throw; the runner is never called', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      script: `${META()}const out = [];
try { await agent('x', { tools: ['read_file', 'write_file'] }); } catch (e) { out.push(e.code); }
try { await agent('y', { tools: ['nope'] }); } catch (e) { out.push(e.code); }
try { await agent('z', { isolation: 'copy' }); } catch (e) { out.push(e.name); }
return out;`,
    });
    expect(await handle.promise).toEqual(['write_tool_without_isolation', 'unknown_tool', 'TypeError']);
    expect(runner.liveCalls).toBe(0);
  });

  it('a runner that throws (terminal API error) makes agent() null and journals a null row', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req) => {
      if (req.prompt === 'bad') throw new Error('500 from api');
      return {};
    });
    const { handle } = start(dir, {
      runner,
      script: `${META()}return [await agent('bad'), await agent('good')];`,
    });
    const v = (await handle.promise) as unknown[];
    expect(v[0]).toBeNull();
    expect(v[1]).toMatch(/^fake result/);
    const [bad] = rows(handle.runDir);
    expect(bad).toMatchObject({ status: 'null', result: null, error: '500 from api' });
  });

  it('a script throw rejects the run', async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      script: `${META()}await agent('a');\nthrow new Error('boom');`,
    });
    await expect(handle.promise).rejects.toThrow('boom');
    // The agent before the throw is journaled; the run dir stays for a resume.
    expect(rows(handle.runDir)).toHaveLength(1);
  });

  it('a syntax error or missing meta rejects before any agent runs', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const syntax = start(dir, { runner, script: `${META()}await agent('a');\nconst = 1;` });
    await expect(syntax.handle.promise).rejects.toBeInstanceOf(SyntaxError);
    const noMeta = start(dir, { runner, script: `await agent('a');\nreturn 1;` });
    await expect(noMeta.handle.promise).rejects.toMatchObject({ code: 'meta_invalid' });
    const badMeta = start(dir, {
      runner,
      script: `const x = 'n';\nexport const meta = { name: x, description: 'd' };\nreturn 1;`,
    });
    await expect(badMeta.handle.promise).rejects.toMatchObject({ code: 'meta_invalid' });
    expect(runner.liveCalls).toBe(0);
    // A broken script never creates (or replaces) a run dir.
    expect(existsSync(syntax.handle.runDir)).toBe(false);
    expect(existsSync(noMeta.handle.runDir)).toBe(false);
    expect(existsSync(badMeta.handle.runDir)).toBe(false);
  });

  it('Date.now() / Math.random() in a script reject the run', async () => {
    const dir = await tmp();
    const a = start(dir, { runner: new FakeRunner(), script: `${META()}return agent('t ' + Date.now());` });
    await expect(a.handle.promise).rejects.toThrow(/determinism/);
    const b = start(dir, { runner: new FakeRunner(), script: `${META()}return Math.random();` });
    await expect(b.handle.promise).rejects.toThrow(/determinism/);
  });

  it('stop() mid-run rejects run_stopped; aborted agents are journaled skipped; resume finishes them', async () => {
    const dir = await tmp();
    const runner = new FakeRunner([
      { match: 'fast', respond: {} },
      { match: 'slow', respond: { turns: 200, delayMs: 10 } },
    ]);
    const { handle } = start(dir, {
      runner,
      script: `${META()}const r = await parallel([() => agent('fast', { label: 'F' }), () => agent('slow 1'), () => agent('slow 2')]);
await agent('after');
return r;`,
    });
    // Stop as soon as 'fast' has finished, while both slow agents are mid-run.
    handle.events.on('agent_end', (e: Extract<WorkflowEvent, { type: 'agent_end' }>) => {
      if (e.label === 'F') handle.stop('user');
    });
    await expect(handle.promise).rejects.toMatchObject({ code: 'run_stopped' });
    const r = rows(handle.runDir);
    expect(r.map((e) => e.status).sort()).toEqual(['ok', 'skipped', 'skipped']);
    expect(r.filter((e) => e.status === 'skipped').every((e) => /run stopped/.test(e.error ?? ''))).toBe(
      true,
    );
    expect(runner.calls.map((c) => c.prompt)).not.toContain('after');

    // W-07: journal stays, the resume serves 'fast' from cache and runs the rest live.
    const r2 = new FakeRunner();
    const again = start(dir, { runner: r2, resumeFromRunId: handle.runId });
    expect(await again.handle.promise).toHaveLength(3);
    expect(r2.calls.map((c) => c.prompt).sort()).toEqual(['after', 'slow 1', 'slow 2']);
  });

  it('skip(id): that agent() returns null with a skipped row, the others continue', async () => {
    const dir = await tmp();
    let handle!: RunHandle;
    let slowId: number | undefined;
    let skipped: boolean | undefined;
    const runner = new FakeRunner([
      {
        match: 'slow',
        // Skip from inside the live runner call (one macrotask later): the agent is mid-run by then.
        respond: () => {
          setImmediate(() => {
            skipped = handle.skip(slowId!);
          });
          return { turns: 1000, delayMs: 10 };
        },
      },
      { match: /./, respond: { delayMs: 30 } },
    ]);
    ({ handle } = start(dir, {
      runner,
      script: `${META()}return await parallel([() => agent('a'), () => agent('slow', { label: 'S' }), () => agent('c')]);`,
    }));
    handle.events.on('agent_start', (e: Extract<WorkflowEvent, { type: 'agent_start' }>) => {
      if (e.label === 'S') slowId = e.id;
    });
    const v = (await handle.promise) as unknown[];
    expect(skipped).toBe(true);
    expect(runner.calls.map((c) => c.prompt).sort()).toEqual(['a', 'c', 'slow']);
    expect(v[0]).toMatch(/^fake result/);
    expect(v[1]).toBeNull();
    expect(v[2]).toMatch(/^fake result/);
    const s = rows(handle.runDir).find((e) => e.label === 'S')!;
    expect(s).toMatchObject({ status: 'skipped', result: null, error: 'skipped by user' });
    expect(handle.skip(999)).toBe(false);
  });

  it('an agent queued for a slot and skipped never reaches the runner', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ delayMs: 40 }));
    const { handle } = start(dir, {
      runner,
      concurrency: 1,
      script: `${META()}return await parallel([() => agent('first'), () => agent('queued', { label: 'Q' })]);`,
    });
    handle.events.on('agent_start', (e: Extract<WorkflowEvent, { type: 'agent_start' }>) => {
      if (e.label === 'Q') handle.skip(e.id);
    });
    const v = (await handle.promise) as unknown[];
    expect(v[1]).toBeNull();
    expect(runner.calls.map((c) => c.prompt)).toEqual(['first']);
    expect(rows(handle.runDir).find((e) => e.label === 'Q')?.status).toBe('skipped');
  });
});

describe('data flow', () => {
  it('step 7: the journal row is on disk before agent() resolves', async () => {
    const dir = await tmp();
    let handle!: RunHandle;
    const seenOnDisk: string[][] = [];
    const runner = new FakeRunner(() => {
      seenOnDisk.push(rows(handle.runDir).map((e) => e.label ?? ''));
      return {};
    });
    ({ handle } = start(dir, {
      runner,
      script: `${META()}await agent('one', { label: 'one' });\nawait agent('two', { label: 'two' });\nreturn agent('three', { label: 'three' });`,
    }));
    await handle.promise;
    expect(seenOnDisk).toEqual([[], ['one'], ['one', 'two']]);
  });

  it('runner request: default read-only tools, inherited model, opts.model / effort pass through', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      model: 'main-model',
      script: `${META()}await agent('a');\nawait agent('b', { model: 'm2', effort: 'high', tools: ['grep'] });\nreturn 1;`,
    });
    await handle.promise;
    const [a, b] = runner.calls;
    expect(a!.model).toBe('main-model');
    expect(a!.tools.map((t) => t.name)).toEqual(['read_file', 'grep', 'glob', 'bash']);
    expect(a!.isolated).toBe(false);
    expect(a!.cwd).toBe(path.resolve(dir));
    expect(a!.system).toContain('Your final message IS the return value of this call');
    expect(b!.model).toBe('m2');
    expect(b!.effort).toBe('high');
    expect(b!.tools.map((t) => t.name)).toEqual(['grep']);
  });

  it('args reach the script unchanged and the return value is the run result', async () => {
    const dir = await tmp();
    const args = { a: [1, { b: null }], s: 'ş', ts: '2026-10-25T00:00:00Z' };
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      args,
      script: `${META()}return { args, year: new Date(args.ts).getUTCFullYear() };`,
    });
    expect(await handle.promise).toEqual({ args, year: 2026 });
  });
});

describe('events (spec 3.7)', () => {
  it('agent_start/agent_end/phase/log/budget_tick with their payloads; default phase = last phase()', async () => {
    const dir = await tmp();
    const runner = new FakeRunner([{ match: 'b', respond: { turns: 2, outputTokensPerTurn: 30 } }]);
    const script = `${META(", phases: [{ title: 'Find' }, { title: 'Verify' }]")}phase('Find');
await agent('a', { label: 'A' });
log('hello');
await agent('b', { label: 'B', phase: 'Verify' });
phase('Verify');
return agent('c');`;
    const { handle, events } = start(dir, { runner, budget: 1_000_000, script });
    await handle.promise;
    const runId = handle.runId;
    const noTicks = events.filter(
      (e) => e.type !== 'budget_tick' && e.type !== 'log' && e.type !== 'agent_status',
    );
    expect(events.some((e) => e.type === 'agent_status' && e.agent.state === 'queued')).toBe(true);
    expect(events.some((e) => e.type === 'agent_status' && e.agent.state === 'running')).toBe(true);
    expect(noTicks.map((e) => e.type)).toEqual([
      'phase',
      'agent_start',
      'agent_end',
      'agent_start',
      'agent_end',
      'phase',
      'agent_start',
      'agent_end',
    ]);
    const [, aStart, aEnd, bStart, bEnd, , cStart] = noTicks;
    expect(noTicks[0]).toEqual({ type: 'phase', runId, title: 'Find' });
    expect(aStart).toMatchObject({ type: 'agent_start', runId, id: 0, label: 'A', phase: 'Find' });
    expect(aEnd).toMatchObject({
      type: 'agent_end',
      id: 0,
      label: 'A',
      phase: 'Find',
      status: 'ok',
      cached: false,
      usage: { input_tokens: 50, output_tokens: 100 },
    });
    expect((aStart as { key: string }).key).toMatch(/^[0-9a-f]{64}:0$/);
    expect(bStart).toMatchObject({ id: 1, phase: 'Verify' });
    expect(bEnd).toMatchObject({ usage: { input_tokens: 100, output_tokens: 60 } });
    expect(cStart).toMatchObject({ id: 2, phase: 'Verify' });
    expect(cStart).not.toHaveProperty('label');
    expect(events.find((e) => e.type === 'log' && e.message === 'hello')).toEqual({
      type: 'log',
      runId,
      message: 'hello',
    });
    const ticks = events.filter((e) => e.type === 'budget_tick');
    expect(ticks.map((t) => (t as { spent: number }).spent)).toEqual([100, 130, 160, 260]);
    expect(ticks[0]).toEqual({
      type: 'budget_tick',
      runId,
      spent: 100,
      total: 1_000_000,
      remaining: 999_900,
    });
    // Journal rows carry the effective phase, too.
    expect(rows(handle.runDir).map((e) => e.phase)).toEqual(['Find', 'Verify', 'Verify']);

    // Resume: every agent is a cache hit and still shows up, marked cached.
    const again = start(dir, { runner: new FakeRunner(), resumeFromRunId: runId, budget: 1_000_000 });
    await again.handle.promise;
    const ends = again.events.filter((e) => e.type === 'agent_end');
    expect(ends).toHaveLength(3);
    expect(ends.every((e) => e.type === 'agent_end' && e.cached && e.status === 'ok')).toBe(true);
    expect(again.events.filter((e) => e.type === 'agent_start')).toHaveLength(3);
    expect(again.events.some((e) => e.type === 'budget_tick')).toBe(false);
  });

  it("events are also emitted under their type name; a listener's throw does not break the run", async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      script: `${META()}log('x');\nreturn agent('a');`,
    });
    const seen: string[] = [];
    let thrown = 0;
    handle.events.on('log', (e: { message: string }) => seen.push(e.message));
    handle.events.on('agent_end', () => {
      thrown++;
      throw new Error('bad listener');
    });
    await expect(handle.promise).resolves.toMatch(/^fake result/);
    expect(seen).toContain('x');
    expect(thrown).toBe(1);
    // The row was written although the listener threw.
    expect(rows(handle.runDir).map((e) => e.status)).toEqual(['ok']);
  });
});

describe('run dir and resume inputs', () => {
  it('resume with an edited script replaces script.js; args.json is reused when args are omitted', async () => {
    const dir = await tmp();
    const s1 = `${META()}return agent('v1 ' + args.x);`;
    const first = start(dir, { runner: new FakeRunner(), script: s1, args: { x: 7 } });
    await first.handle.promise;
    expect(await readFile(path.join(first.handle.runDir, 'script.js'), 'utf8')).toBe(s1);
    expect(JSON.parse(await readFile(path.join(first.handle.runDir, 'args.json'), 'utf8'))).toEqual({ x: 7 });

    const s2 = `${META()}return agent('v2 ' + args.x);`;
    const r2 = new FakeRunner();
    const second = start(dir, { runner: r2, script: s2, resumeFromRunId: first.handle.runId });
    expect(await second.handle.promise).toBe('fake result for: v2 7');
    expect(await readFile(path.join(first.handle.runDir, 'script.js'), 'utf8')).toBe(s2);
    expect(second.handle.runDir).toBe(first.handle.runDir);

    // Resume with no script reuses the stored (edited) one: all cached.
    const r3 = new FakeRunner();
    const third = start(dir, { runner: r3, resumeFromRunId: first.handle.runId });
    expect(await third.handle.promise).toBe('fake result for: v2 7');
    expect(r3.liveCalls).toBe(0);
  });

  it('rejects bad option combinations and unknown resume ids', async () => {
    const dir = await tmp();
    const both = start(dir, { runner: new FakeRunner(), script: `${META()}return 1;`, name: 'x' });
    await expect(both.handle.promise).rejects.toThrow(/exactly one/);
    const none = start(dir, { runner: new FakeRunner() });
    await expect(none.handle.promise).rejects.toThrow(/one of script/);
    const unknown = start(dir, { runner: new FakeRunner(), resumeFromRunId: 'nope' });
    await expect(unknown.handle.promise).rejects.toThrow(/no run nope/);
    const fixed = start(dir, { runner: new FakeRunner(), runId: 'r-1', script: `${META()}return 1;` });
    await fixed.handle.promise;
    const dup = start(dir, { runner: new FakeRunner(), runId: 'r-1', script: `${META()}return 1;` });
    await expect(dup.handle.promise).rejects.toThrow(/already exists/);
    const bad = start(dir, { runner: new FakeRunner(), runId: '../x', script: `${META()}return 1;` });
    await expect(bad.handle.promise).rejects.toThrow(/invalid runId/);
  });

  it('name resolves from workflowsDir; the generated runId is filesystem and branch safe', async () => {
    const dir = await tmp();
    const wfDir = path.join(dir, 'wfs');
    await mkdir(wfDir, { recursive: true });
    await writeFile(path.join(wfDir, 'hello.js'), `${META()}return 'hi';`);
    const { handle } = start(dir, { runner: new FakeRunner(), name: 'hello', workflowsDir: wfDir });
    expect(await handle.promise).toBe('hi');
    expect(handle.runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
  });
});

describe('overrun ceiling log (spec 3.5 aşım payı)', () => {
  it("uses the runner's largest max_tokens: total + concurrency × runner.maxRequestTokens", async () => {
    const dir = await tmp();
    // No agent runs, so the runner's client is never built (never the network).
    const runner = new AnthropicRunner({ maxTokens: 10_000 });
    const { handle, events } = start(dir, { runner, budget: 50_000, script: `${META()}return 1;` });
    expect(await handle.promise).toBe(1);
    expect(runner.maxRequestTokens).toBe(20_000);
    expect(logs(events)).toContain(`budget: total 50000, overrun ceiling ${50_000 + 4 * 20_000}`);
  });

  it('the default runner logs total + concurrency × its raised stage-2 max_tokens', async () => {
    const dir = await tmp();
    const { handle, events } = start(dir, { budget: 50_000, script: `${META()}return 1;` });
    expect(await handle.promise).toBe(1);
    const perTurn = new AnthropicRunner().maxRequestTokens;
    expect(perTurn).toBe(32_000);
    expect(logs(events)).toContain(`budget: total 50000, overrun ceiling ${50_000 + 4 * perTurn}`);
  });
});
