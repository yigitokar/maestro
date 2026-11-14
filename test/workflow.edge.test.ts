// Edge cases and failure modes of run(), checked against docs/spec.md Seviye 2 (data flow steps 1-7,
// null/throw table, resume, writer hand-off, nested workflow, budget aborts, journal append failure).
// The everyday surface is in workflow.test.ts. FakeRunner + temp dirs/repos only; never the network.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Budget } from '../src/budget.js';
import { hashCall } from '../src/journal.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { Entry, RunRequest, WorkflowEvent } from '../src/types.js';
import { type RunHandle, type RunOptions, run } from '../src/workflow.js';

beforeAll(() => {
  // A developer machine's global git config (gpgsign, hooks) must not leak into the fixtures.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-edge-')));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function makeRepo(): Promise<string> {
  const dir = await tmp();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const META = (extra = '') => `export const meta = { name: 'edge', description: 'd'${extra} };\n`;

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

type End = Extract<WorkflowEvent, { type: 'agent_end' }>;
type Start = Extract<WorkflowEvent, { type: 'agent_start' }>;

/** Ids of agents that got an agent_start but no agent_end. */
function unpaired(events: WorkflowEvent[]): number[] {
  const started = new Set<number>();
  const ended = new Set<number>();
  for (const e of events) {
    if (e.type === 'agent_start') started.add(e.id);
    if (e.type === 'agent_end') ended.add(e.id);
  }
  return [...started].filter((id) => !ended.has(id));
}

const WRITE_TOOLS = "['read_file', 'write_file', 'git_commit']";

/** A writer that commits `file` in its worktree and (wrongly) names its own branch in the result. */
const commits = (file: string) => ({
  effect: async (req: RunRequest) => {
    await writeFile(path.join(req.cwd, file), `${file}\n`);
    git(req.cwd, 'add', '-A');
    git(req.cwd, 'commit', '-q', '-m', `add ${file}`);
  },
  result: { summary: `wrote ${file}`, branchName: 'agent-made-up' },
});

// ---------------------------------------------------------------------------------------------------
describe('null/throw table: what throws into the script (Seviye 1)', () => {
  it('unsatisfiable schema throws synchronously at the call site, before any await', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      script: `${META()}let sync = false;
try { agent('x', { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } }); }
catch (e) { sync = e.code === 'schema_invalid'; }
const p = await parallel([() => agent('y', { schema: { type: 'string' } }), () => agent('z')]);
return { sync, p0: p[0], p1ok: typeof p[1] === 'string' };`,
    });
    expect(await handle.promise).toEqual({ sync: true, p0: null, p1ok: true });
    expect(runner.calls.map((c) => c.prompt)).toEqual(['z']);
  });

  it('host MaestroErrors are readable by code and message inside the vm realm', async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      script: `${META(', maxAgents: 1')}const out = [];
try { agent('w', { tools: ['shell'] }); } catch (e) { out.push(e.code); }
await agent('one');
try { await agent('two'); } catch (e) { out.push(e.code, typeof e.message); }
return out;`,
    });
    expect(await handle.promise).toEqual(['write_tool_without_isolation', 'agent_cap', 'string']);
  });

  it('a script throw with an agent still running rejects with the script error; the agent is journaled skipped', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ turns: 100, delayMs: 10 }));
    const { handle } = start(dir, {
      runner,
      script: `${META()}const p = agent('slow');
throw new Error('script boom');`,
    });
    await expect(handle.promise).rejects.toThrow(/script boom/);
    expect(rows(handle.runDir).map((e) => e.status)).toEqual(['skipped']);
  });

  it('opts mutated right after agent() do not leak into the runner request (key and run agree)', async () => {
    // Step 1 + 3.1 ("a silent wrong cache is worse"): the row keyed by hash(p, o) holds the result of an
    // agent that ran with exactly that o.
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ result: (req: RunRequest) => `effort=${req.effort}` }));
    const { handle } = start(dir, {
      runner,
      script: `${META()}const o = { effort: 'low' };
const p = agent('p', o);
o.effort = 'high';
return await p;`,
    });
    const v = await handle.promise;
    const [row] = rows(handle.runDir);
    expect(row!.hash).toBe(hashCall('p', { effort: 'low' }));
    expect(runner.calls[0]!.effort).toBe('low');
    expect(v).toBe('effort=low');
  });

  it('clock/random/host globals throw; argful Date and pure builtins work', async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      args: { ts: '2026-10-25T00:00:00Z' },
      script: `${META()}const t = (f) => { try { f(); return 'ok'; } catch (e) { return e.name === 'ReferenceError' ? 'ref' : e.name === 'TypeError' ? 'type' : 'throw'; } };
return {
  now: t(() => Date.now()),
  newDate: t(() => new Date()),
  spreadDate: t(() => new Date(...[])),
  reflect: t(() => Reflect.construct(Date, [])),
  callDate: t(() => Date()),
  argDate: new Date(args.ts).toISOString(),
  random: t(() => Math.random()),
  floor: Math.floor(1.5),
  fmt: t(() => new Intl.DateTimeFormat('en').format()),
  process: t(() => process),
  require: t(() => require),
  fetch: t(() => fetch),
  setTimeout: t(() => setTimeout),
  json: JSON.stringify({ a: 1 }),
};`,
    });
    expect(await handle.promise).toEqual({
      now: 'throw',
      newDate: 'throw',
      spreadDate: 'throw',
      reflect: 'throw',
      callDate: 'type',
      argDate: '2026-10-25T00:00:00.000Z',
      random: 'throw',
      floor: 1,
      fmt: 'throw',
      process: 'ref',
      require: 'ref',
      fetch: 'ref',
      setTimeout: 'ref',
      json: '{"a":1}',
    });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('step 3: agent cap and budget entry check', () => {
  it('meta.maxAgents is checked before the budget: both exhausted → agent_cap, not budget_exceeded', async () => {
    const dir = await tmp();
    const budget = new Budget({ total: 10_000 });
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      budget,
      script: `${META(', maxAgents: 1')}await agent('one');
try { await agent('two'); return 'no throw'; } catch (e) { return e.code; }`,
    });
    handle.events.on('agent_end', () => budget.report(20_000));
    expect(await handle.promise).toBe('agent_cap');
  });

  it('a cap-throwing agent() writes no row (only the ok one is journaled)', async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      script: `${META(', maxAgents: 1')}await agent('a');
try { await agent('b'); } catch (e) { return e.code; }`,
    });
    expect(await handle.promise).toBe('agent_cap');
    expect(rows(handle.runDir).map((r) => r.status)).toEqual(['ok']);
  });

  it('budget-refused calls do not consume meta.maxAgents', async () => {
    // A call refused by the budget entry check never became an agent (no row), so with maxAgents 2 the
    // third call still fails on the budget, not on the cap.
    const dir = await tmp();
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      budget: 4000, // below the 5k reservation floor: every entry check throws budget_exceeded
      script: `${META(', maxAgents: 2')}const codes = [];
for (let i = 0; i < 3; i++) {
  try { await agent('p' + i); codes.push('ran'); } catch (e) { codes.push(e.code); }
}
return codes;`,
    });
    expect(await handle.promise).toEqual(['budget_exceeded', 'budget_exceeded', 'budget_exceeded']);
    expect(runner.calls).toHaveLength(0);
    expect(rows(handle.runDir)).toHaveLength(0);
  });

  it('entry reservation boundary: spent 5k + 5k reserve = 10k total enters (strict >); spent 6k throws', async () => {
    const dir = await tmp();
    const b1 = new Budget({ total: 10_000 });
    b1.report(5_000);
    const r1 = new FakeRunner(() => ({ outputTokensPerTurn: 1 }));
    const a = start(dir, { runner: r1, budget: b1, runId: 'b1', script: `${META()}return agent('x');` });
    expect(await a.handle.promise).toMatch(/^fake result/);

    const b2 = new Budget({ total: 10_000 });
    b2.report(6_000);
    const r2 = new FakeRunner();
    const b = start(dir, {
      runner: r2,
      budget: b2,
      runId: 'b2',
      script: `${META()}try { await agent('x'); return 'entered'; } catch (e) { return e.code; }`,
    });
    expect(await b.handle.promise).toBe('budget_exceeded');
    expect(r2.liveCalls).toBe(0);
    expect(rows(b.handle.runDir)).toHaveLength(0);
  });

  it('an uncaught budget throw is script-level: the whole run rejects', async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      budget: 4_000,
      script: `${META()}return agent('x');`,
    });
    await expect(handle.promise).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('budget crossed while agents run (spec 3.5)', () => {
  it('a running agent that crosses the budget is aborted at the next turn boundary', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ turns: 10, outputTokensPerTurn: 4_000, delayMs: 5 }));
    const { handle } = start(dir, { runner, budget: 10_000, script: `${META()}return agent('x');` });
    expect(await handle.promise).toBeNull();
    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({ status: 'skipped', result: null });
    expect(row!.usage.output_tokens).toBe(12_000);
  });

  it('spent === total during a run is not an overrun (strict >): agent stays ok', async () => {
    const dir = await tmp();
    const { handle } = start(dir, {
      runner: new FakeRunner(() => ({ turns: 2, outputTokensPerTurn: 5_000 })),
      budget: 10_000,
      script: `${META()}return agent('x');`,
    });
    expect(await handle.promise).toMatch(/^fake result/);
    expect(rows(handle.runDir)[0]!.status).toBe('ok');
  });

  it('running agent → null/skipped, queued agent skipped without a runner call, the next agent() throws', async () => {
    const dir = await tmp();
    const runner = new FakeRunner([
      { match: 'big', respond: { turns: 3, outputTokensPerTurn: 4_000, delayMs: 20 } },
    ]);
    const { handle } = start(dir, {
      runner,
      concurrency: 1,
      budget: 10_000,
      script: `${META()}const r = await parallel([() => agent('big', { label: 'A' }), () => agent('queued', { label: 'B' })]);
let code = null;
try { await agent('after'); } catch (e) { code = e.code; }
return { r, code };`,
    });
    expect(await handle.promise).toEqual({ r: [null, null], code: 'budget_exceeded' });
    expect(runner.calls.map((c) => c.prompt)).toEqual(['big']);
    const rs = rows(handle.runDir);
    expect(rs.map((e) => [e.label, e.status, e.result])).toEqual(
      expect.arrayContaining([
        ['A', 'skipped', null],
        ['B', 'skipped', null],
      ]),
    );
    expect(rs).toHaveLength(2);
    expect(rs.find((e) => e.label === 'B')!.usage.output_tokens).toBe(0);
  });

  it('after the abort no inflight reservation, no live runner call and no unpaired event remain', async () => {
    const dir = await tmp();
    const budget = new Budget({ total: 10_000, concurrency: 4 });
    const runner = new FakeRunner(() => ({ turns: 100, outputTokensPerTurn: 1_500, delayMs: 2 }));
    const { handle, events } = start(dir, {
      runner,
      budget,
      script: `${META()}return await parallel([0, 1].map((i) => () => agent('long ' + i)));`,
    });
    expect(await handle.promise).toEqual([null, null]);
    expect(budget.inflight()).toBe(0);
    expect(budget.spent()).toBeGreaterThan(10_000);
    expect(runner.active).toBe(0);
    expect(unpaired(events)).toEqual([]);
    const r = rows(handle.runDir);
    expect(r.map((e) => e.status)).toEqual(['skipped', 'skipped']);
    expect(r.every((e) => /budget/.test(e.error ?? ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('stop() and skip()', () => {
  it('stop() with agents queued for the only slot: rejects run_stopped, queued ones never reach the runner', async () => {
    const dir = await tmp();
    let handle!: RunHandle;
    // Stop from inside the first live runner call, one macrotask later: by then all three agents have
    // started and two of them wait for the only slot.
    const runner = new FakeRunner(() => {
      setImmediate(() => handle.stop('test'));
      return { turns: 1000, delayMs: 5 };
    });
    const started = start(dir, {
      runner,
      concurrency: 1,
      script: `${META()}return await parallel([0, 1, 2].map((i) => () => agent('a' + i)));`,
    });
    handle = started.handle;
    const events = started.events;
    await expect(handle.promise).rejects.toMatchObject({ code: 'run_stopped' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.active).toBe(0);
    expect(unpaired(events)).toEqual([]);
    const rs = rows(handle.runDir);
    expect(rs.map((e) => e.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(rs.every((e) => e.error === 'run stopped: test')).toBe(true);
    // Nothing trails the rejection: no event arrives once the promise has settled.
    const afterReject = events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(afterReject);
  });

  it('skip() on a cached agent id is false; the cached value is returned', async () => {
    const dir = await tmp();
    const a = start(dir, { runner: new FakeRunner(), runId: 's1', script: `${META()}return agent('x');` });
    const v = await a.handle.promise;
    const b = start(dir, { runner: new FakeRunner(), resumeFromRunId: 's1' });
    let skipped: boolean | undefined;
    b.handle.events.on('agent_start', (e: Start) => {
      skipped = b.handle.skip(e.id);
    });
    expect(await b.handle.promise).toEqual(v);
    expect(skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('step 2: a cache hit comes before cap, budget and isolation', () => {
  it('a resume served from cache ignores a cap of 1 and a budget below the floor', async () => {
    const dir = await tmp();
    const body = `const a = await agent('one'); const b = await agent('two'); const c = await agent('three');
return [a, b, c];`;
    const first = start(dir, { runner: new FakeRunner(), runId: 'c1', script: `${META()}${body}` });
    const v = await first.handle.promise;
    const r2 = new FakeRunner();
    const second = start(dir, {
      runner: r2,
      resumeFromRunId: 'c1',
      budget: 100,
      script: `${META(', maxAgents: 1')}${body}`,
    });
    expect(await second.handle.promise).toEqual(v);
    expect(r2.liveCalls).toBe(0);
    expect(rows(first.handle.runDir)).toHaveLength(3);
    const ends = second.events.filter((e): e is End => e.type === 'agent_end');
    expect(ends.map((e) => [e.cached, e.status])).toEqual([
      [true, 'ok'],
      [true, 'ok'],
      [true, 'ok'],
    ]);
  });

  it('a cached isolated agent never touches isolation (resume succeeds after .git is gone)', async () => {
    const repo = await makeRepo();
    const script = `${META()}return agent('look', { isolation: 'worktree' });`;
    const first = start(repo, { runner: new FakeRunner(), runId: 'iso1', script });
    const v = await first.handle.promise;
    await rm(path.join(repo, '.git'), { recursive: true, force: true });
    const r2 = new FakeRunner();
    const second = start(repo, { runner: r2, resumeFromRunId: 'iso1' });
    expect(await second.handle.promise).toEqual(v);
    expect(r2.liveCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('step 7 and resume: rows, n per hash, torn lines, events (spec 3.1, 3.7)', () => {
  it('parallel agents: each row is on disk when its agent_end fires', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req) => ({ delayMs: req.prompt === 'p1' ? 30 : 5 }));
    const { handle } = start(dir, {
      runner,
      script: `${META()}return parallel(['p0', 'p1', 'p2'].map((p) => () => agent(p, { label: p })));`,
    });
    const rowCountAtEnd: Record<string, number> = {};
    handle.events.on('agent_end', (e: End) => {
      // agent_end fires after the append and before agent() returns.
      rowCountAtEnd[e.label!] = rows(handle.runDir).filter((r) => r.label === e.label).length;
    });
    await handle.promise;
    expect(rowCountAtEnd).toEqual({ p0: 1, p1: 1, p2: 1 });
  });

  it('resume: n restarts at 0 each execution; a null n=0 re-runs live while n=1 is cached', async () => {
    const dir = await tmp();
    const script = `${META()}const out = [];
for (let i = 0; i < 2; i++) out.push(await agent('p'));
return out;`;
    const r1 = new FakeRunner((_req, call) =>
      call === 0 ? { status: 'null', result: null } : { result: 'B' },
    );
    const a = start(dir, { runner: r1, runId: 'n1', script });
    expect(await a.handle.promise).toEqual([null, 'B']);
    const r2 = new FakeRunner(() => ({ result: 'A2' }));
    const b = start(dir, { runner: r2, resumeFromRunId: 'n1' });
    expect(await b.handle.promise).toEqual(['A2', 'B']);
    expect(r2.liveCalls).toBe(1);
    const h = hashCall('p');
    const rs = rows(a.handle.runDir);
    expect(rs.map((e) => [e.key, e.status])).toEqual([
      [`${h}:0`, 'null'],
      [`${h}:1`, 'ok'],
      [`${h}:0`, 'ok'],
    ]);
    // A third execution with one more iteration: n 0,1 cached, n 2 live.
    const r3 = new FakeRunner(() => ({ result: 'C' }));
    const c = start(dir, {
      runner: r3,
      resumeFromRunId: 'n1',
      script: script.replace('i < 2', 'i < 3'),
    });
    expect(await c.handle.promise).toEqual(['A2', 'B', 'C']);
    expect(r3.liveCalls).toBe(1);
    expect(rows(a.handle.runDir).at(-1)!.key).toBe(`${h}:2`);
  });

  it('a half line appended after the last full row is dropped on resume: nothing re-runs, the journal is clean again', async () => {
    const dir = await tmp();
    const script = `${META()}return [await agent('a'), await agent('b')];`;
    const a = start(dir, { runner: new FakeRunner(), runId: 't1', script });
    const v = await a.handle.promise;
    appendFileSync(path.join(a.handle.runDir, 'journal.jsonl'), '{"index":2,"key":"x');
    const r2 = new FakeRunner();
    const b = start(dir, { runner: r2, resumeFromRunId: 't1' });
    expect(await b.handle.promise).toEqual(v);
    // Both agents had full rows, so neither runs again.
    expect(r2.liveCalls).toBe(0);
    expect(b.events.some((e) => e.type === 'log' && /corrupt or torn line 3/.test(e.message))).toBe(true);
    // rows() parses every line: the torn bytes are gone from the file.
    expect(rows(a.handle.runDir).map((e) => e.status)).toEqual(['ok', 'ok']);
  });

  it('every live row has one agent_start and one agent_end (cached: false); cached hits add no rows', async () => {
    const dir = await tmp();
    const script = `${META()}phase('P');
return parallel([() => agent('x', { label: 'X' }), () => agent('y'), () => agent('x', { label: 'X2' })]);`;
    const a = start(dir, { runner: new FakeRunner(), runId: 'ev', script });
    await a.handle.promise;
    const starts = a.events.filter((e): e is Start => e.type === 'agent_start');
    const ends = a.events.filter((e): e is End => e.type === 'agent_end');
    const rs = rows(a.handle.runDir);
    expect(starts.map((e) => e.id).sort()).toEqual([0, 1, 2]);
    expect(ends.map((e) => e.id).sort()).toEqual([0, 1, 2]);
    expect(new Set(ends.map((e) => e.key)).size).toBe(3);
    expect(new Set(ends.map((e) => e.key))).toEqual(new Set(rs.map((e) => e.key)));
    expect(ends.every((e) => !e.cached && e.phase === 'P')).toBe(true);
    expect(rs.map((e) => e.index).sort()).toEqual([0, 1, 2]);
    const b = start(dir, { runner: new FakeRunner(), resumeFromRunId: 'ev' });
    await b.handle.promise;
    const ends2 = b.events.filter((e): e is End => e.type === 'agent_end');
    expect(ends2.map((e) => e.cached)).toEqual([true, true, true]);
    expect(rows(a.handle.runDir)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('journal append failure mid-run (spec 3.1)', () => {
  /** The blob dir disappears while the agent runs: its >64 KB result cannot be journaled. */
  function unjournalable(dir: string): { handle: RunHandle; events: WorkflowEvent[] } {
    let handle!: RunHandle;
    const runner = new FakeRunner(() => {
      rmSync(path.join(handle.runDir, 'blobs'), { recursive: true, force: true });
      return { result: 'x'.repeat(70 * 1024) };
    });
    const started = start(dir, {
      runner,
      script: `${META()}return await parallel([() => agent('big', { label: 'big' })]);`,
    });
    handle = started.handle;
    return started;
  }

  it('an append that fails still closes the agent_start with an agent_end (spec 3.7)', async () => {
    const { handle, events } = unjournalable(await tmp());
    await handle.promise.catch(() => {});
    expect(events.filter((e) => e.type === 'agent_start')).toHaveLength(1);
    // The failure under test really is the journal append (not a fixture error).
    expect(events.some((e) => e.type === 'log' && /journal append failed/.test(e.message))).toBe(true);
    expect(unpaired(events)).toEqual([]);
  });

  it('an append failure is not swallowed into a null parallel slot: the run rejects', async () => {
    // A half-recorded run is unacceptable; only agent-level failures become null.
    const { handle } = unjournalable(await tmp());
    await expect(handle.promise).rejects.toMatchObject({ code: 'journal_unwritable' });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('writer hand-off through run() (spec 3.6)', () => {
  it('runtime adds branchName (overriding the agent), writer system prompt says commit; cached on resume', async () => {
    const repo = await makeRepo();
    const runner = new FakeRunner(() => commits('a.txt'));
    const script = `${META()}return agent('write a', { label: 'fixer', isolation: 'worktree', tools: ${WRITE_TOOLS} });`;
    const a = start(repo, { runner, runId: 'wr', script });
    const v = (await a.handle.promise) as { branchName: string; summary: string };
    expect(v).toEqual({ summary: 'wrote a.txt', branchName: 'wf/wr/fixer' });
    expect(runner.calls[0]!.system).toMatch(/commit/i);
    expect(runner.calls[0]!.isolated).toBe(true);
    const r2 = new FakeRunner();
    const b = start(repo, { runner: r2, resumeFromRunId: 'wr' });
    expect(await b.handle.promise).toEqual(v);
    expect(r2.liveCalls).toBe(0);
  });

  it('a writer that returns ok without a commit is null and does not feed the reserve moving average', async () => {
    const repo = await makeRepo();
    const budget = new Budget({ total: 10_000_000 });
    const runner = new FakeRunner(() => ({
      outputTokensPerTurn: 50_000,
      effect: async (req: RunRequest) => {
        await writeFile(path.join(req.cwd, 'draft.txt'), 'x\n');
      },
      result: 'done',
    }));
    const { handle } = start(repo, {
      runner,
      budget,
      runId: 'w1',
      script: `${META()}return agent('draft', { label: 'drafter', isolation: 'worktree', tools: ['read_file', 'write_file'] });`,
    });
    expect(await handle.promise).toBeNull();
    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({ status: 'null', result: null });
    expect(budget.reserve()).toBe(5_000);
  });

  it('a writer served from the journal keeps its branch: a same-label sibling on resume cannot -B reset it', async () => {
    const repo = await makeRepo();
    const first = `const a = await agent('write a', { label: 'fixer', isolation: 'worktree', tools: ${WRITE_TOOLS} });`;
    const a = start(repo, {
      runner: new FakeRunner(() => commits('a.txt')),
      runId: 'dup',
      script: `${META()}${first}\nreturn a;`,
    });
    const v = (await a.handle.promise) as { branchName: string };
    expect(v.branchName).toBe('wf/dup/fixer');
    expect(git(repo, 'log', '--format=%s', 'main..wf/dup/fixer')).toBe('add a.txt');

    // The same edited script in a FRESH run: the second same-label writer throws duplicate_writer_branch.
    const edited = `${META()}${first}
let code = null;
try { await agent('write b', { label: 'fixer', isolation: 'worktree', tools: ${WRITE_TOOLS} }); } catch (e) { code = e.code; }
return { a, code };`;
    const fresh = start(repo, {
      runner: new FakeRunner(() => commits('b.txt')),
      runId: 'dupfresh',
      script: edited,
    });
    // (the fresh run uses its own branch namespace wf/dupfresh/*)
    expect(((await fresh.handle.promise) as { code: string }).code).toBe('duplicate_writer_branch');

    // Resume: 'write a' is served from the journal (its hand-off is wf/dup/fixer), 'write b' is live.
    const b = start(repo, {
      runner: new FakeRunner(() => commits('b.txt')),
      resumeFromRunId: 'dup',
      script: edited,
    });
    const out = (await b.handle.promise) as { a: { branchName: string }; code: string | null };
    expect(out.a.branchName).toBe('wf/dup/fixer');
    // -B is only safe because the previous attempt was not ok; an ok writer's branch is its result.
    expect(git(repo, 'log', '--format=%s', 'main..wf/dup/fixer')).toBe('add a.txt');
    expect(out.code).toBe('duplicate_writer_branch');
  });
});

// ---------------------------------------------------------------------------------------------------
describe('nested workflow (spec 3.4)', () => {
  it('16 parent agents + a 16-agent child, concurrency 16: all 32 finish, never >16 live, child journaled and cached', async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'child.js'),
      `export const meta = { name: 'kid', description: 'c', phases: [{ title: 'K' }] };
phase('K');
const r = await parallel(Array.from({ length: 16 }, (_, i) => () => agent('child ' + i + ' ' + args.tag)));
return r.filter(Boolean).length;`,
    );
    const runner = new FakeRunner(() => ({ delayMs: 20 }));
    const script = `${META()}const [p, c] = await Promise.all([
  parallel(Array.from({ length: 16 }, (_, i) => () => agent('parent ' + i))),
  workflow({ scriptPath: 'child.js' }, { tag: 'T' }),
]);
return { p: p.filter(Boolean).length, c };`;
    const a = start(dir, { runner, concurrency: 16, runId: 'nest', script });
    expect(await a.handle.promise).toEqual({ p: 16, c: 16 });
    expect(runner.maxConcurrent).toBeLessThanOrEqual(16);
    const childEnds = a.events.filter((e): e is End => e.type === 'agent_end' && e.group === 'kid');
    expect(childEnds).toHaveLength(16);
    expect(childEnds.every((e) => e.phase === 'K')).toBe(true);
    expect(rows(a.handle.runDir)).toHaveLength(32);
    const r2 = new FakeRunner();
    const b = start(dir, { runner: r2, concurrency: 16, resumeFromRunId: 'nest' });
    expect(await b.handle.promise).toEqual({ p: 16, c: 16 });
    expect(r2.liveCalls).toBe(0);
  });

  it('the child shares the top cap: parent maxAgents 3, parent 2 + child 2 → child 2nd throws agent_cap', async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'child.js'),
      `export const meta = { name: 'kid', description: 'c' };
await agent('c1');
try { await agent('c2'); return 'no'; } catch (e) { return e.code; }`,
    );
    const runner = new FakeRunner();
    const a = start(dir, {
      runner,
      script: `${META(', maxAgents: 3')}await agent('p1'); await agent('p2');
return workflow({ scriptPath: 'child.js' });`,
    });
    expect(await a.handle.promise).toBe('agent_cap');
    expect(runner.calls.map((c) => c.prompt)).toEqual(['p1', 'p2', 'c1']);
  });

  it('a single slot: a parent agent and a child agent both finish (no deadlock)', async () => {
    const dir = await tmp();
    const wfDir = path.join(dir, 'wfs');
    await mkdir(wfDir, { recursive: true });
    await writeFile(
      path.join(wfDir, 'child.js'),
      "export const meta = { name: 'child', description: 'c' };\nreturn await agent('child work');\n",
    );
    const runner = new FakeRunner(() => ({ delayMs: 10 }));
    const { handle, events } = start(dir, {
      runner,
      concurrency: 1,
      workflowsDir: wfDir,
      script: `${META()}return await parallel([() => agent('parent work'), () => workflow('child')]);`,
    });
    expect(await handle.promise).toEqual(['fake result for: parent work', 'fake result for: child work']);
    expect(runner.maxConcurrent).toBe(1);
    const childEnds = events.filter((e): e is End => e.type === 'agent_end' && e.group === 'child');
    expect(childEnds.map((e) => e.status)).toEqual(['ok']);
  });
});
