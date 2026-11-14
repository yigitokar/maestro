// Eval step 2 without a human (docs/eval.md 2.3): verify the undecided candidates of eval/data/labels.json
// with eval/workflows/verify.js and write the verdicts back as decisions.
//   npm run build && node eval/verify.js [--labels eval/data/labels.json] [--candidates eval/data/candidates.json]
//     [--to n] [--only id,id] [--effort high] [--budget 400k] [--model m] [--concurrency n]
//     [--out eval/data/verify.json] [--resume <runId>] [--dry-run]
// --to n takes the undecided candidates up to order n. Agents run in the same fresh tip copy as the triage.
// --dry-run uses FakeRunner and temp dirs and writes the decisions to eval/data/labels.dry.json.

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
import { cost, flagReader } from './_launcher.js';
import { materialize } from './materialize.ts';
import { applyVerdicts, confirmed } from './review.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-opus-5-5'; // docs/eval.md bölüm 9, karar 8

const argv = process.argv.slice(2);
const flag = flagReader(argv);
const dryRun = argv.includes('--dry-run');
const labelsPath = flag('--labels') ?? 'eval/data/labels.json';
const labelsOut = dryRun ? 'eval/data/labels.dry.json' : labelsPath;
const data = JSON.parse(readFileSync(flag('--candidates') ?? 'eval/data/candidates.json', 'utf8'));
const out = flag('--out') ?? (dryRun ? 'eval/data/verify.dry.json' : 'eval/data/verify.json');
const model = flag('--model') ?? process.env.MAESTRO_MODEL ?? MODEL;
const effort = flag('--effort') ?? 'high';

const mined = new Map(data.bug.map((c) => [c.id, c]));
const only = flag('--only') ? new Set(flag('--only').split(',')) : null;
const to = flag('--to') ? Number(flag('--to')) : Number.POSITIVE_INFINITY;
const candidates = JSON.parse(readFileSync(labelsPath, 'utf8'))
  .candidates.filter((c) => c.decision === null && c.order <= to && (!only || only.has(c.id)))
  .map((c) => {
    const m = mined.get(c.id);
    if (!m) throw new Error(`verify: ${c.id} is not in the candidates file`);
    const bugs = c.bugs.map(({ file, line, description, trigger, fix }) => ({
      file,
      line,
      description,
      trigger,
      fix,
    }));
    return { id: c.id, pr: m.pr, merge: c.merge, base: c.base, lines: c.lines, files: m.files, bugs };
  });
if (!candidates.length) {
  console.error('verify: no undecided candidates selected');
  process.exit(1);
}
if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error('verify: ANTHROPIC_API_KEY is not set. Export it, or run with --dry-run (no network).');
  process.exit(1);
}

// Dry run: the first reported bug of every candidate is confirmed as reported, the rest are not.
const dryRules = [
  {
    match: 'etiketlerini denetliyorsun',
    respond: (req) => {
      const claims = [...req.prompt.matchAll(/^(\d+)\. (.+?):(\d+): /gm)];
      return {
        turns: 3,
        result: {
          bugs: claims.map(([, i, file, line]) => {
            const yes = i === '0';
            return {
              index: Number(i),
              exists: yes,
              introduced: yes,
              fixed: yes,
              visible: yes,
              corrected: false,
              file,
              line: Number(line),
              description: 'dry run',
              trigger: 'dry run',
              reason: 'dry run',
            };
          }),
        },
      };
    },
  },
];

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));
const cwd = dryRun
  ? tmp('maestro-verify-')
  : materialize(data.repo, data.tip, path.resolve('eval/data/repos', `${path.basename(data.repo)}-tip`));
const stateDir = dryRun ? tmp('maestro-verify-state-') : path.resolve('eval/data/state');
const budget = parseBudgetDirective(flag('--budget') ?? '400k');
if (budget === null) {
  console.error(`verify: invalid --budget "${flag('--budget')}" (e.g. 500k, 1.5m, 20000)`);
  process.exit(1);
}
const resume = flag('--resume');
const handle = run({
  script: readFileSync(path.join(here, 'workflows', 'verify.js'), 'utf8'),
  args: { candidates, effort },
  cwd,
  stateDir,
  model,
  budget,
  runner: dryRun ? new FakeRunner(dryRules) : new AnthropicRunner(),
  ...(flag('--concurrency') ? { concurrency: Number(flag('--concurrency')) } : {}),
  ...(resume ? { resumeFromRunId: resume } : {}),
});
console.error(`verify: ${candidates.length} candidates, ${model}/${effort}, run ${handle.runId} in ${cwd}`);

const detach = attachTerminalProgress(handle, process.stderr);
try {
  const results = await handle.promise;
  const summary = {
    candidates: results.length,
    null: results.filter((r) => !r.verify).length,
    confirmed: results.filter((r) => r.verify?.bugs.some(confirmed)).length,
    bugs: results.reduce((n, r) => n + (r.verify?.bugs.filter(confirmed).length ?? 0), 0),
    ...cost(handle.runDir, model),
  };
  mkdirSync(path.dirname(out), { recursive: true });
  const report = { runId: handle.runId, model, effort, source: data.repo, tip: data.tip, summary, results };
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`verify: ${JSON.stringify(summary)}`);
  console.error(`verify: wrote ${out}`);

  // Re-read: decisions written by hand during the run stay as they are.
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  const written = applyVerdicts(labels, results, handle.runId);
  writeFileSync(labelsOut, `${JSON.stringify(labels, null, 2)}\n`);
  console.error(`verify: ${written.length} decisions written to ${labelsOut}`);
} catch (err) {
  console.error(`verify: run failed: ${err?.message ?? err}`);
  console.error(`verify: continue with the same flags plus --resume ${handle.runId}`);
  process.exitCode = 1;
} finally {
  detach();
}
