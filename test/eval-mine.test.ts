// eval/mine.ts on a synthetic history: one PR per link kind (modified line, neighbour of a pure
// addition, redefined SQL function), a bug fixed inside its own PR, a fix within the gap, clean PRs
// with survival counts, and the size cap. Real git, temporary repo, no network.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIX_PATTERNS, FN_RE, type MineResult, mine, NOISE_RE } from '../eval/mine.js';

const T0 = Date.parse('2026-01-01T12:00:00Z') / 1000;
let dir = '';

function git(day: number, ...args: string[]): string {
  const date = `@${T0 + Math.round(day * 86_400)} +0000`;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), text);
}

async function commit(day: number, message: string, files: Record<string, string>): Promise<void> {
  for (const [f, text] of Object.entries(files)) await put(f, text);
  git(day, 'add', '-A');
  git(day, 'commit', '-q', '-m', message);
}

/** Branch off main, commit, merge back with --no-ff as "Merge pull request #n". */
async function pr(
  n: number,
  day: number,
  commits: { day?: number; message: string; files: Record<string, string> }[],
): Promise<void> {
  git(day, 'checkout', '-q', '-b', `pr${n}`, 'main');
  for (const c of commits) await commit(c.day ?? day, c.message, c.files);
  git(day, 'checkout', '-q', 'main');
  const mergeDay = commits.at(-1)?.day ?? day;
  git(mergeDay, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from u/pr${n}`, `pr${n}`);
}

const OK = (op: string) => `export function ok(x: number) {\n  return x ${op} 0;\n}\n`;
const FLOW = 'export function flow() {\n  start();\n  finish();\n}\n';
const SQL = 'create or replace function public.claim_job() returns int as $$ select 1 $$ language sql;\n';

let res: MineResult;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-eval-mine-')));
  git(0, 'init', '-q', '-b', 'main');
  git(0, 'config', 'user.name', 'Test');
  git(0, 'config', 'user.email', 'test@example.com');
  git(0, 'config', 'commit.gpgsign', 'false');
  await commit(0, 'init', { 'src/q.ts': OK('>'), 'package-lock.json': '{}\n' });

  await pr(1, 1, [{ message: 'feat: accept zero', files: { 'src/q.ts': OK('>=') } }]);
  await pr(2, 2, [{ message: 'feat: flow', files: { 'src/flow.ts': FLOW } }]);
  await pr(3, 3, [{ message: 'feat: claim', files: { 'supabase/migrations/001_claim.sql': SQL } }]);
  await pr(4, 4, [
    { message: 'feat: clean', files: { 'src/clean.ts': 'export const a = 1;\nexport const b = 2;\n' } },
  ]);
  await pr(5, 5, [
    { message: 'feat: self', files: { 'src/self.ts': 'export const s = -1;\n' } },
    { message: 'fix: self sign', files: { 'src/self.ts': 'export const s = 1;\n' } },
  ]);
  await pr(6, 6, [{ message: 'feat: quick', files: { 'src/quick.ts': 'export const k = 0;\n' } }]);
  await pr(7, 6.25, [{ message: 'fix: quick value', files: { 'src/quick.ts': 'export const k = 1;\n' } }]);
  await pr(8, 100, [
    { message: 'fix: ok rejects zero again', files: { 'src/q.ts': OK('>') } },
    {
      message: 'Guard flow before finish (bug)',
      files: {
        'src/flow.ts': 'export function flow() {\n  start();\n  if (!ready()) return;\n  finish();\n}\n',
      },
    },
    {
      message: 'fix: claim_job returns 2',
      files: { 'supabase/migrations/002_claim.sql': SQL.replace('1', '2') },
    },
    { message: 'chore: bump lock', files: { 'package-lock.json': '{"v":2}\n' } },
  ]);
  await commit(200, 'chore: tip', { 'README.md': 'tip\n' });
  res = mine({ repo: dir, ref: 'main' });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mine', () => {
  it('links one PR per kind to the later fix', () => {
    const byPr = new Map(res.bug.map((b) => [b.pr, b]));
    expect([...byPr.keys()].sort()).toEqual([1, 2, 3]);
    expect(byPr.get(1)!.kind).toBe('modified');
    expect(byPr.get(2)!.kind).toBe('added');
    expect(byPr.get(3)!.kind).toBe('sql_fn');
    expect(byPr.get(1)!.fixes.map((f) => f.subject)).toEqual(['fix: ok rejects zero again']);
    expect(byPr.get(2)!.fixes[0]).toMatchObject({
      subject: 'Guard flow before finish (bug)',
      kinds: ['added'],
    });
    expect(byPr.get(3)!.fixes[0]!.gapDays).toBe(97);
  });

  it('fills the candidate fields from the merge', () => {
    const one = res.bug.find((b) => b.pr === 1)!;
    expect(one.id).toBe(`${path.basename(dir)}-1`);
    expect(one.base).toBe(git(0, 'rev-parse', `${one.merge}^1`));
    expect(one).toMatchObject({ lines: 2, files: 1, subject: 'Merge pull request #1 from u/pr1' });
    expect(res.tip).toBe(git(0, 'rev-parse', 'main'));
  });

  it('skips a bug fixed inside its own PR and a fix inside the gap', () => {
    expect(res.bug.some((b) => b.pr === 5 || b.pr === 6)).toBe(false);
    expect(res.stats.linkedPrs).toBe(3);
  });

  it('lists old PRs no outside fix touched as clean, with survival', () => {
    // #6 was fixed within hours: not a candidate and not clean. #1-#3 are linked.
    expect(res.clean.map((c) => c.pr).sort()).toEqual([4, 5, 7, 8]);
    expect(res.clean.find((c) => c.pr === 4)).toMatchObject({ added: 2, surviving: 2 });
    expect(res.clean.find((c) => c.pr === 5)).toMatchObject({ added: 1, surviving: 1 });
  });

  it('applies the size cap after counting every link', () => {
    // Sizes: #1 two lines, #2 four, #3 one; the lock file of #8 never counts.
    const capped = mine({ repo: dir, ref: 'main', maxLines: 1 });
    expect(capped.bug.map((b) => b.pr)).toEqual([3]);
    expect(capped.stats.byKindAndSize).toEqual(res.stats.byKindAndSize);
    expect(res.clean.find((c) => c.pr === 8)!.lines).toBe(2 + 1 + 1); // q.ts, flow.ts guard, 002 migration
    expect(Object.values(res.stats.byKindAndSize.modified)).toEqual([1]);
  });

  it('leaves the repo untouched', () => {
    expect(git(0, 'status', '--porcelain')).toBe('');
    expect(git(0, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(
      ['main', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7', 'pr8'].sort(),
    );
  });
});

describe('fix patterns', () => {
  const broad = new RegExp(FIX_PATTERNS.broad!, 'i');
  const conventional = new RegExp(FIX_PATTERNS.conventional!, 'i');

  it('broad adds fixes that never say fix, but not conventional feature subjects', () => {
    expect(broad.test('Stop the credit balance refresh from logging a 406 every 30 seconds')).toBe(true);
    expect(conventional.test('Stop the credit balance refresh from logging a 406 every 30 seconds')).toBe(
      false,
    );
    expect(broad.test('feat(chat): keep the draft when switching tabs')).toBe(false);
    expect(broad.test('fix(chat): keep the draft')).toBe(true);
    expect(broad.test('Add a pricing page')).toBe(false);
  });
});

describe('mining patterns', () => {
  it('lock files of every package manager are noise; a file merely ending in lock.json is not', () => {
    for (const p of [
      'package-lock.json',
      'web/pnpm-lock.yaml',
      'bun.lockb',
      'yarn.lock',
      'a/b.snap',
      'lock.json',
    ]) {
      expect(NOISE_RE.test(p), p).toBe(true);
    }
    for (const p of ['src/block.json', 'src/unlock.yaml', 'src/lock.ts'])
      expect(NOISE_RE.test(p), p).toBe(false);
  });

  it('a SQL function is named by its function, whatever the schema and quoting', () => {
    const names = (sql: string) => [...sql.matchAll(FN_RE)].map((m) => m[1]);
    expect(names('create or replace function claim_job()')).toEqual(['claim_job']);
    expect(names('CREATE OR REPLACE FUNCTION public.claim_job()')).toEqual(['claim_job']);
    expect(names('create or replace function "public"."claim_job"()')).toEqual(['claim_job']);
    expect(names('create or replace function private.other_fn()')).toEqual(['other_fn']);
  });
});
