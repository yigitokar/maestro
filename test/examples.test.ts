// The Seviye 4 example scripts (examples/workflows/*.js) run through run() with FakeRunner rules:
// Örnek 1 review-changes (null votes, finder null, no synthesis, no Find→Verify barrier), Örnek 2
// find-edge-cases (dry/round termination, dedup on `seen`) and fan-out writers → coordinator merge on a
// temporary git repo. Never the network.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeResponse, FakeRunner } from '../src/testing/fake-runner.js';
import type { RunRequest, WorkflowEvent } from '../src/types.js';
import { type RunOptions, run } from '../src/workflow.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(prefix = 'maestro-examples-'): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
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
  const dir = await tmp('maestro-examples-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const example = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../examples/workflows/${name}.js`, import.meta.url)), 'utf8');

function start(cwd: string, opts: RunOptions) {
  const handle = run({ cwd, concurrency: 4, ...opts });
  const logs: string[] = [];
  handle.events.on('log', (e: WorkflowEvent & { type: 'log' }) => logs.push(e.message));
  return { handle, logs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------------------------------

describe('Örnek 1: review-changes', () => {
  const finding = (file: string, line: number, claim: string) => ({
    file,
    line,
    claim,
    failure: `${claim} fails`,
  });
  const A = finding('a.ts', 1, 'claim-A');
  const B = finding('b.ts', 2, 'claim-B');
  const C = finding('c.ts', 3, 'claim-C');

  it('null votes do not count, a null finder gives [] + log, Verify starts before the slowest Find ends', async () => {
    const dir = await tmp();
    let slowFinderDone = false;
    const verifySawSlowDone: boolean[] = [];
    const votes: Record<string, Array<FakeResponse>> = {
      // 2 of 3 survive: alive.
      'claim-A': [
        { result: { refuted: false, reason: 'r' } },
        { result: { refuted: false, reason: 'r' } },
        { status: 'null' },
      ],
      // Only 1 non-null "not refuted": counting nulls as survivors would wrongly keep it.
      'claim-B': [{ result: { refuted: false, reason: 'r' } }, { status: 'null' }, { status: 'null' }],
      'claim-C': [0, 1, 2].map(() => ({ result: { refuted: true, reason: 'r' } })),
    };
    const runner = new FakeRunner(async (req): Promise<FakeResponse> => {
      const p = req.prompt;
      if (p.includes('Yalnızca mantık hatası')) return { result: { findings: [A, B] } };
      if (p.includes('Yalnızca güvenlik')) return { status: 'null' };
      if (p.includes('Veri kaybı')) {
        // The flag flips only when the slow finder's result is produced, i.e. after its turn wait.
        return {
          delayMs: 400,
          result: () => {
            slowFinderDone = true;
            return { findings: [C] };
          },
        };
      }
      if (p.startsWith('Bu iddiayı ÇÜRÜTMEYE')) {
        verifySawSlowDone.push(slowFinderDone);
        const claim = /claim-[ABC]/.exec(p)![0];
        const i = Number(/Perspektif (\d)/.exec(p)![1]);
        return votes[claim]![i]!;
      }
      if (p.includes('ciddiyete göre')) return { result: { findings: [{ ...A, failure: 'fix it' }] } };
      throw new Error(`unexpected prompt: ${p}`);
    });
    const { handle, logs } = start(dir, {
      runner,
      runId: 'rc1',
      script: example('review-changes'),
      args: { diffRef: 'main...HEAD' },
    });
    const out = await handle.promise;

    expect(out).toEqual({ findings: [{ ...A, failure: 'fix it' }] });
    expect(logs).toContain('security: bulucu null döndü');
    expect(logs).toContain('1 bulgu oylamayı geçti');
    // No Find→Verify barrier: correctness verifiers ran while data-loss was still finding.
    expect(verifySawSlowDone.length).toBe(9);
    expect(verifySawSlowDone[0]).toBe(false);
    // Synthesis gets only the confirmed finding (A), with its dimension and votes.
    const synth = runner.calls.filter((c) => c.prompt.includes('ciddiyete göre'));
    expect(synth).toHaveLength(1);
    expect(synth[0]!.prompt).toContain('"claim":"claim-A"');
    expect(synth[0]!.prompt).toContain('"dimension":"correctness"');
    expect(synth[0]!.prompt).not.toContain('claim-B');
    expect(synth[0]!.prompt).not.toContain('claim-C');
    // Verifiers run with effort high (spec: refutation stages use high effort).
    const verifiers = runner.calls.filter((c) => c.prompt.startsWith('Bu iddiayı ÇÜRÜTMEYE'));
    expect(verifiers.every((c) => c.effort === 'high')).toBe(true);
  });

  it("args.skepticEffort overrides the verifiers' effort; finders and synthesis keep the default", async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req): FakeResponse => {
      if (req.prompt.startsWith('Diff:')) {
        return { result: { findings: [{ file: 'a.ts', line: 1, claim: 'c', failure: 'f' }] } };
      }
      if (req.prompt.startsWith('Bu iddiayı ÇÜRÜTMEYE')) return { result: { refuted: false, reason: 'r' } };
      return { result: { findings: [] } };
    });
    const { handle } = start(dir, {
      runner,
      runId: 'rc-effort',
      script: example('review-changes'),
      args: { diffRef: 'main...HEAD', skepticEffort: 'medium' },
    });
    await handle.promise;
    const verifiers = runner.calls.filter((c) => c.prompt.startsWith('Bu iddiayı ÇÜRÜTMEYE'));
    expect(verifiers).toHaveLength(9);
    expect(verifiers.every((c) => c.effort === 'medium')).toBe(true);
    const others = runner.calls.filter((c) => !c.prompt.startsWith('Bu iddiayı ÇÜRÜTMEYE'));
    expect(others.every((c) => c.effort === undefined)).toBe(true);
  });

  it('nothing confirmed: { findings: [] } and no synthesis agent', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req): FakeResponse => {
      if (req.prompt.startsWith('Diff:')) return { result: { findings: [] } };
      throw new Error(`unexpected prompt: ${req.prompt}`);
    });
    const { handle, logs } = start(dir, {
      runner,
      runId: 'rc2',
      script: example('review-changes'),
      args: { diffRef: 'HEAD~1' },
    });
    expect(await handle.promise).toEqual({ findings: [] });
    expect(runner.liveCalls).toBe(3);
    expect(runner.calls.some((c) => c.prompt.includes('ciddiyete göre'))).toBe(false);
    expect(logs).toContain('0 bulgu oylamayı geçti');
  });
});

// -----------------------------------------------------------------------------------------------------

describe('Örnek 2: find-edge-cases (loop-until-dry)', () => {
  const round = (p: string) => Number(/Tur (\d+)\./.exec(p)![1]);
  const lens = (p: string) => ['boş girdi', 'eşzamanlılık', 'hata yolları'].findIndex((l) => p.includes(l));
  const isVerify = (p: string) => p.includes('gerçek bir hata mı?');

  it('stops after 2 dry rounds; dedup is on seen, so a rejected bug that comes back is not re-verified', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req): FakeResponse => {
      const p = req.prompt;
      if (isVerify(p)) {
        if (p.includes('"d1"')) return { result: { real: true } };
        if (p.includes('"d2"')) return { result: { real: false } };
        if (p.includes('"d3"')) return { status: 'null' };
        throw new Error(`unexpected verify: ${p}`);
      }
      const r = round(p);
      const l = lens(p);
      if (r === 1 && l === 0)
        return {
          result: {
            bugs: [
              { key: 'k1', desc: 'd1' },
              { key: 'k2', desc: 'd2' },
            ],
          },
        };
      if (r === 1 && l === 1) return { result: { bugs: [{ key: 'k3', desc: 'd3' }] } };
      if (r === 1 && l === 2) return { status: 'null' };
      // k2 was rejected by the jury; it is in seen (not in confirmed), so this round stays dry.
      if (r === 2 && l === 0) return { result: { bugs: [{ key: 'k2', desc: 'd2' }] } };
      return { result: { bugs: [] } };
    });
    const { handle, logs } = start(dir, {
      runner,
      runId: 'fe1',
      script: example('find-edge-cases'),
      args: { target: 'src/journal.ts' },
    });
    expect(await handle.promise).toEqual({ confirmed: [{ key: 'k1', desc: 'd1' }], rounds: 3 });

    const verifies = runner.calls.filter((c) => isVerify(c.prompt));
    expect(verifies).toHaveLength(3);
    expect(runner.calls.filter((c) => !isVerify(c.prompt))).toHaveLength(9);
    expect(logs).toContain('tur 1: 3 yeni, 1 doğrulanmış');
    expect(logs).toContain('tur 2: yeni yok (1/2)');
    expect(logs).toContain('tur 3: yeni yok (2/2)');
    expect(logs.some((m) => m.startsWith('tur tavanına'))).toBe(false);
    // Each round tells the finders what is already known.
    const finders = runner.calls.filter((c) => !isVerify(c.prompt));
    expect(
      finders.filter((c) => round(c.prompt) === 1).every((c) => c.prompt.endsWith('(tekrar etme): yok')),
    ).toBe(true);
    expect(
      finders
        .filter((c) => round(c.prompt) === 2)
        .every((c) => c.prompt.endsWith('(tekrar etme): k1, k2, k3')),
    ).toBe(true);
  });

  it('round cap 6: stops with the log line when every round finds something new', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req): FakeResponse => {
      const p = req.prompt;
      if (isVerify(p)) return { result: { real: false } };
      const key = `r${round(p)}-l${lens(p)}`;
      return { result: { bugs: [{ key, desc: `desc ${key}` }] } };
    });
    const { handle, logs } = start(dir, {
      runner,
      runId: 'fe2',
      script: example('find-edge-cases'),
      args: { target: 'x.ts' },
    });
    expect(await handle.promise).toEqual({ confirmed: [], rounds: 6 });
    expect(runner.calls.filter((c) => !isVerify(c.prompt))).toHaveLength(18);
    expect(runner.calls.filter((c) => isVerify(c.prompt))).toHaveLength(18);
    expect(logs).toContain('tur tavanına ulaşıldı, kuyruk tam taranmadı');
  });
});

// -----------------------------------------------------------------------------------------------------

describe('Fan-out writers → coordinator merge', () => {
  const isCoordinator = (p: string) => p.startsWith("Şu branch'leri");

  function commits(files: Record<string, string>, result: unknown): FakeResponse {
    return {
      effect: async (req: RunRequest) => {
        for (const [f, body] of Object.entries(files)) await writeFile(path.join(req.cwd, f), body);
        git(req.cwd, 'add', '-A');
        git(req.cwd, 'commit', '-q', '-m', Object.keys(files).join(' '));
      },
      result,
    };
  }

  it('null writers are filtered, the coordinator gets branch names + summaries + overlap, writers never see a branch', async () => {
    const repo = await makeRepo();
    const runner = new FakeRunner(async (req): Promise<FakeResponse> => {
      const p = req.prompt;
      if (p.startsWith('alpha')) {
        return commits(
          { 'shared.txt': 'alpha\n', 'alpha.txt': 'a\n' },
          { summary: 'alpha özeti', filesTouched: ['shared.txt', 'alpha.txt'] },
        );
      }
      if (p.startsWith('beta')) {
        await sleep(50);
        return commits(
          { 'shared.txt': 'beta\n', 'beta.txt': 'b\n' },
          { summary: 'beta özeti', filesTouched: ['shared.txt', 'beta.txt'] },
        );
      }
      if (p.startsWith('gamma')) return { status: 'null', error: 'gave up' };
      if (isCoordinator(p))
        return commits({ 'merged.txt': 'm\n' }, { summary: 'birleşti', filesTouched: ['merged.txt'] });
      throw new Error(`unexpected prompt: ${p}`);
    });
    const tasks = ['alpha', 'beta', 'gamma'].map((key) => ({ key, brief: `${key} işini yap` }));
    const { handle, logs } = start(repo, {
      runner,
      runId: 'fan1',
      script: example('fanout-writers'),
      args: { tasks },
    });
    const out = await handle.promise;

    expect(out).toEqual({
      summary: 'birleşti',
      filesTouched: ['merged.txt'],
      branchName: 'wf/fan1/coordinator',
    });
    expect(logs).toContain('2/3 branch geldi');
    expect(logs).toContain('çakışma adayı dosyalar: shared.txt');

    const writers = runner.calls.filter((c) => !isCoordinator(c.prompt));
    expect(writers).toHaveLength(3);
    // spec 3.6: the runtime opens the branch; the agent never reads its name.
    expect(writers.every((c) => !c.prompt.includes('wf/') && !c.system.includes('wf/'))).toBe(true);
    expect(writers.every((c) => c.isolated && c.cwd !== repo)).toBe(true);

    const coord = runner.calls.filter((c) => isCoordinator(c.prompt));
    expect(coord).toHaveLength(1);
    const cp = coord[0]!.prompt;
    expect(cp).toContain('Çakışma adayı dosyalar: shared.txt.');
    expect(cp).toContain('- wf/fan1/alpha: alpha özeti (2 dosya)');
    expect(cp).toContain('- wf/fan1/beta: beta özeti (2 dosya)');
    expect(cp).not.toContain('gamma');
    expect(coord[0]).toMatchObject({ isolated: true, effort: 'high' });

    expect(git(repo, 'show', 'wf/fan1/alpha:shared.txt')).toBe('alpha');
    expect(git(repo, 'show', 'wf/fan1/beta:shared.txt')).toBe('beta');
    expect(git(repo, 'show', 'wf/fan1/coordinator:merged.txt')).toBe('m');
  });

  it('no branch arrives: the coordinator is not called and the run returns null', async () => {
    const repo = await makeRepo();
    const runner = new FakeRunner((req): FakeResponse => {
      if (isCoordinator(req.prompt)) throw new Error('coordinator must not run');
      return { status: 'null' };
    });
    const tasks = ['alpha', 'beta'].map((key) => ({ key, brief: `${key} işini yap` }));
    const { handle, logs } = start(repo, {
      runner,
      runId: 'fan2',
      script: example('fanout-writers'),
      args: { tasks },
    });
    expect(await handle.promise).toBeNull();
    expect(logs).toContain('0/2 branch geldi');
    expect(runner.liveCalls).toBe(2);
    expect(runner.calls.some((c) => isCoordinator(c.prompt))).toBe(false);
  });
});
