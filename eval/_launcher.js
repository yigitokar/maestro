// Shared by the eval launchers (eval/triage.js, eval/verify.js): flag reading and the cost of a run.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** $ per million tokens (claude-api skill, cached 2026-11-03; cache write is 1.25 x input). */
export const PRICES = {
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  // Prompts up to 100K tokens; cache read taken as 0.1 x input.
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
};

/** `flag('--name')` → the argument after it, or undefined. */
export function flagReader(argv) {
  return (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
}

/**
 * Token totals over the run's journal rows, and dollars when the model is a priced one. A resumed run
 * keeps its journal, so these are the totals of the run over all its attempts, not of the last one.
 */
export function cost(runDir, model) {
  const u = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const line of readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    u.input += e.usage?.input_tokens ?? 0;
    u.cacheWrite += e.usage?.cache_creation_input_tokens ?? 0;
    u.cacheRead += e.usage?.cache_read_input_tokens ?? 0;
    u.output += e.usage?.output_tokens ?? 0;
  }
  const price = PRICES[model];
  const dollars = price ? Object.entries(u).reduce((s, [k, n]) => s + (n * price[k]) / 1e6, 0) : null;
  return { tokens: u, dollars: dollars === null ? null : Math.round(dollars * 100) / 100 };
}

/**
 * Journal rows of a run that did not end ok, counting the last row of each key (a resume re-runs null
 * and skipped rows). A run can return a value with some of its agents dead: fewer finders or votes.
 */
export function deadAgents(runDir) {
  const last = new Map();
  for (const line of readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    last.set(e.key, e.status);
  }
  return [...last.values()].filter((status) => status !== 'ok').length;
}
