// Workflow tool "cwd": one server (one Claude Code session folder) can point a run at another
// directory. The run's agents work there, writers branch from that repo, and .maestro lives there.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { handleWorkflowToolCall, type WorkflowOutcome, type WorkflowToolContext } from '../src/tool.js';
import type { RunRequest } from '../src/types.js';

beforeAll(() => {
  // A developer machine's global git config (gpgsign, hooks) must not leak into the fixtures.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-tool-cwd-')));
  dirs.push(d);
  return d;
}

async function makeRepo(): Promise<string> {
  const dir = await tmp();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const SCRIPT = `export const meta = { name: 't', description: 'd' };
return await agent('hello');`;

/** A server context rooted at `serverCwd`, with no stateDir override (the default <cwd>/.maestro). */
function server(serverCwd: string, runner: FakeRunner) {
  let resolve!: (v: { runId: string; outcome: WorkflowOutcome }) => void;
  const done = new Promise<{ runId: string; outcome: WorkflowOutcome }>((r) => {
    resolve = r;
  });
  const ctx: WorkflowToolContext = {
    cwd: serverCwd,
    runner,
    concurrency: 2,
    onComplete: (runId, outcome) => resolve({ runId, outcome }),
  };
  return { ctx, done };
}

describe('Workflow tool cwd', () => {
  it('moves the run: agents work in cwd and the run is journaled under <cwd>/.maestro', async () => {
    const serverCwd = await tmp();
    const target = path.join(serverCwd, 'other');
    await mkdir(target);
    const runner = new FakeRunner();
    const { ctx, done } = server(serverCwd, runner);
    // Relative to the server's directory.
    const res = await handleWorkflowToolCall({ script: SCRIPT, cwd: 'other' }, ctx);
    if ('is_error' in res) throw new Error(res.content);
    expect(res.scriptPath).toBe(path.join(target, '.maestro', 'runs', res.runId, 'script.js'));
    expect((await done).outcome.ok).toBe(true);
    expect(runner.calls.map((c) => c.cwd)).toEqual([target]);
    expect(existsSync(path.join(serverCwd, '.maestro'))).toBe(false);
  });

  it('null or empty cwd keeps the server directory', async () => {
    const serverCwd = await tmp();
    for (const cwd of [null, '']) {
      const runner = new FakeRunner();
      const { ctx, done } = server(serverCwd, runner);
      const res = await handleWorkflowToolCall({ script: SCRIPT, cwd }, ctx);
      if ('is_error' in res) throw new Error(res.content);
      expect(res.scriptPath.startsWith(path.join(serverCwd, '.maestro', 'runs'))).toBe(true);
      await done;
      expect(runner.calls[0]?.cwd).toBe(serverCwd);
    }
  });

  it('resolves scriptPath against the given cwd', async () => {
    const serverCwd = await tmp();
    const target = await tmp();
    await writeFile(path.join(target, 'w.js'), SCRIPT);
    const { ctx, done } = server(serverCwd, new FakeRunner());
    const res = await handleWorkflowToolCall({ scriptPath: 'w.js', cwd: target }, ctx);
    expect(res).toMatchObject({ status: 'started' });
    expect((await done).outcome.ok).toBe(true);
  });

  it('writers branch from the git repo named by cwd, even when the server directory is not a repo', async () => {
    const serverCwd = await tmp();
    const repo = await makeRepo();
    const runner = new FakeRunner(() => ({
      effect: async (req: RunRequest) => {
        await writeFile(path.join(req.cwd, 'a.txt'), 'a\n');
        git(req.cwd, 'add', '-A');
        git(req.cwd, 'commit', '-q', '-m', 'add a');
      },
      result: { summary: 'wrote a.txt', filesTouched: ['a.txt'] },
    }));
    const { ctx, done } = server(serverCwd, runner);
    const script = `export const meta = { name: 'w', description: 'd' };
return await agent('write a.txt and commit', { label: 'writer', isolation: 'worktree',
  tools: ['read_file', 'write_file', 'git_commit'],
  schema: { type: 'object', properties: { summary: { type: 'string' }, filesTouched: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'filesTouched'] } });`;
    const res = await handleWorkflowToolCall({ script, cwd: repo }, ctx);
    if ('is_error' in res) throw new Error(res.content);
    const { outcome } = await done;
    expect(outcome).toEqual({
      ok: true,
      result: { summary: 'wrote a.txt', filesTouched: ['a.txt'], branchName: `wf/${res.runId}/writer` },
    });
    expect(git(repo, 'log', '--format=%s', '-1', `wf/${res.runId}/writer`)).toBe('add a');
    expect(runner.calls[0]?.cwd.startsWith(serverCwd)).toBe(false);
  });

  it('a cwd that is missing, a file or not a string is is_error at once', async () => {
    const serverCwd = await tmp();
    await writeFile(path.join(serverCwd, 'file.txt'), 'x');
    const runner = new FakeRunner();
    const { ctx } = server(serverCwd, runner);
    const missing = await handleWorkflowToolCall({ script: SCRIPT, cwd: 'nope' }, ctx);
    expect(missing).toMatchObject({
      is_error: true,
      content: expect.stringMatching(/cwd is not a directory/),
    });
    const file = await handleWorkflowToolCall({ script: SCRIPT, cwd: 'file.txt' }, ctx);
    expect(file).toMatchObject({ is_error: true, content: expect.stringMatching(/cwd is not a directory/) });
    const notString = await handleWorkflowToolCall({ script: SCRIPT, cwd: 42 }, ctx);
    expect(notString).toMatchObject({
      is_error: true,
      content: expect.stringMatching(/cwd must be a string/),
    });
    expect(runner.liveCalls).toBe(0);
  });

  it('resume finds the run only under the same cwd', async () => {
    const serverCwd = await tmp();
    const target = await tmp();
    const runner = new FakeRunner();
    const first = server(serverCwd, runner);
    const res = await handleWorkflowToolCall({ script: SCRIPT, cwd: target }, first.ctx);
    if ('is_error' in res) throw new Error(res.content);
    const one = await first.done;
    expect(runner.liveCalls).toBe(1);

    const elsewhere = await handleWorkflowToolCall(
      { resumeFromRunId: res.runId },
      server(serverCwd, runner).ctx,
    );
    expect(elsewhere).toMatchObject({ is_error: true, content: expect.stringMatching(/no run/) });

    const again = server(serverCwd, runner);
    const resumed = await handleWorkflowToolCall({ resumeFromRunId: res.runId, cwd: target }, again.ctx);
    expect(resumed).toEqual({ runId: res.runId, scriptPath: res.scriptPath, status: 'started' });
    expect(await again.done).toEqual(one);
    expect(runner.liveCalls).toBe(1);
  });
});
