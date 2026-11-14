// ReviewBench (github.com/review-bench/ReviewBench) as the set for the review-changes A/B: the tasks,
// the cell order and the findings file the benchmark's judge reads (its docs/JUDGING_INPUT.md).
// Pure data: no git, no network.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** One pull request of corpus/test/test.json or corpus/manifest.json. */
export interface BenchTask {
  repo: string;
  /** "owner/name". */
  nwo: string;
  pr_number: number;
  base: string;
  head: string;
  title: string;
  language?: string;
  lines_added?: number;
  lines_removed?: number;
}

/** What every arm returns: the FINDINGS schema of examples/workflows/review-changes.js. */
export interface ArmFinding {
  file: string;
  line: number;
  claim: string;
  failure: string;
}

export interface JudgingInput {
  pr: { repo: string; pr_number: number; base: string; head: string };
  agent: string;
  findings: { producer: string; file: string; start_line: number; end_line: number; message: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens: number; cost_usd?: number };
}

const SHA = /^[0-9a-f]{40}$/;

/** The benchmark's own name for a PR: "<owner>_<repo>_<number>-<head8>", as in golden/. */
export function prKey(task: Pick<BenchTask, 'nwo' | 'pr_number' | 'head'>): string {
  return `${task.nwo.replace('/', '_')}_${task.pr_number}-${task.head.slice(0, 8)}`;
}

/** The tasks of a set: 'test' (25 PRs) or 'full' (219). Throws on a row the runner could not use. */
export function loadTasks(benchDir: string, set: 'test' | 'full' = 'test'): BenchTask[] {
  const file = set === 'test' ? 'corpus/test/test.json' : 'corpus/manifest.json';
  const rows = JSON.parse(readFileSync(path.join(benchDir, file), 'utf8')) as BenchTask[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${file}: no tasks`);
  for (const [i, t] of rows.entries()) {
    const ok =
      typeof t.repo === 'string' &&
      typeof t.nwo === 'string' &&
      /^[\w.-]+\/[\w.-]+$/.test(t.nwo) &&
      Number.isInteger(t.pr_number) &&
      SHA.test(t.base) &&
      SHA.test(t.head);
    if (!ok) throw new Error(`${file}[${i}]: not a task (repo, nwo, pr_number, 40-character base and head)`);
  }
  return rows;
}

/**
 * An arm's findings as the judge's input file. Findings the judge would refuse (no file, no positive
 * line) are dropped and counted, so one bad row does not void the PR.
 */
export function toJudgingInput(
  task: BenchTask,
  agent: string,
  findings: ArmFinding[],
  usage?: JudgingInput['usage'],
): { input: JudgingInput; dropped: number } {
  const out: JudgingInput['findings'] = [];
  let dropped = 0;
  for (const f of findings) {
    const file =
      typeof f?.file === 'string'
        ? f.file
            .replace(/\\/g, '/')
            .replace(/^(\.\/)+/, '')
            .replace(/^\/+/, '')
        : '';
    const line = Number.isInteger(f?.line) && f.line >= 1 ? f.line : 0;
    const message = [f?.claim, f?.failure].filter((s) => typeof s === 'string' && s.trim() !== '').join(' ');
    if (file === '' || line === 0 || message === '') {
      dropped++;
      continue;
    }
    out.push({ producer: agent, file, start_line: line, end_line: line, message });
  }
  const input: JudgingInput = {
    pr: { repo: task.repo, pr_number: task.pr_number, base: task.base, head: task.head },
    agent,
    findings: out,
  };
  if (usage) input.usage = usage;
  return { input, dropped };
}

export interface Cell {
  arm: string;
  repeat: number;
  task: BenchTask;
  /** "<arm>-r<repeat>-<prKey>": the run id and the row id in results.jsonl. */
  id: string;
}

/** mulberry32, as in eval/review.ts: the same seed gives the same order on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every task × arm × repeat, shuffled with a fixed seed so no arm runs first or last as a block. */
export function cells(tasks: BenchTask[], arms: string[], repeats: number, seed: number): Cell[] {
  const all: Cell[] = [];
  for (const task of tasks) {
    for (const arm of arms) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        all.push({ arm, repeat, task, id: `${arm}-r${repeat}-${prKey(task)}` });
      }
    }
  }
  const next = rng(seed);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all;
}

/** Mean of the numbers that are there; null when none is. */
export function mean(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** The three arms: which workflow each runs. B is the shipped example, unchanged. */
export const ARMS: Record<string, { script: string; label: string }> = {
  A: { script: 'eval/workflows/single-review.js', label: 'tek ajan' },
  B: { script: 'examples/workflows/review-changes.js', label: 'review-changes' },
  C: { script: 'eval/workflows/finders-only.js', label: 'üç bulucu, skeptik yok' },
};

/**
 * An arm's return value as findings. `failed` when the arm produced no review at all (null, or its own
 * failed mark): such a cell is recorded but gets no findings file, so the judge does not score a
 * broken run as "reviewed and found nothing".
 */
export function armResult(value: unknown): { findings: ArmFinding[]; failed: boolean } {
  const v = value as { findings?: unknown; failed?: unknown } | null;
  if (v === null || typeof v !== 'object' || !Array.isArray(v.findings) || v.failed === true) {
    return { findings: [], failed: true };
  }
  return { findings: v.findings as ArmFinding[], failed: false };
}

export function f1(p: number | null, r: number | null): number | null {
  if (p === null || r === null) return null;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

// ---------------------------------------------------------------------------------------------
// Report: the judge's results.json per arm and repeat, next to what the cells cost.

/** The fields of the judge's MetricSet (scripts/eval/scorer.ts) the report reads. */
export interface JudgeMetrics {
  grounded_precision: number | null;
  grounded_recall: number | null;
  candidate_count: number;
}
interface Stratified {
  overall: JudgeMetrics;
  by_severity: Record<string, JudgeMetrics>;
  by_category: Record<string, JudgeMetrics>;
}
/** One results.json. */
export interface JudgeResults {
  micro: Stratified;
  macro: Stratified;
  pr_count: number;
  per_pr: { pr_key: string; metrics: Stratified }[];
}
/** One row of the runner's results.jsonl. */
export interface CellRow {
  id: string;
  arm: string;
  repeat: number;
  pr: string;
  /** 'degraded': the run returned a review but lost agents (null or skipped rows); not scored. */
  status: 'ok' | 'failed' | 'degraded';
  dollars?: number | null;
  findings?: number;
}

export interface ArmSummary {
  arm: string;
  repeats: number;
  /** Means over the repeats of the micro (all findings pooled) figures. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Lowest and highest F1 of a single repeat: the run-to-run spread. */
  f1Range: [number, number] | null;
  recallHigh: number | null;
  recallCorrectness: number | null;
  recallSecurity: number | null;
  findingsPerPr: number | null;
  dollarsPerPr: number | null;
  cellsOk: number;
  cellsFailed: number;
}

/** Per arm: the judge's figures averaged over its repeats, and cost and failures from the cell rows. */
export function summarize(
  scores: { arm: string; repeat: number; results: JudgeResults }[],
  rows: CellRow[],
): ArmSummary[] {
  const last = new Map<string, CellRow>();
  for (const r of rows) last.set(r.id, r);
  const cellRows = [...last.values()];
  const arms = [...new Set([...scores.map((s) => s.arm), ...cellRows.map((r) => r.arm)])].sort();
  return arms.map((arm) => {
    const mine = scores.filter((s) => s.arm === arm);
    const micro = mine.map((s) => s.results.micro);
    const f1s = micro
      .map((m) => f1(m.overall.grounded_precision, m.overall.grounded_recall))
      .filter((v): v is number => v !== null);
    const cellsOfArm = cellRows.filter((r) => r.arm === arm);
    const ok = cellsOfArm.filter((r) => r.status === 'ok');
    return {
      arm,
      repeats: mine.length,
      precision: mean(micro.map((m) => m.overall.grounded_precision)),
      recall: mean(micro.map((m) => m.overall.grounded_recall)),
      f1: mean(f1s),
      f1Range: f1s.length ? [Math.min(...f1s), Math.max(...f1s)] : null,
      recallHigh: mean(micro.map((m) => m.by_severity.high?.grounded_recall)),
      recallCorrectness: mean(micro.map((m) => m.by_category.correctness?.grounded_recall)),
      recallSecurity: mean(micro.map((m) => m.by_category.security?.grounded_recall)),
      findingsPerPr: mean(ok.map((r) => r.findings)),
      // Failed cells cost money too: every cell with a cost counts.
      dollarsPerPr: mean(cellsOfArm.map((r) => r.dollars)),
      cellsOk: ok.length,
      cellsFailed: cellsOfArm.length - ok.length,
    };
  });
}

/**
 * Paired comparison of two arms on the PRs both were scored on: per PR the mean grounded recall over the
 * repeats, then how often `b` is ahead, behind or level. A PR with no golden true positive has no recall
 * and is left out.
 */
export function paired(
  scores: { arm: string; repeat: number; results: JudgeResults }[],
  a: string,
  b: string,
): { prs: number; bAhead: number; aAhead: number; level: number; meanDiff: number | null } {
  const recallByPr = (arm: string) => {
    const byPr = new Map<string, (number | null)[]>();
    for (const s of scores.filter((x) => x.arm === arm)) {
      for (const p of s.results.per_pr) {
        byPr.set(p.pr_key, [...(byPr.get(p.pr_key) ?? []), p.metrics.overall.grounded_recall]);
      }
    }
    return new Map([...byPr].map(([k, v]) => [k, mean(v)] as const));
  };
  const ra = recallByPr(a);
  const rb = recallByPr(b);
  const diffs: number[] = [];
  for (const [key, va] of ra) {
    const vb = rb.get(key);
    if (va !== null && vb !== null && vb !== undefined) diffs.push(vb - va);
  }
  const eps = 1e-9;
  return {
    prs: diffs.length,
    bAhead: diffs.filter((d) => d > eps).length,
    aAhead: diffs.filter((d) => d < -eps).length,
    level: diffs.filter((d) => Math.abs(d) <= eps).length,
    meanDiff: mean(diffs),
  };
}

const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null) => (v === null ? '–' : `$${v.toFixed(2)}`);

/** The report as Markdown. */
export function reportMarkdown(
  summary: ArmSummary[],
  pairs: { a: string; b: string; p: ReturnType<typeof paired> }[],
): string {
  const lines = [
    '| Kol | Tekrar | Precision | Recall | F1 (en düşük–en yüksek) | Recall: high | Recall: correctness | Recall: security | Bulgu/PR | $/PR | Başarısız hücre |',
    '|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const s of summary) {
    const range = s.f1Range ? ` (${pct(s.f1Range[0])}–${pct(s.f1Range[1])})` : '';
    lines.push(
      `| ${s.arm} ${ARMS[s.arm]?.label ?? ''} | ${s.repeats} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)}${range} | ` +
        `${pct(s.recallHigh)} | ${pct(s.recallCorrectness)} | ${pct(s.recallSecurity)} | ` +
        `${s.findingsPerPr === null ? '–' : s.findingsPerPr.toFixed(1)} | ${usd(s.dollarsPerPr)} | ${s.cellsFailed} |`,
    );
  }
  lines.push(
    '',
    'Rakamlar hakemin "grounded" ölçüleridir (yalnızca golden set ile eşleşenler), tekrarların ortalaması.',
  );
  for (const { a, b, p } of pairs) {
    lines.push(
      `${b} ile ${a}, PR başına recall (${p.prs} PR): ${b} önde ${p.bAhead}, ${a} önde ${p.aAhead}, eşit ${p.level}; ` +
        `ortalama fark ${p.meanDiff === null ? '–' : `${(p.meanDiff * 100).toFixed(1)} puan`}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
