import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { formatInspectMarkdown, inspectRun } from '../src/inspect.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-inspect-'));
  dirs.push(d);
  return d;
}

describe('inspectRun & formatInspectMarkdown', () => {
  it('distills failed nodes with exact inputs, outputs, failed tools, and referenced upstream state in compact mode', async () => {
    const cwd = await tmp();
    const runner = new FakeRunner((req) => {
      if (req.prompt.includes('ingest-alpha')) {
        return {
          result: { module: 'auth/jwt-verifier', finding: 'expired tokens accepted when leeway is NaN' },
          usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 50 },
        };
      }
      if (req.prompt.includes('ingest-unrelated')) {
        return {
          result: { module: 'ui/button', finding: 'none' },
          usage: { input_tokens: 80, output_tokens: 20 },
        };
      }
      if (req.prompt.includes('patch')) {
        return {
          status: 'null',
          result: null,
          raw: '{broken json',
          error: 'schema parse failed twice',
          usage: { input_tokens: 200, output_tokens: 60 },
          trace: {
            toolCalls: [
              { tool: 'read_file', inputSummary: '{"path":"auth/jwt.ts"}', ok: true },
              { tool: 'bash', inputSummary: '{"command":"git bad"}', ok: false },
            ],
            finalText: 'I tried to produce JSON.',
          },
        };
      }
      return { result: 'ok' };
    });

    const script = `export const meta = {
  name: 'audit-and-patch',
  description: 'inspect test',
  phases: [{ title: 'Ingest' }, { title: 'Patch' }],
};
const alpha = await agent('ingest-alpha for ' + args.repo, { label: 'ingest:alpha', phase: 'Ingest' });
await agent('ingest-unrelated', { label: 'ingest:unrelated', phase: 'Ingest' });
const patched = await agent('patch bug: ' + alpha.finding + ' in ' + alpha.module, {
  label: 'patch:auth',
  phase: 'Patch',
  model: 'claude-opus-5-5',
});
if (!patched) throw new Error('patch:auth failed');
return patched;`;

    const handle = run({ cwd, runner, script, args: { repo: 'acme/api' }, runId: 'run-fail-1' });
    await expect(handle.promise).rejects.toThrow('patch:auth failed');

    const report = await inspectRun(handle.runDir, handle.runId, { compact: true });
    expect(report.status).toBe('failed');
    expect(report.degraded).toBe(false);
    expect(report.outcome).toEqual({ ok: false, error: 'patch:auth failed' });
    expect(report.stats).toMatchObject({ totalAgents: 3, ok: 2, null: 1, skipped: 0 });
    expect(report.overview).toBeUndefined(); // omitted in compact failure mode

    expect(report.nodes).toHaveLength(1);
    const failed = report.nodes[0]!;
    expect(failed.label).toBe('patch:auth');
    expect(failed.phase).toBe('Patch');
    expect(failed.status).toBe('null');
    expect(failed.error).toBe('schema parse failed twice');
    expect(failed.raw).toBe('{broken json');
    expect(failed.input?.prompt).toContain('expired tokens accepted when leeway is NaN');
    expect(failed.input?.model).toBe('claude-opus-5-5');
    expect(failed.failedToolCalls).toEqual([
      { tool: 'bash', inputSummary: '{"command":"git bad"}', ok: false },
    ]);

    // Upstream state prioritizes `ingest:alpha` as referenced-in-prompt.
    const alphaUp = report.upstream.find((u) => u.label === 'ingest:alpha');
    expect(alphaUp?.reason).toBe('referenced-in-prompt');
    expect(alphaUp?.resultPreview).toContain('auth/jwt-verifier');

    const md = formatInspectMarkdown(report);
    expect(md).toContain('# Run run-fail-1 (audit-and-patch) — failed');
    expect(md).toContain('## Failed Nodes (1)');
    expect(md).toContain('`patch:auth`');
    expect(md).toContain('schema parse failed twice');
    expect(md).toContain('`ingest:alpha`');
    expect(md).toContain('referenced in failing prompt');
    expect(md).not.toContain('## Agents (');
  });

  it('captures upstream context when the workflow script throws after all agents succeeded', async () => {
    const cwd = await tmp();
    const runner = new FakeRunner(() => ({ result: { count: 0 } }));
    const script = `export const meta = { name: 'script-throw', description: 'd' };
const res = await agent('fetch data', { label: 'fetch' });
if (res.count === 0) throw new Error('expected at least one item');
return res;`;

    const handle = run({ cwd, runner, script, runId: 'run-throw' });
    await expect(handle.promise).rejects.toThrow('expected at least one item');

    const report = await inspectRun(handle.runDir, handle.runId, { compact: true });
    expect(report.status).toBe('failed');
    expect(report.nodes).toHaveLength(0);
    expect(report.upstream).toHaveLength(1);
    expect(report.upstream[0]!.label).toBe('fetch');
    expect(report.upstream[0]!.resultPreview).toContain('"count":0');

    const md = formatInspectMarkdown(report);
    expect(md).toContain('workflow script threw directly');
    expect(md).toContain('Relevant Upstream State (1)');
  });

  it('flags degraded runs where outcome is ok but an agent returned null, and excludes recovered nodes after resume', async () => {
    const cwd = await tmp();
    let attempt = 0;
    const runner = new FakeRunner((req) => {
      if (req.prompt === 'flaky' && attempt++ === 0) {
        return { status: 'null', result: null, error: 'transient 503' };
      }
      return { result: `ok:${req.prompt}` };
    });
    const script = `export const meta = { name: 'degraded', description: 'd' };
const a = await agent('stable', { label: 'stable' });
const b = await agent('flaky', { label: 'flaky' });
return { a, b };`;

    const first = run({ cwd, runner, script, runId: 'run-deg' });
    expect(await first.promise).toEqual({ a: 'ok:stable', b: null });

    const r1 = await inspectRun(first.runDir, first.runId, { compact: true });
    expect(r1.status).toBe('done');
    expect(r1.degraded).toBe(true);
    expect(r1.nodes.map((n) => n.label)).toEqual(['flaky']);

    // Resume heals `flaky` and serves `stable` from cache.
    const second = run({ cwd, runner, resumeFromRunId: 'run-deg' });
    expect(await second.promise).toEqual({ a: 'ok:stable', b: 'ok:flaky' });

    const r2 = await inspectRun(second.runDir, second.runId, { compact: true });
    expect(r2.status).toBe('done');
    expect(r2.degraded).toBe(false);
    expect(r2.nodes).toHaveLength(0);
    expect(r2.stats.journalCacheHits).toBe(1);
    expect(r2.stats.liveCalls).toBe(1);
  });

  it('supports CLI `maestro inspect --compact`, `--json`, label selector, and `maestro show --compact`', async () => {
    const cwd = await tmp();
    const runner = new FakeRunner((req) =>
      req.prompt === 'bad' ? { status: 'null', result: null, error: 'boom' } : { result: 'good' },
    );
    const script = `export const meta = { name: 'cli-insp', description: 'd' };
await agent('good', { label: 'step:good' });
await agent('bad', { label: 'step:bad' });
return 'done';`;
    const handle = run({ cwd, runner, script, runId: 'cli-run' });
    await handle.promise;

    const runCli = async (argv: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await main(argv, {
        cwd,
        stdout: { write: (s) => (stdout += s) },
        stderr: { write: (s) => (stderr += s), isTTY: false },
      });
      return { code, stdout, stderr };
    };

    const mdRes = await runCli(['inspect', 'cli-run', '--compact']);
    expect(mdRes.code, mdRes.stderr).toBe(0);
    expect(mdRes.stdout).toContain('step:bad');
    expect(mdRes.stdout).toContain('boom');

    const jsonRes = await runCli(['inspect', 'cli-run', '--compact', '--json']);
    expect(jsonRes.code, jsonRes.stderr).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.runId).toBe('cli-run');
    expect(parsed.degraded).toBe(true);
    expect(parsed.nodes[0].label).toBe('step:bad');

    const targeted = await runCli(['inspect', 'cli-run', 'step:good', '--json']);
    expect(targeted.code, targeted.stderr).toBe(0);
    expect(JSON.parse(targeted.stdout).nodes[0].label).toBe('step:good');

    const viaShow = await runCli(['show', 'cli-run', '--compact']);
    expect(viaShow.code, viaShow.stderr).toBe(0);
    expect(viaShow.stdout).toBe(mdRes.stdout);
  });
});
