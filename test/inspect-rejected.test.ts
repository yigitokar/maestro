import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectFailures } from '../src/inspect.js';
import { readEntries } from '../src/journal.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { run } from '../src/workflow.js';

const header = `export const meta = { name: 'admission', description: '' };\n`;
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-rejected-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

it('records schema, tool and budget rejections without admitting a node, including when caught by the script', async () => {
  const runner = new FakeRunner();
  const first = run({
    cwd,
    runner,
    budget: 5000,
    script:
      header +
      `
    try { agent('invalid schema', {label:'validate',schema:{type:'number'}}); } catch {}
    try { agent('bad tool', {label:'search',tools:['missing_tool']}); } catch {}
    const worked = await agent('ok');
    try { agent('over limit', {upstream:{worked}}); } catch {}
    return worked;`,
  });
  expect(await first.promise).toBe('fake result for: ok');
  expect(runner.liveCalls).toBe(1);
  const rows = await readEntries(first.runDir);
  expect(rows.map((r) => r.index)).toEqual([0]);
  const report = await inspectFailures(first.runDir, first.runId);
  expect(report.failures).toEqual([]);
  expect(report.rejectedCalls).toMatchObject([
    {
      id: 'rejected-0',
      reason: expect.stringContaining('root schema'),
      input: { prompt: 'invalid schema', options: { label: 'validate', schema: { type: 'number' } } },
    },
    {
      id: 'rejected-1',
      reason: expect.stringContaining('unknown tool'),
      input: { prompt: 'bad tool', options: { label: 'search', tools: ['missing_tool'] } },
    },
    {
      id: 'rejected-2',
      reason: expect.stringContaining('budget exceeded'),
      input: { prompt: 'over limit', options: { upstream: { worked: 'fake result for: ok' } } },
    },
  ]);
  const resumed = run({ cwd, runner, resumeFromRunId: first.runId, script: `${header}return agent('ok');` });
  expect(await resumed.promise).toBe('fake result for: ok');
  expect((await inspectFailures(first.runDir, first.runId)).rejectedCalls).toBeUndefined();
  expect(runner.liveCalls).toBe(1);
});

it('captures safe fields and leaves workflow getters and thrown error accessors untouched', async () => {
  const runner = new FakeRunner();
  const handle = run({
    cwd,
    runner,
    script:
      header +
      `
    let reads = 0;
    const thrown = { get message() { reads++; return 'side effect'; } };
    const bad = { get schema() { throw thrown; }, get label() { reads++; return 'side effect'; } };
    let same = false;
    try { agent('safe prompt', bad); } catch (e) { same = e === thrown; }
    return { reads, same };`,
  });
  expect(await handle.promise).toEqual({ reads: 0, same: true });
  expect(runner.liveCalls).toBe(0);
  const report = await inspectFailures(handle.runDir, handle.runId);
  expect(report.rejectedCalls).toMatchObject([
    {
      input: { prompt: 'safe prompt', unavailable: ['options'] },
      reason: 'agent call threw before admission',
    },
  ]);
});
