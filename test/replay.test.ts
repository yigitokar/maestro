import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { readEventLines } from '../src/event-log.js';
import { readEntries, readTrace, resolveBlobFile } from '../src/journal.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { type RunOptions, run } from '../src/workflow.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-replay-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const meta = "export const meta = { name: 'replay', description: 'find replay boundary' };\n";
const script = `${meta}const a = await agent(args.topic, {label: 'ingest'});
const b = await agent('classify', {label: 'judge'});
return [a, b, await agent('publish', {label:'end'})];`;

function start(opts: RunOptions) {
  return run({ cwd: dir, runner: new FakeRunner(), ...opts });
}

async function source(opts: RunOptions = {}) {
  const h = start({ script, args: { topic: 'source' }, runId: 'original', ...opts });
  await h.promise;
  return h;
}

function replay(from: string, opts: RunOptions = {}) {
  return start({ replayFrom: { runId: 'original', from }, ...opts });
}

it('replays the edited target and identical suffix live in a separate run and preserves large cached results/traces', async () => {
  const big = 'x'.repeat(90_000);
  const trace = { finalText: big, toolCalls: [] };
  const first = await source({
    model: 'default-a',
    runner: new FakeRunner([{ match: 'source', respond: { result: big, trace } }]),
  });
  const files = ['journal.jsonl', 'events.jsonl', 'args.json', 'run.json', 'outcome.json', 'script.js'];
  const snapshot = () => Promise.all(files.map((f) => readFile(path.join(first.runDir, f), 'utf8')));
  const before = await snapshot();
  const runner = new FakeRunner();
  const child = replay('judge', { script: script.replace('classify', 'correct'), runner });
  expect(await child.promise).toEqual([big, 'fake result for: correct', 'fake result for: publish']);
  expect(runner.calls.map((c) => [c.prompt, c.model])).toEqual([
    ['correct', 'default-a'],
    ['publish', 'default-a'],
  ]);
  expect(await snapshot()).toEqual(before);
  const rows = await readEntries(child.runDir);
  expect(rows.map((r) => r.cachedFrom)).toEqual(['original', undefined, undefined]);
  const events = (await readEventLines(child.runDir)).lines;
  expect(events.flatMap((e) => (e.type === 'agent_end' ? [[e.label, e.cached]] : []))).toEqual([
    ['ingest', true],
    ['judge', false],
    ['end', false],
  ]);
  expect(JSON.parse(await readFile(path.join(child.runDir, 'run.json'), 'utf8')).replayFrom).toEqual({
    runId: 'original',
    from: 'judge',
  });
  await rm(first.runDir, { recursive: true });
  expect(await readTrace(child.runDir, rows[0]!)).toEqual(trace);
  const resumed = new FakeRunner();
  expect(await start({ resumeFromRunId: child.runId, runner: resumed }).promise).toEqual(await child.promise);
  expect(resumed.liveCalls).toBe(0);
});

it('uses latest attempt IDs and current labels after the source was resumed with a modified graph', async () => {
  await source();
  const edited = script
    .replace('const b =', "const x = await agent('extra'); const b =")
    .replace("label: 'judge'", "label: 'renamed'");
  await start({ script: edited, resumeFromRunId: 'original' }).promise;
  const runner = new FakeRunner();
  await replay('#2', { runner }).promise;
  expect(runner.calls.map((c) => c.prompt)).toEqual(['classify', 'publish']);
  await expect(replay('judge').promise).rejects.toThrow(/no replay node/);
  const byLabel = replay('renamed');
  await byLabel.promise;
  expect(
    (await readEventLines(byLabel.runDir)).lines.flatMap((e) => (e.type === 'agent_end' ? [e.cached] : [])),
  ).toEqual([true, true, false, false]);
});

it('uses invocation IDs when agents finish out of order and repeated labels require disambiguation', async () => {
  const parallel = `${meta}return parallel(['slow','fast','last'].map(p => () => agent(p, {label:'same'})));`;
  const h = await source({
    script: parallel,
    runner: new FakeRunner([{ match: 'slow', respond: { delayMs: 45 } }]),
  });
  const rows = await readEntries(h.runDir);
  expect(rows[0]!.index).toBe(1);
  await expect(replay('same').promise).rejects.toThrow(/ambiguous.*#0, #1, #2/);
  const runner = new FakeRunner();
  await replay(rows[0]!.key, { runner }).promise;
  expect(runner.calls.map((c) => c.prompt)).toEqual(['fast', 'last']);
});

it('refuses upstream cache misses or divergence even if the script catches the error', async () => {
  await source({
    runner: new FakeRunner([{ match: 'source', respond: { status: 'null', error: 'no response' } }]),
  });
  const runner = new FakeRunner();
  await expect(replay('judge', { runner }).promise).rejects.toThrow(/no successful upstream cache for #0/);
  expect(runner.liveCalls).toBe(0);
  await start({ resumeFromRunId: 'original' }).promise;
  const caught = script.replace(
    "await agent(args.topic, {label: 'ingest'})",
    "(await parallel([() => agent('changed')]))[0]",
  );
  await expect(replay('judge', { script: caught, runner }).promise).rejects.toThrow(
    /upstream node #0 .* changed/,
  );
  await expect(
    replay('judge', { script: `${meta}return agent(args.topic)`, runner }).promise,
  ).rejects.toThrow(/ended before reaching/);
  await expect(
    replay('judge', { script: script.replace("label: 'judge'", "label: 'gone'"), runner }).promise,
  ).rejects.toThrow(/expected "judge" at #1/);
  expect(runner.liveCalls).toBe(0);
});

it('never retries an upstream call when its result blob is missing', async () => {
  const h = await source({
    runner: new FakeRunner([{ match: 'source', respond: { result: 'x'.repeat(80_000) } }]),
  });
  const [row] = await readEntries(h.runDir);
  await rm(resolveBlobFile(path.join(h.runDir, 'blobs'), row!.key));
  const runner = new FakeRunner();
  await expect(replay('judge', { runner }).promise).rejects.toThrow(/upstream cache result blob unreadable/);
  expect(runner.liveCalls).toBe(0);
});

it('does not dispatch a parallel live suffix before its cached prefix has been restored', async () => {
  const h = await source({
    script: `${meta}return parallel(['ingest','target','other'].map(p => () => agent(p, { label: p })));`,
    runner: new FakeRunner([{ match: 'ingest', respond: { result: 'x'.repeat(80_000) } }]),
  });
  const row = (await readEntries(h.runDir)).find((entry) => entry.label === 'ingest')!;
  await rm(resolveBlobFile(path.join(h.runDir, 'blobs'), row.key));
  const runner = new FakeRunner();
  await expect(replay('target', { runner }).promise).rejects.toThrow(/upstream cache result blob unreadable/);
  expect(runner.liveCalls).toBe(0);
});

it('finds a target issued by the faster of two parallel upstream branches', async () => {
  const flow = `${meta}return parallel(['slow','fast'].map(p => async () => {
    await agent(p, { label: p });
    return agent('review ' + p, { label: 'review-' + p });
  }));`;
  await source({ script: flow, runner: new FakeRunner([{ match: 'slow', respond: { delayMs: 45 } }]) });
  const runner = new FakeRunner();
  await expect(replay('review-fast', { runner }).promise).resolves.toEqual([
    'fake result for: review slow',
    'fake result for: review fast',
  ]);
  expect(runner.calls.map((c) => c.prompt).sort()).toEqual(['review fast', 'review slow']);
});

it('guards source and destination IDs and reserves each new destination once', async () => {
  const h = await source();
  const before = await readFile(path.join(h.runDir, 'journal.jsonl'), 'utf8');
  await expect(replay('judge', { runId: h.runId }).promise).rejects.toThrow(/already exists/);
  await expect(replay('judge', { resumeFromRunId: h.runId }).promise).rejects.toThrow(/cannot be combined/);
  await expect(start({ replayFrom: { runId: '../original', from: 'judge' } }).promise).rejects.toThrow(
    /invalid source runId/,
  );
  const results = await Promise.allSettled([
    replay('judge', { runId: 'fixed' }).promise,
    replay('judge', { runId: 'fixed' }).promise,
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(await readFile(path.join(h.runDir, 'journal.jsonl'), 'utf8')).toEqual(before);
});

it('accepts a CLI edit and reuses the stored runner, args, budget and concurrency', async () => {
  const h = await source({ budget: 50_000, concurrency: 2 });
  await writeFile(path.join(dir, 'edited.js'), script.replace('classify', 'different'));
  let stdout = '',
    stderr = '';
  const code = await main(['replay', h.runId, '--from', 'judge', '--script', 'edited.js'], {
    cwd: dir,
    env: {},
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
      isTTY: false,
    },
  });
  expect(code, stderr).toBe(0);
  expect(stderr).toMatch(/\(dry run\)/);
  expect(JSON.parse(stdout)).toEqual([
    'fake result for: source',
    'fake result for: different',
    'fake result for: publish',
  ]);
  const childId = /maestro: run (\S+)/.exec(stderr)![1]!;
  const start = (await readEventLines(path.join(dir, '.maestro', 'runs', childId))).lines[0];
  expect(start).toMatchObject({ type: 'run_start', budget: 50_000, concurrency: 2, runner: 'FakeRunner' });
});
