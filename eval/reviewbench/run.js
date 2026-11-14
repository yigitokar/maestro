// The review-changes A/B on ReviewBench (docs/eval.md 10): runs every PR × arm × repeat as one Maestro
// run in a checkout that ends at the PR's head, and writes each cell's findings in the benchmark's
// judging format.
//   npm run build && node eval/reviewbench/run.js --out eval/data/rb/<name> [--arms A,B,C] [--repeats 3]
//     [--set test|full] [--only <prKey,...>] [--limit n] [--model m] [--skeptic-effort high]
//     [--cell-budget 400k] [--max-dollars 50] [--concurrency n] [--seed n]
//     [--bench eval/data/reviewbench] [--repos eval/data/rb-repos] [--dry-run]
// Arms: A one agent, B examples/workflows/review-changes.js, C its three finders without skeptics.
// Cells finished in <out>/results.jsonl are skipped, so the same command continues a stopped run.
// --max-dollars stops starting new cells once the cells of this out directory have cost that much.
// --dry-run uses FakeRunner and temp dirs: no network, no git fetch, no money.
// Judge afterwards with eval/reviewbench/judge.js.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnthropicRunner, FakeRunner, parseBudgetDirective, run } from '../../dist/index.js';
import { cost, flagReader } from '../_launcher.js';
import { ARMS, armResult, cells, loadTasks, prKey, toJudgingInput } from './bench.ts';
import { prepareTask } from './prepare.ts';

const MODEL = 'claude-sonnet-5-5'; // docs/eval.md bölüm 9, karar 1
const argv = process.argv.slice(2);
const flag = flagReader(argv);
const dryRun = argv.includes('--dry-run');
const die = (message) => {
  console.error(`rb-run: ${message}`);
  process.exit(1);
};

const out = flag('--out');
if (!out) die('--out <dir> is required (one directory per experiment, e.g. eval/data/rb/pilot)');
const benchDir = path.resolve(flag('--bench') ?? 'eval/data/reviewbench');
if (!existsSync(path.join(benchDir, 'corpus'))) {
  die(
    `no ReviewBench checkout at ${benchDir}: git clone https://github.com/review-bench/ReviewBench ${benchDir}`,
  );
}
const arms = (flag('--arms') ?? 'A,B,C').split(',');
for (const a of arms) if (!ARMS[a]) die(`unknown arm "${a}" (A, B, C)`);
const number = (name, fallback) => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) die(`${name} needs a positive number, got "${raw}"`);
  return n;
};
const repeats = number('--repeats', 3);
const seed = number('--seed', 20261114);
const maxDollars = number('--max-dollars', 50);
const cellBudget = parseBudgetDirective(flag('--cell-budget') ?? '400k');
if (cellBudget === null) die(`invalid --cell-budget "${flag('--cell-budget')}" (e.g. 400k)`);
const model = flag('--model') ?? process.env.MAESTRO_MODEL ?? MODEL;
const skepticEffort = flag('--skeptic-effort') ?? 'high';
if (!dryRun && !process.env.ANTHROPIC_API_KEY)
  die('ANTHROPIC_API_KEY is not set. Export it, or use --dry-run.');

const set = flag('--set') ?? 'test';
if (set !== 'test' && set !== 'full') die(`--set is test or full, got "${set}"`);
let tasks = loadTasks(benchDir, set);
if (flag('--only')) {
  const keys = new Set(flag('--only').split(','));
  tasks = tasks.filter((t) => keys.has(prKey(t)));
}
if (flag('--limit')) tasks = tasks.slice(0, number('--limit', tasks.length));
if (tasks.length === 0) die('no pull requests selected');

const outDir = path.resolve(out);
const reposDir = path.resolve(flag('--repos') ?? 'eval/data/rb-repos');
const stateDir = path.join(outDir, 'state');
const resultsFile = path.join(outDir, 'results.jsonl');
mkdirSync(outDir, { recursive: true });
const done = new Map();
if (existsSync(resultsFile)) {
  for (const line of readFileSync(resultsFile, 'utf8').split('\n')) {
    if (line.trim()) {
      const row = JSON.parse(line);
      done.set(row.id, row); // the last row of a cell wins
    }
  }
}
let spent = [...done.values()].reduce((s, r) => s + (r.dollars ?? 0), 0);

// Dry run: one finding per finder, every skeptic confirms it, the synthesis passes them on.
const dryRules = [
  { match: 'ÇÜRÜTMEYE', respond: () => ({ result: { refuted: false, reason: 'dry run' } }) },
  {
    match: 'doğrulanmış bulguları',
    respond: (req) => {
      const confirmed = JSON.parse(req.prompt.slice(req.prompt.indexOf('\n') + 1));
      return {
        result: {
          findings: confirmed.map(({ file, line, claim, failure }) => ({ file, line, claim, failure })),
        },
      };
    },
  },
  {
    match: 'Diff:',
    respond: (req) => ({
      result: {
        findings: [
          { file: 'src/x.ts', line: 1 + (req.prompt.length % 7), claim: 'dry run', failure: 'dry run' },
        ],
      },
    }),
  },
];
const dryCwd = dryRun ? mkdtempSync(path.join(os.tmpdir(), 'maestro-rb-')) : undefined;

const plan = cells(tasks, arms, repeats, seed);
const todo = plan.filter((c) => done.get(c.id)?.status !== 'ok');
console.error(
  `rb-run: ${tasks.length} PRs × ${arms.join(',')} × ${repeats} = ${plan.length} cells, ${todo.length} to run, ` +
    `${model}${dryRun ? ' (dry run)' : ''}, $${spent.toFixed(2)} spent so far, limit $${maxDollars}`,
);

let failed = 0;
for (const [i, cell] of todo.entries()) {
  if (!dryRun && spent >= maxDollars) {
    console.error(
      `rb-run: stopping, $${spent.toFixed(2)} spent reached --max-dollars ${maxDollars}; ${todo.length - i} cells left`,
    );
    process.exitCode = 2;
    break;
  }
  const key = prKey(cell.task);
  const started = Date.now();
  const row = { id: cell.id, arm: cell.arm, repeat: cell.repeat, pr: key, model, status: 'failed' };
  let handle;
  try {
    const cwd = dryCwd ?? prepareTask(cell.task, path.join(reposDir, key));
    const resume = existsSync(path.join(stateDir, 'runs', cell.id));
    handle = run({
      script: readFileSync(ARMS[cell.arm].script, 'utf8'),
      args: { diffRef: `${cell.task.base}...${cell.task.head}`, skepticEffort },
      cwd,
      stateDir,
      model,
      budget: cellBudget,
      runner: dryRun ? new FakeRunner(dryRules) : new AnthropicRunner(),
      ...(flag('--concurrency') ? { concurrency: number('--concurrency', 1) } : {}),
      ...(resume ? { resumeFromRunId: cell.id } : { runId: cell.id }),
    });
    const { findings, failed: armFailed } = armResult(await handle.promise);
    const { tokens, dollars } = cost(handle.runDir, model);
    Object.assign(row, { tokens, dollars });
    if (armFailed) {
      row.error = 'the arm returned no review';
    } else {
      const usage = {
        prompt_tokens: tokens.input + tokens.cacheWrite + tokens.cacheRead,
        completion_tokens: tokens.output,
        cached_tokens: tokens.cacheRead,
        ...(dollars !== null ? { cost_usd: dollars } : {}),
      };
      const { input, dropped } = toJudgingInput(cell.task, `maestro-${cell.arm}`, findings, usage);
      const dir = path.join(outDir, 'findings', `${cell.arm}-r${cell.repeat}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${key}.json`), `${JSON.stringify(input, null, 2)}\n`);
      Object.assign(row, { status: 'ok', findings: input.findings.length, dropped });
    }
  } catch (err) {
    row.error = String(err?.message ?? err);
    if (handle && existsSync(path.join(handle.runDir, 'journal.jsonl'))) {
      Object.assign(row, cost(handle.runDir, model));
    }
  }
  row.ms = Date.now() - started;
  // A resumed cell's journal holds all its attempts: its cost replaces the earlier row's, not adds to it.
  spent += (row.dollars ?? 0) - (done.get(cell.id)?.dollars ?? 0);
  done.set(cell.id, row);
  appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
  if (row.status !== 'ok') failed++;
  console.error(
    `rb-run: [${i + 1}/${todo.length}] ${cell.id}: ${row.status}` +
      (row.status === 'ok' ? `, ${row.findings} findings` : `, ${row.error}`) +
      `, $${(row.dollars ?? 0).toFixed(2)} (total $${spent.toFixed(2)})`,
  );
}
if (failed) {
  console.error(`rb-run: ${failed} cells failed; run the same command again to retry them`);
  process.exitCode ||= 1;
}
