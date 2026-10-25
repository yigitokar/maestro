// Isolation (spec 3.6) against real temporary git repositories.

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs, lstatSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { branchNameFor, gc, Isolation, type WorktreeLease } from '../src/isolation.js';
import { MaestroError } from '../src/types.js';

beforeAll(() => {
  // A developer machine's global config (gpgsign, hooks) must not leak into the fixtures.
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

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-iso-')));
  tmpDirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  // Trailing slash on purpose: it does not match a node_modules symlink (the exclude must).
  // `.maestro/` deliberately NOT ignored here: Isolation has to keep it out of status itself.
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
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

describe('branchNameFor', () => {
  it('builds wf/<runId>/<slug> and passes git check-ref-format', async () => {
    const repo = await makeRepo();
    expect(branchNameFor('r1', 'fix-auth', H('a'), 0)).toBe('wf/r1/fix-auth');
    expect(branchNameFor('r1', undefined, 'deadbeefcafe', 0)).toBe('wf/r1/agent-deadbeef');
    expect(branchNameFor('r1', 'fix', H('a'), 2)).toBe('wf/r1/fix');
    expect(branchNameFor('r1', undefined, 'deadbeefcafe', 2)).toBe('wf/r1/agent-deadbeef-2');
    expect(branchNameFor('r1', 'x y//z', H('a'), 0)).toBe('wf/r1/x-y-z');
    expect(branchNameFor('r1', 'foo.lock', H('a'), 0)).toBe('wf/r1/foo');
    expect(branchNameFor('r1', '..', 'abcdef0123', 0)).toBe('wf/r1/agent-abcdef01');
    const labels = [
      '',
      '..',
      '.hidden',
      'foo.lock',
      'foo.lock.lock',
      'a..b',
      'a//b',
      'x y',
      '~^:?*[',
      '@{x}',
      '@',
      '-lead',
      'trail.',
      'a/.b',
      'x'.repeat(300),
      'ünïcødé 漢字',
      'end-',
      undefined,
    ];
    for (const label of labels) {
      for (const n of [0, 3]) {
        const name = branchNameFor('run-1', label, 'f00dfeed99', n);
        expect(name.startsWith('wf/run-1/')).toBe(true);
        expect(name.split('/')).toHaveLength(3);
        expect(sh(repo, 'check-ref-format', '--branch', name)).toBe(name);
      }
    }
    // runId is sanitized into a single component as well
    const odd = branchNameFor('a/b c', 'l', H('a'), 0);
    expect(odd.split('/')).toHaveLength(3);
    expect(sh(repo, 'check-ref-format', '--branch', odd)).toBe(odd);
  });
});

describe('Isolation', () => {
  it('4 parallel writers hand off 4 distinct branches, worktrees removed', async () => {
    const repo = await makeRepo();
    const base = sh(repo, 'rev-parse', 'HEAD');
    const iso = new Isolation({ repoDir: repo, runId: 'run4' });
    const labels = ['alpha', 'beta', 'gamma', 'delta'];
    const results = await Promise.all(
      labels.map(async (label, i) => {
        const lease = await iso.open({
          key: `${H(String(i))}:0`,
          label,
          hash: H(String(i)),
          n: 0,
          writer: true,
        });
        expect(lease.baseSha).toBe(base);
        expect(lease.branch).toBe(`wf/run4/${label}`);
        expect(sh(lease.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`wf/run4/${label}`);
        await commitIn(lease.path, `${label}.txt`, `${label}\n`);
        const res = await lease.close(true);
        expect(existsSync(lease.path)).toBe(false);
        return res;
      }),
    );
    for (const [i, label] of labels.entries()) {
      expect(results[i]).toEqual({ branchName: `wf/run4/${label}` });
      expect(sh(repo, 'rev-list', '--count', `wf/run4/${label}`, `^${base}`)).toBe('1');
      expect(sh(repo, 'show', `wf/run4/${label}:${label}.txt`)).toBe(label);
    }
    expect(worktreeCount(repo)).toBe(1);
    // nested worktrees never showed up in the main checkout
    expect(sh(repo, 'status', '--porcelain')).toBe('');
  });

  it('16 parallel opens (mixed read-only / writer) all succeed and all are removed', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'run16' });
    const leases = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        iso.open({
          key: `${H('b')}:${i}`,
          label: i % 2 === 0 ? `w${i}` : 'reader',
          hash: H('b'),
          n: i,
          writer: i % 2 === 0,
        }),
      ),
    );
    expect(new Set(leases.map((l) => l.path)).size).toBe(16);
    expect(worktreeCount(repo)).toBe(17);
    for (const l of leases) {
      expect(existsSync(path.join(l.path, 'README.md'))).toBe(true);
      if (!l.writer) expect(sh(l.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    }
    const results = await Promise.all(leases.map((l) => l.close(false)));
    for (const [i, r] of results.entries()) {
      expect(r.dirty).toBeUndefined();
      if (i % 2 === 1) expect(r).toEqual({});
    }
    for (const l of leases) expect(existsSync(l.path)).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
  });

  it('writer that writes but does not commit: dirty kept, path logged, no branchName', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'r', log });
    const lease = await iso.open({ key: 'k:0', label: 'lazy', hash: H('c'), n: 0, writer: true });
    await fs.writeFile(path.join(lease.path, 'README.md'), 'changed\n');
    await fs.writeFile(path.join(lease.path, 'new.txt'), 'new\n');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/dirty/);
    expect(res.dirty?.path).toBe(lease.path);
    expect(res.dirty?.diffStat).toMatch(/README\.md/);
    expect(res.dirty?.diffStat).toMatch(/1 untracked file/);
    expect(existsSync(lease.path)).toBe(true);
    expect(lines.some((l) => l.includes(lease.path))).toBe(true);
    expect(lines.some((l) => l.startsWith('no handoff:'))).toBe(true);
  });

  it('writer that commits nothing: no handoff, worktree removed, branch stays', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'r', log });
    const lease = await iso.open({ key: 'k:0', label: 'idle', hash: H('d'), n: 0, writer: true });
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/no commit/);
    expect(res.dirty).toBeUndefined();
    expect(existsSync(lease.path)).toBe(false);
    expect(sh(repo, 'branch', '--list', 'wf/r/idle')).toContain('wf/r/idle');
    expect(lines.some((l) => l.startsWith('no handoff: no commit'))).toBe(true);
  });

  it('writer that switches to another branch and commits there: no handoff', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'r', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'rogue', hash: H('e'), n: 0, writer: true });
    sh(lease.path, 'checkout', '-q', '-b', 'elsewhere');
    await commitIn(lease.path, 'x.txt', 'x\n');
    const res = await lease.close(true);
    expect(res.branchName).toBeUndefined();
    expect(res.noHandoffReason).toMatch(/HEAD is elsewhere/);
    expect(existsSync(lease.path)).toBe(false);
  });

  it('resume after a failed attempt: same key re-opens, branch reset to base (-B)', async () => {
    const repo = await makeRepo();
    const base = sh(repo, 'rev-parse', 'HEAD');
    const iso1 = new Isolation({ repoDir: repo, runId: 'res', log: () => {} });
    const a = await iso1.open({ key: 'k:0', label: 'job', hash: H('f'), n: 0, writer: true });
    await commitIn(a.path, 'half.txt', 'half\n');
    expect((await a.close(false)).noHandoffReason).toBe('agent did not finish ok');
    expect(sh(repo, 'rev-parse', 'wf/res/job')).not.toBe(base);
    // new process / new Isolation for the resumed run
    const iso2 = new Isolation({ repoDir: repo, runId: 'res', log: () => {} });
    const b = await iso2.open({ key: 'k:0', label: 'job', hash: H('f'), n: 0, writer: true });
    expect(sh(repo, 'rev-parse', 'wf/res/job')).toBe(base);
    expect(existsSync(path.join(b.path, 'half.txt'))).toBe(false);
    await commitIn(b.path, 'full.txt', 'full\n');
    expect(await b.close(true)).toEqual({ branchName: 'wf/res/job' });
    // same key may re-claim within one instance too (retry)
    const c = await iso2.open({ key: 'k:0', label: 'job', hash: H('f'), n: 0, writer: true });
    expect(sh(c.path, 'rev-parse', 'HEAD')).toBe(base);
    await c.close(false);
  });

  it('resume after a DIRTY attempt still opens; previous changes stay on disk', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso1 = new Isolation({ repoDir: repo, runId: 'rd', log });
    const a = await iso1.open({ key: 'k:0', label: 'job', hash: H('1'), n: 0, writer: true });
    await fs.writeFile(path.join(a.path, 'wip.txt'), 'wip\n');
    const ra = await a.close(true);
    expect(ra.dirty?.path).toBe(a.path);
    const iso2 = new Isolation({ repoDir: repo, runId: 'rd', log });
    const b = await iso2.open({ key: 'k:0', label: 'job', hash: H('1'), n: 0, writer: true });
    expect(b.path).not.toBe(a.path);
    expect(sh(b.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wf/rd/job');
    expect(readFileSync(path.join(a.path, 'wip.txt'), 'utf8')).toBe('wip\n');
    expect(sh(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(lines.some((l) => l.includes('detached') && l.includes(a.path))).toBe(true);
    await commitIn(b.path, 'done.txt', 'done\n');
    expect(await b.close(true)).toEqual({ branchName: 'wf/rd/job' });
  });

  it('abort: close(false) removes a clean writer, keeps a dirty one and logs its path', async () => {
    const repo = await makeRepo();
    const { lines, log } = logger();
    const iso = new Isolation({ repoDir: repo, runId: 'ab', log });
    const clean = await iso.open({ key: 'a:0', label: 'clean', hash: H('2'), n: 0, writer: true });
    const dirty = await iso.open({ key: 'b:0', label: 'dirty', hash: H('3'), n: 0, writer: true });
    await fs.writeFile(path.join(dirty.path, 'README.md'), 'half-done\n');
    const ac = new AbortController();
    const run = async (lease: WorktreeLease) => {
      try {
        await new Promise((_, reject) => {
          ac.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      } catch {
        return lease.close(false);
      }
    };
    const pending = Promise.all([run(clean), run(dirty)]);
    ac.abort();
    const [rc, rd] = await pending;
    expect(rc?.branchName).toBeUndefined();
    expect(existsSync(clean.path)).toBe(false);
    expect(rd?.dirty?.path).toBe(dirty.path);
    expect(existsSync(dirty.path)).toBe(true);
    expect(lines.some((l) => l.includes(dirty.path))).toBe(true);
    // idempotent
    expect(await clean.close(true)).toBe(rc);
  });

  it('duplicate label with a different key throws duplicate_writer_branch; same key allowed', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'dup', log: () => {} });
    const opens = await Promise.allSettled([
      iso.open({ key: `${H('4')}:0`, label: 'same', hash: H('4'), n: 0, writer: true }),
      iso.open({ key: `${H('5')}:0`, label: 'same', hash: H('5'), n: 0, writer: true }),
    ]);
    expect(opens[0]?.status).toBe('fulfilled');
    expect(opens[1]?.status).toBe('rejected');
    const err = (opens[1] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('duplicate_writer_branch');
    const first = (opens[0] as PromiseFulfilledResult<WorktreeLease>).value;
    await first.close(false);
    const again = await iso.open({ key: `${H('4')}:0`, label: 'same', hash: H('4'), n: 0, writer: true });
    await again.close(false);
    // read-only agents never claim branches
    const r1 = await iso.open({ key: 'x:0', label: 'same', hash: H('6'), n: 0, writer: false });
    const r2 = await iso.open({ key: 'y:0', label: 'same', hash: H('7'), n: 0, writer: false });
    await Promise.all([r1.close(true), r2.close(true)]);
  });

  it('verification uses the recorded baseSha when main HEAD moves', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'mv', log: () => {} });
    const lease = await iso.open({ key: 'k:0', label: 'w', hash: H('8'), n: 0, writer: true });
    const base = lease.baseSha;
    // main moves ahead by two commits; `git add -A` in main must not pick up the nested worktree
    await commitIn(repo, 'm1.txt', '1\n');
    await commitIn(repo, 'm2.txt', '2\n');
    expect(sh(repo, 'ls-files')).not.toContain('.maestro');
    expect(sh(repo, 'rev-parse', 'HEAD')).not.toBe(base);
    await commitIn(lease.path, 'w.txt', 'w\n');
    expect(await lease.close(true)).toEqual({ branchName: 'wf/mv/w' });
    expect(sh(repo, 'merge-base', 'wf/mv/w', 'main')).toBe(base);
  });

  it('node_modules is not in a fresh worktree; symlinkNodeModules links it and stays clean', async () => {
    const repo = await makeRepo();
    const plain = new Isolation({ repoDir: repo, runId: 'nm1' });
    const a = await plain.open({ key: 'k:0', hash: H('9'), n: 0, writer: false });
    expect(existsSync(path.join(a.path, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(a.path, 'README.md'))).toBe(true);
    await a.close(true);

    const linked = new Isolation({ repoDir: repo, runId: 'nm2', symlinkNodeModules: true, log: () => {} });
    const b = await linked.open({ key: 'k:0', label: 'w', hash: H('a'), n: 0, writer: true });
    const nm = path.join(b.path, 'node_modules');
    expect(lstatSync(nm).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(nm, 'dep', 'index.js'))).toBe(true);
    expect(sh(b.path, 'status', '--porcelain')).toBe('');
    await fs.writeFile(path.join(b.path, 'f.txt'), 'f\n');
    sh(b.path, 'add', '-A');
    sh(b.path, 'commit', '-q', '-m', 'f');
    expect(sh(b.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('f.txt');
    expect(await b.close(true)).toEqual({ branchName: 'wf/nm2/w' });
    expect(existsSync(b.path)).toBe(false);
    // the real node_modules survived worktree removal
    expect(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('honours a custom worktreeRoot outside the repo', async () => {
    const repo = await makeRepo();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-iso-root-'));
    tmpDirs.push(root);
    const iso = new Isolation({ repoDir: repo, runId: 'cr', worktreeRoot: root });
    const lease = await iso.open({ key: 'k:0', hash: H('b'), n: 0, writer: false });
    expect(lease.path.startsWith(await fs.realpath(root))).toBe(true);
    await lease.close(true);
    expect(existsSync(lease.path)).toBe(false);
  });
});

describe('gc', () => {
  it('lists dirty worktrees and merged/unmerged wf/* branches; delete and force', async () => {
    const repo = await makeRepo();
    const iso = new Isolation({ repoDir: repo, runId: 'gc', log: () => {}, symlinkNodeModules: true });
    // merged: zero commits past main
    const m = await iso.open({ key: 'm:0', label: 'merged', hash: H('c'), n: 0, writer: true });
    await m.close(true);
    // unmerged: a real commit not on main
    const u = await iso.open({ key: 'u:0', label: 'unmerged', hash: H('d'), n: 0, writer: true });
    await commitIn(u.path, 'u.txt', 'u\n');
    await u.close(true);
    // dirty writer left behind
    const d = await iso.open({ key: 'd:0', label: 'dirty', hash: H('e'), n: 0, writer: true });
    await fs.writeFile(path.join(d.path, 'wip.txt'), 'wip\n');
    await d.close(true);
    // a non-wf branch must never be touched
    sh(repo, 'branch', 'feature');

    const listed = await gc({ repoDir: repo });
    expect(listed.dirtyWorktrees).toHaveLength(1);
    expect(listed.dirtyWorktrees[0]?.path).toBe(d.path);
    expect(listed.dirtyWorktrees[0]?.branch).toBe('wf/gc/dirty');
    expect(listed.dirtyWorktrees[0]?.diffStat).toMatch(/1 untracked file/);
    expect(listed.mergedBranches.sort()).toEqual(['wf/gc/dirty', 'wf/gc/merged']);
    expect(listed.unmergedBranches).toEqual(['wf/gc/unmerged']);
    expect(listed.removed).toEqual([]);
    expect(existsSync(d.path)).toBe(true);

    const del = await gc({ repoDir: repo, delete: true });
    expect(del.removed).toContain(d.path);
    expect(del.removed).toContain('wf/gc/merged');
    expect(del.removed).toContain('wf/gc/dirty');
    expect(del.removed).not.toContain('wf/gc/unmerged');
    expect(existsSync(d.path)).toBe(false);
    expect(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(sh(repo, 'branch', '--list', 'wf/*', '--format=%(refname:short)')).toBe('wf/gc/unmerged');
    expect(worktreeCount(repo)).toBe(1);

    const after = await gc({ repoDir: repo });
    expect(after.dirtyWorktrees).toEqual([]);
    expect(after.unmergedBranches).toEqual(['wf/gc/unmerged']);

    const forced = await gc({ repoDir: repo, delete: true, force: true });
    expect(forced.removed).toEqual(['wf/gc/unmerged']);
    expect(sh(repo, 'branch', '--list', 'wf/*')).toBe('');
    expect(sh(repo, 'branch', '--list', 'feature')).toContain('feature');
  });
});

describe('Isolation.claim (cached writer hits)', () => {
  it('a claimed branch blocks a different key and lets the same key re-claim', () => {
    const iso = new Isolation({ repoDir: process.cwd(), runId: 'claimrun' });
    const a = iso.claim({ key: 'h1:0', label: 'w', hash: 'h1', n: 0, writer: true });
    expect(a).toEqual({ branch: 'wf/claimrun/w', claimed: true });
    expect(iso.claim({ key: 'h1:0', label: 'w', hash: 'h1', n: 0, writer: true }).claimed).toBe(false);
    expect(() => iso.claim({ key: 'h2:0', label: 'w', hash: 'h2', n: 0, writer: true })).toThrow(
      /duplicate|collides/,
    );
  });
});
