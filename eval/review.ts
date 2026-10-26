// Eval step 2 input (docs/eval.md 2.3, 2.4): the human review sheet built from the triage and the mine.
//   node eval/review.ts [--triage eval/data/triage.json] [--candidates eval/data/candidates.json]
//                       [--earlier eval/data/triage.v1.json] [--out eval/data/review.md]
// Accepted candidates in full (bugs deduped by file:line across fixes), ones an earlier triage accepted
// and this one rejects with the earlier verdict, rejected ones in one line each, and the clean pool with
// survival. Pure data transform: no git, no network.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Type-only: Node's type stripping erases it, so the .js specifier never has to resolve at run time.
import type { BugCandidate, CleanCandidate, MineResult } from './mine.js';

/** Same buckets as eval/mine.ts sizeBucket (a value import would need a .ts specifier tsc rejects). */
function sizeBucket(lines: number): string {
  return lines <= 200 ? '<=200' : lines <= 800 ? '201-800' : lines <= 2000 ? '801-2000' : '>2000';
}

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

export const keep = (f: TriageFix): boolean =>
  f.defect && f.introducedHere && f.visibleFromDiff && f.bugs.length > 0;

/** Bugs of the kept fixes, one per file:line, with every fix that reported it. */
export function distinctBugs(row: TriageRow): (TriageBug & { fixes: string[] })[] {
  const byLoc = new Map<string, TriageBug & { fixes: string[] }>();
  for (const f of row.triage?.fixes.filter(keep) ?? []) {
    for (const b of f.bugs) {
      const k = `${b.file}:${b.line}`;
      const seen = byLoc.get(k);
      if (seen) seen.fixes.push(f.sha.slice(0, 9));
      else byLoc.set(k, { ...b, fixes: [f.sha.slice(0, 9)] });
    }
  }
  return [...byLoc.values()];
}

const flags = (f: TriageFix) =>
  `${f.defect ? 'kusur' : '-'} / ${f.introducedHere ? 'bu PR' : '-'} / ${f.visibleFromDiff ? 'görülür' : '-'}`;
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const title = (r: { pr: number | null; merge: string }) => (r.pr === null ? r.merge.slice(0, 9) : `#${r.pr}`);

/** Heading, diff command, deduped bugs and the per-fix verdict table of one triaged candidate. */
function candidateBlock(r: TriageRow, out: string[]): void {
  out.push('');
  out.push(`### ${r.id}: ${title(r)}, ${r.lines} satır, ${r.files} dosya`);
  out.push('');
  out.push(
    `Merge ${r.mergedAt.slice(0, 10)}, bağlantı \`${r.kind}\`. \`git diff ${r.base.slice(0, 12)} ${r.merge.slice(0, 12)}\``,
  );
  out.push('');
  out.push("Bug'lar:");
  out.push('');
  for (const b of distinctBugs(r)) {
    out.push(`- \`${b.file}:${b.line}\` ${b.description} Senaryo: ${b.trigger} (fix: ${b.fixes.join(', ')})`);
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
}

/**
 * `earlier`: a previous triage of the same candidates. One a previous round accepted and this round
 * rejects is listed apart with the earlier verdict: triage is noisy, the human decides.
 */
export function reviewSheet(triage: TriageReport, mined: MineResult, earlier?: TriageReport): string {
  const rows = triage.results;
  const accepted = rows.filter((r) => r.triage?.fixes.some(keep));
  const before = new Map((earlier?.results ?? []).map((r) => [r.id, r]));
  const flipped = rows
    .filter((r) => !accepted.includes(r) && before.get(r.id)?.triage?.fixes.some(keep))
    .map((r) => ({ now: r, earlierRow: before.get(r.id)! }));
  const rejected = rows.filter((r) => !accepted.includes(r) && !flipped.some((f) => f.now === r));
  accepted.sort((a, b) => a.lines - b.lines);
  const count = (list: { lines: number }[], b: string) =>
    list.filter((r) => sizeBucket(r.lines) === b).length;
  const out: string[] = [];

  out.push('# Eval etiket onayı');
  out.push('');
  out.push(
    `Eleme: run \`${triage.runId}\`, ${triage.model}/${triage.effort}. ` +
      `${rows.length} aday, ${accepted.length} kabul ` +
      `(≤200: ${count(accepted, '<=200')}, 201-800: ${count(accepted, '201-800')}, ` +
      `801-2000: ${count(accepted, '801-2000')}), ` +
      `${flipped.length} önceki turda kabul edilmişti, ${rows.filter((r) => !r.triage).length} null. ` +
      `Maliyet: ${JSON.stringify(triage.summary.dollars ?? null)} $.`,
  );
  out.push('');
  out.push(
    "Hedef (docs/eval.md 2.3): 20 bug'lı PR; boyut dağılımı bölüm 2.3'te. Pilot bu setten PR almaz. " +
      'Her aday için karar ver: kabul, red ya da tanımı düzelt. Aynı bug birden çok ' +
      "fix'te geçiyorsa burada zaten tek satıra indirildi. Diff'i görmek için başlıktaki komutu lula'da çalıştır.",
  );
  out.push('');
  out.push(`## Kabul edilenler (${accepted.length})`);
  for (const r of accepted) candidateBlock(r, out);
  out.push('');
  if (flipped.length) {
    out.push(`## Önceki turda kabul, bu turda red (${flipped.length})`);
    out.push('');
    out.push(
      "Fix listesi değişince yeniden soruldu ve bu tur reddetti. Aşağıda önceki turun kararı var; bu turun ilk fix'e " +
        'gerekçesi başlığın altında.',
    );
    for (const { now, earlierRow } of flipped) {
      candidateBlock(earlierRow, out);
      out.push('');
      out.push(`Bu tur: ${cell(trim(now.triage?.fixes[0]?.reason ?? 'null (ajan sonuç vermedi)', 280))}`);
    }
    out.push('');
  }
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

function survival(c: CleanCandidate): number {
  return c.added ? c.surviving / c.added : 1;
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
  mkdirSync(path.dirname(out), { recursive: true });
  const earlierPath = flag(argv, '--earlier');
  const earlier = earlierPath ? JSON.parse(readFileSync(earlierPath, 'utf8')) : undefined;
  writeFileSync(out, reviewSheet(triage, mined, earlier));
  console.error(`review: wrote ${out}`);
}
