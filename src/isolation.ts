// Isolation (spec 3.6): one git worktree per isolated agent. Read-only agents get a detached
// checkout, writers get the runtime-opened branch wf/<runId>/<slug>. Every worktree add/remove/prune
// and branch-moving git command runs under one per-repo mutex. Clean worktrees are removed on close,
// dirty ones are kept for `gc`; writer hand-off is verified from git, never from the agent's word.

import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { childGitEnv } from './git-env.js';
import { MaestroError } from './types.js';

// ---------------------------------------------------------------------------------------------
// git helper

/** Environment for every git child: never inherit a foreign repo (hooks / agent runtimes set these). */
function gitEnv(): NodeJS.ProcessEnv {
  return childGitEnv({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || '').trim() || err.message;
          reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${msg}`));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// per-repo mutex (keyed by realpath of the git common dir)

const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(lockKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  repoLocks.set(lockKey, tail);
  void tail.then(() => {
    if (repoLocks.get(lockKey) === tail) repoLocks.delete(lockKey);
  });
  return run;
}

interface RepoInfo {
  /** realpath of the main checkout's top level */
  toplevel: string;
  /** realpath of the git common dir (mutex key) */
  commonDir: string;
}

async function repoInfo(repoDir: string): Promise<RepoInfo> {
  const common = (await git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  const commonDir = await fs.realpath(common);
  // The first `worktree list` entry is the main checkout, also when repoDir is a linked worktree.
  const main = (await listWorktrees(repoDir))[0];
  const top =
    main?.path ?? (await git(repoDir, ['rev-parse', '--path-format=absolute', '--show-toplevel'])).trim();
  return { toplevel: await fs.realpath(top), commonDir };
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // Missing path: resolve the deepest existing ancestor so /var vs /private/var still agree.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(await realpathOrSelf(parent), path.basename(p));
  }
}

function isUnder(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Append `line` to the shared info/exclude unless present (caller holds the mutex). */
async function ensureExclude(cwd: string, line: string): Promise<void> {
  const file = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'])).trim();
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  if (current.split(/\r?\n/).includes(line)) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await fs.appendFile(file, `${sep}${line}\n`);
}

interface WorktreeEntry {
  path: string;
  head?: string;
  /** short branch name (without refs/heads/) */
  branch?: string;
  detached: boolean;
  prunable: boolean;
}

async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), detached: false, prunable: false };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return entries;
}

async function porcelain(wt: string): Promise<string[]> {
  const out = await git(wt, ['status', '--porcelain']);
  return out.split('\n').filter((l) => l.trim() !== '');
}

/** `git diff --stat HEAD` (staged + unstaged) plus a count of untracked files. */
async function diffStat(wt: string, statusLines?: string[]): Promise<string> {
  const lines = statusLines ?? (await porcelain(wt));
  let stat = '';
  try {
    stat = (await git(wt, ['diff', '--stat', 'HEAD'])).trimEnd();
  } catch {
    // Unborn HEAD (e.g. `checkout --orphan`): staged vs empty tree, plus unstaged.
    const staged = (await git(wt, ['diff', '--cached', '--stat']).catch(() => '')).trimEnd();
    const unstaged = (await git(wt, ['diff', '--stat']).catch(() => '')).trimEnd();
    stat = [staged, unstaged].filter((x) => x !== '').join('\n');
  }
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const parts = [stat];
  if (untracked > 0) parts.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}`);
  return parts.filter((p) => p !== '').join('\n');
}

// ---------------------------------------------------------------------------------------------
// branch names

const SLUG_MAX = 80;

/** Sanitize to one valid git ref component; '' when nothing usable is left. */
function sanitizeComponent(s: string): string {
  let out = s.replace(/[^A-Za-z0-9._-]/g, '-');
  out = out.replace(/-+/g, '-').replace(/\.+/g, '.'); // collapse repeats; kills '..'
  out = out.slice(0, SLUG_MAX);
  for (;;) {
    const before = out;
    out = out.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
    if (out.toLowerCase().endsWith('.lock')) out = out.slice(0, -'.lock'.length);
    if (out === before) break;
  }
  return out;
}

/**
 * 'wf/<runId>/<label>' (spec 3.6, Seviye 4): a labelled writer gets exactly its (sanitized) label,
 * independent of call order. Only the unlabelled fallback 'agent-<hash8>' carries '-<n>' for n > 0.
 */
export function branchNameFor(runId: string, label: string | undefined, hash: string, n: number): string {
  const run = sanitizeComponent(runId) || 'run';
  const labelled = label !== undefined ? sanitizeComponent(label) : '';
  if (labelled) return `wf/${run}/${labelled}`;
  const fallback = `agent-${sanitizeComponent(hash.slice(0, 8)) || 'x'}`;
  return `wf/${run}/${n > 0 ? `${fallback}-${n}` : fallback}`;
}

/** Ref names are compared case-insensitively: loose refs collide on case-insensitive filesystems. */
function claimKey(branch: string): string {
  return branch.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Isolation

export interface WorktreeLease {
  readonly path: string;
  readonly writer: boolean;
  readonly branch?: string;
  readonly baseSha: string;
  close(agentOk: boolean): Promise<CloseResult>;
}

export interface CloseResult {
  branchName?: string;
  noHandoffReason?: string;
  dirty?: { path: string; diffStat: string };
}

export interface IsolationOptions {
  repoDir: string;
  runId: string;
  /** default <repo toplevel>/.maestro/worktrees/<runId> */
  worktreeRoot?: string;
  log?: (m: string) => void;
  /** default false */
  symlinkNodeModules?: boolean;
}

export interface OpenSpec {
  key: string;
  label?: string;
  hash: string;
  n: number;
  writer: boolean;
}

interface Ctx extends RepoInfo {
  root: string;
}

export class Isolation {
  private readonly opts: IsolationOptions;
  private readonly log: (m: string) => void;
  private ctx?: Promise<Ctx>;
  /** lower-cased branch name → key that claimed it (spec Seviye 4: sibling writers never share a branch) */
  private readonly claims = new Map<string, { key: string; branch: string }>();

  constructor(opts: IsolationOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  private context(): Promise<Ctx> {
    this.ctx ??= (async () => {
      const info = await repoInfo(this.opts.repoDir);
      const root = this.opts.worktreeRoot
        ? await realpathOrSelf(path.resolve(this.opts.worktreeRoot))
        : path.join(info.toplevel, '.maestro', 'worktrees', this.opts.runId);
      await fs.mkdir(root, { recursive: true });
      const realRoot = await fs.realpath(root);
      // Keep nested worktrees out of the main checkout's status / `git add -A`.
      if (isUnder(realRoot, info.toplevel)) {
        const rel = path.relative(info.toplevel, realRoot).split(path.sep);
        const first = rel[0] === '.maestro' ? '.maestro' : rel.join('/');
        await withRepoLock(info.commonDir, () => ensureExclude(info.toplevel, `/${first}/`));
      }
      return { ...info, root: realRoot };
    })();
    this.ctx.catch(() => {
      this.ctx = undefined;
    });
    return this.ctx;
  }

  /**
   * Claims the writer branch for `spec.key` without opening a worktree. The runtime calls this for a
   * writer served from the journal, so a later sibling with the same label cannot `-B`-reset the
   * cached writer's branch. Returns the branch and whether this call made a new claim.
   */
  claim(spec: OpenSpec): { branch: string; claimed: boolean } {
    const branch = branchNameFor(this.opts.runId, spec.label, spec.hash, spec.n);
    const owner = this.claims.get(claimKey(branch));
    if (owner !== undefined && owner.key !== spec.key) {
      throw new MaestroError(
        `writer branch ${branch} collides with ${owner.branch} claimed by ${owner.key}; give writers distinct labels`,
        'duplicate_writer_branch',
      );
    }
    if (owner !== undefined) return { branch, claimed: false };
    this.claims.set(claimKey(branch), { key: spec.key, branch });
    return { branch, claimed: true };
  }

  async open(spec: OpenSpec): Promise<WorktreeLease> {
    // Claim synchronously, before any await, so concurrent siblings cannot both pass.
    let branch: string | undefined;
    let claimed = false;
    if (spec.writer) ({ branch, claimed } = this.claim(spec));
    try {
      const ctx = await this.context();
      const baseSha = (await git(this.opts.repoDir, ['rev-parse', 'HEAD'])).trim();
      const wtPath = await withRepoLock(ctx.commonDir, async () => {
        const worktrees = await listWorktrees(ctx.toplevel);
        if (branch) {
          await refuseCaseVariant(ctx, branch);
          await this.freeBranch(ctx, worktrees, branch);
        }
        const base = branch ? branch.slice(branch.lastIndexOf('/') + 1) : readOnlyName(spec);
        const p = pickPath(ctx.root, base, worktrees);
        if (branch) await git(ctx.toplevel, ['worktree', 'add', '-B', branch, p, baseSha]);
        else await git(ctx.toplevel, ['worktree', 'add', '--detach', p, baseSha]);
        try {
          if (this.opts.symlinkNodeModules) await linkNodeModules(ctx, p);
        } catch (err) {
          // The caller gets no lease to close, so open itself must not leave the worktree behind.
          await rollbackWorktree(ctx, p);
          throw err;
        }
        return p;
      });
      return new Lease(this, ctx, wtPath, spec.writer, branch, baseSha, this.log);
    } catch (err) {
      if (claimed && branch) this.claims.delete(claimKey(branch));
      throw err;
    }
  }

  /**
   * `-B` fails while the branch is in use by any worktree; free it in our own leftover worktree
   * (an earlier, not-ok attempt) without touching that worktree's index or files, so a run aborted
   * mid-merge, mid-cherry-pick or mid-rebase stays on disk for `gc` and the re-run can still open.
   */
  private async freeBranch(ctx: Ctx, worktrees: WorktreeEntry[], branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    let pruned = false;
    for (const wt of worktrees) {
      const real = await realpathOrSelf(wt.path);
      const gone = wt.prunable || !existsSync(real);
      const rebasing = !gone && wt.branch === undefined ? await rebaseHolds(real, ref) : false;
      if (wt.branch !== branch && !rebasing) continue;
      if (!isUnder(real, ctx.root)) {
        throw new Error(
          `branch ${branch} is checked out at ${wt.path} (outside ${ctx.root}); cannot reset it`,
        );
      }
      if (gone) {
        if (!pruned) await git(ctx.toplevel, ['worktree', 'prune']);
        pruned = true;
        continue;
      }
      if (rebasing) {
        // --quit drops only the rebase state: HEAD stays detached, index and files are untouched.
        await git(real, ['rebase', '--quit']);
      } else {
        const head =
          wt.head && !/^0+$/.test(wt.head) ? wt.head : (await git(real, ['rev-parse', 'HEAD'])).trim();
        // Per-worktree HEAD (cwd = that worktree); unlike `checkout --detach` this works with an unmerged index.
        await git(real, ['update-ref', '--no-deref', '-m', 'maestro: free branch for re-run', 'HEAD', head]);
      }
      this.log(`detached previous attempt worktree ${real} to reuse ${branch}`);
    }
  }

  /** @internal mutex wrapper for leases */
  locked<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
    return withRepoLock(ctx.commonDir, fn);
  }
}

function readOnlyName(spec: OpenSpec): string {
  const label = spec.label !== undefined ? sanitizeComponent(spec.label) : '';
  const hash8 = sanitizeComponent(spec.hash.slice(0, 8)) || 'x';
  return `ro-${label ? `${label}-` : ''}${hash8}-${spec.n}`;
}

/** True when the worktree at `wt` is mid-rebase of `ref` (git then still counts the branch as in use). */
async function rebaseHolds(wt: string, ref: string): Promise<boolean> {
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    try {
      const file = (
        await git(wt, ['rev-parse', '--path-format=absolute', '--git-path', `${dir}/head-name`])
      ).trim();
      if ((await fs.readFile(file, 'utf8')).trim() === ref) return true;
    } catch {
      // no rebase of this kind in progress
    }
  }
  return false;
}

/** An existing ref differing only in case would be the same loose-ref file on APFS/NTFS: `-B` would reset it. */
async function refuseCaseVariant(ctx: Ctx, branch: string): Promise<void> {
  const prefix = `refs/heads/${branch.slice(0, branch.lastIndexOf('/') + 1)}`;
  const out = await git(ctx.toplevel, ['for-each-ref', '--format=%(refname)', prefix]);
  const want = `refs/heads/${branch}`;
  for (const line of out.split('\n')) {
    const r = line.trim();
    if (r !== '' && r !== want && claimKey(r) === claimKey(want)) {
      throw new MaestroError(
        `writer branch ${branch} collides with existing ${r.slice('refs/heads/'.length)} (refs differ only in case)`,
        'duplicate_writer_branch',
      );
    }
  }
}

/** Undo a `worktree add` whose follow-up setup failed (caller holds the mutex); never throws. */
async function rollbackWorktree(ctx: Ctx, wt: string): Promise<void> {
  await unlinkNodeModules(wt);
  try {
    await git(ctx.toplevel, ['worktree', 'remove', '--force', wt]);
  } catch {
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    await git(ctx.toplevel, ['worktree', 'prune']).catch(() => '');
  }
}

/** First free path: not on disk and not registered as a worktree (missing-but-registered blocks add). */
function pickPath(root: string, base: string, worktrees: WorktreeEntry[]): string {
  const registered = new Set(worktrees.map((w) => path.resolve(w.path)));
  for (let i = 1; ; i++) {
    const p = path.join(root, i === 1 ? base : `${base}-r${i}`);
    if (!existsSync(p) && !registered.has(p)) return p;
  }
}

async function linkNodeModules(ctx: Ctx, wt: string): Promise<void> {
  const src = path.join(ctx.toplevel, 'node_modules');
  const dst = path.join(wt, 'node_modules');
  if (!existsSync(src) || existsSync(dst)) return;
  // No trailing slash: a symlink is not a directory to git, `node_modules/` would not match it.
  await ensureExclude(wt, '/node_modules');
  await fs.symlink(src, dst, 'dir');
}

async function unlinkNodeModules(wt: string): Promise<void> {
  const dst = path.join(wt, 'node_modules');
  try {
    const st = await fs.lstat(dst);
    if (st.isSymbolicLink()) await fs.unlink(dst);
  } catch {
    // absent
  }
}

class Lease implements WorktreeLease {
  private result?: Promise<CloseResult>;

  constructor(
    private readonly iso: Isolation,
    private readonly ctx: Ctx,
    readonly path: string,
    readonly writer: boolean,
    readonly branch: string | undefined,
    readonly baseSha: string,
    private readonly log: (m: string) => void,
  ) {}

  /** Called from the caller's finally on every exit path; never throws, idempotent. */
  close(agentOk: boolean): Promise<CloseResult> {
    this.result ??= this.doClose(agentOk).catch((err: unknown) => {
      const why = `isolation close failed: ${err instanceof Error ? err.message : String(err)}`;
      this.log(why);
      return { noHandoffReason: why };
    });
    return this.result;
  }

  private async doClose(agentOk: boolean): Promise<CloseResult> {
    const wt = this.path;
    if (!existsSync(wt)) {
      await this.iso.locked(this.ctx, () => git(this.ctx.toplevel, ['worktree', 'prune'])).catch(() => '');
      const why = `worktree ${wt} disappeared`;
      if (this.writer) this.log(`no handoff: ${why}`);
      return this.writer ? { noHandoffReason: why } : {};
    }
    let status: string[];
    let statusError: string | undefined;
    try {
      status = await porcelain(wt);
    } catch (err) {
      // Unknown state is never deleted: treat it as dirty.
      statusError = err instanceof Error ? err.message : String(err);
      status = [];
    }
    const dirty = status.length > 0 || statusError !== undefined;
    const res: CloseResult = {};

    if (this.writer) {
      // spec 3.6 exit verification: expected branch, clean, >= 1 commit past base. Evidence comes from
      // git; any git failure here means "no proof", never a crash that skips the cleanup below.
      let why: string | undefined;
      if (!agentOk) why = 'agent did not finish ok';
      else {
        try {
          why = await this.verify(dirty);
        } catch (err) {
          why = `exit verification failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (why === undefined) res.branchName = this.branch;
      else {
        res.noHandoffReason = why;
        this.log(`no handoff: ${why}`);
      }
    }

    if (dirty) {
      // Kept for `gc`; never deleted automatically (spec 3.6).
      const stat =
        statusError !== undefined
          ? `git status failed: ${statusError}`
          : await diffStat(wt, status).catch((err: unknown) => `git diff --stat failed: ${String(err)}`);
      res.dirty = { path: wt, diffStat: stat };
      this.log(`dirty worktree kept: ${wt}${stat ? `\n${stat}` : ''}`);
      return res;
    }

    // Removal is cleanup, not evidence: a failure must not cancel a hand-off git already proved.
    try {
      await this.iso.locked(this.ctx, async () => {
        await unlinkNodeModules(wt);
        await git(this.ctx.toplevel, ['worktree', 'remove', wt]);
      });
    } catch (err) {
      this.log(
        `worktree remove failed, clean worktree left at ${wt} (gc --delete collects it): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return res;
  }

  /** undefined when the hand-off is proven, else the reason. */
  private async verify(dirty: boolean): Promise<string | undefined> {
    const wt = this.path;
    // symbolic-ref instead of `rev-parse --abbrev-ref`: same check, but unambiguous when a tag shares
    // the branch name, and it also works on an unborn branch (`checkout --orphan`).
    const head = (await git(wt, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
    if (head !== `refs/heads/${this.branch}`) {
      const shown = head === '' ? 'detached' : head.replace(/^refs\/heads\//, '');
      return `HEAD is ${shown}, expected ${this.branch}`;
    }
    if (dirty) return 'worktree is dirty (uncommitted changes)';
    const count = Number((await git(wt, ['rev-list', '--count', 'HEAD', `^${this.baseSha}`])).trim());
    if (!(count >= 1)) return `no commit on ${this.branch} past base ${this.baseSha.slice(0, 12)}`;
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// gc

export interface GcOptions {
  repoDir: string;
  /** default <toplevel>/.maestro/worktrees */
  worktreeRoot?: string;
  delete?: boolean;
  force?: boolean;
}

export interface GcResult {
  dirtyWorktrees: Array<{ path: string; branch?: string; diffStat: string }>;
  mergedBranches: string[];
  unmergedBranches: string[];
  /** worktree paths removed and branch names deleted (delete: true only) */
  removed: string[];
}

async function listBranches(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['branch', '--format=%(refname:short)', '--list', 'wf/*']);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * Merged into HEAD by ancestry or by patch equivalence: the Seviye 4 coordinator integrates writer
 * branches with `git cherry-pick`, which never makes them ancestors. `git cherry` marks every commit
 * of the branch without an equivalent patch upstream with '+'.
 */
async function mergedIntoHead(cwd: string, branch: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['cherry', 'HEAD', branch]);
    return !out.split('\n').some((l) => l.startsWith('+'));
  } catch {
    return false; // e.g. no common history: not merged
  }
}

/** List (and with delete:true, collect) leftover worktrees and wf/* branches (spec 3.6 `workflow gc`). */
export async function gc(opts: GcOptions): Promise<GcResult> {
  const info = await repoInfo(opts.repoDir);
  const root = opts.worktreeRoot
    ? await realpathOrSelf(path.resolve(opts.worktreeRoot))
    : path.join(info.toplevel, '.maestro', 'worktrees');

  const dirtyWorktrees: GcResult['dirtyWorktrees'] = [];
  const ours: string[] = [];
  for (const wt of await listWorktrees(info.toplevel)) {
    if (wt.prunable || !existsSync(wt.path)) continue;
    const real = await fs.realpath(wt.path);
    if (!isUnder(real, root)) continue;
    ours.push(real);
    const status = await porcelain(real);
    if (status.length > 0) {
      const entry: GcResult['dirtyWorktrees'][number] = {
        path: real,
        diffStat: await diffStat(real, status),
      };
      if (wt.branch) entry.branch = wt.branch;
      dirtyWorktrees.push(entry);
    }
  }

  const mergedBranches: string[] = [];
  const unmergedBranches: string[] = [];
  for (const b of await listBranches(info.toplevel)) {
    ((await mergedIntoHead(info.toplevel, b)) ? mergedBranches : unmergedBranches).push(b);
  }
  const removed: string[] = [];

  if (opts.delete) {
    await withRepoLock(info.commonDir, async () => {
      // Clean leftovers (crashed runs) go too: they would otherwise pin their branches.
      for (const wt of ours) {
        await unlinkNodeModules(wt);
        await git(info.toplevel, ['worktree', 'remove', '--force', wt]);
        removed.push(wt);
      }
      await git(info.toplevel, ['worktree', 'prune']);
      // -D also for merged ones: `branch -d` refuses a cherry-picked (patch-merged) branch.
      const toDelete = opts.force ? [...mergedBranches, ...unmergedBranches] : mergedBranches;
      for (const b of toDelete) {
        try {
          await git(info.toplevel, ['branch', '-D', b]);
          removed.push(b);
        } catch {
          // still checked out somewhere outside the root: keep it listed
        }
      }
      await removeEmptyDirs(root);
    });
  }
  return { dirtyWorktrees, mergedBranches, unmergedBranches, removed };
}

/** rmdir empty run directories under root (never removes anything with content). */
async function removeEmptyDirs(root: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(root, name);
    try {
      if ((await fs.lstat(p)).isDirectory() && (await fs.readdir(p)).length === 0) await fs.rmdir(p);
    } catch {
      // ignore
    }
  }
}
