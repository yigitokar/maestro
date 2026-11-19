import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { inspectRun } from '../src/inspect.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { LIMITS, type WorkflowEvent } from '../src/types.js';
import { replay, run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-replay-'));
  dirs.push(d);
  return d;
}

const THREE_PHASE_SCRIPT = `export const meta = {
  name: 'three-phase',
  description: 'ingest -> analyze -> synth',
  phases: [{ title: 'Ingest' }, { title: 'Analyze' }, { title: 'Synth' }],
};
const docs = await agent('read repo', { label: 'ingest', phase: 'Ingest' });
const issues = await agent('analyze: ' + docs, { label: 'analyze', phase: 'Analyze' });
const report = await agent('summarize: ' + issues, { label: 'synth', phase: 'Synth' });
return { docs, issues, report };`;

describe('time-travel replay', () => {
  it('forks into a new runId, serves upstream nodes from cache, re-runs target & downstream live, and leaves source untouched', async () => {
    const cwd = await tmp();
    const r1 = new FakeRunner((req) => ({ result: `v1:${req.prompt}` }));
    const first = run({ cwd, runner: r1, script: THREE_PHASE_SCRIPT, runId: 'run-v1' });
    const out1 = await first.promise;
    expect(r1.liveCalls).toBe(3);

    const beforeJournal = await readFile(path.join(first.runDir, 'journal.jsonl'), 'utf8');
    const beforeOutcome = await readFile(path.join(first.runDir, 'outcome.json'), 'utf8');
    const beforeRunJson = await readFile(path.join(first.runDir, 'run.json'), 'utf8');

    // Replay from `analyze` with a new runner returning v2 answers — prompt didn't change,
    // yet `analyze` and `synth` must execute live while `ingest` is served from cache!
    const r2 = new FakeRunner((req) => ({ result: `v2:${req.prompt}` }));
    const events: WorkflowEvent[] = [];
    const second = replay({
      cwd,
      runner: r2,
      fromRunId: 'run-v1',
      from: 'analyze',
      runId: 'run-v2',
    });
    second.events.on('event', (ev: WorkflowEvent) => events.push(ev));
    const out2 = await second.promise;

    expect(r2.liveCalls).toBe(2);
    expect(r2.calls.map((c) => c.prompt)).toEqual([
      'analyze: v1:read repo',
      'summarize: v2:analyze: v1:read repo',
    ]);
    expect(out2).toEqual({
      docs: 'v1:read repo',
      issues: 'v2:analyze: v1:read repo',
      report: 'v2:summarize: v2:analyze: v1:read repo',
    });
    expect(out2).not.toEqual(out1);

    const ends = events.filter(
      (e): e is Extract<WorkflowEvent, { type: 'agent_end' }> => e.type === 'agent_end',
    );
    expect(ends.map((e) => [e.label, e.cached])).toEqual([
      ['ingest', true],
      ['analyze', false],
      ['synth', false],
    ]);

    // Original v1 run directory is completely untouched.
    expect(await readFile(path.join(first.runDir, 'journal.jsonl'), 'utf8')).toBe(beforeJournal);
    expect(await readFile(path.join(first.runDir, 'outcome.json'), 'utf8')).toBe(beforeOutcome);
    expect(await readFile(path.join(first.runDir, 'run.json'), 'utf8')).toBe(beforeRunJson);

    // Forked run records provenance in run.json and inspectRun.
    const runJson2 = JSON.parse(await readFile(path.join(second.runDir, 'run.json'), 'utf8'));
    expect(runJson2.replayedFrom).toEqual({
      runId: 'run-v1',
      from: 'analyze',
      seededAgents: 1,
      invalidatedAgents: 2,
    });
    const inspected = await inspectRun(second.runDir, second.runId, { compact: true });
    expect(inspected.replayedFrom).toMatchObject({ runId: 'run-v1', from: 'analyze' });
    expect(inspected.stats.journalCacheHits).toBe(1);
    expect(inspected.stats.liveCalls).toBe(2);
  });

  it('supports phase:<title>, #index, and edited script hot-reload without re-running upstream nodes', async () => {
    const cwd = await tmp();
    const r1 = new FakeRunner((req) => ({ result: `v1:${req.prompt}` }));
    const first = run({ cwd, runner: r1, script: THREE_PHASE_SCRIPT, runId: 'src-phases' });
    await first.promise;

    // Replay by `phase:Synth` — `ingest` and `analyze` both come from cache!
    const r2 = new FakeRunner((req) => ({ result: `v2:${req.prompt}` }));
    const byPhase = replay({
      cwd,
      runner: r2,
      fromRunId: 'src-phases',
      from: 'phase:Synth',
      runId: 'replay-phase',
    });
    await byPhase.promise;
    expect(r2.liveCalls).toBe(1);
    expect(r2.calls[0]!.prompt).toContain('summarize:');

    // Replay by `#2` with an edited final prompt.
    const edited = THREE_PHASE_SCRIPT.replace('summarize: ', 'concise summary: ');
    const r3 = new FakeRunner((req) => ({ result: `v3:${req.prompt}` }));
    const byIndex = replay({
      cwd,
      runner: r3,
      fromRunId: 'src-phases',
      from: '#2',
      script: edited,
      runId: 'replay-index',
    });
    const out3 = (await byIndex.promise) as { docs: string; issues: string; report: string };
    expect(r3.liveCalls).toBe(1);
    expect(out3.docs).toBe('v1:read repo');
    expect(out3.report).toBe('v3:concise summary: v1:analyze: v1:read repo');
  });

  it('copies >64 KB upstream result blobs cleanly into the forked run', async () => {
    const cwd = await tmp();
    const bigPayload = 'x'.repeat(LIMITS.blobThresholdBytes + 2048);
    const r1 = new FakeRunner((req) => ({
      result: req.prompt === 'big' ? { text: bigPayload } : `small:${req.prompt.length}`,
    }));
    const script = `export const meta = { name: 'blobs', description: 'd' };
const big = await agent('big', { label: 'big' });
const end = await agent('tail:' + big.text.length, { label: 'tail' });
return { len: big.text.length, end };`;
    const first = run({ cwd, runner: r1, script, runId: 'blob-v1' });
    await first.promise;

    const r2 = new FakeRunner(() => ({ result: 'replayed-tail' }));
    const second = replay({ cwd, runner: r2, fromRunId: 'blob-v1', from: 'tail', runId: 'blob-v2' });
    expect(await second.promise).toEqual({ len: bigPayload.length, end: 'replayed-tail' });
    expect(r2.liveCalls).toBe(1);
  });

  it('fails cleanly before creating a run directory when --from does not match any node', async () => {
    const cwd = await tmp();
    const first = run({ cwd, runner: new FakeRunner(), script: THREE_PHASE_SCRIPT, runId: 'src-err' });
    await first.promise;

    const bad = replay({
      cwd,
      runner: new FakeRunner(),
      fromRunId: 'src-err',
      from: 'nonexistent',
      runId: 'bad-fork',
    });
    await expect(bad.promise).rejects.toThrow(/node "nonexistent" not found.*available:.*ingest/);
    expect(existsSync(bad.runDir)).toBe(false);
  });

  it('supports CLI `maestro replay <runId> --from <node> [script.js]`', async () => {
    const cwd = await tmp();
    await writeFile(path.join(cwd, 'wf.js'), THREE_PHASE_SCRIPT);

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

    const r1 = await runCli(['run', 'wf.js', '--dry-run']);
    expect(r1.code, r1.stderr).toBe(0);
    const sourceRunId = r1.stderr.match(/maestro: run (\S+)/)![1]!;

    const editedPath = path.join(cwd, 'wf-v2.js');
    await writeFile(editedPath, THREE_PHASE_SCRIPT.replace('summarize: ', 'refined: '));
    const r2 = await runCli(['replay', sourceRunId, 'wf-v2.js', '--from', 'synth', '--dry-run']);
    expect(r2.code, r2.stderr).toBe(0);
    expect(r2.stderr).toContain(`from ${sourceRunId} --from synth`);
    expect(r2.stderr).toContain('seeded 2 cached agents, invalidated 1');
    const parsed = JSON.parse(r2.stdout);
    expect(parsed.report).toContain('refined:');
  });
});
