import { readdirSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { serveMcp } from '../src/mcp.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { exportVizHtml, readSnapshot } from '../src/viz.js';
import { readOutcome, run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeDir(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-outcome-')));
  dirs.push(d);
  return d;
}

async function runCli(argv: string[], cwd: string) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd,
    env: {},
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s), isTTY: false },
  });
  return { code, stdout, stderr };
}

describe('outcome.json, cross-session MCP WorkflowResult, maestro runs/show/viz, and meta warnings', () => {
  it('persists outcome.json for both ok and failed runs, updates it on resume, and warns on unknown meta keys', async () => {
    const dir = await makeDir();
    const logs: string[] = [];
    const okRun = run({
      cwd: dir,
      runId: 'run-ok',
      runner: new FakeRunner(() => ({ result: { score: 99 } })),
      script: `export const meta = { name: 'ok-wf', description: 'd', maxAgent: 3 };
const r = await agent('evaluate', { label: 'eval', schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } });
return { final: r.score };`,
    });
    okRun.events.on('log', (e: { message: string }) => logs.push(e.message));
    expect(await okRun.promise).toEqual({ final: 99 });
    expect(logs.some((m) => m.includes('meta: unknown key "maxAgent" ignored'))).toBe(true);
    expect(await readOutcome(okRun.runDir)).toEqual({ ok: true, result: { final: 99 } });

    let shouldFail = true;
    const failRun = run({
      cwd: dir,
      runId: 'run-fail',
      runner: new FakeRunner(() => ({ result: 'step1' })),
      script: `export const meta = { name: 'flaky-wf', description: 'd' };
const x = await agent('step', { label: 's1' });
if (args.fail) throw new Error('boom-after-agent');
return { recovered: x };`,
      args: { fail: shouldFail },
    });
    await expect(failRun.promise).rejects.toThrow('boom-after-agent');
    expect(await readOutcome(failRun.runDir)).toEqual({ ok: false, error: 'boom-after-agent' });

    shouldFail = false;
    const resumed = run({
      cwd: dir,
      resumeFromRunId: 'run-fail',
      runner: new FakeRunner(),
      args: { fail: shouldFail },
    });
    expect(await resumed.promise).toEqual({ recovered: 'step1' });
    expect(await readOutcome(resumed.runDir)).toEqual({ ok: true, result: { recovered: 'step1' } });
  });

  it('MCP WorkflowResult reads settled runs from outcome.json in a brand-new server session', async () => {
    const dir = await makeDir();

    // Session 1: run a workflow to completion, then shut down the MCP server.
    const s1In = new PassThrough();
    const s1Out = new PassThrough();
    const server1 = await serveMcp(
      { cwd: dir, runner: new FakeRunner(() => ({ result: 'session1-value' })) },
      new StdioServerTransport(s1In, s1Out),
    );
    const client1 = new Client({ name: 'c1', version: '0.1.0' });
    const c1In = new PassThrough();
    const c1Out = new PassThrough();
    s1Out.pipe(c1In);
    c1Out.pipe(s1In);
    await client1.connect(new StdioServerTransport(c1In, c1Out));

    const started = await client1.callTool({
      name: 'Workflow',
      arguments: {
        script: `export const meta = { name: 'cross-session', description: 'd' };
const v = await agent('work');
return { answer: v };`,
      },
    });
    const { runId } = JSON.parse((started.content as any)[0].text) as { runId: string };
    const settled = await client1.callTool({
      name: 'WorkflowResult',
      arguments: { runId, wait: true },
    });
    expect(JSON.parse((settled.content as any)[0].text)).toEqual({
      runId,
      status: 'done',
      result: { answer: 'session1-value' },
    });
    await client1.close();
    await server1.close();

    // Session 2: completely fresh MCP server with empty in-memory outcomes map!
    const s2In = new PassThrough();
    const s2Out = new PassThrough();
    const server2 = await serveMcp(
      { cwd: dir, runner: new FakeRunner() },
      new StdioServerTransport(s2In, s2Out),
    );
    const client2 = new Client({ name: 'c2', version: '0.1.0' });
    const c2In = new PassThrough();
    const c2Out = new PassThrough();
    s2Out.pipe(c2In);
    c2Out.pipe(s2In);
    await client2.connect(new StdioServerTransport(c2In, c2Out));
    try {
      const fromDisk = await client2.callTool({
        name: 'WorkflowResult',
        arguments: { runId },
      });
      expect(fromDisk.isError).toBeFalsy();
      expect(JSON.parse((fromDisk.content as any)[0].text)).toEqual({
        runId,
        status: 'done',
        result: { answer: 'session1-value' },
      });
    } finally {
      await client2.close();
      await server2.close();
    }
  });

  it('surfaces outcome in maestro show, maestro viz snapshot/HTML, and lists runs via maestro runs / ls', async () => {
    const dir = await makeDir();
    const empty = await runCli(['runs'], dir);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('(no runs in');

    const r1 = run({
      cwd: dir,
      runId: '20261114-010000-aaaaaa',
      runner: new FakeRunner(() => ({ result: 'alpha' })),
      script: `export const meta = { name: 'first-wf', description: 'd' };
return await agent('one', { label: 'a1' });`,
    });
    await r1.promise;

    await new Promise((r) => setTimeout(r, 15));

    const r2 = run({
      cwd: dir,
      runId: '20261114-010001-bbbbbb',
      runner: new FakeRunner(() => ({ result: 'beta' })),
      script: `export const meta = { name: 'second-wf', description: 'd' };
await agent('two', { label: 'b1' });
throw new Error('planned-failure');`,
    });
    await expect(r2.promise).rejects.toThrow('planned-failure');

    const listed = await runCli(['runs'], dir);
    expect(listed.code, listed.stderr).toBe(0);
    const lines = listed.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    // Newest run first:
    expect(lines[0]).toContain('20261114-010001-bbbbbb');
    expect(lines[0]).toContain('[failed]');
    expect(lines[0]).toContain('second-wf');
    expect(lines[1]).toContain('20261114-010000-aaaaaa');
    expect(lines[1]).toContain('[done]');
    expect(lines[1]).toContain('first-wf');

    const limited = await runCli(['ls', '--limit', '1'], dir);
    expect(limited.code).toBe(0);
    expect(limited.stdout.trim().split('\n')).toHaveLength(1);
    expect(limited.stdout).toContain('20261114-010001-bbbbbb');

    const shown1 = await runCli(['show', '20261114-010000-aaaaaa'], dir);
    expect(shown1.code).toBe(0);
    expect(shown1.stdout).toContain('outcome: ok · "alpha"');

    const shown2 = await runCli(['show', '20261114-010001-bbbbbb'], dir);
    expect(shown2.code).toBe(0);
    expect(shown2.stdout).toContain('outcome: failed · planned-failure');

    const snap = await readSnapshot(r1.runDir, r1.runId);
    expect(snap.outcome).toEqual({ ok: true, result: 'alpha' });
    const html = await exportVizHtml(r1.runDir, r1.runId);
    expect(html).toContain('id="outcome-panel"');
    expect(html).toContain('"outcome":{"ok":true,"result":"alpha"}');
  });

  it('a result JSON cannot hold still settles the run, and leaves no outcome file', async () => {
    const dir = await makeDir();
    for (const [runId, body] of [
      ['run-bigint', 'return { n: 10n };'],
      ['run-cycle', 'const o = {}; o.self = o; return o;'],
    ] as const) {
      const h = run({
        cwd: dir,
        runId,
        runner: new FakeRunner(),
        script: `export const meta = { name: 'odd', description: 'd' };\n${body}`,
      });
      await expect(h.promise).resolves.toBeTypeOf('object');
      expect(await readOutcome(h.runDir)).toBeUndefined();
      expect(readdirSync(h.runDir).filter((f) => f.includes('.tmp'))).toEqual([]);
    }
  });
});
