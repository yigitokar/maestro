// Resume through run() (spec 3.1 Testler, ADR-4): content-addressed cache hits, n per hash, blobs,
// budget-aborted agents reviving on a bigger budget, null rows re-running, torn last line.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { Entry, WorkflowEvent } from '../src/types.js';
import { type RunHandle, type RunOptions, run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-resume-'));
  dirs.push(d);
  return d;
}

const META = (extra = '') => `export const meta = { name: 'resume', description: 'd'${extra} };\n`;

function start(dir: string, opts: RunOptions): { handle: RunHandle; events: WorkflowEvent[] } {
  const handle = run({ cwd: dir, stateDir: path.join(dir, 'state'), concurrency: 8, ...opts });
  const events: WorkflowEvent[] = [];
  handle.events.on('event', (e: WorkflowEvent) => events.push(e));
  return { handle, events };
}

function rows(runDir: string): Entry[] {
  return readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Entry);
}

const SIX = (third: string) => `${META()}const r1 = await agent('step one');
const r2 = await agent('step two');
const r3 = await agent('${third}');
const r4 = await agent('step four');
const r5 = await agent('step five');
const r6 = await agent('summarize: ' + r3);
return [r1, r2, r3, r4, r5, r6];`;

describe('resume (spec 3.1)', () => {
  it('same script + same args: zero live calls and a deepEqual return value; the run dir holds its files', async () => {
    const dir = await tmp();
    const script = `${META()}const a = await agent('analyse ' + args.target, { schema: { type: 'object', properties: { n: { type: 'integer' }, s: { type: 'string' } }, required: ['n', 's'] } });
const b = await parallel([1, 2, 3].map((i) => () => agent('lens ' + i)));
return { a, b, args };`;
    const r1 = new FakeRunner();
    const first = start(dir, { runner: r1, script, args: { target: 'src/' } });
    const v1 = await first.handle.promise;
    expect(r1.liveCalls).toBe(4);

    const runDir = first.handle.runDir;
    expect(readdirSync(runDir).sort()).toEqual(['args.json', 'blobs', 'journal.jsonl', 'script.js']);
    expect(statSync(path.join(runDir, 'blobs')).isDirectory()).toBe(true);
    expect(readFileSync(path.join(runDir, 'script.js'), 'utf8')).toBe(script);

    const r2 = new FakeRunner();
    const second = start(dir, {
      runner: r2,
      script,
      args: { target: 'src/' },
      resumeFromRunId: first.handle.runId,
    });
    expect(await second.handle.promise).toEqual(v1);
    expect(r2.liveCalls).toBe(0);
    expect(rows(runDir)).toHaveLength(4);
  });

  it('3rd prompt edited: the 3rd and the 6th (which embeds the 3rd result) run live, 4 and 5 are cached', async () => {
    const dir = await tmp();
    const first = start(dir, { runner: new FakeRunner(), script: SIX('step three') });
    const v1 = (await first.handle.promise) as string[];
    const r2 = new FakeRunner();
    const second = start(dir, {
      runner: r2,
      script: SIX('step three, edited'),
      resumeFromRunId: first.handle.runId,
    });
    const v2 = (await second.handle.promise) as string[];
    expect(r2.liveCalls).toBe(2);
    expect(r2.calls.map((c) => c.prompt)).toEqual([
      'step three, edited',
      'summarize: fake result for: step three, edited',
    ]);
    expect([v2[0], v2[1], v2[3], v2[4]]).toEqual([v1[0], v1[1], v1[3], v1[4]]);
    expect(v2[2]).not.toBe(v1[2]);
  });

  it('a label/phase-only edit is still a cache hit', async () => {
    const dir = await tmp();
    const meta = META(", phases: [{ title: 'A' }, { title: 'B' }]");
    const first = start(dir, {
      runner: new FakeRunner(),
      script: `${meta}return [await agent('p', { label: 'one', phase: 'A', effort: 'low' }), await agent('q')];`,
    });
    const v1 = await first.handle.promise;
    const r2 = new FakeRunner();
    const second = start(dir, {
      runner: r2,
      resumeFromRunId: first.handle.runId,
      script: `${meta}phase('B');\nreturn [await agent('p', { effort: 'low', phase: 'B', label: 'renamed' }), await agent('q', { label: 'new' })];`,
    });
    expect(await second.handle.promise).toEqual(v1);
    expect(r2.liveCalls).toBe(0);
    // The tree shows the new labels.
    const labels = second.events
      .filter((e) => e.type === 'agent_end')
      .map((e) => (e as { label?: string }).label);
    expect(labels).toEqual(['renamed', 'new']);
  });

  it('the same prompt 5 times in a loop: one hash, n 0..4, 5 rows; a resume serves each from its own row', async () => {
    const dir = await tmp();
    let k = 0;
    const runner = new FakeRunner(() => ({ result: `answer ${k++}` }));
    const script = `${META()}const out = [];\nfor (let i = 0; i < 5; i++) out.push(await agent('same prompt'));\nreturn out;`;
    const first = start(dir, { runner, script });
    expect(await first.handle.promise).toEqual(['answer 0', 'answer 1', 'answer 2', 'answer 3', 'answer 4']);
    const r = rows(first.handle.runDir);
    expect(r).toHaveLength(5);
    expect(new Set(r.map((e) => e.hash)).size).toBe(1);
    expect(r.map((e) => e.n)).toEqual([0, 1, 2, 3, 4]);
    expect(r.map((e) => e.key)).toEqual(r.map((e) => `${e.hash}:${e.n}`));

    const r2 = new FakeRunner();
    const second = start(dir, { runner: r2, resumeFromRunId: first.handle.runId });
    expect(await second.handle.promise).toEqual(['answer 0', 'answer 1', 'answer 2', 'answer 3', 'answer 4']);
    expect(r2.liveCalls).toBe(0);
  });

  it('parallel 4 branches finishing A,C,B,D: resume serves all from cache in A,B,C,D order', async () => {
    const dir = await tmp();
    const delays: Record<string, number> = { A: 10, B: 120, C: 60, D: 180 };
    const runner = new FakeRunner((req) => ({ delayMs: delays[req.prompt.slice(-1)] ?? 0 }));
    const script = `${META()}return await parallel(['A', 'B', 'C', 'D'].map((x) => () => agent('branch ' + x, { label: x })));`;
    const first = start(dir, { runner, script });
    const v1 = await first.handle.promise;
    expect(rows(first.handle.runDir).map((e) => e.label)).toEqual(['A', 'C', 'B', 'D']);

    // Reversed timing on the resume would reorder any order-addressed key; content keys do not care.
    const r2 = new FakeRunner(() => ({ delayMs: 50 }));
    const second = start(dir, { runner: r2, resumeFromRunId: first.handle.runId });
    expect(await second.handle.promise).toEqual(v1);
    expect(v1).toEqual(['A', 'B', 'C', 'D'].map((x) => `fake result for: branch ${x}`));
    expect(r2.liveCalls).toBe(0);
  });

  it('a 200 KB result goes to blobs/ and comes back intact on resume', async () => {
    const dir = await tmp();
    const big = { text: 'x'.repeat(200 * 1024), n: 1 };
    const first = start(dir, {
      runner: new FakeRunner(() => ({ result: big })),
      script: `${META()}return agent('big');`,
    });
    expect(await first.handle.promise).toEqual(big);
    const [row] = rows(first.handle.runDir);
    expect(row!.blob).toBe(true);
    expect(row!.result).toEqual({ blob: row!.key });
    const blobFile = path.join(first.handle.runDir, 'blobs', `${row!.key}.json`);
    expect(existsSync(blobFile)).toBe(true);
    expect(statSync(blobFile).size).toBeGreaterThan(200 * 1024);

    const r2 = new FakeRunner();
    const second = start(dir, { runner: r2, resumeFromRunId: first.handle.runId });
    expect(await second.handle.promise).toEqual(big);
    expect(r2.liveCalls).toBe(0);
  });

  it('budget 100k: 6 short agents ok, 4 long ones aborted mid-run (skipped); resume with 300k: 6 cached, 4 live, 14 rows', async () => {
    const dir = await tmp();
    // Shorts finish at once with 10k each (60k); longs report 5k per 30 ms turn and cross 100k in round 3.
    const rules = [
      { match: 'short', respond: { outputTokensPerTurn: 10_000 } },
      { match: 'long', respond: { turns: 8, delayMs: 30, outputTokensPerTurn: 5_000 } },
    ];
    const script = `${META()}const r = await parallel([
  ...[0, 1, 2, 3, 4, 5].map((i) => () => agent('short ' + i)),
  ...[0, 1, 2, 3].map((i) => () => agent('long ' + i)),
]);
log(r.filter((x) => x === null).length + ' agents dropped');
return r;`;
    const r1 = new FakeRunner(rules);
    const first = start(dir, { runner: r1, script, budget: 100_000, concurrency: 10 });
    const v1 = (await first.handle.promise) as unknown[];
    expect(v1.slice(0, 6).every((v) => typeof v === 'string')).toBe(true);
    expect(v1.slice(6)).toEqual([null, null, null, null]);
    const rows1 = rows(first.handle.runDir);
    expect(rows1.filter((e) => e.status === 'ok')).toHaveLength(6);
    const skipped = rows1.filter((e) => e.status === 'skipped');
    expect(skipped).toHaveLength(4);
    expect(skipped.every((e) => e.error === 'budget exceeded while running')).toBe(true);

    const r2 = new FakeRunner(rules);
    const second = start(dir, {
      runner: r2,
      resumeFromRunId: first.handle.runId,
      budget: 300_000,
      concurrency: 10,
    });
    const v2 = (await second.handle.promise) as unknown[];
    expect(r2.liveCalls).toBe(4);
    expect(r2.calls.every((c) => c.prompt.startsWith('long'))).toBe(true);
    expect(v2.every((v) => typeof v === 'string')).toBe(true);
    expect(v2.slice(0, 6)).toEqual(v1.slice(0, 6));
    expect(rows(first.handle.runDir)).toHaveLength(14);
  });

  it('an agent that died with an API error (status null) re-runs on resume; get returns the new ok row', async () => {
    const dir = await tmp();
    const script = `${META()}return [await agent('flaky'), await agent('stable')];`;
    const r1 = new FakeRunner([{ match: 'flaky', respond: { status: 'null', error: '529 overloaded' } }]);
    const first = start(dir, { runner: r1, script });
    const v1 = (await first.handle.promise) as unknown[];
    expect(v1[0]).toBeNull();

    const r2 = new FakeRunner([{ match: 'flaky', respond: { result: 'recovered' } }]);
    const second = start(dir, { runner: r2, resumeFromRunId: first.handle.runId });
    expect(await second.handle.promise).toEqual(['recovered', v1[1]]);
    expect(r2.calls.map((c) => c.prompt)).toEqual(['flaky']);
    const r = rows(first.handle.runDir);
    expect(r.map((e) => e.status)).toEqual(['null', 'ok', 'ok']);
    expect(r[0]!.key).toBe(r[2]!.key);

    const r3 = new FakeRunner();
    const third = start(dir, { runner: r3, resumeFromRunId: first.handle.runId });
    expect(await third.handle.promise).toEqual(['recovered', v1[1]]);
    expect(r3.liveCalls).toBe(0);
  });

  it('a torn last line (process killed mid-write) is dropped; resume continues from the last full line', async () => {
    const dir = await tmp();
    const script = `${META()}return [await agent('one'), await agent('two'), await agent('three')];`;
    const first = start(dir, { runner: new FakeRunner(), script });
    const v1 = await first.handle.promise;
    const journal = path.join(first.handle.runDir, 'journal.jsonl');
    const text = await readFile(journal, 'utf8');
    const lastStart = text.lastIndexOf('\n', text.length - 2) + 1;
    // Cut the last row in half, as if the write never completed.
    await truncate(
      journal,
      Buffer.byteLength(text.slice(0, lastStart + Math.floor((text.length - lastStart) / 2))),
    );

    const r2 = new FakeRunner();
    const second = start(dir, { runner: r2, resumeFromRunId: first.handle.runId });
    expect(await second.handle.promise).toEqual(v1);
    expect(r2.calls.map((c) => c.prompt)).toEqual(['three']);
    expect(second.events.some((e) => e.type === 'log' && /corrupt or torn line 3/.test(e.message))).toBe(
      true,
    );
    // The torn bytes are gone, every line parses, and a third resume is fully cached.
    expect(rows(first.handle.runDir).map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);

    // A hand-appended half line (no newline) is dropped the same way.
    await appendFile(journal, '{"index":9,"hash":"ab');
    const r3 = new FakeRunner();
    const third = start(dir, { runner: r3, resumeFromRunId: first.handle.runId });
    expect(await third.handle.promise).toEqual(v1);
    expect(r3.liveCalls).toBe(0);
    expect(readFileSync(journal, 'utf8').endsWith('\n')).toBe(true);
  });
});
