// Adversarial spec-contract suite for Isolation (spec 3.6, Seviye 4 fan-out writers pattern).
// Tests assert SPEC behaviour; the ones marked "VIOLATION" fail against the current src/isolation.ts.

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gc, Isolation } from '../src/isolation.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

function sh(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const tmpDirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

async function makeRepo(): Promise<string> {
  const dir = await tmp('maestro-iso-va-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
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
    await fs.chmod(d, 0o755).catch(() => {});
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
// Violations

describe('spec 3.6 exit verification / cleanup: violations', () => {
  it('VIOLATION: writer on an unborn (orphan) branch with staged files: dirty worktree reported in return value and log', async () => {
    // spec 3.6: "Kirli worktree silinmez; yolu ve git diff --stat özeti dönüş değerine ve log'a yazılır."
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'orph', log });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('1'), n: 0, writer: true });
    sh(lease.path, 'checkout', '-q', '--orphan', 'elsewhere'); // all files now staged as new, HEAD unborn
    expect(sh(lease.path, 'status', '--porcelain')).not.toBe('');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.dirty?.path).toBe(lease.path);
    expect(existsSync(lease.path)).toBe(true);
    expect(lines.some((l) => l.includes('dirty') && l.includes(lease.path))).toBe(true);
  });

  it('VIOLATION: writer on an unborn branch with a clean status: worktree is removed (every exit path)', async () => {
    // spec 3.6: "Bitişte git status temizse worktree finally bloğunda silinir, ... her çıkış yolunda."
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'orph2', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('2'), n: 0, writer: true });
    sh(lease.path, 'checkout', '-q', '--orphan', 'elsewhere');
    sh(lease.path, 'rm', '-rfq', '.');
    expect(sh(lease.path, 'status', '--porcelain')).toBe('');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toBeTruthy();
    expect(existsSync(lease.path)).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
  });

  it('VIOLATION: all three exit checks pass but worktree removal fails: branchName must still be returned', async () => {
    // spec 3.6: "Üçü de tutarsa ajan ok ve dönüş değerine branchName eklenir." Removal is cleanup, not evidence.
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'lock', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('3'), n: 0, writer: true });
    await commitIn(lease.path, 'a.txt', 'a\n');
    sh(repo, 'worktree', 'lock', lease.path); // makes `git worktree remove` fail
    const res = await lease.close(true);
    expect(res.branchName).toBe('wf/lock/w');
    sh(repo, 'worktree', 'unlock', lease.path);
  });

  it('VIOLATION: a failed open() must not leak a registered worktree that nobody can close', async () => {
    // spec 3.6: clean worktree removed "her çıkış yolunda"; a throwing open returns no lease to close.
    if (process.getuid?.() === 0) return; // root ignores the chmod below
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
    await expect(iso.open({ key: 'k:0', label: 'r', hash: H('4'), n: 0, writer: false })).rejects.toThrow();
    expect(worktreeCount(repo)).toBe(1);
    await fs.chmod(exclude, 0o644);
  });

  it('VIOLATION (low): a same-named tag makes --abbrev-ref print heads/<branch>; correct handoff must not be rejected', async () => {
    // spec 3.6: HEAD on the expected branch + clean + >= 1 commit → ok + branchName.
    const repo = await makeRepo();
    sh(repo, 'tag', 'wf/amb/w');
    const iso = new Isolation({ repoDir: repo, runId: 'amb', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('5'), n: 0, writer: true });
    expect(sh(lease.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/wf/amb/w');
    await commitIn(lease.path, 'a.txt', 'a\n');
    const res = await lease.close(true);
    expect(res.branchName).toBe('wf/amb/w');
  });
});

describe('spec 3.6 gc after coordinator merge: violation', () => {
  it('VIOLATION: writer branch integrated by cherry-pick (the Seviye 4 coordinator pattern) is deleted by gc --delete', async () => {
    // spec 3.6: "Run branch'leri (wf/<runId>/*) koordinatör birleştirdikten sonra workflow gc ile silinir";
    // Seviye 4: the coordinator integrates writer branches with `git cherry-pick`.
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'cp', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'writer', hash: H('6'), n: 0, writer: true });
    await commitIn(w.path, 'feature.txt', 'feature\n');
    expect((await w.close(true)).branchName).toBe('wf/cp/writer');
    // Coordinator result lands on main (cherry-pick of the writer branch).
    sh(repo, 'cherry-pick', 'wf/cp/writer');
    expect(sh(repo, 'show', 'HEAD:feature.txt')).toBe('feature');
    const listed = await gc({ repoDir: repo });
    expect(listed.mergedBranches).toContain('wf/cp/writer');
    const del = await gc({ repoDir: repo, delete: true });
    expect(del.removed).toContain('wf/cp/writer');
  });
});

// -----------------------------------------------------------------------------------------------
// Invariant probes (expected to pass; durable regression coverage)

describe('spec 3.6 invariants (probes)', () => {
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
    expect(worktreeCount(repo)).toBe(1);
  });

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

  it('committed + clean writer: branchName returned, worktree removed, branch kept; no path/diff in result', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'ok', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('b'), n: 0, writer: true });
    await commitIn(w.path, 'a.txt', 'a\n');
    const res = await w.close(true);
    expect(res).toEqual({ branchName: 'wf/ok/w' });
    expect(existsSync(w.path)).toBe(false);
    expect(sh(repo, 'show', 'wf/ok/w:a.txt')).toBe('a');
  });

  it('committed but left an untracked file: no branchName (kirli lane), dirty path + diffstat returned and logged', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'dl', log });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('c'), n: 0, writer: true });
    await commitIn(w.path, 'a.txt', 'a\n');
    await fs.writeFile(path.join(w.path, 'README.md'), 'changed\n');
    const res = await w.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.dirty?.path).toBe(w.path);
    expect(res.dirty?.diffStat).toMatch(/README\.md/);
    expect(existsSync(w.path)).toBe(true);
    expect(lines.some((l) => l.includes(w.path))).toBe(true);
    expect(lines.some((l) => l.startsWith('no handoff'))).toBe(true);
  });

  it('detached HEAD with a commit (agent left the branch): no handoff', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'dh', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('d'), n: 0, writer: true });
    sh(w.path, 'checkout', '-q', '--detach');
    await commitIn(w.path, 'a.txt', 'a\n');
    const res = await w.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toBeTruthy();
  });

  it('-B on resume: an existing, unrelated-history branch of the same name is reset to HEAD (no -b error)', async () => {
    const repo = await makeRepo();
    const head = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'branch', 'wf/rs/w');
    const iso1 = new Isolation({ repoDir: repo, runId: 'rs', log: () => {} });
    const a = await iso1.open({ key: 'w:0', label: 'w', hash: H('e'), n: 0, writer: true });
    await commitIn(a.path, 'old.txt', 'old\n');
    await a.close(false); // previous attempt not ok
    const iso2 = new Isolation({ repoDir: repo, runId: 'rs', log: () => {} });
    const b = await iso2.open({ key: 'w:0', label: 'w', hash: H('e'), n: 0, writer: true });
    expect(sh(b.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(path.join(b.path, 'old.txt'))).toBe(false);
    await b.close(false);
  });

  it('close() is idempotent and gc without delete removes nothing', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'id', log: () => {} });
    const w = await iso.open({ key: 'w:0', label: 'w', hash: H('f'), n: 0, writer: true });
    await fs.writeFile(path.join(w.path, 'wip.txt'), 'wip\n');
    const r1 = await w.close(true);
    const r2 = await w.close(true);
    expect(r2).toBe(r1);
    const listed = await gc({ repoDir: repo });
    expect(listed.removed).toEqual([]);
    expect(listed.dirtyWorktrees.map((d) => d.path)).toEqual([w.path]);
    expect(existsSync(w.path)).toBe(true);
  });
});
