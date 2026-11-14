// A checkout of one ReviewBench PR at its head with nothing after it (docs/eval.md 3): the head and base
// commits and their ancestors, no remote, no refs, no FETCH_HEAD. The golden set is partly inferred from
// follow-up commits, so `git log --all` and `git show <later sha>` must find nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { BenchTask } from './bench.ts';

/** The benchmark's frozen copies of the source repositories. */
const MIRROR_ORG = 'review-bench';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function has(dir: string, sha: string): boolean {
  try {
    git(dir, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Where the two commits are fetched from, in order: the benchmark's mirror, then the upstream repo. */
export function sources(task: Pick<BenchTask, 'nwo'>): string[] {
  return [
    `https://github.com/${MIRROR_ORG}/${task.nwo.replace('/', '_')}.git`,
    `https://github.com/${task.nwo}.git`,
  ];
}

/**
 * Creates `dir` at the task's head, or reuses it when it already is there. `from` overrides the
 * sources (tests pass a local repository). Returns `dir`.
 */
export function prepareTask(task: BenchTask, dir: string, from: string[] = sources(task)): string {
  if (existsSync(path.join(dir, '.git'))) {
    let head: string | undefined;
    try {
      head = git(dir, 'rev-parse', '--verify', 'HEAD');
    } catch {
      // A half-made checkout of an earlier attempt.
    }
    if (head === task.head && has(dir, task.base)) return dir;
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let lastError = '';
  for (const url of from) {
    try {
      git(dir, 'fetch', '-q', '--no-tags', url, task.base, task.head);
    } catch (e) {
      lastError = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
    }
    if (has(dir, task.base) && has(dir, task.head)) break;
  }
  if (!has(dir, task.base) || !has(dir, task.head)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`cannot fetch base and head of ${task.nwo}#${task.pr_number}: ${lastError}`);
  }
  git(dir, 'checkout', '-q', '--force', '--detach', task.head);
  rmSync(path.join(dir, '.git', 'FETCH_HEAD'), { force: true });
  return dir;
}
