// Eval step 1a (docs/eval.md 2.1, 2.4): mine bug-introducing PRs and clean PRs from a repo's history.
//   node eval/mine.ts --repo ../lula --ref origin/lula-version [--out eval/data/candidates.json]
//                     [--max-lines 800] [--min-gap-days 1] [--clean-age-days 90] [--fix-pattern broad|<regex>]
// SZZ: every fix commit's changed lines are blamed at fix^ and the blamed commit's PR becomes a
// candidate. Three link kinds: modified lines, the neighbour of a pure addition (missing-guard bugs),
// and a migration redefining a SQL function (append-only migrations defeat blame). Read-only on --repo.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type LinkKind = 'modified' | 'sql_fn' | 'added';
/** Strongest first: a PR counts under the strongest kind that links it. */
export const LINK_KINDS: readonly LinkKind[] = ['modified', 'sql_fn', 'added'];

export interface MineOptions {
  repo: string;
  ref: string;
  /** Size cap on changed lines (lock files and snapshots excluded). Default 800. */
  maxLines?: number;
  /** A fix that lands sooner than this after the merge is not "found later". Default 1. */
  minGapDays?: number;
  /** A clean PR is merged at least this long before the tip. Default 90. */
  cleanAgeDays?: number;
  /**
   * Which commit subjects count as fixes: a FIX_PATTERNS name ('conventional', the default, or 'broad')
   * or a case-insensitive regex source.
   */
  fixPattern?: string;
}

export interface FixLink {
  sha: string;
  subject: string;
  date: string;
  kinds: LinkKind[];
  gapDays: number;
}

export interface Candidate {
  id: string;
  pr: number | null;
  merge: string;
  base: string;
  mergedAt: string;
  subject: string;
  lines: number;
  files: number;
}

export interface BugCandidate extends Candidate {
  kind: LinkKind;
  fixes: FixLink[];
}

export interface CleanCandidate extends Candidate {
  /** Lines the PR added (lock files and snapshots excluded) and how many of them blame to it at the tip. */
  added: number;
  surviving: number;
}

export interface MineResult {
  repo: string;
  ref: string;
  tip: string;
  params: Required<Omit<MineOptions, 'repo' | 'ref'>>;
  stats: {
    merges: number;
    fixCommits: number;
    sqlFunctionDefs: number;
    /** Paths git could not blame (C-quoted names and the like): skipped, not fatal. */
    blameErrors: number;
    linkedPrs: number;
    /** Every linked PR by strongest kind and size bucket, before the size cap. */
    byKindAndSize: Record<LinkKind, Record<string, number>>;
    bugCandidates: number;
    cleanCandidates: number;
  };
  bug: BugCandidate[];
  clean: CleanCandidate[];
}

const FIX_RE = /^(fix|hotfix)\b|\bfix(es|ed)?\b|\bbug\b|regression/i;
/**
 * Named fix patterns (docs/eval.md 2.2). 'broad' adds fixes that never say "fix", like lula's
 * "Stop the credit balance refresh from logging a 406", but not conventional feat:/chore:/… subjects.
 */
export const FIX_PATTERNS: Record<string, string> = {
  conventional: FIX_RE.source,
  broad:
    `${FIX_RE.source}|^(?!(feat|chore|docs|refactor|style|test|perf|build|ci)(\\(.+\\))?!?:).*` +
    "\\b(prevent|avoid|correct(ly|s|ed)?|guard|no longer|don'?t|doesn'?t|stop(s|ped)?|missing|broken|wrong|" +
    'crash|leak|race|instead of|handle[sd]?|restore[sd]?|repair|resolve[sd]?|patch|block(s|ed)?|only|never|' +
    'skip|ensure|keep)\\b',
};
/** Never blamed, never counted toward size. */
export const NOISE_RE = /(\.lock$|\.lockb$|(?:^|[/-])lock\.(?:json|ya?ml)$|\.snap$)/;
/** Not blamed: prose, and SQL (handled by the function linker). */
const NO_BLAME_RE = /(\.md$|\.sql$)/;
// The schema, quoted or not, is skipped: "public"."claim_job" and private.claim_job both name claim_job.
export const FN_RE = /create\s+or\s+replace\s+function\s+(?:"?\w+"?\s*\.\s*)?"?(\w+)"?/gi;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+/;
const DAY = 86_400;

function gitIn(repo: string) {
  return (...args: string[]): string => {
    const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout;
  };
}

/**
 * Path from a `--no-prefix` "--- x" / "+++ x" header. git appends a tab when the path has a space and
 * C-quotes paths with quotes, backslashes or control characters (non-ASCII stays raw: core.quotepath=false).
 */
export function headerPath(line: string): string | null {
  const p = line.slice(4).replace(/\t$/, '');
  if (p === '/dev/null') return null;
  if (!p.startsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return null; // octal escapes: not worth blaming
  }
}

export function sizeBucket(lines: number): string {
  return lines <= 200 ? '<=200' : lines <= 800 ? '201-800' : lines <= 2000 ? '801-2000' : '>2000';
}

export function mine(opts: MineOptions): MineResult {
  const params = {
    maxLines: opts.maxLines ?? 800,
    minGapDays: opts.minGapDays ?? 1,
    cleanAgeDays: opts.cleanAgeDays ?? 90,
    fixPattern: opts.fixPattern ?? 'conventional',
  };
  const fixRe = new RegExp(FIX_PATTERNS[params.fixPattern] ?? params.fixPattern, 'i');
  const git = gitIn(opts.repo);
  const name = path.basename(path.resolve(opts.repo));
  const tip = git('rev-parse', opts.ref).trim();

  // First-parent merges are the PRs; every PR commit maps to the merge that brought it in.
  interface Merge {
    sha: string;
    t: number;
    pr: number | null;
    subject: string;
  }
  const merges: Merge[] = [];
  for (const line of git('log', '--first-parent', '--merges', '--format=%H %ct %s', opts.ref).split('\n')) {
    if (!line) continue;
    const [sha, ct, ...rest] = line.split(' ');
    const subject = rest.join(' ');
    const m = /pull request #(\d+)/i.exec(subject);
    merges.push({ sha: sha!, t: Number(ct), pr: m ? Number(m[1]) : null, subject });
  }
  const bySha = new Map(merges.map((m) => [m.sha, m]));
  const owner = new Map<string, string>();
  const prCommits = new Map<string, Set<string>>();
  for (const m of merges) {
    const commits = new Set(git('rev-list', `${m.sha}^1..${m.sha}^2`).split('\n').filter(Boolean));
    commits.add(m.sha); // conflict resolutions live in the merge itself
    prCommits.set(m.sha, commits);
    for (const c of commits) if (!owner.has(c)) owner.set(c, m.sha);
  }

  // Every commit that added a .sql file defining a function, for the migration linker.
  const sqlDefs: { t: number; sha: string; fn: string }[] = [];
  let cur: { sha: string; t: number } | null = null;
  for (const line of git(
    'log',
    '--format=COMMIT %H %ct',
    '-p',
    '--diff-filter=A',
    opts.ref,
    '--',
    '*.sql',
  ).split('\n')) {
    if (line.startsWith('COMMIT ')) {
      const [, sha, ct] = line.split(' ');
      cur = { sha: sha!, t: Number(ct) };
    } else if (cur && line.startsWith('+') && !line.startsWith('+++')) {
      for (const m of line.matchAll(FN_RE)) sqlDefs.push({ ...cur, fn: m[1]!.toLowerCase() });
    }
  }

  const fixes: { sha: string; t: number; subject: string }[] = [];
  for (const line of git('log', '--no-merges', '--format=%H %ct %s', opts.ref).split('\n')) {
    if (!line) continue;
    const [sha, ct, ...rest] = line.split(' ');
    const subject = rest.join(' ');
    if (fixRe.test(subject)) fixes.push({ sha: sha!, t: Number(ct), subject });
  }

  /** Commits blamed for the given 1-based line ranges of `file` at `rev`; a path git can't blame counts. */
  let blameErrors = 0;
  const blame = (rev: string, file: string, ranges: [number, number][]): Set<string> => {
    const out = new Set<string>();
    if (!ranges.length) return out;
    const args = ['blame', '-l', '-s', ...ranges.flatMap(([a, b]) => ['-L', `${a},${b}`]), rev, '--', file];
    let text: string;
    try {
      text = git(...args);
    } catch {
      blameErrors++;
      return out;
    }
    for (const l of text.split('\n')) if (l.trim()) out.add(l.split(' ')[0]!.replace(/^\^/, ''));
    return out;
  };

  // links: merge sha -> fix sha -> kinds. fixed: every PR a fix from outside touched, however soon.
  const links = new Map<string, Map<string, Set<LinkKind>>>();
  const fixed = new Set<string>();
  for (const f of fixes) {
    const parents = git('rev-list', '--parents', '-n', '1', f.sha).trim().split(' ');
    if (parents.length < 2) continue; // root commit
    const intro = new Map<LinkKind, Set<string>>(LINK_KINDS.map((k) => [k, new Set<string>()]));
    const ranges = new Map<string, { modified: [number, number][]; added: [number, number][] }>();
    let file: string | null = null; // pre-fix path
    let newFile: string | null = null;
    let inHeader = false; // between "diff --git" and the first hunk: ---/+++ are paths, not content
    for (const l of git('diff', '-U0', '--no-renames', '--no-prefix', `${f.sha}^`, f.sha).split('\n')) {
      if (l.startsWith('diff --git ')) {
        inHeader = true;
        file = null;
        newFile = null;
      } else if (inHeader && l.startsWith('--- ')) {
        file = headerPath(l);
      } else if (inHeader && l.startsWith('+++ ')) {
        newFile = headerPath(l);
      } else if (HUNK_RE.test(l)) {
        inHeader = false;
        if (!file || NOISE_RE.test(file) || NO_BLAME_RE.test(file)) continue;
        const h = HUNK_RE.exec(l)!;
        const start = Number(h[1]);
        const n = h[2] === undefined ? 1 : Number(h[2]);
        const r = ranges.get(file) ?? { modified: [], added: [] };
        if (n > 0) r.modified.push([start, start + n - 1]);
        else if (start > 0) r.added.push([start, start]); // pure insertion after `start`
        ranges.set(file, r);
      } else if (!inHeader && newFile?.endsWith('.sql') && l.startsWith('+')) {
        for (const m of l.matchAll(FN_RE)) {
          const fn = m[1]!.toLowerCase();
          let last: { t: number; sha: string } | null = null;
          for (const d of sqlDefs) if (d.fn === fn && d.t < f.t && (!last || d.t > last.t)) last = d;
          if (last) intro.get('sql_fn')!.add(last.sha);
        }
      }
    }
    for (const [p, r] of ranges) {
      for (const c of blame(`${f.sha}^`, p, r.modified)) intro.get('modified')!.add(c);
      for (const c of blame(`${f.sha}^`, p, r.added)) intro.get('added')!.add(c);
    }
    const fixOwner = owner.get(f.sha);
    for (const [kind, commits] of intro) {
      for (const c of commits) {
        const m = owner.get(c);
        if (!m || m === fixOwner) continue; // direct commit to trunk, or fixed inside its own PR
        fixed.add(m);
        if (f.t - bySha.get(m)!.t < params.minGapDays * DAY) continue;
        const perFix = links.get(m) ?? new Map<string, Set<LinkKind>>();
        perFix.set(f.sha, (perFix.get(f.sha) ?? new Set()).add(kind));
        links.set(m, perFix);
      }
    }
  }

  const fixBySha = new Map(fixes.map((f) => [f.sha, f]));
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const base = (m: Merge): Candidate => {
    let lines = 0;
    let files = 0;
    for (const l of git('diff', '--numstat', '--no-renames', `${m.sha}^1`, m.sha).split('\n')) {
      const [add, del, p] = l.split('\t');
      if (!p || NOISE_RE.test(p)) continue;
      files++;
      if (add !== '-') lines += Number(add) + Number(del);
    }
    return {
      id: `${name}-${m.pr ?? m.sha.slice(0, 9)}`,
      pr: m.pr,
      merge: m.sha,
      base: git('rev-parse', `${m.sha}^1`).trim(),
      mergedAt: iso(m.t),
      subject: m.subject,
      lines,
      files,
    };
  };

  const byKindAndSize = Object.fromEntries(LINK_KINDS.map((k) => [k, {}])) as Record<
    LinkKind,
    Record<string, number>
  >;
  const bug: BugCandidate[] = [];
  for (const [mSha, perFix] of links) {
    const c = base(bySha.get(mSha)!);
    const all = new Set([...perFix.values()].flatMap((s) => [...s]));
    const kind = LINK_KINDS.find((k) => all.has(k))!;
    const bucket = sizeBucket(c.lines);
    byKindAndSize[kind][bucket] = (byKindAndSize[kind][bucket] ?? 0) + 1;
    if (c.lines === 0 || c.lines > params.maxLines) continue;
    const t = bySha.get(mSha)!.t;
    const fixLinks = [...perFix].map(([sha, kinds]) => {
      const f = fixBySha.get(sha)!;
      return {
        sha,
        subject: f.subject,
        date: iso(f.t),
        kinds: LINK_KINDS.filter((k) => kinds.has(k)),
        gapDays: Math.round((f.t - t) / DAY),
      };
    });
    fixLinks.sort((a, b) => a.date.localeCompare(b.date));
    bug.push({ ...c, kind, fixes: fixLinks });
  }
  bug.sort((a, b) => a.lines - b.lines || a.id.localeCompare(b.id));

  // Clean: old enough, never touched by an outside fix, in scope; survival tells how much of it is
  // still at the tip.
  const tipT = Number(git('log', '-1', '--format=%ct', tip).trim());
  const tipFiles = new Set(git('ls-tree', '-r', '--name-only', tip).split('\n'));
  const clean: CleanCandidate[] = [];
  for (const m of merges) {
    if (fixed.has(m.sha) || tipT - m.t < params.cleanAgeDays * DAY) continue;
    const c = base(m);
    if (c.lines === 0 || c.lines > params.maxLines) continue;
    let added = 0;
    let surviving = 0;
    const own = prCommits.get(m.sha)!;
    for (const l of git('diff', '--numstat', '--no-renames', `${m.sha}^1`, m.sha).split('\n')) {
      const [add, , p] = l.split('\t');
      if (!p || add === '-' || NOISE_RE.test(p) || Number(add) === 0) continue;
      added += Number(add);
      if (!tipFiles.has(p)) continue;
      let text: string;
      try {
        text = git('blame', '-l', '-s', tip, '--', p);
      } catch {
        blameErrors++;
        continue;
      }
      for (const b of text.split('\n')) {
        if (b.trim() && own.has(b.split(' ')[0]!.replace(/^\^/, ''))) surviving++;
      }
    }
    clean.push({ ...c, added, surviving });
  }
  clean.sort((a, b) => a.lines - b.lines || a.id.localeCompare(b.id));

  return {
    repo: path.resolve(opts.repo),
    ref: opts.ref,
    tip,
    params,
    stats: {
      merges: merges.length,
      fixCommits: fixes.length,
      sqlFunctionDefs: sqlDefs.length,
      blameErrors,
      linkedPrs: links.size,
      byKindAndSize,
      bugCandidates: bug.length,
      cleanCandidates: clean.length,
    },
    bug,
    clean,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const repo = flag(argv, '--repo');
  const ref = flag(argv, '--ref');
  if (!repo || !ref) {
    console.error('usage: node eval/mine.ts --repo <path> --ref <trunk ref> [--out f] [--max-lines n]');
    process.exit(2);
  }
  const num = (n: string) => {
    const raw = flag(argv, n);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      console.error(`mine: ${n} needs a non-negative number, got "${raw}"`);
      process.exit(2);
    }
    return value;
  };
  const result = mine({
    repo,
    ref,
    maxLines: num('--max-lines'),
    minGapDays: num('--min-gap-days'),
    cleanAgeDays: num('--clean-age-days'),
    fixPattern: flag(argv, '--fix-pattern'),
  });
  const out = flag(argv, '--out') ?? 'eval/data/candidates.json';
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.error(`mine: ${JSON.stringify(result.stats)}`);
  console.error(`mine: wrote ${out}`);
}
