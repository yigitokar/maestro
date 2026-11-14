// Isolation edge cases and failure modes, checked against docs/spec.md 3.6: unusual exit states,
// failed opens, resume after an interrupted writer, branch-name collisions, mutex contention and gc
// after a cherry-pick merge. Real temporary git repositories; the happy paths are in isolation.test.ts.

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gc, Isolation } from '../src/isolation.js';

beforeAll(() => {
  // A developer machine's global config (gpgsign, hooks) must not leak into the fixtures.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

function sh(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await tmp('maestro-iso-edge-');
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

const origPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = origPath;
  for (const d of tmpDirs.splice(0)) {
    // undo the chmods of the failed-open tests so cleanup cannot fail
    await fs.chmod(path.join(d, '.git', 'info', 'exclude'), 0o644).catch(() => {});
    await fs.rm(d, { recursive: true, force: true });
  }
});

function logger(): { lines: string[]; log: (m: string) => void } {
  const lines: string[] = [];
  return { lines, log: (m) => lines.push(m) };
}

async function commitIn(wt: string, file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(wt, file), content);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-q', '-m', `add ${file}`);
}

const H = (c: string) => c.repeat(64);
const worktreeCount = (repo: string) =>
  sh(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

/** root ignores file modes, so the read-only info/exclude of the failed-open tests would not fail. */
const isRoot = process.getuid?.() === 0;

/** Is the temp filesystem case-insensitive (default APFS / NTFS)? The fixtures live under os.tmpdir(). */
function caseInsensitiveTmp(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'maestro-iso-case-'));
  try {
    writeFileSync(path.join(dir, 'CaseProbe.tmp'), 'x');
    return existsSync(path.join(dir, 'caseprobe.tmp'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A `git` shim first on PATH: around every `worktree add|remove|prune` it takes an atomic mkdir
 * lock; if the lock is already held, another worktree mutation is running concurrently → OVERLAP.
 */
async function installGitShim(): Promise<{ logFile: string }> {
  const dir = await tmp('maestro-shim-');
  const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
  const logFile = path.join(dir, 'log');
  const lockDir = path.join(dir, 'lock');
  const script = `#!/bin/sh
case "$1 $2" in
  "worktree add"|"worktree remove"|"worktree prune")
    if mkdir "${lockDir}" 2>/dev/null; then
      echo "start $2" >> "${logFile}"
      sleep 0.03
      "${realGit}" "$@"; rc=$?
      echo "end $2" >> "${logFile}"
      rmdir "${lockDir}"
      exit $rc
    else
      echo "OVERLAP $2" >> "${logFile}"
      exec "${realGit}" "$@"
    fi
    ;;
esac
exec "${realGit}" "$@"
`;
  await fs.writeFile(path.join(dir, 'git'), script, { mode: 0o755 });
  await fs.writeFile(logFile, '');
  process.env.PATH = `${dir}${path.delimiter}${origPath}`;
  return { logFile };
}

// -----------------------------------------------------------------------------------------------

describe('open: start state and failure paths', () => {
  it('writer starts ON wf/<runId>/<label> (not detached); reader is detached at HEAD', async () => {
    const repo = await makeRepo();
    const head = sh(repo, 'rev-parse', 'HEAD');
    const iso = new Isolation({ repoDir: repo, runId: 'r1', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'coordinator', hash: H('9'), n: 0, writer: true });
    const r = await iso.open({ key: 'r:0', label: 'reader', hash: H('a'), n: 0, writer: false });
    expect(sh(w.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/wf/r1/coordinator');
    expect(sh(w.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(() => sh(r.path, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(sh(r.path, 'rev-parse', 'HEAD')).toBe(head);
    await w.close(false);
    await r.close(false);
  });

  // spec 3.6: a clean worktree is removed on every exit path; a throwing open returns no lease to close,
  // so open itself has to roll back. The read-only info/exclude makes the node_modules link step fail,
  // which runs after `git worktree add`.
  it.skipIf(isRoot)(
    'reader open that fails after `worktree add` (custom root) leaves no worktree behind',
    async () => {
      const repo = await makeRepo();
      const root = await tmp('maestro-wtroot-');
      const exclude = path.join(repo, '.git', 'info', 'exclude');
      await fs.mkdir(path.dirname(exclude), { recursive: true });
      await fs.writeFile(exclude, '# read-only\n');
      await fs.chmod(exclude, 0o444);
      const iso = new Isolation({
        repoDir: repo,
        runId: 'leak',
        worktreeRoot: root,
        symlinkNodeModules: true,
        log: () => {},
      });
      await expect(iso.open({ key: 'k:0', label: 'r', hash: H('4'), n: 0, writer: false })).rejects.toThrow(
        /EACCES|EPERM/,
      );
      expect(worktreeCount(repo)).toBe(1);
      expect(await fs.readdir(root)).toEqual([]);
    },
  );

  it.skipIf(isRoot)(
    'writer open that fails after `worktree add` (default root) leaves no worktree behind',
    async () => {
      const repo = await makeRepo();
      // context() needs nothing written (already excluded); linking node_modules must append and fails.
      const exclude = path.join(repo, '.git', 'info', 'exclude');
      await fs.mkdir(path.dirname(exclude), { recursive: true });
      await fs.writeFile(exclude, '/.maestro/\n');
      await fs.chmod(exclude, 0o444);
      const iso = new Isolation({ repoDir: repo, runId: 'lf', symlinkNodeModules: true, log: () => {} });
      await expect(iso.open({ key: 'k:0', label: 'w', hash: H('5'), n: 0, writer: true })).rejects.toThrow(
        /EACCES|EPERM/,
      );
      expect(worktreeCount(repo)).toBe(1);
      expect(await fs.readdir(path.join(repo, '.maestro', 'worktrees', 'lf'))).toEqual([]);
    },
  );

  it('open in a non-git directory rejects and creates nothing', async () => {
    const dir = await tmp('maestro-iso-nogit-');
    const iso = new Isolation({ repoDir: dir, runId: 'ng', log: () => {} });
    await expect(iso.open({ key: 'k:0', hash: H('6'), n: 0, writer: false })).rejects.toThrow(
      /not a git repository/,
    );
    expect(existsSync(path.join(dir, '.maestro'))).toBe(false);
  });
});

describe('close: exit verification and cleanup', () => {
  it('writer on an unborn (orphan) branch with staged files: no handoff, dirty worktree kept, path and diffstat returned and logged', async () => {
    // spec 3.6: a dirty worktree is not deleted; its path and `git diff --stat` go to the result and the log.
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'orph', log });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('1'), n: 0, writer: true });
    sh(lease.path, 'checkout', '-q', '--orphan', 'elsewhere'); // all files now staged as new, HEAD unborn
    expect(sh(lease.path, 'status', '--porcelain')).not.toBe('');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/HEAD is elsewhere/);
    expect(res.dirty?.path).toBe(lease.path);
    // `git diff --stat HEAD` cannot run on an unborn HEAD; the staged files still have to be listed
    expect(res.dirty?.diffStat).toMatch(/README\.md/);
    expect(existsSync(lease.path)).toBe(true);
    expect(lines.some((l) => l.includes('dirty') && l.includes(lease.path))).toBe(true);
  });

  it('writer on an unborn branch with a clean status: no handoff, worktree removed', async () => {
    // spec 3.6: a clean worktree is removed on every exit path.
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'orph2', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('2'), n: 0, writer: true });
    sh(lease.path, 'checkout', '-q', '--orphan', 'elsewhere');
    sh(lease.path, 'rm', '-rfq', '.');
    expect(sh(lease.path, 'status', '--porcelain')).toBe('');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/HEAD is elsewhere/);
    expect(res.dirty).toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
  });

  it('all three exit checks pass but `worktree remove` fails: branchName is still handed off, failure is logged', async () => {
    // spec 3.6: when the three checks hold the agent is ok and gets branchName. Removal is cleanup, not
    // evidence: a locked worktree must not turn the proven commit into a null.
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'lock', log });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('3'), n: 0, writer: true });
    await commitIn(lease.path, 'a.txt', 'a\n');
    sh(repo, 'worktree', 'lock', lease.path); // makes `git worktree remove` (no --force) fail
    try {
      const res = await lease.close(true);
      expect(res).toEqual({ branchName: 'wf/lock/w' });
      expect(existsSync(lease.path)).toBe(true);
      expect(lines.some((l) => l.startsWith('worktree remove failed') && l.includes(lease.path))).toBe(true);
    } finally {
      sh(repo, 'worktree', 'unlock', lease.path);
    }
  });

  it('a tag with the same name as the writer branch does not block a correct handoff', async () => {
    // With the tag present `rev-parse --abbrev-ref HEAD` prints heads/<branch>, not <branch>.
    const repo = await makeRepo();
    sh(repo, 'tag', 'wf/amb/w');
    const iso = new Isolation({ repoDir: repo, runId: 'amb', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('5'), n: 0, writer: true });
    expect(sh(lease.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/wf/amb/w');
    await commitIn(lease.path, 'a.txt', 'a\n');
    const res = await lease.close(true);
    expect(res).toEqual({ branchName: 'wf/amb/w' });
  });

  it('committed but left a tracked file modified: no branchName, dirty path + diffstat returned and logged; close is idempotent', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'dl', log });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('c'), n: 0, writer: true });
    await commitIn(w.path, 'a.txt', 'a\n');
    await fs.writeFile(path.join(w.path, 'README.md'), 'changed\n');
    const res = await w.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/dirty/);
    expect(res.dirty?.path).toBe(w.path);
    expect(res.dirty?.diffStat).toMatch(/README\.md/);
    expect(existsSync(w.path)).toBe(true);
    expect(lines.some((l) => l.includes(w.path))).toBe(true);
    expect(lines.some((l) => l.startsWith('no handoff'))).toBe(true);
    // a second close of the kept (dirty) lease returns the first result
    expect(await w.close(true)).toBe(res);
  });

  it('detached HEAD with a commit (agent left the branch): no handoff, clean worktree removed', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'dh', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('d'), n: 0, writer: true });
    sh(w.path, 'checkout', '-q', '--detach');
    await commitIn(w.path, 'a.txt', 'a\n');
    const res = await w.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/HEAD is detached/);
    expect(existsSync(w.path)).toBe(false);
  });

  it('writer committed then aborted: no handoff, clean worktree removed, commit kept on its branch', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'ab', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('e'), n: 0, writer: true });
    await commitIn(lease.path, 'w.txt', 'w\n');
    const tip = sh(lease.path, 'rev-parse', 'HEAD');
    const res = await lease.close(false);
    expect(res).toEqual({ noHandoffReason: 'agent did not finish ok' });
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

  it('dirty read-only worktree is kept and reported, never removed', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'ro', log });
    const lease = await iso.open({ key: 'k:0', label: 'reader', hash: H('2'), n: 0, writer: false });
    await fs.writeFile(path.join(lease.path, 'README.md'), 'oops\n');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toBeUndefined();
    expect(res.dirty?.path).toBe(lease.path);
    expect(res.dirty?.diffStat).toMatch(/README\.md/);
    expect(existsSync(lease.path)).toBe(true);
    expect(lines.some((l) => l.includes(lease.path))).toBe(true);
  });
});

describe('resume after an interrupted writer (spec 3.6: -B, not -b)', () => {
  it('previous attempt aborted in a merge conflict (unmerged index): the re-run opens and hands off', async () => {
    // Seviye 4: the coordinator writer cherry-picks / merges sibling branches and resolves conflicts.
    // Aborted mid-conflict its worktree is dirty (kept); on resume the writer runs again and `-B`
    // resets its branch, so that re-run must be able to open.
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

  it('previous attempt aborted mid-rebase: the re-run opens and hands off', async () => {
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

  it('crash before close (clean worktree left behind): resume opens a fresh worktree on the reset branch', async () => {
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

describe('writer branch names (spec 3.6 / Seviye 4: each writer gets its own wf/<runId>/<label>)', () => {
  // Loose refs differing only in case are one file on a case-insensitive filesystem.
  it.skipIf(!caseInsensitiveTmp())(
    'labels differing only in case: the second writer is refused and the first branch is not reset (case-insensitive FS)',
    async () => {
      const repo = await makeRepo();
      const base = sh(repo, 'rev-parse', 'HEAD');
      const iso = new Isolation({ repoDir: repo, runId: 'ci', log: () => {} });
      const upper = await iso.open({ key: `${H('7')}:0`, label: 'Fix', hash: H('7'), n: 0, writer: true });
      await commitIn(upper.path, 'upper.txt', 'upper\n');
      const upperTip = sh(upper.path, 'rev-parse', 'HEAD');
      await expect(
        iso.open({ key: `${H('8')}:0`, label: 'fix', hash: H('8'), n: 0, writer: true }),
      ).rejects.toMatchObject({ code: 'duplicate_writer_branch' });
      expect(sh(repo, 'rev-parse', 'refs/heads/wf/ci/Fix')).toBe(upperTip);
      expect(upperTip).not.toBe(base);
      expect(await upper.close(true)).toEqual({ branchName: 'wf/ci/Fix' });
    },
  );

  it('distinct labels "fix" (n=1) and "fix-1" (n=0) get distinct branches and can both run', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'nn', log: () => {} });
    const a = await iso.open({ key: `${H('a')}:0`, label: 'fix-1', hash: H('a'), n: 0, writer: true });
    const b = await iso.open({ key: `${H('b')}:1`, label: 'fix', hash: H('b'), n: 1, writer: true });
    expect(a.branch).toBe('wf/nn/fix-1');
    expect(b.branch).toBe('wf/nn/fix');
    await Promise.all([a.close(false), b.close(false)]);
  });

  it('a second writer with the same label but a different key is refused while the first runs; the first branch is untouched', async () => {
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

describe('per-repo mutex and contention', () => {
  it('16 parallel isolated opens and closes: worktree mutations never overlap (single mutex)', async () => {
    const repo = await makeRepo();
    const { logFile } = await installGitShim();
    const iso = new Isolation({ repoDir: repo, runId: 'mx', log: () => {} });
    const leases = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        iso.open({ key: `${H('7')}:${i}`, label: `w${i}`, hash: H('7'), n: i, writer: i % 2 === 0 }),
      ),
    );
    expect(worktreeCount(repo)).toBe(17);
    await Promise.all(leases.map((l) => l.close(false)));
    expect(worktreeCount(repo)).toBe(1);
    const log = await fs.readFile(logFile, 'utf8');
    expect(log).not.toMatch(/OVERLAP/);
    expect(log.match(/start add/g)?.length).toBe(16);
    expect(log.match(/start remove/g)?.length).toBe(16);
  });

  it('two Isolation instances (different runIds, same repo) share the mutex', async () => {
    const repo = await makeRepo();
    const { logFile } = await installGitShim();
    const a = new Isolation({ repoDir: repo, runId: 'ra', log: () => {} });
    const b = new Isolation({ repoDir: repo, runId: 'rb', log: () => {} });
    const leases = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? a : b).open({ key: `k${i}:0`, label: `x${i}`, hash: H('8'), n: 0, writer: true }),
      ),
    );
    await Promise.all(leases.map((l) => l.close(false)));
    const log = await fs.readFile(logFile, 'utf8');
    expect(log).not.toMatch(/OVERLAP/);
    // the shim really saw every mutation
    expect(log.match(/start add/g)?.length).toBe(8);
    expect(log.match(/start remove/g)?.length).toBe(8);
    expect(worktreeCount(repo)).toBe(1);
  });

  it('16 writers open, commit and close while their siblings do the same: every one hands off', async () => {
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
    for (const [i, r] of results.entries()) expect(r).toEqual({ branchName: `wf/storm/w${i}` });
    expect(worktreeCount(repo)).toBe(1);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('gc after the coordinator merge', () => {
  it('a writer branch integrated by cherry-pick (the Seviye 4 coordinator pattern) counts as merged and gc --delete removes it', async () => {
    // spec 3.6: run branches (wf/<runId>/*) are deleted with `workflow gc` after the coordinator merged
    // them; a cherry-picked branch never becomes an ancestor of HEAD.
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'cp', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'writer', hash: H('6'), n: 0, writer: true });
    await commitIn(w.path, 'feature.txt', 'feature\n');
    expect((await w.close(true)).branchName).toBe('wf/cp/writer');
    // main has moved since the writer's base: otherwise the picked commit can equal the branch tip, the
    // branch is a plain ancestor of HEAD and patch equivalence is never exercised
    await commitIn(repo, 'main.txt', 'main\n');
    sh(repo, 'cherry-pick', 'wf/cp/writer');
    expect(sh(repo, 'show', 'HEAD:feature.txt')).toBe('feature');
    expect(() => sh(repo, 'merge-base', '--is-ancestor', 'wf/cp/writer', 'HEAD')).toThrow();
    const listed = await gc({ repoDir: repo });
    expect(listed.mergedBranches).toEqual(['wf/cp/writer']);
    expect(listed.unmergedBranches).toEqual([]);
    const del = await gc({ repoDir: repo, delete: true });
    expect(del.removed).toEqual(['wf/cp/writer']);
    expect(sh(repo, 'branch', '--list', 'wf/*')).toBe('');
  });
});
