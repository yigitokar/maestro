// A repo holding one commit and its ancestors only (docs/eval.md 3): no remote, no refs, no FETCH_HEAD,
// so `git log --all` and `git show <later sha>` cannot reach anything after `sha`. Read-only on `source`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Creates `dir` at `sha` fetched from `source`, or reuses it when it is already there. Returns `dir`. */
export function materialize(source: string, sha: string, dir: string): string {
  if (existsSync(path.join(dir, '.git'))) {
    let head: string | undefined;
    try {
      head = git('-C', dir, 'rev-parse', '--verify', 'HEAD');
    } catch {
      // An earlier attempt died between `git init` and the checkout: nothing in it is worth keeping.
      rmSync(dir, { recursive: true, force: true });
    }
    if (head === sha) return dir;
    if (head !== undefined) throw new Error(`${dir} is at another commit; remove it first`);
  }
  mkdirSync(dir, { recursive: true });
  git('init', '-q', dir);
  git('-C', dir, 'fetch', '-q', '--no-tags', path.resolve(source), sha);
  git('-C', dir, 'checkout', '-q', '--detach', sha);
  rmSync(path.join(dir, '.git', 'FETCH_HEAD'), { force: true });
  return dir;
}
