// Eval step 1b (docs/eval.md 2.2): triage the mined bug candidates with eval/workflows/triage.js.
//   npm run build && node eval/triage.js [--candidates eval/data/candidates.json] [--out eval/data/triage.json]
//     [--only id,id] [--limit n] [--effort medium] [--budget 1.5m] [--model m] [--concurrency n]
//     [--resume <runId>] [--dry-run]
// Agents run in a fresh copy of the source repo at the mined tip (eval/data/repos/<name>-tip), never in
// the user's checkout. Run state goes to eval/data/state. --dry-run uses FakeRunner and temp dirs.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnthropicRunner,
  attachTerminalProgress,
  FakeRunner,
  parseBudgetDirective,
  run,
} from '../dist/index.js';
import { materialize } from './materialize.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-sonnet-5-5'; // docs/eval.md bölüm 9
/** Sonnet 5.5, $ per million tokens (README "Maliyet ve effort"). */
const PRICE = { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 };

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const dryRun = argv.includes('--dry-run');
const data = JSON.parse(readFileSync(flag('--candidates') ?? 'eval/data/candidates.json', 'utf8'));
const out = flag('--out') ?? (dryRun ? 'eval/data/triage.dry.json' : 'eval/data/triage.json');
const model = flag('--model') ?? process.env.MAESTRO_MODEL ?? MODEL;
const effort = flag('--effort') ?? 'medium';

let candidates = data.bug;
if (flag('--only')) {
  const ids = new Set(flag('--only').split(','));
  candidates = candidates.filter((c) => ids.has(c.id));
}
if (flag('--limit')) candidates = candidates.slice(0, Number(flag('--limit')));
if (!candidates.length) {
  console.error('triage: no candidates selected');
  process.exit(1);
}
if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error('triage: ANTHROPIC_API_KEY is not set. Export it, or run with --dry-run (no network).');
  process.exit(1);
}

// Dry run: the first fix of every candidate is a confirmed bug, the rest are not.
const dryRules = [
  {
    match: 'etiketleme',
    respond: (req) => {
      const shas = [...req.prompt.matchAll(/^- ([0-9a-f]{40}) /gm)].map((m) => m[1]);
      return {
        turns: 3,
        result: {
          fixes: shas.map((sha, i) => ({
            sha,
            defect: i === 0,
            introducedHere: i === 0,
            visibleFromDiff: i === 0,
            reason: 'dry run',
            bugs: i === 0 ? [{ file: 'src/x.ts', line: 1, description: 'dry run', trigger: 'dry run' }] : [],
          })),
        },
      };
    },
  },
];

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));
const cwd = dryRun
  ? tmp('maestro-triage-')
  : materialize(data.repo, data.tip, path.resolve('eval/data/repos', `${path.basename(data.repo)}-tip`));
const stateDir = dryRun ? tmp('maestro-triage-state-') : path.resolve('eval/data/state');
const budget = parseBudgetDirective(flag('--budget') ?? '1.5m');
if (budget === null) {
  console.error(`triage: invalid --budget "${flag('--budget')}" (e.g. 500k, 1.5m, 20000)`);
  process.exit(1);
}
const resume = flag('--resume');
const handle = run({
  script: readFileSync(path.join(here, 'workflows', 'triage.js'), 'utf8'),
  args: { candidates, effort },
  cwd,
  stateDir,
  model,
  budget,
  runner: dryRun ? new FakeRunner(dryRules) : new AnthropicRunner(),
  ...(flag('--concurrency') ? { concurrency: Number(flag('--concurrency')) } : {}),
  ...(resume ? { resumeFromRunId: resume } : {}),
});
console.error(`triage: ${candidates.length} candidates, ${model}/${effort}, run ${handle.runId} in ${cwd}`);

/** Token totals over the run's journal rows, and dollars when the model is the priced one. */
function cost(runDir) {
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const line of readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    u.input += e.usage?.input_tokens ?? 0;
    u.cacheWrite += e.usage?.cache_creation_input_tokens ?? 0;
    u.cacheRead += e.usage?.cache_read_input_tokens ?? 0;
    u.output += e.usage?.output_tokens ?? 0;
  }
  const dollars = Object.entries(u).reduce((s, [k, n]) => s + (n * PRICE[k]) / 1e6, 0);
  return { tokens: u, dollars: model === MODEL ? Math.round(dollars * 100) / 100 : null };
}

const detach = attachTerminalProgress(handle, process.stderr);
try {
  const results = await handle.promise;
  const byId = new Map(results.map((r) => [r.id, r.triage]));
  const rows = candidates.map((c) => ({ ...c, triage: byId.get(c.id) ?? null }));
  const keep = (f) => f.defect && f.introducedHere && f.visibleFromDiff && f.bugs.length > 0;
  const accepted = rows.filter((r) => r.triage?.fixes.some(keep));
  const summary = {
    candidates: rows.length,
    null: rows.filter((r) => !r.triage).length,
    accepted: accepted.length,
    // Several fixes of one PR often report the same bug: count distinct file:line per candidate.
    bugs: accepted.reduce(
      (n, r) =>
        n +
        new Set(r.triage.fixes.filter(keep).flatMap((f) => f.bugs.map((b) => `${b.file}:${b.line}`))).size,
      0,
    ),
    ...cost(handle.runDir),
  };
  mkdirSync(path.dirname(out), { recursive: true });
  const report = {
    runId: handle.runId,
    model,
    effort,
    source: data.repo,
    tip: data.tip,
    summary,
    results: rows,
  };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`triage: ${JSON.stringify(summary)}`);
  console.error(`triage: wrote ${out}`);
} catch (err) {
  console.error(`triage: run failed: ${err?.message ?? err}`);
  console.error(`triage: continue with the same flags plus --resume ${handle.runId}`);
  process.exitCode = 1;
} finally {
  detach();
}
