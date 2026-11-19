import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Budget } from './budget.js';
import { canonicalJSON } from './journal.js';
import { parseScript } from './runtime.js';
import { defaultConcurrency } from './scheduler.js';
import { DEFAULT_MODEL, type Usage, type WorkflowEvent } from './types.js';
import { addUsage, cacheReadRatio, totalInput } from './usage.js';
import { type RunOptions, run, SAFE_ID } from './workflow.js';

// The documents have already been parsed as JSON. Keep args, expected and actual untouched so all
// JSON object keys (including __proto__) survive validation and grading.
const caseId = z
  .string()
  .min(1)
  .refine((id) => id.trim().length > 0, 'empty case id');
const fixture = z.strictObject({ id: caseId, args: z.unknown().optional(), expected: z.unknown() });
const count = z.number().int().nonnegative();
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.optional(),
  cache_creation_input_tokens: count.optional(),
});
const savedCase = z.object({
  id: caseId,
  runId: z.string().regex(SAFE_ID),
  argsHash: z.string(),
  expectedHash: z.string(),
  status: z.enum(['pass', 'fail']),
  error: z.string().optional(),
  mismatch: z.object({ expected: z.unknown(), actual: z.unknown() }).optional(),
  usage: usageSchema,
  calls: count,
  hits: count,
});
const savedReport = z.object({
  version: z.literal(1),
  id: z.string().regex(SAFE_ID),
  cases: z.array(savedCase).min(1),
});
type CaseResult = z.infer<typeof savedCase>;
type SavedReport = z.infer<typeof savedReport>;

function summarize(report: SavedReport) {
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let passed = 0;
  let calls = 0;
  let hits = 0;
  for (const item of report.cases) {
    if (item.status === 'pass') passed++;
    calls += item.calls;
    hits += item.hits;
    addUsage(usage, item.usage);
  }
  return {
    id: report.id,
    passed,
    total: report.cases.length,
    calls,
    hits,
    journalHitRatio: calls ? hits / calls : null,
    usage,
    tokens: totalInput(usage) + usage.output_tokens,
    promptCacheRatio: cacheReadRatio(usage),
  };
}

export type EvalReport = SavedReport & ReturnType<typeof summarize>;

function assertUniqueIds(cases: { id: string }[]) {
  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`duplicate eval case ID ${JSON.stringify(item.id)}`);
    ids.add(item.id);
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

export async function readEval(stateDir: string, id: string): Promise<EvalReport> {
  if (!SAFE_ID.test(id)) throw new Error(`invalid eval ID ${JSON.stringify(id)}`);
  const file = path.join(stateDir, 'evals', `${id}.json`);
  const saved = savedReport.parse(JSON.parse(await readFile(file, 'utf8')));
  if (saved.id !== id) throw new Error(`eval ID in ${file} does not match ${id}`);
  assertUniqueIds(saved.cases);
  return { ...saved, ...summarize(saved) };
}

export type EvalOptions = Pick<
  RunOptions,
  | 'cwd'
  | 'stateDir'
  | 'tools'
  | 'toolsDir'
  | 'workflowsDir'
  | 'isolation'
  | 'concurrency'
  | 'model'
  | 'runner'
  | 'budget'
> & {
  scriptPath: string;
  casesPath: string;
  baseline?: string;
  from?: string;
  signal?: AbortSignal;
  onCaseStart?: (caseId: string, runId: string) => void;
};

/** Each case gets a standard workflow run and a stable ID for aligning reports across revisions. */
export async function runEval(options: EvalOptions): Promise<EvalReport> {
  const { scriptPath, casesPath, baseline, from, signal, onCaseStart, ...runOptions } = options;
  if ((baseline === undefined) !== (from === undefined))
    throw new Error('eval needs both --baseline and --from for replay');
  const cwd = path.resolve(options.cwd ?? '.');
  const stateDir = path.resolve(cwd, options.stateDir ?? '.maestro');
  // Snapshot the source once so all cases execute the same revision even if the file is edited mid-run.
  const [script, casesJson] = await Promise.all([
    readFile(path.resolve(cwd, scriptPath), 'utf8'),
    readFile(path.resolve(cwd, casesPath), 'utf8'),
  ]);
  parseScript(script);
  const fixtures = z.array(fixture).min(1).parse(JSON.parse(casesJson));
  assertUniqueIds(fixtures);
  const previous = baseline === undefined ? [] : (await readEval(stateDir, baseline)).cases;
  const previousById = new Map(previous.map((item) => [item.id, item]));
  // Use the current suite's settings for new and replayed cases alike. A standalone replay
  // normally inherits missing settings from its source run.
  const concurrency = options.concurrency ?? defaultConcurrency();
  const model = options.model ?? DEFAULT_MODEL;
  const requestLimit =
    options.runner && 'maxRequestTokens' in options.runner ? options.runner.maxRequestTokens : undefined;
  const budget =
    typeof options.budget === 'number'
      ? new Budget({
          total: options.budget,
          concurrency,
          maxTokensPerTurn: typeof requestLimit === 'number' ? requestLimit : undefined,
        })
      : (options.budget ?? null);
  const evalDir = path.join(stateDir, 'evals');
  await mkdir(evalDir, { recursive: true });
  const report: SavedReport = { version: 1, id: `eval-${randomUUID()}`, cases: [] };
  for (const item of fixtures) {
    signal?.throwIfAborted();
    const args = item.args ?? null;
    const argsHash = hash(args);
    const expectedHash = hash(item.expected);
    const source = previousById.get(item.id);
    const handle = run({
      ...runOptions,
      cwd,
      stateDir,
      model,
      concurrency,
      budget,
      script,
      args,
      ...(source && source.argsHash === argsHash && from !== undefined
        ? { replayFrom: { runId: source.runId, from } }
        : {}),
    });
    const result: CaseResult = {
      id: item.id,
      runId: handle.runId,
      argsHash,
      expectedHash,
      status: 'fail',
      calls: 0,
      hits: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const onEnd = (event: Extract<WorkflowEvent, { type: 'agent_end' }>) => {
      result.calls++;
      if (event.cached) result.hits++;
      else addUsage(result.usage, event.usage);
    };
    handle.events.on('agent_end', onEnd);
    const stop = () => handle.stop('eval interrupted');
    signal?.addEventListener('abort', stop, { once: true });
    try {
      try {
        onCaseStart?.(item.id, handle.runId);
      } catch {
        // As with run() event listeners, a progress observer cannot change the case outcome.
      }
      const value = await handle.promise;
      const actual: unknown = JSON.parse(JSON.stringify(value) ?? 'null');
      if (hash(actual) === expectedHash) result.status = 'pass';
      else result.mismatch = { expected: item.expected, actual };
    } catch (error) {
      signal?.throwIfAborted();
      const message = (error as { message?: unknown } | null)?.message;
      result.error = typeof message === 'string' ? message : String(error);
    } finally {
      signal?.removeEventListener('abort', stop);
      handle.events.off('agent_end', onEnd);
    }
    report.cases.push(result);
  }
  const file = path.join(evalDir, `${report.id}.json`);
  await writeFile(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await rename(`${file}.tmp`, file);
  return { ...report, ...summarize(report) };
}

function percentage(ratio: number | null): string {
  return ratio === null ? 'n/a' : `${(100 * ratio).toFixed(1)}%`;
}

function hitLabel(row: ReturnType<typeof summarize>): string {
  return `${row.hits}/${row.calls} (${percentage(row.journalHitRatio)})`;
}

export function formatEval(report: EvalReport): string {
  const lines = [
    `Eval ${report.id}`,
    `Passed ${report.passed}/${report.total} | Tokens ${report.tokens} | [CACHE HIT] ${hitLabel(report)} | Prompt cache ${percentage(report.promptCacheRatio)}`,
  ];
  for (const item of report.cases) {
    lines.push(`${item.status.toUpperCase()} ${JSON.stringify(item.id)}  ${item.runId}`);
    if (item.error !== undefined) lines.push(`  ${item.error}`);
    if (item.mismatch)
      lines.push(`  expected ${preview(item.mismatch.expected)}, received ${preview(item.mismatch.actual)}`);
  }
  return lines.join('\n');
}

function preview(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length <= 200 ? text : `${text.slice(0, 200)}…`;
}

export function diffEvals(a: EvalReport, b: EvalReport) {
  const before = summarize(a);
  const after = summarize(b);
  const left = new Map(a.cases.map((item) => [item.id, item]));
  const right = new Map(b.cases.map((item) => [item.id, item]));
  const cases = [...new Set([...left.keys(), ...right.keys()])].map((id) => {
    const x = left.get(id);
    const y = right.get(id);
    let change: string;
    if (!x) change = 'added';
    else if (!y) change = 'removed';
    else if (x.argsHash !== y.argsHash || x.expectedHash !== y.expectedHash) change = 'case changed';
    else if (x.status === y.status) change = 'unchanged';
    else change = y.status === 'pass' ? 'fixed' : 'regressed';
    return {
      id,
      before: x?.status ?? null,
      after: y?.status ?? null,
      change,
      beforeRunId: x?.runId ?? null,
      afterRunId: y?.runId ?? null,
    };
  });
  return {
    before,
    after,
    delta: { passed: after.passed - before.passed, tokens: after.tokens - before.tokens },
    cases,
  };
}

export function formatEvalDiff(diff: ReturnType<typeof diffEvals>): string {
  const { before, after, delta } = diff;
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  return [
    `Eval ${before.id} → ${after.id}`,
    `Passed: ${before.passed}/${before.total} → ${after.passed}/${after.total} (${signed(delta.passed)})`,
    `Tokens: ${before.tokens} → ${after.tokens} (${signed(delta.tokens)})`,
    `[CACHE HIT]: ${hitLabel(before)} → ${hitLabel(after)}`,
    `Prompt cache: ${percentage(before.promptCacheRatio)} → ${percentage(after.promptCacheRatio)}`,
    ...diff.cases.map(
      (item) =>
        `${item.change}  ${JSON.stringify(item.id)}  ${item.before ?? '—'} → ${item.after ?? '—'}  ${item.afterRunId ?? item.beforeRunId}`,
    ),
  ].join('\n');
}
