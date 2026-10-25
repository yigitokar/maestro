// Nested workflow() through run() (spec 3.4): one level, shared semaphore / counter / budget, no deadlock,
// child agents grouped as "▸ name", name registry lookups and catchable failures.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { WorkflowEvent } from '../src/types.js';
import { type RunHandle, type RunOptions, run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-nested-'));
  dirs.push(d);
  return d;
}

function start(dir: string, opts: RunOptions): { handle: RunHandle; events: WorkflowEvent[] } {
  const handle = run({ cwd: dir, stateDir: path.join(dir, 'state'), concurrency: 4, ...opts });
  const events: WorkflowEvent[] = [];
  handle.events.on('event', (e: WorkflowEvent) => events.push(e));
  return { handle, events };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms),
    ),
  ]);
}

const CHILD = `export const meta = { name: 'child', description: 'c', phases: [{ title: 'Inner' }] };
phase('Inner');
const r = await parallel(Array.from({ length: 16 }, (_, i) => () => agent('child task ' + i + ' ' + args.k)));
return { ok: r.filter(Boolean).length, spentSeen: budget.spent() };`;

describe('nested workflow (spec 3.4)', () => {
  it('16 parent agents + a 16-agent child with concurrency 16: completes, never above 16, shared counter and budget', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'child.js'), CHILD);
    const runner = new FakeRunner(() => ({ delayMs: 30 }));
    const { handle, events } = start(dir, {
      runner,
      concurrency: 16,
      budget: 1_000_000,
      script: `export const meta = { name: 'parent', description: 'p', maxAgents: 31 };
const [mine, child] = await Promise.all([
  parallel(Array.from({ length: 16 }, (_, i) => () => agent('parent task ' + i))),
  workflow({ scriptPath: 'child.js' }, { k: 'K' }),
]);
return { mine: mine.filter(Boolean).length, child, spent: budget.spent() };`,
    });
    const v = (await withTimeout(handle.promise, 15_000)) as {
      mine: number;
      child: { ok: number; spentSeen: number };
      spent: number;
    };
    expect(runner.maxConcurrent).toBeLessThanOrEqual(16);
    // The top run's cap (31) covers the child too: exactly one of the 32 agents hits agent_cap.
    expect(runner.liveCalls).toBe(31);
    expect(v.mine + v.child.ok).toBe(31);
    // One shared budget pool: 31 agents × 100 output tokens.
    expect(v.spent).toBe(3100);
    expect(v.child.spentSeen).toBeGreaterThan(0);

    const childStarts = events.filter((e) => e.type === 'agent_start' && e.group === 'child');
    const parentStarts = events.filter((e) => e.type === 'agent_start' && e.group === undefined);
    expect(childStarts.length + parentStarts.length).toBe(31);
    expect(childStarts.every((e) => e.type === 'agent_start' && e.phase === 'Inner')).toBe(true);
    expect(events).toContainEqual({ type: 'phase', runId: handle.runId, title: 'Inner', group: 'child' });
    // Agent ids are unique across parent and child.
    const ids = events.filter((e) => e.type === 'agent_start').map((e) => (e as { id: number }).id);
    expect(new Set(ids).size).toBe(31);
    expect(runner.calls.filter((c) => c.prompt.endsWith(' K')).length).toBe(childStarts.length);
  });

  it('child agents are journaled and cached on resume like any other agent', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'child.js'), CHILD);
    const script = `export const meta = { name: 'parent', description: 'p' };
return workflow({ scriptPath: 'child.js' }, { k: 1 });`;
    const first = start(dir, { runner: new FakeRunner(), concurrency: 16, script });
    const v1 = (await first.handle.promise) as { ok: number };
    expect(v1.ok).toBe(16);
    const r2 = new FakeRunner();
    const second = start(dir, { runner: r2, concurrency: 16, resumeFromRunId: first.handle.runId });
    expect(((await second.handle.promise) as { ok: number }).ok).toBe(16);
    expect(r2.liveCalls).toBe(0);
  });

  it('workflow() inside a child throws nested_workflow', async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'child.js'),
      `export const meta = { name: 'child', description: 'c' };
try { await workflow({ scriptPath: 'grandchild.js' }); return 'ran'; } catch (e) { return e.code; }`,
    );
    await writeFile(
      path.join(dir, 'grandchild.js'),
      `export const meta = { name: 'gc', description: 'g' };\nreturn 1;`,
    );
    const { handle } = start(dir, {
      runner: new FakeRunner(),
      script: `export const meta = { name: 'parent', description: 'p' };\nreturn workflow({ scriptPath: 'child.js' });`,
    });
    expect(await handle.promise).toBe('nested_workflow');
  });

  it("workflow('<name>') resolves from workflowsDir; an unknown name rejects into the parent script", async () => {
    const dir = await tmp();
    const wfDir = path.join(dir, 'registry');
    await mkdir(wfDir, { recursive: true });
    await writeFile(
      path.join(wfDir, 'greeter.js'),
      `export const meta = { name: 'greeter', description: 'g' };\nreturn await agent('greet ' + args.who, { label: 'g' });`,
    );
    const runner = new FakeRunner();
    const { handle, events } = start(dir, {
      runner,
      workflowsDir: wfDir,
      script: `export const meta = { name: 'parent', description: 'p' };
const hi = await workflow('greeter', { who: 'ada' });
let missing;
try { await workflow('does-not-exist'); } catch (e) { missing = e.message; }
let bad;
try { await workflow('../escape'); } catch (e) { bad = e.message; }
return { hi, missing, bad };`,
    });
    const v = (await handle.promise) as { hi: string; missing: string; bad: string };
    expect(v.hi).toBe('fake result for: greet ada');
    expect(v.missing).toMatch(/unknown workflow "does-not-exist"/);
    expect(v.bad).toMatch(/invalid workflow name/);
    expect(events.find((e) => e.type === 'agent_end')).toMatchObject({ group: 'greeter', label: 'g' });
  });

  it('an uncaught child failure rejects the parent; child phases are validated against the child meta', async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'child.js'),
      `export const meta = { name: 'child', description: 'c', phases: [{ title: 'Inner' }] };\nphase('Outer');\nreturn 1;`,
    );
    const runner = new FakeRunner();
    const { handle } = start(dir, {
      runner,
      script: `export const meta = { name: 'parent', description: 'p', phases: [{ title: 'Outer' }] };
phase('Outer');
return workflow({ scriptPath: 'child.js' });`,
    });
    await expect(handle.promise).rejects.toMatchObject({ code: 'unknown_phase' });

    await writeFile(
      path.join(dir, 'broken.js'),
      `export const meta = { name: 'b', description: 'b' };\nconst = 1;`,
    );
    const syntax = start(dir, {
      runner,
      script: `export const meta = { name: 'parent', description: 'p' };
try { await workflow({ scriptPath: 'broken.js' }); } catch (e) { return e.name; }`,
    });
    expect(await syntax.handle.promise).toBe('SyntaxError');
  });

  it("a child's meta.maxAgents is ignored (logged): only the top run's cap applies", async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'child.js'),
      `export const meta = { name: 'child', description: 'c', maxAgents: 1 };
return (await parallel([0, 1, 2].map((i) => () => agent('c' + i)))).filter(Boolean).length;`,
    );
    const { handle, events } = start(dir, {
      runner: new FakeRunner(),
      script: `export const meta = { name: 'parent', description: 'p', maxAgents: 10 };\nreturn workflow({ scriptPath: 'child.js' });`,
    });
    expect(await handle.promise).toBe(3);
    expect(events.some((e) => e.type === 'log' && /meta\.maxAgents 1 ignored/.test(e.message))).toBe(true);
  });
});
