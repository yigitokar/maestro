import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { hashCall, readEntries } from '../src/journal.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { run } from '../src/workflow.js';

const meta = "export const meta = { name: 'triage', description: '' };\n";
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'maestro-inspect-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function inspect(id?: string) {
  let stdout = '';
  let stderr = '';
  const code = await main(['inspect', '--compact', ...(id ? [id] : [])], {
    cwd,
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
  });
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout);
}

describe('compact inspection', () => {
  it('returns full failure I/O and the right stage input across concurrent pipeline items', async () => {
    const suffix = 'long prompt '.repeat(8000);
    const raw = 'invalid answer '.repeat(400);
    const runner = new FakeRunner((req) =>
      req.prompt.startsWith('fail-')
        ? { status: 'null', error: 'invalid JSON', raw }
        : { result: 'success-only output' },
    );
    const handle = run({
      cwd,
      runner,
      model: 'model-1',
      args: suffix,
      script:
        meta +
        `
      return pipeline(['bad','other'],
        (item) => ({ key: item }),
        async (prev, item) => {
          await Promise.resolve();
          const label = item === 'bad' ? 'judge' : 'unrelated-node';
          return agent((item === 'bad' ? 'fail-' : '') + args, {
            label, tools: [], schema: {type:'object'}, upstream: {chosen: prev.key}
          });
        });
    `,
    });
    await handle.promise;
    const report = await inspect();
    expect(report.runId).toBe(handle.runId);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      id: 0,
      label: 'judge',
      status: 'null',
      reason: 'invalid JSON',
      input: {
        prompt: `fail-${suffix}`,
        model: 'model-1',
        tools: [],
        options: { schema: { type: 'object' } },
      },
      output: null,
      rawOutput: raw,
      upstream: {
        state: { chosen: 'bad' },
        pipeline: { index: 0, stage: 2, previous: { key: 'bad' }, item: 'bad' },
      },
    });
    expect(JSON.stringify(report)).not.toContain('unrelated-node');
    expect(JSON.stringify(report)).not.toContain('success-only output');
    const rows = await readEntries(handle.runDir);
    expect(rows.find((r) => r.label === 'judge')).toMatchObject({ failureInputBlob: true });
    expect(rows.find((r) => r.label === 'unrelated-node')?.failureInput).toBeUndefined();
  });

  it('drops resolved failures after resume and preserves cache keys when only diagnostic state changes', async () => {
    expect(hashCall('x', { upstream: { old: 1 } })).toBe(hashCall('x'));
    const src = `${meta}return agent('x', {label:'judge'});`;
    const handle = run({
      cwd,
      script: src,
      runner: new FakeRunner(() => ({ status: 'null', error: 'offline' })),
    });
    await handle.promise;
    expect((await inspect(handle.runId)).failures[0].reason).toBe('offline');
    await run({ cwd, resumeFromRunId: handle.runId, runner: new FakeRunner() }).promise;
    expect(await inspect(handle.runId)).toEqual({ runId: handle.runId, failures: [] });
  });

  it('reports a script exception and a swallowed slot without dumping a successful response', async () => {
    const handle = run({
      cwd,
      runner: new FakeRunner(),
      script:
        meta +
        `
      await parallel([() => { throw new Error('malformed input'); }, () => agent('unrelated')]);
      throw new Error('workflow failed');
    `,
    });
    await expect(handle.promise).rejects.toThrow('workflow failed');
    expect(await inspect(handle.runId)).toMatchObject({
      runError: 'workflow failed',
      failures: [],
      stepErrors: [{ kind: 'parallel', index: 0, error: 'malformed input' }],
    });
  });

  it('captures a throwing stage input before mutation without invoking workflow hooks', async () => {
    const script = `${meta}
      let observed = 0;
      const unusual = [{ toJSON() { observed++; } },
        { get field() { observed++; } },
        new Proxy({}, { ownKeys() { observed++; return [] } })];
      await pipeline(unusual, () => agent('probe'));
      await pipeline([{amount: 10}], item => {
        item.amount = 20;
        throw Error('bad amount');
      });
      return observed;
    `;
    const handle = run({ cwd, script, runner: new FakeRunner() });
    await expect(handle.promise).resolves.toBe(0);
    expect((await inspect(handle.runId)).stepErrors[0]).toMatchObject({
      kind: 'pipeline',
      index: 0,
      error: 'bad amount',
      output: null,
      input: { stage: 1, index: 0, previous: { amount: 10 } },
    });
    await expect(run({ cwd, resumeFromRunId: handle.runId, runner: new FakeRunner() }).promise).resolves.toBe(
      0,
    );
  });

  it('recovers a journaled failure when the last event-log writes are missing', async () => {
    const handle = run({
      cwd,
      script: `${meta}await agent('x'); throw Error('failed workflow');`,
      runner: new FakeRunner(() => ({ status: 'null', error: 'runner failed' })),
    });
    await expect(handle.promise).rejects.toThrow('failed workflow');
    const file = path.join(handle.runDir, 'events.jsonl');
    const start = (await readFile(file, 'utf8')).split('\n')[0];
    await writeFile(file, `${start}\n`);
    expect(await inspect(handle.runId)).toMatchObject({
      runError: 'failed workflow',
      failures: [{ id: 0, reason: 'runner failed', input: { prompt: 'x' } }],
    });
  });

  it('marks legacy truncated previews as incomplete, and reads journal-only runs', async () => {
    const handle = run({
      cwd,
      script: `${meta}return agent('x'.repeat(5000));`,
      runner: new FakeRunner(() => ({ status: 'null' })),
    });
    await handle.promise;
    const file = path.join(handle.runDir, 'journal.jsonl');
    const legacy = JSON.parse(await readFile(file, 'utf8'));
    delete legacy.failureInput;
    await writeFile(file, `${JSON.stringify(legacy)}\n`);
    const report = await inspect(handle.runId);
    expect(report.failures[0].input).toMatchObject({
      prompt: 'x'.repeat(4000),
      promptTruncated: true,
      incomplete: expect.any(String),
    });
    await rm(path.join(handle.runDir, 'events.jsonl'));
    expect((await inspect(handle.runId)).failures[0].input).toEqual({
      unavailable: 'input was not recorded',
    });
  });
});
