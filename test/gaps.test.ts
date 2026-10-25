// run()-level tests for behaviour that was only covered at the unit level: no slot held during worktree
// setup (Seviye 2 data flow 4-5, 3.4), schema `raw` in the journal row (3.2), an unwritable journal
// stops the run before any agent (3.1), aborted clean/dirty worktrees (3.6 tests) and the schemaless
// writer hand-off wrap. FakeRunner + temp dirs/repos only; never the network.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeResponse, FakeRunner } from '../src/testing/fake-runner.js';
import type { Entry, RunRequest, WorkflowEvent } from '../src/types.js';
import { type RunHandle, type RunOptions, run } from '../src/workflow.js';

beforeAll(() => {
  // A developer machine's global git config (gpgsign, hooks) must not leak into the fixtures.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await chmod(d, 0o700).catch(() => {});
    await rm(d, { recursive: true, force: true });
  }
});

async function tmp(prefix = 'maestro-gaps-'): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function makeRepo(): Promise<string> {
  const dir = await tmp('maestro-gaps-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function start(
  cwd: string,
  opts: RunOptions,
): { handle: RunHandle; events: WorkflowEvent[]; logs: string[] } {
  const handle = run({ cwd, concurrency: 4, ...opts });
  const events: WorkflowEvent[] = [];
  const logs: string[] = [];
  handle.events.on('event', (e: WorkflowEvent) => {
    events.push(e);
    if (e.type === 'log') logs.push(e.message);
  });
  return { handle, events, logs };
}

function rows(runDir: string): Entry[] {
  const p = path.join(runDir, 'journal.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Entry);
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const worktrees = (repo: string) =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '));

const META = "export const meta = { name: 'gaps', description: 'd' };\n";
const WRITE_TOOLS = "['read_file', 'grep', 'glob', 'bash', 'write_file', 'edit_file', 'shell', 'git_commit']";
const WRITE_RESULT =
  "{ type: 'object', properties: { summary: { type: 'string' }, filesTouched: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'filesTouched'] }";

describe('worktree setup holds no slot (Seviye 2 data flow 4-5, 3.4)', () => {
  it('concurrency 1: a non-isolated agent reaches the runner while the isolated one is still opening', async () => {
    const repo = await makeRepo();
    const side = await tmp();
    const marker = path.join(side, 'hook-done');
    // git runs post-checkout on `git worktree add`: a slow hook makes Isolation.open slow.
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\nsleep 1\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);

    const seenMarker: Record<string, boolean> = {};
    const runner = new FakeRunner((req) => {
      seenMarker[req.prompt] = existsSync(marker);
      return { result: req.prompt };
    });
    const { handle } = start(repo, {
      runner,
      runId: 'slot1',
      concurrency: 1,
      // The isolated agent is called first: if it took the slot before opening, 'plain' would wait.
      script: `${META}return parallel([() => agent('iso', { isolation: 'worktree' }), () => agent('plain')]);`,
    });
    expect(await handle.promise).toEqual(['iso', 'plain']);
    expect(runner.calls.map((c) => c.prompt)).toEqual(['plain', 'iso']);
    // 'plain' ran before the hook (worktree creation) finished; 'iso' only after its worktree existed.
    expect(seenMarker).toEqual({ plain: false, iso: true });
    expect(runner.maxConcurrent).toBe(1);
    expect(runner.calls[1]!.isolated).toBe(true);
    expect(runner.calls[1]!.cwd).not.toBe(repo);
  });
});

describe('schema parse failed twice: raw text in the journal row (spec 3.2)', () => {
  it("status 'null' + raw from the runner: agent() null, the row carries raw", async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({
      status: 'null',
      raw: 'not json {',
      error: 'structured output did not match the schema twice',
    }));
    const { handle } = start(dir, {
      runner,
      runId: 'raw1',
      script: `${META}return agent('x', { label: 'parser', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });`,
    });
    expect(await handle.promise).toBeNull();
    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({ label: 'parser', status: 'null', result: null, raw: 'not json {' });
    expect(row!.error).toMatch(/schema/);
  });

  it('raw is not recorded on an ok row', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ result: 'fine', raw: 'ignored' }));
    const { handle } = start(dir, { runner, runId: 'raw2', script: `${META}return agent('x');` });
    expect(await handle.promise).toBe('fine');
    expect(rows(handle.runDir)[0]!.raw).toBeUndefined();
  });
});

describe('unwritable journal: the run does not start (spec 3.1)', () => {
  const SCRIPT = `${META}const a = await agent('first');\nreturn a;`;

  it('<stateDir>/runs is a regular file → journal_unwritable, zero runner calls', async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, 'state'));
    await writeFile(path.join(dir, 'state', 'runs'), 'not a directory\n');
    const runner = new FakeRunner();
    const { handle, events } = start(dir, { runner, runId: 'j1', stateDir: 'state', script: SCRIPT });
    await expect(handle.promise).rejects.toMatchObject({ code: 'journal_unwritable' });
    expect(runner.liveCalls).toBe(0);
    expect(events.some((e) => e.type === 'agent_start')).toBe(false);
  });

  it.skipIf(isRoot)('read-only stateDir → journal_unwritable, zero runner calls', async () => {
    const dir = await tmp();
    const state = path.join(dir, 'state');
    await mkdir(state);
    await chmod(state, 0o500);
    dirs.unshift(state); // restored to 0o700 before removal
    const runner = new FakeRunner();
    const { handle, events } = start(dir, { runner, runId: 'j2', stateDir: 'state', script: SCRIPT });
    await expect(handle.promise).rejects.toMatchObject({ code: 'journal_unwritable' });
    expect(runner.liveCalls).toBe(0);
    expect(events.some((e) => e.type === 'agent_start')).toBe(false);
    expect(existsSync(path.join(state, 'runs'))).toBe(false);
  });
});

describe('aborted isolated agents (spec 3.6 tests)', () => {
  const WRITER = `${META}return agent('draft it', { label: 'drafter', isolation: 'worktree', tools: ${WRITE_TOOLS}, schema: ${WRITE_RESULT} });`;

  /** A writer that (optionally) dirties its worktree, then runs long enough to be aborted. */
  function slowWriter(dirty: boolean) {
    const reached = deferred<RunRequest>();
    const runner = new FakeRunner((req): FakeResponse => {
      // Inside the handler, i.e. before the abortable turn wait: FakeResponse.effect would run too late.
      if (dirty) writeFileSync(path.join(req.cwd, 'draft.txt'), 'half done\n');
      reached.resolve(req);
      return { delayMs: 10_000 };
    });
    return { runner, reached: reached.promise };
  }

  it('dirty writer + skip(id): agent() null, row skipped with worktree path + diffStat, dir kept, path logged', async () => {
    const repo = await makeRepo();
    const { runner, reached } = slowWriter(true);
    const { handle, events, logs } = start(repo, { runner, runId: 'ab1', script: WRITER });
    const req = await reached;
    const startEv = events.find((e) => e.type === 'agent_start');
    expect(handle.skip((startEv as { id: number }).id)).toBe(true);
    expect(await handle.promise).toBeNull();

    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({
      label: 'drafter',
      status: 'skipped',
      result: null,
      error: 'skipped by user',
    });
    expect(row!.worktree?.path).toBe(req.cwd);
    expect(row!.worktree?.diffStat).toMatch(/draft\.txt|untracked/);
    expect(existsSync(path.join(req.cwd, 'draft.txt'))).toBe(true);
    expect(logs.some((m) => m.includes(req.cwd))).toBe(true);
    expect(worktrees(repo)).toHaveLength(2);
  });

  it('dirty writer + stop(): the run rejects run_stopped, the dirty worktree is kept and journaled', async () => {
    const repo = await makeRepo();
    const { runner, reached } = slowWriter(true);
    const { handle, logs } = start(repo, { runner, runId: 'ab2', script: WRITER });
    const req = await reached;
    handle.stop('test');
    await expect(handle.promise).rejects.toMatchObject({ code: 'run_stopped' });
    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({ status: 'skipped', result: null });
    expect(row!.worktree?.path).toBe(req.cwd);
    expect(existsSync(req.cwd)).toBe(true);
    expect(logs.some((m) => m.includes(req.cwd))).toBe(true);
  });

  it('clean writer + skip(id): agent() null, no worktree left, nothing recorded on the row', async () => {
    const repo = await makeRepo();
    const { runner, reached } = slowWriter(false);
    const { handle, events } = start(repo, { runner, runId: 'ab3', script: WRITER });
    const req = await reached;
    expect(existsSync(req.cwd)).toBe(true);
    const startEv = events.find((e) => e.type === 'agent_start');
    expect(handle.skip((startEv as { id: number }).id)).toBe(true);
    expect(await handle.promise).toBeNull();

    const [row] = rows(handle.runDir);
    expect(row).toMatchObject({ status: 'skipped', result: null, error: 'skipped by user' });
    expect(row!.worktree).toBeUndefined();
    expect(existsSync(req.cwd)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
  });
});

describe('schemaless writer hand-off (spec 3.6)', () => {
  it('a non-object result is wrapped as { result, branchName }', async () => {
    const repo = await makeRepo();
    const runner = new FakeRunner(() => ({
      effect: async (req: RunRequest) => {
        await writeFile(path.join(req.cwd, 'note.txt'), 'note\n');
        git(req.cwd, 'add', '-A');
        git(req.cwd, 'commit', '-q', '-m', 'note');
      },
      result: 'done',
    }));
    const { handle } = start(repo, {
      runner,
      runId: 'wrap1',
      script: `${META}return agent('write a note', { label: 'noter', isolation: 'worktree', tools: ${WRITE_TOOLS} });`,
    });
    expect(await handle.promise).toEqual({ result: 'done', branchName: 'wf/wrap1/noter' });
    expect(rows(handle.runDir)[0]).toMatchObject({
      status: 'ok',
      result: { result: 'done', branchName: 'wf/wrap1/noter' },
    });
    expect(git(repo, 'show', 'wf/wrap1/noter:note.txt')).toBe('note');
  });
});
