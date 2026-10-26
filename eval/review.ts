// Eval step 2 (docs/eval.md 2.3-2.5): the review sheet, the review order and the set.
//   node eval/review.ts [--triage eval/data/triage.json] [--candidates eval/data/candidates.json]
//                       [--earlier eval/data/triage.v1.json] [--out eval/data/review.md]
//                       [--labels eval/data/labels.json] [--set eval/data/set.json] [--pilot eval/data/pilot.json]
// The candidates to review (accepted, and ones an earlier triage accepted and this one rejects) in one
// numbered order: <=200 lines first, then 201-800 and 801-2000, each shuffled with a fixed seed. Bugs are
// deduped by file:line across fixes. A decision per candidate goes into labels.json, by hand or by
// eval/verify.js (the file is created once, never overwritten); walking the order, the first 20 accepted become set.json with 5 clean PRs of
// the same size split, and 2 more clean PRs become pilot.json. The sheet also lists the rejected candidates
// and the clean pool. Pure data transform: no git, no network.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Type-only: Node's type stripping erases it, so the .js specifier never has to resolve at run time.
import type { BugCandidate, CleanCandidate, MineResult } from './mine.js';

/** Same buckets as eval/mine.ts sizeBucket (a value import would need a .ts specifier tsc rejects). */
function sizeBucket(lines: number): string {
  return lines <= 200 ? '<=200' : lines <= 800 ? '201-800' : lines <= 2000 ? '801-2000' : '>2000';
}

/** Review order seed (docs/eval.md 2.3). */
export const SEED = 20261026;
/** Bug PRs in the set. */
export const TARGET = 20;
const GROUPS = ['<=200', '201-800', '801-2000'];
const GROUP_TITLE: Record<string, string> = {
  '<=200': '≤200 satır, onaylananların hepsi alınır',
  '201-800': '201–800 satır, sabit tohumla karıştırıldı',
  '801-2000': "801–2000 satır, sabit tohumla karıştırıldı; yalnızca 20'ye yetmezse",
};

export interface TriageBug {
  file: string;
  line: number;
  description: string;
  trigger: string;
}

export interface TriageFix {
  sha: string;
  defect: boolean;
  introducedHere: boolean;
  visibleFromDiff: boolean;
  reason: string;
  bugs: TriageBug[];
}

export interface TriageRow extends BugCandidate {
  triage: { fixes: TriageFix[] } | null;
}

export interface TriageReport {
  runId: string;
  model: string;
  effort: string;
  summary: Record<string, unknown>;
  results: TriageRow[];
}

export interface ReviewItem {
  order: number;
  group: string;
  /** The row whose verdicts accept the candidate: this round's, or the earlier round's when `now` is set. */
  row: TriageRow;
  /** This round's row, set when an earlier round accepted the candidate and this one rejects it. */
  now?: TriageRow;
}

export interface LabelBug extends TriageBug {
  /** The first fix that reported the bug and how that fix links to the PR. */
  fix: string;
  link: string;
}

export interface LabelEntry {
  order: number;
  id: string;
  group: string;
  lines: number;
  merge: string;
  base: string;
  /** Written by the human: accept, reject, or null while undecided. */
  decision: 'accept' | 'reject' | null;
  note: string;
  bugs: LabelBug[];
}

export interface Labels {
  repo: string;
  seed: number;
  target: number;
  candidates: LabelEntry[];
}

/** One bug PR of the set (docs/eval.md 2.5). */
export interface SetRecord {
  id: string;
  repo: string;
  merge: string;
  base: string;
  kind: 'bug' | 'clean';
  lines: number;
  bugs: (LabelBug & { id: string })[];
}

/** One bug's verdict from eval/workflows/verify.js, with the location and wording it settled on. */
export interface VerifyBug extends TriageBug {
  index: number;
  exists: boolean;
  introduced: boolean;
  fixed: boolean;
  visible: boolean;
  corrected: boolean;
  reason: string;
}

export interface VerifyResult {
  id: string;
  verify: { bugs: VerifyBug[] } | null;
}

export const keep = (f: TriageFix): boolean =>
  f.defect && f.introducedHere && f.visibleFromDiff && f.bugs.length > 0;

export const confirmed = (b: VerifyBug): boolean => b.exists && b.introduced && b.fixed && b.visible;

/** Bugs of the kept fixes, one per file:line, with every fix that reported it. */
export function distinctBugs(row: TriageRow): (TriageBug & { fixes: string[] })[] {
  const byLoc = new Map<string, TriageBug & { fixes: string[] }>();
  for (const f of row.triage?.fixes.filter(keep) ?? []) {
    for (const b of f.bugs) {
      const k = `${b.file}:${b.line}`;
      const seen = byLoc.get(k);
      if (seen) seen.fixes.push(f.sha);
      else byLoc.set(k, { ...b, fixes: [f.sha] });
    }
  }
  return [...byLoc.values()];
}

/** Fisher-Yates with mulberry32: the same seed gives the same order on every machine. */
function shuffle<T>(list: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Candidates to review, in the order the set takes them: <=200 by size (all of them are taken), then
 * 201-800 and 801-2000, each shuffled with its own generator from `seed` so one group's change leaves the
 * others' order alone. `earlier`: a previous triage of the same candidates; one it accepted and this round
 * rejects is reviewed too, on the earlier verdict (triage is noisy, the human decides).
 */
export function reviewOrder(triage: TriageReport, earlier?: TriageReport, seed = SEED): ReviewItem[] {
  const before = new Map((earlier?.results ?? []).map((r) => [r.id, r]));
  const items: { row: TriageRow; now?: TriageRow }[] = [];
  for (const r of triage.results) {
    const e = before.get(r.id);
    if (r.triage?.fixes.some(keep)) items.push({ row: r });
    else if (e?.triage?.fixes.some(keep)) items.push({ row: e, now: r });
  }
  return GROUPS.flatMap((g) => {
    const group = items
      .filter((i) => sizeBucket(i.row.lines) === g)
      .sort((a, b) => a.row.lines - b.row.lines || a.row.id.localeCompare(b.row.id));
    return g === '<=200' ? group : shuffle(group, seed);
  }).map((i, k) => ({ ...i, order: k + 1, group: sizeBucket(i.row.lines) }));
}

/** The decisions file before the human writes into it: every decision null, the triage's bugs per candidate. */
export function labelsSkeleton(order: ReviewItem[], repo: string, seed = SEED): Labels {
  return {
    repo,
    seed,
    target: TARGET,
    candidates: order.map(({ order: n, group, row }) => {
      const link = new Map(row.fixes.map((f) => [f.sha, f.kinds.join('+')]));
      return {
        order: n,
        id: row.id,
        group,
        lines: row.lines,
        merge: row.merge,
        base: row.base,
        decision: null,
        note: '',
        bugs: distinctBugs(row).map(({ fixes, ...b }) => ({
          ...b,
          fix: fixes[0]!,
          link: link.get(fixes[0]!) ?? '?',
        })),
      };
    }),
  };
}

/**
 * Writes the verifier's verdicts into `labels` as decisions (docs/eval.md 2.3): a candidate with a confirmed
 * bug is accepted with its confirmed bugs only, in the verifier's wording; one without is rejected. A
 * decision already written is never touched, and a null verdict leaves the candidate undecided. Returns the
 * ids written.
 */
export function applyVerdicts(labels: Labels, results: VerifyResult[], runId: string): string[] {
  const byId = new Map(labels.candidates.map((c) => [c.id, c]));
  const written: string[] = [];
  for (const { id, verify } of results) {
    const c = byId.get(id);
    if (!c || c.decision !== null || !verify) continue;
    const kept = new Map<string, LabelBug>();
    for (const v of verify.bugs.filter(confirmed)) {
      const claimed = c.bugs[v.index];
      if (!claimed) continue;
      const bug = { file: v.file, line: v.line, description: v.description, trigger: v.trigger };
      kept.set(`${v.file}:${v.line}`, { ...bug, fix: claimed.fix, link: claimed.link });
    }
    c.decision = kept.size ? 'accept' : 'reject';
    if (kept.size) c.bugs = [...kept.values()];
    c.note = `verify ${runId}: ${verify.bugs
      .map(
        (v) =>
          `#${v.index} ${confirmed(v) ? 'doğrulandı' : 'red'}${v.corrected ? ' (düzeltildi)' : ''}: ${v.reason}`,
      )
      .join(' | ')}`;
    written.push(id);
  }
  return written;
}

/**
 * Walks `labels` in order and takes accepted candidates until the target. Stops at the first undecided
 * one, since the set is not fixed until it is decided: `next` is that candidate, null once the set is
 * complete or the order ran out.
 */
export function pickSet(labels: Labels): { set: SetRecord[]; rejected: number; next: LabelEntry | null } {
  const set: SetRecord[] = [];
  let rejected = 0;
  for (const c of labels.candidates) {
    if (set.length === labels.target) break;
    if (c.decision === null) return { set, rejected, next: c };
    if (c.decision === 'reject') {
      rejected++;
      continue;
    }
    if (c.decision !== 'accept') {
      throw new Error(`${c.id}: decision must be accept, reject or null, not ${JSON.stringify(c.decision)}`);
    }
    if (!c.bugs.length) throw new Error(`${c.id}: accepted without a bug`);
    set.push({
      id: c.id,
      repo: labels.repo,
      merge: c.merge,
      base: c.base,
      kind: 'bug',
      lines: c.lines,
      bugs: c.bugs.map((b, i) => ({ id: `${c.id}-${String.fromCharCode(97 + i)}`, ...b })),
    });
  }
  return { set, rejected, next: null };
}

/**
 * Clean PRs (docs/eval.md 2.4): `n` for the set, then `pilot` more for the pilot, each split over the size
 * groups like the bug set (largest remainder; a group short of PRs leaves its share to the best of the
 * rest). Within a group the highest survival first, ties broken by `seed`. A PR that added no counted line
 * gives the arms nothing to review and is never picked.
 */
export function pickClean(
  pool: CleanCandidate[],
  bugs: SetRecord[],
  n = 5,
  pilot = 2,
  seed = SEED,
): { set: CleanCandidate[]; pilot: CleanCandidate[] } {
  const rank = (list: CleanCandidate[]) =>
    shuffle(
      [...list].sort((a, b) => a.id.localeCompare(b.id)),
      seed,
    ).sort((a, b) => survival(b) - survival(a));
  const pick = (from: CleanCandidate[], k: number) => {
    const share = GROUPS.map(
      (g) => (k * bugs.filter((b) => sizeBucket(b.lines) === g).length) / (bugs.length || 1),
    );
    const quota = share.map(Math.floor);
    const byRemainder = GROUPS.map((_, i) => i).sort(
      (a, b) => share[b]! - quota[b]! - (share[a]! - quota[a]!),
    );
    for (const i of byRemainder.slice(0, k - quota.reduce((t, q) => t + q, 0))) quota[i] = quota[i]! + 1;
    const picked = GROUPS.flatMap((g, i) =>
      rank(from.filter((c) => sizeBucket(c.lines) === g)).slice(0, quota[i]),
    );
    return [...picked, ...rank(from.filter((c) => !picked.includes(c))).slice(0, k - picked.length)];
  };
  const eligible = pool.filter((c) => c.added > 0);
  const set = pick(eligible, n);
  return {
    set,
    pilot: pick(
      eligible.filter((c) => !set.includes(c)),
      pilot,
    ),
  };
}

/** A clean PR as a set record (docs/eval.md 2.5): no bugs to find. */
export function cleanRecord(c: CleanCandidate, repo: string): SetRecord {
  return { id: c.id, repo, merge: c.merge, base: c.base, kind: 'clean', lines: c.lines, bugs: [] };
}

const flags = (f: TriageFix) =>
  `${f.defect ? 'kusur' : '-'} / ${f.introducedHere ? 'bu PR' : '-'} / ${f.visibleFromDiff ? 'görülür' : '-'}`;
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const title = (r: { pr: number | null; merge: string }) => (r.pr === null ? r.merge.slice(0, 9) : `#${r.pr}`);

/**
 * Numbered heading, diff command, deduped bugs and the per-fix verdict table of one candidate; for one
 * this round rejects, also this round's verdict on each fix the earlier round accepted.
 */
function candidateBlock({ order, row: r, now }: ReviewItem, out: string[]): void {
  out.push('');
  out.push(
    `### ${order}. ${r.id}: ${title(r)}, ${r.lines} satır, ${r.files} dosya${now ? ' (önceki turda kabul, bu turda red)' : ''}`,
  );
  out.push('');
  out.push(
    `Merge ${r.mergedAt.slice(0, 10)}, bağlantı \`${r.kind}\`. \`git diff ${r.base.slice(0, 12)} ${r.merge.slice(0, 12)}\``,
  );
  out.push('');
  out.push("Bug'lar:");
  out.push('');
  for (const b of distinctBugs(r)) {
    const fixes = b.fixes.map((s) => s.slice(0, 9)).join(', ');
    out.push(`- \`${b.file}:${b.line}\` ${b.description} Senaryo: ${b.trigger} (fix: ${fixes})`);
  }
  out.push('');
  out.push('| Fix | Konu | Karar | Gerekçe |');
  out.push('|---|---|---|---|');
  const subject = new Map(r.fixes.map((f) => [f.sha, f.subject]));
  for (const f of r.triage!.fixes) {
    out.push(
      `| \`${f.sha.slice(0, 9)}\` | ${cell(trim(subject.get(f.sha) ?? '?', 70))} | ${flags(f)} | ${cell(trim(f.reason, 280))} |`,
    );
  }
  if (!now) return;
  out.push('');
  out.push(
    "Fix listesi değişince yeniden soruldu ve bu tur reddetti. Yukarıdaki karar önceki turun; önceki turun kabul ettiği her fix'e bu turun kararı:",
  );
  out.push('');
  const current = new Map((now.triage?.fixes ?? []).map((f) => [f.sha, f]));
  for (const f of r.triage!.fixes.filter(keep)) {
    const c = current.get(f.sha);
    out.push(
      `- Bu tur \`${f.sha.slice(0, 9)}\`: ${c ? `${flags(c)}, ${cell(trim(c.reason, 280))}` : 'sorulmadı (8 fix sınırı ya da null)'}`,
    );
  }
}

/** `earlier`: a previous triage of the same candidates (see reviewOrder). */
export function reviewSheet(triage: TriageReport, mined: MineResult, earlier?: TriageReport): string {
  const rows = triage.results;
  const order = reviewOrder(triage, earlier);
  const reviewed = new Set(order.map((i) => i.row.id));
  const rejected = rows.filter((r) => !reviewed.has(r.id));
  const accepted = order.filter((i) => !i.now);
  const count = (b: string) => accepted.filter((i) => i.group === b).length;
  const out: string[] = [];

  out.push('# Eval etiket onayı');
  out.push('');
  out.push(
    `Eleme: run \`${triage.runId}\`, ${triage.model}/${triage.effort}. ` +
      `${rows.length} aday, ${accepted.length} kabul ` +
      `(≤200: ${count('<=200')}, 201-800: ${count('201-800')}, 801-2000: ${count('801-2000')}), ` +
      `${order.length - accepted.length} önceki turda kabul edilmişti, ${rows.filter((r) => !r.triage).length} null. ` +
      `Maliyet: ${JSON.stringify(triage.summary.dollars ?? null)} $.`,
  );
  out.push('');
  out.push(
    `Hedef (docs/eval.md 2.3): ${TARGET} bug'lı PR. Sırayla ilerle: ≤200 grubunun hepsine bak, sonra kabul ` +
      `sayısı ${TARGET} olana kadar devam et; sonrakilere bakman gerekmez. Kararı \`eval/data/labels.json\`'da ` +
      "adayın `decision` alanına yaz (`accept` ya da `reject`); bir bug'ın tanımını düzeltebilir ya da yanlış " +
      "bug'ı silebilirsin. Aynı bug birden çok fix'te geçiyorsa burada zaten tek satıra indirildi. Diff'i görmek " +
      "için başlıktaki komutu lula'da çalıştır. `node eval/review.ts --earlier eval/data/triage.v1.json` " +
      `ilerlemeyi ve sıradakini gösterir, ${TARGET} kabulde \`eval/data/set.json\`'u yazar. Pilot bu setten PR almaz.`,
  );
  for (const g of GROUPS) {
    const items = order.filter((i) => i.group === g);
    if (!items.length) continue;
    const first = items[0]!.order;
    const last = items.at(-1)!.order;
    out.push('');
    out.push(`## ${first === last ? first : `${first}–${last}`}: ${GROUP_TITLE[g]}`);
    for (const i of items) candidateBlock(i, out);
  }
  out.push('');
  out.push(`## Reddedilenler (${rejected.length})`);
  out.push('');
  out.push('| Aday | Satır | İlk fix | Gerekçe |');
  out.push('|---|---:|---|---|');
  for (const r of rejected) {
    const f = r.triage?.fixes[0];
    out.push(
      `| ${r.id} | ${r.lines} | ${cell(trim(r.fixes[0]?.subject ?? '', 60))} | ${f ? cell(trim(f.reason, 200)) : 'null (ajan sonuç vermedi)'} |`,
    );
  }
  out.push('');
  const clean = [...mined.clean].sort(
    (a, b) => survival(b) - survival(a) || a.lines - b.lines || a.id.localeCompare(b.id),
  );
  out.push(`## Temiz havuz (${clean.length})`);
  out.push('');
  out.push(
    'Hedef (docs/eval.md 2.4, 5): set için bug setinin boyut dağılımına benzeyen 5 temiz PR, pilot için bunlardan ' +
      "ayrı 2 temiz PR. Hayatta kalma, PR'ın eklediği satırlardan trunk ucunda hâlâ ona ait olanların oranıdır; " +
      'yüksek olan önce.',
  );
  out.push('');
  out.push('| Aday | Satır | Boyut | Hayatta kalma | Merge | Konu |');
  out.push('|---|---:|---|---:|---|---|');
  for (const c of clean) {
    out.push(
      `| ${c.id} | ${c.lines} | ${sizeBucket(c.lines)} | ${Math.round(survival(c) * 100)}% (${c.surviving}/${c.added}) | ${c.mergedAt.slice(0, 10)} | ${cell(trim(c.subject, 60))} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

/** Capped at 1: blame at the tip can credit the PR with a few more lines than it added. */
function survival(c: CleanCandidate): number {
  return c.added ? Math.min(1, c.surviving / c.added) : 1;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const triage = JSON.parse(readFileSync(flag(argv, '--triage') ?? 'eval/data/triage.json', 'utf8'));
  const mined = JSON.parse(readFileSync(flag(argv, '--candidates') ?? 'eval/data/candidates.json', 'utf8'));
  const out = flag(argv, '--out') ?? 'eval/data/review.md';
  const labelsPath = flag(argv, '--labels') ?? 'eval/data/labels.json';
  const setPath = flag(argv, '--set') ?? 'eval/data/set.json';
  const pilotPath = flag(argv, '--pilot') ?? 'eval/data/pilot.json';
  mkdirSync(path.dirname(out), { recursive: true });
  const earlierPath = flag(argv, '--earlier');
  const earlier = earlierPath ? JSON.parse(readFileSync(earlierPath, 'utf8')) : undefined;
  const order = reviewOrder(triage, earlier);
  const labels: Labels | undefined = existsSync(labelsPath)
    ? JSON.parse(readFileSync(labelsPath, 'utf8'))
    : undefined;

  // A sheet numbered apart from the decisions would mislead, so neither file is written then.
  if (labels && labels.candidates.map((c) => c.id).join() !== order.map((i) => i.row.id).join()) {
    console.error(
      `review: ${labelsPath} does not follow this order (--earlier missing, or a new triage); nothing written`,
    );
    process.exitCode = 1;
  } else {
    writeFileSync(out, reviewSheet(triage, mined, earlier));
    console.error(`review: wrote ${out}`);
    if (!labels) {
      writeFileSync(
        labelsPath,
        `${JSON.stringify(labelsSkeleton(order, path.basename(mined.repo)), null, 2)}\n`,
      );
      console.error(`review: wrote ${labelsPath}, ${order.length} candidates, no decisions yet`);
    } else {
      const { set, rejected, next } = pickSet(labels);
      const where = next ? `; next #${next.order} ${next.id}` : '';
      console.error(`review: ${set.length}/${labels.target} accepted, ${rejected} rejected${where}`);
      if (set.length === labels.target) {
        const clean = pickClean(mined.clean, set);
        const records = (list: CleanCandidate[]) => list.map((c) => cleanRecord(c, labels.repo));
        writeFileSync(setPath, `${JSON.stringify([...set, ...records(clean.set)], null, 2)}\n`);
        writeFileSync(pilotPath, `${JSON.stringify(records(clean.pilot), null, 2)}\n`);
        console.error(
          `review: wrote ${setPath} (${set.length} bug, ${clean.set.length} clean) and ${pilotPath}`,
        );
      } else if (!next) {
        console.error(`review: the order ran out below ${labels.target}`);
      }
    }
  }
}
