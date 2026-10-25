// Writer agents through run() (spec 3.6, Seviye 4 fan-out writers) on a real temporary git repo: the
// runtime opens wf/<runId>/<label>, verifies the hand-off from git and adds branchName to the result.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeResponse, FakeRunner } from '../src/testing/fake-runner.js';
import type { Entry, RunRequest } from '../src/types.js';
import { type RunOptions, run } from '../src/workflow.js';

beforeAll(() => {
  // A developer machine's global git config (gpgsign, hooks) must not leak into the fixtures.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-writers-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function start(repo: string, opts: RunOptions) {
  return run({ cwd: repo, concurrency: 4, ...opts });
}

function rows(runDir: string): Entry[] {
  return readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Entry);
}

const WRITE_TOOLS = "['read_file', 'grep', 'glob', 'bash', 'write_file', 'edit_file', 'shell', 'git_commit']";
const WRITE_RESULT =
  "{ type: 'object', properties: { summary: { type: 'string' }, filesTouched: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'filesTouched'] }";
const META = "export const meta = { name: 'writers', description: 'w' };\n";

/** Writes <file> in the agent's worktree; commits unless told not to. */
function writes(file: string, opts: { commit?: boolean } = {}): FakeResponse {
  return {
    effect: async (req: RunRequest) => {
      await writeFile(path.join(req.cwd, file), `${file}\n`);
      if (opts.commit !== false) {
        git(req.cwd, 'add', '-A');
        git(req.cwd, 'commit', '-q', '-m', `add ${file}`);
      }
    },
    result: { summary: `wrote ${file}`, filesTouched: [file] },
  };
}

const worktrees = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

describe('writer agents (spec 3.6)', () => {
  it('4 parallel writers: each result carries branchName wf/<runId>/<label>; clean worktrees are removed', async () => {
    const repo = await makeRepo();
    const cwds: string[] = [];
    const runner = new FakeRunner((req) => {
      cwds.push(req.cwd);
      return writes(`${req.prompt.split(' ')[1]}.txt`);
    });
    const handle = start(repo, {
      runner,
      runId: 'r1',
      script: `${META}const keys = ['alpha', 'beta', 'gamma', 'delta'];
const out = await parallel(keys.map((k) => () =>
  agent('task ' + k + ' then commit', { label: k, isolation: 'worktree', tools: ${WRITE_TOOLS}, schema: ${WRITE_RESULT} })));
log(out.filter(Boolean).length + '/4 branch geldi');
return out;`,
    });
    const out = (await handle.promise) as Array<{
      summary: string;
      filesTouched: string[];
      branchName: string;
    }>;
    expect(out.map((o) => o.branchName)).toEqual(['wf/r1/alpha', 'wf/r1/beta', 'wf/r1/gamma', 'wf/r1/delta']);
    expect(out[0]).toEqual({
      summary: 'wrote alpha.txt',
      filesTouched: ['alpha.txt'],
      branchName: 'wf/r1/alpha',
    });
    // Every agent ran isolated in its own worktree, with the writer system prompt.
    expect(new Set(cwds).size).toBe(4);
    expect(cwds.every((c) => c !== repo)).toBe(true);
    expect(runner.calls.every((c) => c.isolated && c.system.includes('git_commit'))).toBe(true);
    // Worktrees are gone, branches stay with one commit each.
    expect(worktrees(repo)).toHaveLength(1);
    expect(cwds.every((c) => !existsSync(c))).toBe(true);
    expect(git(repo, 'branch', '--list', 'wf/*', '--format=%(refname:short)').split('\n').sort()).toEqual([
      'wf/r1/alpha',
      'wf/r1/beta',
      'wf/r1/delta',
      'wf/r1/gamma',
    ]);
    expect(git(repo, 'show', 'wf/r1/beta:beta.txt')).toBe('beta.txt');
    // The main checkout is untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // Resume: ok writers come from the journal, branchName included; no worktree is opened.
    const r2 = new FakeRunner();
    const again = start(repo, { runner: r2, resumeFromRunId: 'r1' });
    expect(await again.promise).toEqual(out);
    expect(r2.liveCalls).toBe(0);
  });

  it('a writer that does not commit: agent() null, the row records the dirty worktree, which is kept', async () => {
    const repo = await makeRepo();
    const handle = start(repo, {
      runner: new FakeRunner(() => writes('draft.txt', { commit: false })),
      runId: 'r2',
      script: `${META}return agent('draft it', { label: 'drafter', isolation: 'worktree', tools: ${WRITE_TOOLS}, schema: ${WRITE_RESULT} });`,
    });
    const logs: string[] = [];
    handle.events.on('log', (e: { message: string }) => logs.push(e.message));
    expect(await handle.promise).toBeNull();
    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({ status: 'null', result: null, label: 'drafter' });
    expect(row!.error).toMatch(/dirty/);
    expect(row!.worktree?.path).toBeTruthy();
    expect(row!.worktree?.diffStat).toMatch(/untracked/);
    expect(existsSync(path.join(row!.worktree!.path, 'draft.txt'))).toBe(true);
    expect(logs.some((m) => m.startsWith('no handoff'))).toBe(true);
    expect(logs.some((m) => m.includes(row!.worktree!.path))).toBe(true);
  });

  it('a writer that is null on the first run re-runs on resume over its existing branch (-B) and hands off', async () => {
    const repo = await makeRepo();
    const script = `${META}return agent('fix it', { label: 'fixer', isolation: 'worktree', tools: ${WRITE_TOOLS}, schema: ${WRITE_RESULT} });`;
    // First attempt commits, then dies with an API error: the branch exists, the agent is null.
    const first = start(repo, {
      runner: new FakeRunner(() => ({ ...writes('first.txt'), status: 'null', error: '500' })),
      runId: 'r3',
      script,
    });
    expect(await first.promise).toBeNull();
    expect(git(repo, 'branch', '--list', 'wf/r3/fixer', '--format=%(refname:short)')).toBe('wf/r3/fixer');

    const second = start(repo, { runner: new FakeRunner(() => writes('second.txt')), resumeFromRunId: 'r3' });
    const v = (await second.promise) as { branchName: string };
    expect(v.branchName).toBe('wf/r3/fixer');
    // -B reset the branch to HEAD: only the second attempt's commit is on it.
    expect(git(repo, 'log', '--format=%s', 'main..wf/r3/fixer')).toBe('add second.txt');
    expect(rows(first.runDir).map((e) => e.status)).toEqual(['null', 'ok']);
  });

  it('a read-only isolated agent gets a detached worktree that is removed afterwards', async () => {
    const repo = await makeRepo();
    let seen: { cwd: string; head: string; readme: string } | undefined;
    const runner = new FakeRunner(() => ({
      effect: (req) => {
        seen = {
          cwd: req.cwd,
          head: git(req.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
          readme: readFileSync(path.join(req.cwd, 'README.md'), 'utf8'),
        };
      },
      result: 'looked',
    }));
    const handle = start(repo, {
      runner,
      runId: 'r4',
      script: `${META}return agent('look around', { label: 'reader', isolation: 'worktree' });`,
    });
    expect(await handle.promise).toBe('looked');
    expect(seen!.cwd).not.toBe(repo);
    expect(seen!.head).toBe('HEAD');
    expect(seen!.readme).toBe('hello\n');
    expect(runner.calls[0]!.tools.some((t) => t.write)).toBe(false);
    expect(runner.calls[0]!.isolated).toBe(true);
    expect(existsSync(seen!.cwd)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(git(repo, 'branch', '--list', 'wf/*')).toBe('');
  });
});
