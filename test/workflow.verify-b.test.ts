// Adversarial verification of the Workflow surface (run()) against docs/spec.md, failure-mode lens:
// stop/skip/budget abort leaks, nested workflow deadlock, journal append failure, writer hand-off on
// resume, opts snapshotting (content-addressed key vs what actually ran), cross-realm error values.
// FakeRunner + temp dirs only; never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Budget } from '../src/budget.js';
import { hashCall } from '../src/journal.js';
import { type FakeResponse, FakeRunner } from '../src/testing/fake-runner.js';
import type { Entry, RunRequest, WorkflowEvent } from '../src/types.js';
import { type RunHandle, type RunOptions, run } from '../src/workflow.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-vb-')));
  dirs.push(d);
  return d;
}

const META = (extra = '') => `export const meta = { name: 'vb', description: 'd'${extra} };\n`;

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

function unpaired(events: WorkflowEvent[]): number[] {
  const started = new Set<number>();
  const ended = new Set<number>();
  for (const e of events) {
    if (e.type === 'agent_start') started.add(e.id);
    if (e.type === 'agent_end') ended.add(e.id);
  }
  return [...started].filter((id) => !ended.has(id));
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

const WRITE_TOOLS = "['read_file', 'write_file', 'git_commit']";
const WRITE_RESULT = "{ type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }";

function writes(file: string): FakeResponse {
  return {
    effect: async (req: RunRequest) => {
      await writeFile(path.join(req.cwd, file), `${file}\n`);
      git(req.cwd, 'add', '-A');
      git(req.cwd, 'commit', '-q', '-m', `add ${file}`);
    },
    result: { summary: `wrote ${file}` },
  };
}

// ---------------------------------------------------------------------------------------------------

describe('verify-b: content-addressed key vs what actually ran', () => {
  // Spec Seviye 2 adım 1 + 3.1 hata halleri ("sessiz yanlış cache daha kötü"): the row keyed by
  // hash(p, o) must hold the result of an agent that ran with exactly that o.
  it('opts mutated right after agent() do not leak into the runner request (key and run agree)', async () => {
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
    // The agent behind the effort-low key must have run with effort 'low'.
    expect(runner.calls[0]!.effort).toBe('low');
    expect(v).toBe('effort=low');
  });
});

describe('verify-b: writer hand-off across resume (spec 3.6)', () => {
  // Spec 3.6: -B is safe only because the earlier attempt was not ok; an ok writer comes back from the
  // journal and its branch must not be reset. A fresh run refuses a second writer on the same branch.
  it('a cached ok writer keeps its branch: a resumed sibling with the same label cannot -B reset it', async () => {
    const repo = await makeRepo();
    const runner1 = new FakeRunner([{ match: 'task A', respond: writes('a.txt') }]);
    const writerA = `agent('task A', { label: 'fix', isolation: 'worktree', tools: ${WRITE_TOOLS}, schema: ${WRITE_RESULT} })`;
    const writerB = `agent('task B', { label: 'fix', isolation: 'worktree', tools: ${WRITE_TOOLS}, schema: ${WRITE_RESULT} })`;
    const first = run({
      cwd: repo,
      runId: 'r1',
      concurrency: 2,
      runner: runner1,
      script: `${META()}return await ${writerA};`,
    });
    const a = (await first.promise) as { branchName: string };
    expect(a.branchName).toBe('wf/r1/fix');
    expect(git(repo, 'log', '--format=%s', 'main..wf/r1/fix')).toBe('add a.txt');

    // Within one fresh run the second writer would throw duplicate_writer_branch. On resume the
    // first writer is served from the journal; the sibling must still not take over its branch.
    const runner2 = new FakeRunner([{ match: 'task B', respond: writes('b.txt') }]);
    const second = run({
      cwd: repo,
      resumeFromRunId: 'r1',
      concurrency: 2,
      runner: runner2,
      script: `${META()}const a = await ${writerA};
let b;
try { b = await ${writerB}; } catch (e) { b = e.code; }
return { a, b };`,
    });
    const out = (await second.promise) as { a: { branchName: string }; b: unknown };
    expect(out.a.branchName).toBe('wf/r1/fix');
    // The ok writer's commit is still on the branch its (cached) result advertises.
    expect(git(repo, 'log', '--format=%s', 'main..wf/r1/fix').split('\n')).toContain('add a.txt');
    expect(out.b).toBe('duplicate_writer_branch');
  });
});

describe('verify-b: journal append failure mid-run', () => {
  // Spec 3.7 / O-01: every agent_start has a matching agent_end.
  it('an append that fails still closes the agent_start with an agent_end', async () => {
    const dir = await tmp();
    let handle!: RunHandle;
    const runner = new FakeRunner(() => {
      // Blob dir disappears while the agent runs: the >64 KB result cannot be journaled.
      rmSync(path.join(handle.runDir, 'blobs'), { recursive: true, force: true });
      return { result: 'x'.repeat(70 * 1024) };
    });
    const started = start(dir, {
      runner,
      script: `${META()}return await parallel([() => agent('big', { label: 'big' })]);`,
    });
    handle = started.handle;
    const events = started.events;
    await handle.promise.catch(() => {});
    expect(events.some((e) => e.type === 'agent_start')).toBe(true);
    // The failure under test really is the journal append (not a fixture error).
    expect(events.some((e) => e.type === 'log' && /journal append failed/.test(e.message))).toBe(true);
    expect(unpaired(events)).toEqual([]);
  });

  // Spec 3.1 hata halleri: a half-recorded run is unacceptable; the null/throw table makes only
  // agent-level failures silent. A journal write failure is not an agent failure: the run must die.
  it('an append failure is not swallowed into a null parallel slot: the run rejects', async () => {
    const dir = await tmp();
    let handle!: RunHandle;
    const runner = new FakeRunner(() => {
      rmSync(path.join(handle.runDir, 'blobs'), { recursive: true, force: true });
      return { result: 'x'.repeat(70 * 1024) };
    });
    ({ handle } = start(dir, {
      runner,
      script: `${META()}return await parallel([() => agent('big', { label: 'big' })]);`,
    }));
    await expect(handle.promise).rejects.toMatchObject({ code: 'journal_unwritable' });
  });
});

describe('verify-b: agent cap counts agents, not refused calls', () => {
  // Spec Seviye 1 / 3.4: meta.maxAgents is a hard cap on agents of the run. A call refused by the budget
  // entry check never became an agent (no row, J-25), so it must not use up the cap.
  it('budget-refused calls do not consume meta.maxAgents', async () => {
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
  });
});

// ---------------------------------------------------------------------------------------------------
// Passing probes of tricky invariants

describe('verify-b probes', () => {
  it('budget overshoot mid-run: no inflight reservation, no live runner call and no unpaired event remain', async () => {
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

  it('stop() with agents queued for the only slot: rejects run_stopped, queued ones never reach the runner', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ turns: 1000, delayMs: 5 }));
    const { handle, events } = start(dir, {
      runner,
      concurrency: 1,
      script: `${META()}return await parallel([0, 1, 2].map((i) => () => agent('a' + i)));`,
    });
    handle.events.once('agent_start', () => setTimeout(() => handle.stop('test'), 20));
    await expect(handle.promise).rejects.toMatchObject({ code: 'run_stopped' });
    const afterReject = events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.length).toBe(afterReject);
    expect(runner.calls).toHaveLength(1);
    expect(runner.active).toBe(0);
    expect(unpaired(events)).toEqual([]);
    expect(rows(handle.runDir).map((e) => e.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  it('nested workflow with a single slot: parent agent and child agent both finish (no deadlock)', async () => {
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
    const v = (await handle.promise) as unknown[];
    expect(v.every((x) => typeof x === 'string')).toBe(true);
    expect(runner.maxConcurrent).toBe(1);
    const childEnd = events.find((e) => e.type === 'agent_end' && e.group === 'child');
    expect(childEnd).toBeDefined();
  });

  it('host MaestroErrors are readable by code inside the vm realm', async () => {
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
});
