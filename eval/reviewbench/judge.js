// Scores the findings of eval/reviewbench/run.js with ReviewBench's own judge and writes the report.
//   node eval/reviewbench/judge.js --out eval/data/rb/<name> [--model claude-sonnet-5] [--provider anthropic]
//     [--judge-concurrency 4] [--bench eval/data/reviewbench] [--report-only]
// For every findings/<arm>-r<k> directory it runs the benchmark's `npm run judge` (an LLM matcher and
// classifier: this costs money) and stores scoring/<arm>-r<k>/results.json. A directory already scored
// is skipped; the judge itself resumes a half-done one. Then it writes <out>/report.md.
// --report-only skips the judge and rebuilds the report from the scores that are there.
// Needs `npm ci` run once inside the ReviewBench checkout. The golden set is never changed: --ingest
// is not passed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { flagReader } from '../_launcher.js';
import { paired, reportMarkdown, summarize } from './bench.ts';

const argv = process.argv.slice(2);
const flag = flagReader(argv);
const die = (message) => {
  console.error(`rb-judge: ${message}`);
  process.exit(1);
};
const out = flag('--out');
if (!out) die('--out <dir> is required (the --out of eval/reviewbench/run.js)');
const outDir = path.resolve(out);
const benchDir = path.resolve(flag('--bench') ?? 'eval/data/reviewbench');
const findingsDir = path.join(outDir, 'findings');
if (!existsSync(findingsDir)) die(`no findings in ${findingsDir}; run eval/reviewbench/run.js first`);
// The leaderboard's judge (docs/OFFLINE_EVAL.md of the benchmark), so scores compare with it.
const model = flag('--model') ?? 'claude-sonnet-5';
const provider = flag('--provider') ?? 'anthropic';
const reportOnly = argv.includes('--report-only');

const groups = readdirSync(findingsDir)
  .filter((d) => /^[A-Z]-r\d+$/.test(d))
  .sort();
if (groups.length === 0) die(`no <arm>-r<k> directories in ${findingsDir}`);

if (!reportOnly) {
  if (!process.env.ANTHROPIC_API_KEY && provider === 'anthropic') die('ANTHROPIC_API_KEY is not set.');
  if (!existsSync(path.join(benchDir, 'node_modules'))) {
    die(`the judge is not installed: run "npm ci" in ${benchDir} first`);
  }
  // The judge's model registry may not list the model yet; this is the configuration its docs give.
  const judgeConfig = path.join(outDir, 'judge-config');
  mkdirSync(judgeConfig, { recursive: true });
  writeFileSync(
    path.join(judgeConfig, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          [provider]: {
            apiKey: 'ANTHROPIC_API_KEY',
            models: [{ id: model, reasoning: true, contextWindow: 1000000, maxTokens: 64000 }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  for (const group of groups) {
    const output = path.join(outDir, 'scoring', group, 'results.json');
    if (existsSync(output)) {
      console.error(`rb-judge: ${group} already scored`);
      continue;
    }
    console.error(`rb-judge: judging ${group} with ${provider}/${model}`);
    const res = spawnSync(
      'npm',
      [
        'run',
        'judge',
        '--',
        '--candidate',
        path.join(findingsDir, group),
        '--provider',
        provider,
        '--model',
        model,
        '--output',
        output,
        '--repo-dir',
        path.join(outDir, 'judge-repos'),
        '--concurrency',
        flag('--judge-concurrency') ?? '4',
      ],
      { cwd: benchDir, stdio: 'inherit', env: { ...process.env, PI_CODING_AGENT_DIR: judgeConfig } },
    );
    if (res.status !== 0)
      die(`the judge failed on ${group} (exit ${res.status}); run the same command to resume`);
  }
}

const scores = [];
for (const group of groups) {
  const file = path.join(outDir, 'scoring', group, 'results.json');
  if (!existsSync(file)) continue;
  const [arm, r] = group.split('-r');
  scores.push({ arm, repeat: Number(r), results: JSON.parse(readFileSync(file, 'utf8')) });
}
if (scores.length === 0) die('nothing is scored yet');
const rowsFile = path.join(outDir, 'results.jsonl');
const rows = existsSync(rowsFile)
  ? readFileSync(rowsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  : [];
const summary = summarize(scores, rows);
const arms = summary.map((s) => s.arm);
const pairs = [
  ['A', 'B'],
  ['A', 'C'],
  ['C', 'B'],
]
  .filter(([a, b]) => arms.includes(a) && arms.includes(b))
  .map(([a, b]) => ({ a, b, p: paired(scores, a, b) }));
const report = reportMarkdown(summary, pairs);
writeFileSync(path.join(outDir, 'report.md'), report);
console.log(report);
console.error(
  `rb-judge: wrote ${path.join(outDir, 'report.md')} (${scores.length} of ${groups.length} groups scored)`,
);
