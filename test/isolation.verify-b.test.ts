// Adversarial verification of Isolation (spec 3.6, Seviye 4 fan-out writers, v0.2/v0.3 decisions):
// abort / resume / failure paths, git lock contention, branch-name boundaries. Real temp git repos.
// Tests marked SPEC-VIOLATION assert the spec behaviour and are expected to fail against the
// implementation they were written against; the rest are regression probes that should pass.

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { branchNameFor, gc, Isolation } from '../src/isolation.js';
import { MaestroError } from '../src/types.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Run git and swallow a non-zero exit (used to provoke conflicts). */
function shMayFail(cwd: string, ...args: string[]): void {
  try {
    sh(cwd, ...args);
  } catch {
    // expected (conflict)
  }
}

const tmpDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-isob-')));
  tmpDirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  await fs.writeFile(path.join(dir, 'shared.txt'), 'base\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    // undo chmods / worktree locks so cleanup cannot fail
    try {
      await fs.chmod(path.join(d, '.git', 'info', 'exclude'), 0o644);
    } catch {
      // absent
    }
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function commitIn(wt: string, file: string, content: string, msg = `add ${file}`): Promise<void> {
  await fs.writeFile(path.join(wt, file), content);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-q', '-m', msg);
}

const H = (c: string) => c.repeat(64);
const worktreeCount = (repo: string) =>
  sh(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

/** Case-insensitive filesystem (default APFS / NTFS)? */
async function caseInsensitiveFs(dir: string): Promise<boolean> {
  const probe = path.join(dir, 'CaseProbe.tmp');
  await fs.writeFile(probe, 'x');
  const hit = existsSync(path.join(dir, 'caseprobe.tmp'));
  await fs.rm(probe);
  return hit;
}

// ---------------------------------------------------------------------------------------------
// SPEC-VIOLATION: resume of a writer whose previous attempt was aborted mid-operation

describe('resume after an interrupted writer (spec 3.6 "-B, -b değil")', () => {
  it('SPEC-VIOLATION: previous attempt aborted in a merge conflict (unmerged index) -> re-run still opens', async () => {
    // Seviye 4: the coordinator writer cherry-picks / merges sibling branches and resolves conflicts.
    // If it is aborted mid-conflict its worktree is dirty (kept). spec 3.6: on resume a `null`/`skipped`
    // writer runs again and `-B` resets its branch; that re-run must be able to open.
    const repo = await makeRepo();
    sh(repo, 'checkout', '-q', '-b', 'side');
    await commitIn(repo, 'shared.txt', 'side\n');
    sh(repo, 'checkout', '-q', 'main');

    const iso1 = new Isolation({ repoDir: repo, runId: 'rc', log: () => {} });
    const a = await iso1.open({ key: 'k:0', label: 'coordinator', hash: H('1'), n: 0, writer: true });
    await commitIn(a.path, 'shared.txt', 'mine\n');
    shMayFail(a.path, 'merge', '--no-edit', 'side'); // conflict -> unmerged index
    expect(sh(a.path, 'ls-files', '-u')).not.toBe('');
    const ra = await a.close(false); // aborted
    expect(ra.dirty?.path).toBe(a.path);

    const iso2 = new Isolation({ repoDir: repo, runId: 'rc', log: () => {} });
    const b = await iso2.open({ key: 'k:0', label: 'coordinator', hash: H('1'), n: 0, writer: true });
    expect(sh(b.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wf/rc/coordinator');
    expect(sh(b.path, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'main'));
    await commitIn(b.path, 'done.txt', 'done\n');
    expect(await b.close(true)).toEqual({ branchName: 'wf/rc/coordinator' });
  });

  it('SPEC-VIOLATION: previous attempt aborted mid-rebase -> re-run still opens', async () => {
    const repo = await makeRepo();
    const iso1 = new Isolation({ repoDir: repo, runId: 'rr', log: () => {} });
    const a = await iso1.open({ key: 'k:0', label: 'coordinator', hash: H('2'), n: 0, writer: true });
    await commitIn(a.path, 'shared.txt', 'mine\n');
    // main moves with a conflicting change; the coordinator rebases onto it and is aborted mid-conflict
    await commitIn(repo, 'shared.txt', 'theirs\n');
    shMayFail(a.path, 'rebase', 'main');
    expect(sh(a.path, 'status', '--porcelain')).not.toBe('');
    const ra = await a.close(false);
    expect(ra.dirty?.path).toBe(a.path);

    const iso2 = new Isolation({ repoDir: repo, runId: 'rr', log: () => {} });
    const b = await iso2.open({ key: 'k:0', label: 'coordinator', hash: H('2'), n: 0, writer: true });
    expect(sh(b.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wf/rr/coordinator');
    await commitIn(b.path, 'done.txt', 'done\n');
    expect(await b.close(true)).toEqual({ branchName: 'wf/rr/coordinator' });
  });

  it('probe: crash before close (clean worktree left behind) -> resume opens a fresh worktree', async () => {
    const repo = await makeRepo();
    const base = sh(repo, 'rev-parse', 'HEAD');
    const iso1 = new Isolation({ repoDir: repo, runId: 'cr', log: () => {} });
    const a = await iso1.open({ key: 'k:0', label: 'w', hash: H('3'), n: 0, writer: true });
    await commitIn(a.path, 'half.txt', 'half\n');
    // process dies: close() never runs
    const iso2 = new Isolation({ repoDir: repo, runId: 'cr', log: () => {} });
    const b = await iso2.open({ key: 'k:0', label: 'w', hash: H('3'), n: 0, writer: true });
    expect(b.path).not.toBe(a.path);
    expect(sh(repo, 'rev-parse', 'wf/cr/w')).toBe(base);
    await commitIn(b.path, 'full.txt', 'full\n');
    expect(await b.close(true)).toEqual({ branchName: 'wf/cr/w' });
  });
});

// ---------------------------------------------------------------------------------------------
// SPEC-VIOLATION: cleanup failure must not destroy a verified hand-off

describe('exit verification vs. cleanup failure (spec 3.6 "Çıkış doğrulaması runtime\'da")', () => {
  it('SPEC-VIOLATION: three git checks pass but `worktree remove` fails -> branchName still handed off', async () => {
    // spec 3.6: "Üçü de tutarsa ajan ok ve dönüş değerine branchName eklenir." Removal is cleanup; when
    // it fails (locked worktree, populated submodules, a tool process still writing ...) the commit on
    // the branch is still the agent's proven product and must not be turned into null.
    const repo = await makeRepo();
    const lines: string[] = [];
    const iso = new Isolation({ repoDir: repo, runId: 'lk', log: (m) => lines.push(m) });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('4'), n: 0, writer: true });
    await commitIn(lease.path, 'w.txt', 'w\n');
    sh(repo, 'worktree', 'lock', lease.path); // makes `git worktree remove` (no --force) fail
    try {
      const res = await lease.close(true);
      expect(res.branchName).toBe('wf/lk/w');
    } finally {
      sh(repo, 'worktree', 'unlock', lease.path);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// SPEC-VIOLATION: open() must not leak a worktree when it fails after `git worktree add`

describe('open() failure paths (spec 3.6 "her çıkış yolunda")', () => {
  it('SPEC-VIOLATION: a failure after `worktree add` (node_modules link) leaves no worktree behind', async () => {
    const repo = await makeRepo();
    // context() needs nothing written (already excluded); linking node_modules must append and fails.
    const exclude = path.join(repo, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await fs.writeFile(exclude, '/.maestro/\n');
    await fs.chmod(exclude, 0o444);
    const iso = new Isolation({ repoDir: repo, runId: 'lf', symlinkNodeModules: true, log: () => {} });
    await expect(iso.open({ key: 'k:0', label: 'w', hash: H('5'), n: 0, writer: true })).rejects.toBeTruthy();
    // the caller never got a lease, so it can never close it: open itself must roll back
    expect(worktreeCount(repo)).toBe(1);
  });

  it('probe: open in a non-git directory rejects and creates nothing', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-isob-nogit-')));
    tmpDirs.push(dir);
    const iso = new Isolation({ repoDir: dir, runId: 'ng', log: () => {} });
    await expect(iso.open({ key: 'k:0', hash: H('6'), n: 0, writer: false })).rejects.toBeTruthy();
    expect(existsSync(path.join(dir, '.maestro'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Branch-name boundaries (spec 3.6 / Seviye 4: each writer gets its own wf/<runId>/<label>)

describe('writer branch names', () => {
  it('SPEC-VIOLATION: labels differing only in case never share a branch (case-insensitive FS)', async () => {
    const repo = await makeRepo();
    if (!(await caseInsensitiveFs(repo))) return; // only meaningful on APFS / NTFS defaults
    const base = sh(repo, 'rev-parse', 'HEAD');
    const iso = new Isolation({ repoDir: repo, runId: 'ci', log: () => {} });
    const upper = await iso.open({ key: `${H('7')}:0`, label: 'Fix', hash: H('7'), n: 0, writer: true });
    await commitIn(upper.path, 'upper.txt', 'upper\n');
    const upperTip = sh(upper.path, 'rev-parse', 'HEAD');
    let lower: Awaited<ReturnType<Isolation['open']>> | undefined;
    try {
      lower = await iso.open({ key: `${H('8')}:0`, label: 'fix', hash: H('8'), n: 0, writer: true });
    } catch (err) {
      // acceptable: an explicit refusal instead of silently sharing a ref
      expect(err).toBeInstanceOf(MaestroError);
      expect((err as MaestroError).code).toBe('duplicate_writer_branch');
    }
    // the sibling must not have reset the first writer's branch
    expect(sh(repo, 'rev-parse', 'refs/heads/wf/ci/Fix')).toBe(upperTip);
    expect(upperTip).not.toBe(base);
    expect(await upper.close(true)).toEqual({ branchName: 'wf/ci/Fix' });
    if (lower) await lower.close(false);
  });

  it('SPEC-VIOLATION: a labelled writer gets exactly wf/<runId>/<label>, whatever its occurrence n', () => {
    // best-of-N: same prompt/opts (same hash), distinct labels -> n = 0, 1, 2
    expect(branchNameFor('r', 'try-a', H('9'), 0)).toBe('wf/r/try-a');
    expect(branchNameFor('r', 'try-b', H('9'), 1)).toBe('wf/r/try-b');
    expect(branchNameFor('r', 'try-c', H('9'), 2)).toBe('wf/r/try-c');
  });

  it('SPEC-VIOLATION: distinct labels "fix" (n=1) and "fix-1" (n=0) can both run', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'nn', log: () => {} });
    const a = await iso.open({ key: `${H('a')}:0`, label: 'fix-1', hash: H('a'), n: 0, writer: true });
    const b = await iso.open({ key: `${H('b')}:1`, label: 'fix', hash: H('b'), n: 1, writer: true });
    expect(a.branch).not.toBe(b.branch);
    await Promise.all([a.close(false), b.close(false)]);
  });

  it('probe: a second writer with the same label but a different key is refused while the first runs', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'dl', log: () => {} });
    const a = await iso.open({ key: 'a:0', label: 'same', hash: H('c'), n: 0, writer: true });
    await commitIn(a.path, 'a.txt', 'a\n');
    const tip = sh(a.path, 'rev-parse', 'HEAD');
    await expect(
      iso.open({ key: 'b:0', label: 'same', hash: H('d'), n: 0, writer: true }),
    ).rejects.toMatchObject({ code: 'duplicate_writer_branch' });
    expect(sh(repo, 'rev-parse', 'wf/dl/same')).toBe(tip);
    expect(await a.close(true)).toEqual({ branchName: 'wf/dl/same' });
  });
});

// ---------------------------------------------------------------------------------------------
// Abort paths and contention (regression probes)

describe('abort and contention probes', () => {
  it('writer committed then aborted: no handoff, clean worktree removed, commit kept on its branch', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'ab', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('e'), n: 0, writer: true });
    await commitIn(lease.path, 'w.txt', 'w\n');
    const tip = sh(lease.path, 'rev-parse', 'HEAD');
    const res = await lease.close(false);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toBeTruthy();
    expect(res.dirty).toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
    expect(sh(repo, 'rev-parse', 'wf/ab/w')).toBe(tip);
    // idempotent: a later close(true) does not flip the verdict
    expect((await lease.close(true)).branchName).toBeUndefined();
  });

  it('worktree directory deleted by the agent: close never throws, writer gets no handoff, git pruned', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'gone', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('f'), n: 0, writer: true });
    const r = await iso.open({ key: 'r:0', hash: H('0'), n: 0, writer: false });
    await commitIn(w.path, 'w.txt', 'w\n');
    await fs.rm(w.path, { recursive: true, force: true });
    await fs.rm(r.path, { recursive: true, force: true });
    const [rw, rr] = await Promise.all([w.close(true), r.close(true)]);
    expect(rw.branchName).toBeUndefined();
    expect(rw.noHandoffReason).toMatch(/disappeared/);
    expect(rr).toEqual({});
    expect(worktreeCount(repo)).toBe(1);
  });

  it('16 writers committing while siblings open/close concurrently: no git lock errors', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'storm', log: () => {} });
    const results = await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const lease = await iso.open({
          key: `${H('1')}:${i}`,
          label: `w${i}`,
          hash: H('1'),
          n: i,
          writer: true,
        });
        await commitIn(lease.path, `f${i}.txt`, `${i}\n`);
        return lease.close(true);
      }),
    );
    for (const r of results) expect(r.branchName).toBeDefined();
    expect(worktreeCount(repo)).toBe(1);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
  });

  it('dirty read-only worktree is kept and reported, never removed', async () => {
    const repo = await makeRepo();
    const lines: string[] = [];
    const iso = new Isolation({ repoDir: repo, runId: 'ro', log: (m) => lines.push(m) });
    const lease = await iso.open({ key: 'k:0', label: 'reader', hash: H('2'), n: 0, writer: false });
    await fs.writeFile(path.join(lease.path, 'README.md'), 'oops\n');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.dirty?.path).toBe(lease.path);
    expect(existsSync(lease.path)).toBe(true);
    expect(lines.some((l) => l.includes(lease.path))).toBe(true);
  });

  it('gc without delete never removes anything (no automatic deletion)', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'g', log: () => {} });
    const d = await iso.open({ key: 'd:0', label: 'dirty', hash: H('3'), n: 0, writer: true });
    await fs.writeFile(path.join(d.path, 'wip.txt'), 'wip\n');
    await d.close(true);
    const before = sh(repo, 'branch', '--list', 'wf/*');
    const out = await gc({ repoDir: repo });
    expect(out.removed).toEqual([]);
    expect(existsSync(d.path)).toBe(true);
    expect(sh(repo, 'branch', '--list', 'wf/*')).toBe(before);
  });
});
