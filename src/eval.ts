// Native eval runner & side-by-side run diff (`maestro eval` & `maestro eval diff <run-a> <run-b>`).
// Runs a Maestro workflow script across a JSON/JSONL dataset of cases, grades each case via
// declarative expectations or a custom JS grader, persists results to <stateDir>/evals/<evalId>/eval.json,
// optionally seeds upstream caches from an earlier eval run (`fromEvalId` / `from`), and compares
// two eval runs (or two individual workflow runs) with score, case-status, token/cost, and [CACHE HIT] deltas.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGeminiModel } from './gemini-runner.js';
import { canonicalJSON, readEntries } from './journal.js';
import { defaultModelRoute } from './routing-runner.js';
import type { AgentRunner, Entry, Usage } from './types.js';
import { DEFAULT_MODEL } from './types.js';
import { addUsage, cacheReadRatio, totalInput } from './usage.js';
import { readEventLines } from './viz.js';
import { readOutcome, run, SAFE_ID } from './workflow.js';

export interface EvalExpectation {
  /** Exact deep equality against the workflow's returned JSON value. */
  equals?: unknown;
  /** Recursive subset match against objects/arrays in the returned value. */
  match?: unknown;
  /** Substring(s) that must appear in the stringified output. */
  contains?: string | string[];
  /** Substring(s) that must not appear in the stringified output. */
  notContains?: string | string[];
  /** Regular expression pattern (string) that the stringified output must match. */
  regex?: string;
}

export interface EvalCase {
  id: string;
  args?: unknown;
  expect?: EvalExpectation;
  /** Optional reference answer or metadata forwarded to custom graders (also used as exact match when `expect` is absent). */
  expected?: unknown;
  tags?: string[];
  description?: string;
}

export interface EvalGraderContext {
  case: EvalCase;
  output: unknown;
  ok: boolean;
  error?: string;
  runId: string;
  runDir: string;
}

export interface EvalGradeResult {
  pass: boolean;
  score?: number;
  reason?: string;
}

export type EvalGraderFn = (
  ctx: EvalGraderContext,
) => boolean | EvalGradeResult | Promise<boolean | EvalGradeResult>;

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M prompt-cache write tokens (defaults to 1.25x input if omitted). */
  cacheWrite?: number;
  /** USD per 1M prompt-cache read tokens (defaults to 0.1x input if omitted). */
  cacheRead?: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** Reference snapshot in USD per million tokens. The `prices` option overrides entries by model ID. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  'gemini-4-carbon': { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15 },
  'gemini-4-argon': { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 },
  'gemini-4-hydrogen': { input: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 3 },
  'gemini-3.5-flash-lite': { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.4 },
};

export interface EvalCaseResult {
  id: string;
  argsHash?: string;
  expectationHash?: string;
  runId: string;
  status: 'pass' | 'fail' | 'error';
  pass: boolean;
  score: number;
  reason?: string;
  durationMs: number;
  degraded: boolean;
  failedAgents: number;
  /** Total token usage across this run's journal rows, excluding rows seeded from replay. */
  usage: Usage;
  /** Live API token usage only (excluding journal cache hits). */
  liveUsage: Usage;
  estimatedCostUsd: number | null;
  agentCalls: number;
  journalCacheHits: number;
  promptCacheRatio: number | null;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  passRate: number;
  scoreAvg: number;
  durationMs: number;
  tokens: {
    input: number;
    output: number;
    totalInput: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  estimatedCostUsd: number | null;
  agentCalls: number;
  journalCacheHits: number;
  journalCacheHitRatio: number | null;
  promptCacheRatio: number | null;
}

export interface EvalRecord {
  version: 1;
  evalId: string;
  createdAt: string;
  scriptPath?: string;
  workflowName?: string;
  casesPath?: string;
  graderPath?: string;
  model: string;
  runner: string;
  fromEvalId?: string;
  fromNode?: string;
  summary: EvalSummary;
  cases: EvalCaseResult[];
}

export interface RunEvalOptions {
  /** Workflow script source or path (exactly one). */
  script?: string;
  scriptPath?: string;
  /** Cases loaded in memory, or a path to a `.json` / `.jsonl` file. */
  cases?: EvalCase[];
  casesPath?: string;
  /** Custom grader function or path to an ESM `.js`/`.mjs` file default-exporting an EvalGraderFn. */
  grader?: EvalGraderFn;
  graderPath?: string;
  /** Optional stable eval run ID (e.g. `v1`, `v2`). Default: generated `eval-YYYYMMDD-HHMMSS-<hex>`. */
  evalId?: string;
  /** Seed each matching case from an earlier eval run's case runId (time-travel replay across the suite). */
  fromEvalId?: string;
  /** Optional `--from <node>` passed through when `fromEvalId` is set. */
  fromNode?: string;
  /** Filter to specific case IDs. */
  only?: string[];
  /** Cap how many cases to run. */
  limit?: number;
  /** Number of cases to execute in parallel (default 1). */
  caseConcurrency?: number;
  /** Per-case agent concurrency passed to `run()`. */
  concurrency?: number;
  /** Per-case output-token budget passed to `run()`. */
  budget?: number | null;
  runner?: AgentRunner;
  model?: string;
  cwd?: string;
  stateDir?: string;
  toolsDir?: string;
  /** Custom pricing overrides keyed by model ID. */
  prices?: Record<string, ModelPrice>;
  /** Optional progress callback invoked as each case settles. */
  onCaseComplete?: (result: EvalCaseResult, index: number, total: number) => void;
}

export interface CaseStatusDiff {
  id: string;
  beforeStatus: 'pass' | 'fail' | 'error' | 'missing';
  afterStatus: 'pass' | 'fail' | 'error' | 'missing';
  beforeReason?: string;
  afterReason?: string;
  beforeRunId?: string;
  afterRunId?: string;
}

export interface EvalDiffReport {
  kind: 'eval' | 'run';
  runA: string;
  runB: string;
  score: {
    passedA: number;
    totalA: number;
    passRateA: number;
    passedB: number;
    totalB: number;
    passRateB: number;
    passedDelta: number;
    passRateDelta: number;
  };
  cases: {
    changed: CaseStatusDiff[];
    fixed: CaseStatusDiff[];
    regressions: CaseStatusDiff[];
    stillFailing: CaseStatusDiff[];
    stillPassing: number;
    added: CaseStatusDiff[];
    removed: CaseStatusDiff[];
  };
  tokens: {
    inputA: number;
    inputB: number;
    inputDelta: number;
    outputA: number;
    outputB: number;
    outputDelta: number;
    totalA: number;
    totalB: number;
    totalDelta: number;
    totalDeltaPct: number | null;
  };
  costUsd: {
    costA: number | null;
    costB: number | null;
    delta: number | null;
  };
  cache: {
    journalHitsA: number;
    agentCallsA: number;
    journalHitRatioA: number | null;
    journalHitsB: number;
    agentCallsB: number;
    journalHitRatioB: number | null;
    promptCacheRatioA: number | null;
    promptCacheRatioB: number | null;
  };
  durationMs: {
    a: number;
    b: number;
    delta: number;
  };
}

function generateEvalId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `eval-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(3).toString('hex')}`
  );
}

/** Loads eval cases from a `.json` (array or `{ cases: [...] }`) or `.jsonl` file. */
export async function loadEvalCases(casesPath: string): Promise<EvalCase[]> {
  const raw = (await readFile(casesPath, 'utf8')).trim();
  if (!raw) return [];
  let items: unknown[];
  if (casesPath.endsWith('.jsonl') || (!raw.startsWith('[') && !raw.startsWith('{'))) {
    items = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw new Error(`invalid JSONL on line ${i + 1} of ${casesPath}: ${errorText(err)}`);
        }
      });
  } else {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cases?: unknown }).cases)) {
      items = (parsed as { cases: unknown[] }).cases;
    } else {
      throw new Error(`${casesPath} must contain a JSON array of cases or { "cases": [...] }`);
    }
  }

  const seen = new Set<string>();
  return items.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`eval case #${idx + 1} in ${casesPath} must be an object`);
    }
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' && rec.id.trim() !== '' ? rec.id.trim() : `case-${idx + 1}`;
    if (seen.has(id)) throw new Error(`duplicate eval case id "${id}" in ${casesPath}`);
    seen.add(id);
    return {
      id,
      ...(rec.args !== undefined ? { args: rec.args } : {}),
      ...(rec.expect !== undefined ? { expect: rec.expect as EvalExpectation } : {}),
      ...(rec.expected !== undefined ? { expected: rec.expected } : {}),
      ...(Array.isArray(rec.tags) ? { tags: rec.tags.map(String) } : {}),
      ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
    };
  });
}

/** Dynamically imports a custom grader module (`export default function grade(ctx) { ... }`). */
export async function loadEvalGrader(graderPath: string): Promise<EvalGraderFn> {
  const abs = path.resolve(graderPath);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown; grade?: unknown };
  const fn = typeof mod.default === 'function' ? mod.default : mod.grade;
  if (typeof fn !== 'function') {
    throw new Error(`grader ${graderPath} must default-export a function (or export \`grade\`)`);
  }
  return fn as EvalGraderFn;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.hasOwn(b as object, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function matchesSubset(actual: unknown, pattern: unknown): boolean {
  if (Object.is(actual, pattern)) return true;
  if (pattern === null || typeof pattern !== 'object') return false;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual) || actual.length < pattern.length) return false;
    return pattern.every((p, i) => matchesSubset(actual[i], p));
  }
  if (Array.isArray(actual)) return false;
  for (const [k, v] of Object.entries(pattern as Record<string, unknown>)) {
    if (!Object.hasOwn(actual as object, k)) return false;
    if (!matchesSubset((actual as Record<string, unknown>)[k], v)) return false;
  }
  return true;
}

function outputAsText(output: unknown): string {
  if (typeof output === 'string') return output;
  return JSON.stringify(output) ?? 'null';
}

/** Evaluates built-in declarative expectations against a case's output. */
export function evaluateExpectation(expect: EvalExpectation, output: unknown): EvalGradeResult {
  const failures: string[] = [];
  if ('equals' in expect && !deepEqual(output, expect.equals)) {
    failures.push(`expected ${JSON.stringify(expect.equals)}, got ${JSON.stringify(output)}`);
  }
  if ('match' in expect && !matchesSubset(output, expect.match)) {
    failures.push(`output did not match subset ${JSON.stringify(expect.match)}`);
  }
  const text = outputAsText(output);
  if (expect.contains !== undefined) {
    const needles = Array.isArray(expect.contains) ? expect.contains : [expect.contains];
    for (const needle of needles) {
      if (!text.includes(needle)) failures.push(`missing expected substring ${JSON.stringify(needle)}`);
    }
  }
  if (expect.notContains !== undefined) {
    const needles = Array.isArray(expect.notContains) ? expect.notContains : [expect.notContains];
    for (const needle of needles) {
      if (text.includes(needle)) failures.push(`found forbidden substring ${JSON.stringify(needle)}`);
    }
  }
  if (expect.regex !== undefined) {
    const re = new RegExp(expect.regex);
    if (!re.test(text)) failures.push(`output did not match /${expect.regex}/`);
  }
  if (failures.length === 0) return { pass: true, score: 1 };
  return { pass: false, score: 0, reason: failures.join('; ') };
}

/**
 * Estimates USD cost from token usage, returning null for an unpriced model.
 * Eval calls it per live call with the model the runner reported sending (`RunResult.model`, recorded
 * on the call's `agent_end` event), so a runner-level override or a custom route is priced as what ran.
 * A call recorded with a null model, which its runner could not name, makes the estimate null. A call
 * with no recorded model at all is priced from the requested model through default routing.
 */
export function estimateCostUsd(
  usage: Usage,
  model: string,
  prices: Record<string, ModelPrice> = MODEL_PRICES,
): number | null {
  const cost = usageCost(usage, model, prices);
  return cost === null ? null : Math.round(cost * 10_000) / 10_000;
}

// Keep full precision when accumulating small calls across models and cases.
function usageCost(usage: Usage, model: string, prices: Record<string, ModelPrice>): number | null {
  const normalized = model.trim().replace(/^(?:anthropic|google|openai)\//i, '');
  const key = Object.hasOwn(prices, model) ? model : normalized;
  const table = Object.hasOwn(prices, key) ? prices : MODEL_PRICES;
  const price = Object.hasOwn(table, key) ? table[key] : undefined;
  if (!price) return null;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  return (
    (usage.input_tokens * price.input +
      (usage.cache_creation_input_tokens ?? 0) * cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * cacheRead +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

/**
 * A guess at the model a call ran on, from the requested model and the run's runner class. Only for a
 * call whose `agent_end` has no model field: an event log written before runners reported theirs, or a
 * runner that reports nothing. It cannot see a runner-level override or a custom route.
 */
function effectiveModel(runner: string | undefined, model: string | undefined): string | undefined {
  const route = runner === 'RoutingRunner' && model ? defaultModelRoute(model) : undefined;
  if (runner === 'GeminiRunner' || route === 'gemini') return resolveGeminiModel(model ?? '');
  if ((runner === 'CodexRunner' || route === 'codex') && model?.startsWith('claude-')) return undefined;
  return model;
}

async function collectRunMetrics(runDir: string, prices: Record<string, ModelPrice>) {
  const [rows, { lines: events }] = await Promise.all([
    readEntries(runDir).catch(() => [] as Entry[]),
    readEventLines(runDir),
  ]);
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  const latestByKey = new Map<string, Entry>();
  for (const r of rows) {
    if (r.cachedFrom === undefined) addUsage(usage, r.usage);
    latestByKey.set(r.key, r);
  }

  let lastStartIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'run_start') {
      lastStartIdx = i;
      break;
    }
  }
  const invokedKeys = new Set<string>();
  const promptModels = new Map<number, string>();
  let defaultModel: string | undefined;
  let runner: string | undefined;
  let estimatedCostUsd: number | null = 0;
  let agentCalls = 0;
  let journalCacheHits = 0;
  const liveUsage: Usage = lastStartIdx < 0 ? usage : { input_tokens: 0, output_tokens: 0 };
  let workflowName: string | undefined;
  let runStartTime: number | undefined;
  let runEndTime: number | undefined;

  for (let i = Math.max(0, lastStartIdx); i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === 'run_start') {
      defaultModel = ev.model;
      runner = ev.runner;
      workflowName = ev.name;
      runStartTime = ev.t;
    } else if (ev.type === 'run_end') {
      runEndTime = ev.t;
    } else if (ev.type === 'agent_start') {
      invokedKeys.add(ev.key);
    } else if (ev.type === 'agent_prompt' && ev.model !== undefined) {
      promptModels.set(ev.id, ev.model);
    } else if (ev.type === 'agent_end' && lastStartIdx >= 0) {
      agentCalls++;
      if (ev.cached) journalCacheHits++;
      else {
        addUsage(liveUsage, ev.usage);
        if (estimatedCostUsd !== null && (totalInput(ev.usage) > 0 || ev.usage.output_tokens > 0)) {
          // A null model is the runner's own word that it ran on a model it cannot name: no guess then.
          const model =
            ev.model === null
              ? undefined
              : ev.model || effectiveModel(runner, promptModels.get(ev.id) ?? defaultModel);
          const cost = model ? usageCost(ev.usage, model, prices) : null;
          estimatedCostUsd = cost === null ? null : estimatedCostUsd + cost;
        }
      }
    }
  }

  if (lastStartIdx < 0) {
    agentCalls = rows.length;
    journalCacheHits = rows.filter((r) => r.cachedFrom !== undefined).length;
    estimatedCostUsd = totalInput(usage) > 0 || usage.output_tokens > 0 ? null : 0;
  }
  const failedAgents = [...latestByKey.values()].filter(
    (r) => r.status !== 'ok' && (lastStartIdx < 0 || invokedKeys.has(r.key)),
  ).length;
  return {
    estimatedCostUsd,
    usage,
    liveUsage,
    failedAgents,
    agentCalls,
    journalCacheHits,
    promptCacheRatio: cacheReadRatio(liveUsage) ?? cacheReadRatio(usage),
    workflowName,
    durationMs:
      runStartTime !== undefined && runEndTime !== undefined ? Math.max(0, runEndTime - runStartTime) : 0,
  };
}

function roundCost(cost: number | null): number | null {
  return cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000;
}

function roundedCaseResult(result: EvalCaseResult): EvalCaseResult {
  return { ...result, estimatedCostUsd: roundCost(result.estimatedCostUsd) };
}

function summarizeCases(cases: EvalCaseResult[], totalDurationMs: number): EvalSummary {
  const total = cases.length;
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let scoreSum = 0;
  let agentCalls = 0;
  let journalCacheHits = 0;
  const liveUsage: Usage = { input_tokens: 0, output_tokens: 0 };

  let estimatedCostUsd: number | null = 0;
  for (const c of cases) {
    if (c.estimatedCostUsd === null) estimatedCostUsd = null;
    else if (estimatedCostUsd !== null) estimatedCostUsd += c.estimatedCostUsd;
    if (c.status === 'pass') passed++;
    else if (c.status === 'fail') failed++;
    else errored++;
    scoreSum += c.score;
    agentCalls += c.agentCalls;
    journalCacheHits += c.journalCacheHits;
    addUsage(liveUsage, c.liveUsage);
  }

  const totalIn = totalInput(liveUsage);
  return {
    total,
    passed,
    failed,
    errored,
    passRate: total === 0 ? 0 : passed / total,
    scoreAvg: total === 0 ? 0 : scoreSum / total,
    durationMs: totalDurationMs,
    tokens: {
      input: liveUsage.input_tokens,
      output: liveUsage.output_tokens,
      totalInput: totalIn,
      cacheRead: liveUsage.cache_read_input_tokens ?? 0,
      cacheWrite: liveUsage.cache_creation_input_tokens ?? 0,
      total: totalIn + liveUsage.output_tokens,
    },
    estimatedCostUsd: roundCost(estimatedCostUsd),
    agentCalls,
    journalCacheHits,
    journalCacheHitRatio: agentCalls === 0 ? null : journalCacheHits / agentCalls,
    promptCacheRatio: cacheReadRatio(liveUsage),
  };
}

export function evalsDirFor(stateDir: string): string {
  return path.join(stateDir, 'evals');
}

export async function readEvalRecord(stateDir: string, evalIdOrPath: string): Promise<EvalRecord> {
  const direct = existsSync(evalIdOrPath) ? evalIdOrPath : undefined;
  const candidate = direct
    ? direct.endsWith('.json')
      ? direct
      : path.join(direct, 'eval.json')
    : path.join(evalsDirFor(stateDir), evalIdOrPath, 'eval.json');
  const parsed = JSON.parse(await readFile(candidate, 'utf8')) as EvalRecord;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cases)) {
    throw new Error(`invalid eval record at ${candidate}`);
  }
  return parsed;
}

export async function listEvalRecords(stateDir: string, limit?: number): Promise<EvalRecord[]> {
  const dir = evalsDirFor(stateDir);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const records: EvalRecord[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_ID.test(e.name)) continue;
    try {
      records.push(await readEvalRecord(stateDir, e.name));
    } catch {
      // Skip incomplete or malformed eval folders.
    }
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.evalId.localeCompare(a.evalId));
  return limit !== undefined ? records.slice(0, limit) : records;
}

/** Runs a workflow across an eval dataset, grades every case, and persists `<stateDir>/evals/<evalId>/eval.json`. */
export async function runEval(opts: RunEvalOptions): Promise<EvalRecord> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const stateDir = path.resolve(cwd, opts.stateDir ?? '.maestro');
  const evalId = opts.evalId ?? generateEvalId();
  if (!SAFE_ID.test(evalId)) throw new Error(`invalid evalId "${evalId}"`);
  if ((opts.script === undefined) === (opts.scriptPath === undefined)) {
    throw new Error('runEval requires exactly one of script or scriptPath');
  }
  if ((opts.cases === undefined) === (opts.casesPath === undefined)) {
    throw new Error('runEval requires exactly one of cases or casesPath');
  }

  let cases = opts.cases ?? (await loadEvalCases(path.resolve(cwd, opts.casesPath!)));
  if (opts.only && opts.only.length > 0) {
    const wanted = new Set(opts.only);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  if (opts.limit !== undefined) cases = cases.slice(0, opts.limit);
  if (cases.length === 0) throw new Error('no eval cases selected');

  const grader =
    opts.grader ?? (opts.graderPath ? await loadEvalGrader(path.resolve(cwd, opts.graderPath)) : undefined);
  const prices = opts.prices ?? MODEL_PRICES;
  const model = opts.model ?? DEFAULT_MODEL;
  const runnerName = opts.runner ? opts.runner.constructor.name : 'AnthropicRunner';

  // Optional previous eval run for per-case time-travel cache seeding.
  const sourceCaseRunIds = new Map<string, string>();
  if (opts.fromEvalId) {
    const prev = await readEvalRecord(stateDir, opts.fromEvalId);
    for (const c of prev.cases) sourceCaseRunIds.set(c.id, c.runId);
  }

  const caseConcurrency = Math.max(1, opts.caseConcurrency ?? 1);
  const results = new Array<EvalCaseResult>(cases.length);
  const startedAt = Date.now();
  let workflowName: string | undefined;
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < cases.length) {
      const i = nextIdx++;
      const c = cases[i]!;
      const args = c.args ?? null;
      const argsHash = createHash('sha256').update(canonicalJSON({ args })).digest('hex');
      const expectationHash = createHash('sha256')
        .update(canonicalJSON({ expect: c.expect, expected: c.expected }))
        .digest('hex');
      const caseStart = Date.now();
      const sourceRunId = sourceCaseRunIds.get(c.id);
      const handle = run({
        ...(opts.script !== undefined ? { script: opts.script } : {}),
        ...(opts.scriptPath !== undefined ? { scriptPath: path.resolve(cwd, opts.scriptPath) } : {}),
        args,
        ...(sourceRunId !== undefined
          ? {
              replayFrom: {
                runId: sourceRunId,
                ...(opts.fromNode !== undefined ? { from: opts.fromNode } : {}),
              },
            }
          : {}),
        ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
        ...(opts.toolsDir !== undefined ? { toolsDir: opts.toolsDir } : {}),
        cwd,
        stateDir,
      });

      let ok = false;
      let output: unknown = null;
      let runError: string | undefined;
      try {
        output = await handle.promise;
        ok = true;
      } catch (err) {
        runError = errorText(err);
      }
      const durationMs = Date.now() - caseStart;
      const metrics = await collectRunMetrics(handle.runDir, prices);
      workflowName ??= metrics.workflowName;

      let grade: EvalGradeResult;
      let isErrorStatus = false;
      if (grader) {
        try {
          const rawGrade = await grader({
            case: c,
            output,
            ok,
            ...(runError !== undefined ? { error: runError } : {}),
            runId: handle.runId,
            runDir: handle.runDir,
          });
          grade =
            typeof rawGrade === 'boolean'
              ? { pass: rawGrade, score: rawGrade ? 1 : 0 }
              : {
                  pass: Boolean(rawGrade.pass),
                  score: typeof rawGrade.score === 'number' ? rawGrade.score : rawGrade.pass ? 1 : 0,
                  ...(rawGrade.reason !== undefined ? { reason: rawGrade.reason } : {}),
                };
        } catch (err) {
          grade = { pass: false, score: 0, reason: `grader error: ${errorText(err)}` };
          isErrorStatus = true;
        }
      } else if (!ok) {
        grade = { pass: false, score: 0, reason: runError ?? 'workflow failed' };
        isErrorStatus = true;
      } else if (c.expect !== undefined) {
        grade = evaluateExpectation(c.expect, output);
      } else if (c.expected !== undefined) {
        grade = evaluateExpectation({ equals: c.expected }, output);
      } else {
        const pass = output !== null && output !== undefined;
        grade = {
          pass,
          score: pass ? 1 : 0,
          ...(pass ? {} : { reason: 'workflow returned null/undefined' }),
        };
      }

      const status: 'pass' | 'fail' | 'error' = isErrorStatus ? 'error' : grade.pass ? 'pass' : 'fail';
      const caseResult: EvalCaseResult = {
        id: c.id,
        argsHash,
        expectationHash,
        runId: handle.runId,
        status,
        pass: status === 'pass',
        score: grade.score ?? (status === 'pass' ? 1 : 0),
        ...(grade.reason !== undefined ? { reason: grade.reason } : {}),
        durationMs,
        degraded: ok && metrics.failedAgents > 0,
        failedAgents: metrics.failedAgents,
        usage: metrics.usage,
        liveUsage: metrics.liveUsage,
        estimatedCostUsd: metrics.estimatedCostUsd,
        agentCalls: metrics.agentCalls,
        journalCacheHits: metrics.journalCacheHits,
        promptCacheRatio: metrics.promptCacheRatio,
      };
      results[i] = caseResult;
      opts.onCaseComplete?.(roundedCaseResult(caseResult), i, cases.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(caseConcurrency, cases.length) }, () => worker()));
  const totalDurationMs = Date.now() - startedAt;

  const record: EvalRecord = {
    version: 1,
    evalId,
    createdAt: new Date().toISOString(),
    ...(opts.scriptPath !== undefined ? { scriptPath: path.resolve(cwd, opts.scriptPath) } : {}),
    ...(workflowName !== undefined ? { workflowName } : {}),
    ...(opts.casesPath !== undefined ? { casesPath: path.resolve(cwd, opts.casesPath) } : {}),
    ...(opts.graderPath !== undefined ? { graderPath: path.resolve(cwd, opts.graderPath) } : {}),
    model: effectiveModel(runnerName, model) ?? '(runner default)',
    runner: runnerName,
    ...(opts.fromEvalId !== undefined ? { fromEvalId: opts.fromEvalId } : {}),
    ...(opts.fromNode !== undefined ? { fromNode: opts.fromNode } : {}),
    summary: summarizeCases(results, totalDurationMs),
    cases: results.map(roundedCaseResult),
  };

  const evalDir = path.join(evalsDirFor(stateDir), evalId);
  await mkdir(evalDir, { recursive: true });
  const finalPath = path.join(evalDir, 'eval.json');
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`);
  await rename(tmpPath, finalPath).catch(async (err) => {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  });

  return record;
}

/** Wraps an individual workflow run on disk as a 1-case `EvalRecord` so `eval diff` can compare single runs too. */
async function workflowRunAsEvalRecord(
  stateDir: string,
  runId: string,
  prices: Record<string, ModelPrice>,
): Promise<EvalRecord> {
  const runDir = path.join(stateDir, 'runs', runId);
  if (!existsSync(runDir)) throw new Error(`no eval or workflow run "${runId}" found under ${stateDir}`);
  const [outcome, metrics, runMeta] = await Promise.all([
    readOutcome(runDir),
    collectRunMetrics(runDir, prices),
    readFile(path.join(runDir, 'run.json'), 'utf8')
      .then((s) => JSON.parse(s) as { model?: string; runner?: string })
      .catch(() => ({ model: undefined, runner: undefined })),
  ]);
  const model = runMeta.model ?? DEFAULT_MODEL;
  const runner = runMeta.runner ?? 'UnknownRunner';
  const pass = outcome?.ok === true && metrics.failedAgents === 0;
  const status: 'pass' | 'fail' | 'error' = outcome?.ok === false ? 'error' : pass ? 'pass' : 'fail';
  const reason =
    outcome?.ok === false
      ? outcome.error
      : metrics.failedAgents > 0
        ? `${metrics.failedAgents} agent(s) failed`
        : undefined;
  const caseRes: EvalCaseResult = {
    id: metrics.workflowName ?? 'run',
    runId,
    status,
    pass,
    score: pass ? 1 : 0,
    ...(reason !== undefined ? { reason } : {}),
    durationMs: metrics.durationMs,
    degraded: outcome?.ok === true && metrics.failedAgents > 0,
    failedAgents: metrics.failedAgents,
    usage: metrics.usage,
    liveUsage: metrics.liveUsage,
    estimatedCostUsd: metrics.estimatedCostUsd,
    agentCalls: metrics.agentCalls,
    journalCacheHits: metrics.journalCacheHits,
    promptCacheRatio: metrics.promptCacheRatio,
  };
  return {
    version: 1,
    evalId: runId,
    createdAt: '',
    model,
    runner,
    summary: summarizeCases([caseRes], metrics.durationMs),
    cases: [roundedCaseResult(caseRes)],
  };
}

/** Computes a structured diff between two `EvalRecord`s. */
export function diffEvalRecords(a: EvalRecord, b: EvalRecord, kind: 'eval' | 'run' = 'eval'): EvalDiffReport {
  const mapA = new Map(a.cases.map((c) => [c.id, c]));
  const mapB = new Map(b.cases.map((c) => [c.id, c]));
  const allIds = [...new Set([...a.cases.map((c) => c.id), ...b.cases.map((c) => c.id)])];

  const changed: CaseStatusDiff[] = [];
  const fixed: CaseStatusDiff[] = [];
  const regressions: CaseStatusDiff[] = [];
  const stillFailing: CaseStatusDiff[] = [];
  const added: CaseStatusDiff[] = [];
  const removed: CaseStatusDiff[] = [];
  let stillPassing = 0;

  for (const id of allIds) {
    const ca = mapA.get(id);
    const cb = mapB.get(id);
    if (!ca && cb) {
      added.push({
        id,
        beforeStatus: 'missing',
        afterStatus: cb.status,
        ...(cb.reason !== undefined ? { afterReason: cb.reason } : {}),
        afterRunId: cb.runId,
      });
      continue;
    }
    if (ca && !cb) {
      removed.push({
        id,
        beforeStatus: ca.status,
        afterStatus: 'missing',
        ...(ca.reason !== undefined ? { beforeReason: ca.reason } : {}),
        beforeRunId: ca.runId,
      });
      continue;
    }
    if (!ca || !cb) continue;
    const item: CaseStatusDiff = {
      id,
      beforeStatus: ca.status,
      afterStatus: cb.status,
      ...(ca.reason !== undefined ? { beforeReason: ca.reason } : {}),
      ...(cb.reason !== undefined ? { afterReason: cb.reason } : {}),
      beforeRunId: ca.runId,
      afterRunId: cb.runId,
    };
    if (
      ca.argsHash &&
      cb.argsHash &&
      ca.expectationHash &&
      cb.expectationHash &&
      (ca.argsHash !== cb.argsHash || ca.expectationHash !== cb.expectationHash)
    ) {
      changed.push(item);
    } else if (!ca.pass && cb.pass) fixed.push(item);
    else if (ca.pass && !cb.pass) regressions.push(item);
    else if (!ca.pass && !cb.pass) stillFailing.push(item);
    else stillPassing++;
  }

  const inputA = a.summary.tokens.totalInput;
  const inputB = b.summary.tokens.totalInput;
  const outputA = a.summary.tokens.output;
  const outputB = b.summary.tokens.output;
  const totalA = a.summary.tokens.total;
  const totalB = b.summary.tokens.total;
  const costA = a.summary.estimatedCostUsd;
  const costB = b.summary.estimatedCostUsd;

  return {
    kind,
    runA: a.evalId,
    runB: b.evalId,
    score: {
      passedA: a.summary.passed,
      totalA: a.summary.total,
      passRateA: a.summary.passRate,
      passedB: b.summary.passed,
      totalB: b.summary.total,
      passRateB: b.summary.passRate,
      passedDelta: b.summary.passed - a.summary.passed,
      passRateDelta: b.summary.passRate - a.summary.passRate,
    },
    cases: { changed, fixed, regressions, stillFailing, stillPassing, added, removed },
    tokens: {
      inputA,
      inputB,
      inputDelta: inputB - inputA,
      outputA,
      outputB,
      outputDelta: outputB - outputA,
      totalA,
      totalB,
      totalDelta: totalB - totalA,
      totalDeltaPct: totalA === 0 ? null : (totalB - totalA) / totalA,
    },
    costUsd: {
      costA,
      costB,
      delta: costA !== null && costB !== null ? Math.round((costB - costA) * 10_000) / 10_000 : null,
    },
    cache: {
      journalHitsA: a.summary.journalCacheHits,
      agentCallsA: a.summary.agentCalls,
      journalHitRatioA: a.summary.journalCacheHitRatio,
      journalHitsB: b.summary.journalCacheHits,
      agentCallsB: b.summary.agentCalls,
      journalHitRatioB: b.summary.journalCacheHitRatio,
      promptCacheRatioA: a.summary.promptCacheRatio,
      promptCacheRatioB: b.summary.promptCacheRatio,
    },
    durationMs: {
      a: a.summary.durationMs,
      b: b.summary.durationMs,
      delta: b.summary.durationMs - a.summary.durationMs,
    },
  };
}

/** Loads two eval runs (or two workflow runs as fallback) from `stateDir` and diffs them. */
export async function diffEvalRuns(
  stateDir: string,
  runA: string,
  runB: string,
  prices: Record<string, ModelPrice> = MODEL_PRICES,
): Promise<EvalDiffReport> {
  const isEvalA = existsSync(runA) || existsSync(path.join(evalsDirFor(stateDir), runA, 'eval.json'));
  const isEvalB = existsSync(runB) || existsSync(path.join(evalsDirFor(stateDir), runB, 'eval.json'));
  if (isEvalA && isEvalB) {
    const [a, b] = await Promise.all([readEvalRecord(stateDir, runA), readEvalRecord(stateDir, runB)]);
    return diffEvalRecords(a, b, 'eval');
  }
  const [a, b] = await Promise.all([
    isEvalA ? readEvalRecord(stateDir, runA) : workflowRunAsEvalRecord(stateDir, runA, prices),
    isEvalB ? readEvalRecord(stateDir, runB) : workflowRunAsEvalRecord(stateDir, runB, prices),
  ]);
  return diffEvalRecords(a, b, isEvalA || isEvalB ? 'eval' : 'run');
}

function fmtSigned(n: number): string {
  return n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
}

function fmtPct(ratio: number | null): string {
  return ratio === null ? 'n/a' : `${Math.round(ratio * 1000) / 10}%`;
}

function fmtUsd(v: number | null): string {
  return v === null ? 'n/a' : `$${v.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** Formats an `EvalRecord` summary as concise Markdown/text. */
export function formatEvalSummary(record: EvalRecord): string {
  const s = record.summary;
  const n = (v: number) => v.toLocaleString('en-US');
  const lines: string[] = [
    `# Eval ${record.evalId}${record.workflowName ? ` (${record.workflowName})` : ''}`,
    `- score: ${s.passed}/${s.total} (${fmtPct(s.passRate)}) · ${s.failed} failed, ${s.errored} errored`,
    `- model: \`${record.model}\` · runner: \`${record.runner}\` · duration: ${fmtMs(s.durationMs)}`,
    `- tokens: ${n(s.tokens.totalInput)} in, ${n(s.tokens.output)} out (${n(s.tokens.total)} total)` +
      (s.estimatedCostUsd !== null ? ` · est. cost: ${fmtUsd(s.estimatedCostUsd)}` : ''),
    `- [CACHE HIT] ratio: ${s.journalCacheHits}/${s.agentCalls} (${fmtPct(s.journalCacheHitRatio)})` +
      (s.promptCacheRatio !== null ? ` · prompt cache: ${fmtPct(s.promptCacheRatio)}` : ''),
  ];
  if (record.fromEvalId) {
    lines.push(
      `- replayed from: \`${record.fromEvalId}\`${record.fromNode ? ` (--from ${record.fromNode})` : ''}`,
    );
  }
  lines.push('', '## Cases');
  for (const c of record.cases) {
    const icon = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '!';
    const cacheTag = c.journalCacheHits > 0 ? ` [${c.journalCacheHits}/${c.agentCalls} CACHE HIT]` : '';
    const reason = c.reason ? ` — ${c.reason}` : '';
    lines.push(
      `- ${icon} \`${c.id}\` [${c.status}] (run \`${c.runId}\`, ${fmtMs(c.durationMs)})${cacheTag}${reason}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function failureDetails(c: CaseStatusDiff): string {
  const reason = c.afterReason ? ` (${c.afterReason})` : '';
  const hint = c.afterRunId ? ` · inspect: \`maestro inspect ${c.afterRunId} --compact\`` : '';
  return reason + hint;
}

/** Formats an `EvalDiffReport` side-by-side summary as crisp Markdown. */
export function formatEvalDiff(diff: EvalDiffReport): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const ppDelta = Math.round(diff.score.passRateDelta * 1000) / 10;
  const ppStr = ppDelta > 0 ? `+${ppDelta}pp` : `${ppDelta}pp`;
  const lines: string[] = [
    `# Eval Diff: \`${diff.runA}\` → \`${diff.runB}\``,
    '',
    '| Metric | Before | After | Delta |',
    '|---|---:|---:|---:|',
    `| Score | ${diff.score.passedA}/${diff.score.totalA} (${fmtPct(diff.score.passRateA)}) | ${diff.score.passedB}/${diff.score.totalB} (${fmtPct(diff.score.passRateB)}) | ${fmtSigned(diff.score.passedDelta)} (${ppStr}) |`,
    `| Tokens (in / out) | ${n(diff.tokens.inputA)} / ${n(diff.tokens.outputA)} | ${n(diff.tokens.inputB)} / ${n(diff.tokens.outputB)} | ${fmtSigned(diff.tokens.totalDelta)} total${diff.tokens.totalDeltaPct !== null ? ` (${diff.tokens.totalDeltaPct > 0 ? '+' : ''}${Math.round(diff.tokens.totalDeltaPct * 100)}%)` : ''} |`,
    `| Est. Cost | ${fmtUsd(diff.costUsd.costA)} | ${fmtUsd(diff.costUsd.costB)} | ${diff.costUsd.delta === null ? 'n/a' : `${diff.costUsd.delta > 0 ? '+' : ''}$${diff.costUsd.delta.toFixed(4)}`} |`,
    `| [CACHE HIT] Ratio | ${diff.cache.journalHitsA}/${diff.cache.agentCallsA} (${fmtPct(diff.cache.journalHitRatioA)}) | ${diff.cache.journalHitsB}/${diff.cache.agentCallsB} (${fmtPct(diff.cache.journalHitRatioB)}) | prompt cache: ${fmtPct(diff.cache.promptCacheRatioA)} → ${fmtPct(diff.cache.promptCacheRatioB)} |`,
    `| Duration | ${fmtMs(diff.durationMs.a)} | ${fmtMs(diff.durationMs.b)} | ${diff.durationMs.delta >= 0 ? '+' : '-'}${fmtMs(Math.abs(diff.durationMs.delta))} |`,
  ];

  lines.push(
    '',
    `## Case Status Changes (${diff.cases.fixed.length} fixed, ${diff.cases.regressions.length} regressions, ${diff.cases.changed.length} changed, ${diff.cases.stillFailing.length} still failing, ${diff.cases.stillPassing} unchanged passing)`,
  );
  if (diff.cases.changed.length > 0) {
    lines.push('', `### Changed Cases (${diff.cases.changed.length})`);
    for (const c of diff.cases.changed) {
      lines.push(
        `- \`${c.id}\`: ${c.beforeStatus} → ${c.afterStatus}${c.afterStatus === 'pass' ? '' : failureDetails(c)}`,
      );
    }
  }
  if (diff.cases.fixed.length > 0) {
    lines.push('', `### Fixed (${diff.cases.fixed.length})`);
    for (const c of diff.cases.fixed) {
      lines.push(
        `- ✓ \`${c.id}\`: ${c.beforeStatus} → pass${c.beforeReason ? ` (was: ${c.beforeReason})` : ''}`,
      );
    }
  }
  if (diff.cases.regressions.length > 0) {
    lines.push('', `### Regressions (${diff.cases.regressions.length})`);
    for (const c of diff.cases.regressions) {
      lines.push(`- ✗ \`${c.id}\`: pass → ${c.afterStatus}${failureDetails(c)}`);
    }
  }
  if (diff.cases.stillFailing.length > 0) {
    lines.push('', `### Still Failing (${diff.cases.stillFailing.length})`);
    for (const c of diff.cases.stillFailing) {
      const inspectHint = c.afterRunId ? ` · run \`${c.afterRunId}\`` : '';
      lines.push(
        `- ! \`${c.id}\`: ${c.beforeStatus} → ${c.afterStatus}${c.afterReason ? ` (${c.afterReason})` : ''}${inspectHint}`,
      );
    }
  }
  if (diff.cases.added.length > 0) {
    lines.push('', `### Added Cases (${diff.cases.added.length})`);
    for (const c of diff.cases.added) lines.push(`- + \`${c.id}\` [${c.afterStatus}]`);
  }
  if (diff.cases.removed.length > 0) {
    lines.push('', `### Removed Cases (${diff.cases.removed.length})`);
    for (const c of diff.cases.removed) lines.push(`- - \`${c.id}\` [was ${c.beforeStatus}]`);
  }

  return `${lines.join('\n')}\n`;
}

function errorText(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(e);
}
