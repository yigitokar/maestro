// CLI (bin "maestro") tested in-process through main(argv, io): dry runs, resume, gc, mcp, usage errors.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { main, watchParent } from '../src/cli.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-cli-')));
  dirs.push(d);
  return d;
}

async function cli(argv: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd,
    env,
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s), isTTY: false },
  });
  return { code, stdout, stderr };
}

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const SCRIPT = `export const meta = { name: 'cli-demo', description: 'd' };
const r = await agent('summarize ' + args.topic, { label: 'sum', schema: { type: 'object', properties: { title: { type: 'string' }, n: { type: 'integer' } }, required: ['title', 'n'] } });
log('got ' + r.title);
return { topic: args.topic, r };`;

describe('maestro run', () => {
  it('--dry-run --args prints the JSON result on stdout and progress on stderr', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'demo.js'), SCRIPT);
    const res = await cli(
      ['run', 'demo.js', '--dry-run', '--args', '{"topic":"x"}', '--concurrency', '2'],
      dir,
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ topic: 'x', r: { title: 'summarize x.title', n: 1 } });
    expect(res.stderr).toMatch(/run \d{8}-\d{6}-[0-9a-f]{6} \(dry run\)/);
    expect(res.stderr).toContain('✓ sum  100 tok');
    expect(res.stderr).toContain('· got summarize x.title');

    // --resume reuses the stored script and args: same output.
    const runId = /run (\S+) \(dry run\)/.exec(res.stderr)![1]!;
    const again = await cli(['run', '--resume', runId, '--dry-run'], dir);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual(JSON.parse(res.stdout));
    expect(again.stderr).toContain('↺ sum');
  });

  it('--args-file, --budget and --cwd are honoured', async () => {
    const dir = await tmp();
    const work = path.join(dir, 'work');
    await writeFile(path.join(dir, 'demo.js'), SCRIPT);
    await writeFile(path.join(dir, 'args.json'), '{"topic":"from-file"}');
    await mkdir(work);
    const res = await cli(
      ['run', 'demo.js', '--dry-run', '--args-file', 'args.json', '--budget', '50k', '--cwd', 'work'],
      dir,
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).topic).toBe('from-file');
    expect(res.stderr).toContain('budget: total 50000, overrun ceiling');
    expect(res.stderr).toContain(path.join(work, '.maestro', 'runs'));
  });

  it('--tools-dir gives the agents the custom tools of that directory', async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'uses-tool.js'),
      `export const meta = { name: 'uses-tool', description: 'd' };
return await agent('look it up', { label: 'look', tools: ['echo'] });`,
    );
    await mkdir(path.join(dir, 'my-tools'));
    await writeFile(
      path.join(dir, 'my-tools', 'echo.js'),
      `export default { name: 'echo', description: 'Echo the text back.', write: false,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  async run(input) { return 'echo: ' + input.text; } };
`,
    );
    const without = await cli(['run', 'uses-tool.js', '--dry-run'], dir);
    expect(without.code).toBe(1);
    expect(without.stderr).toContain('unknown tool "echo"');
    const res = await cli(['run', 'uses-tool.js', '--dry-run', '--tools-dir', 'my-tools'], dir);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('✓ look');
  });

  it('a failing script exits 1 with the error and a resume hint', async () => {
    const dir = await tmp();
    await writeFile(
      path.join(dir, 'bad.js'),
      `export const meta = { name: 'b', description: 'd' };\nthrow new Error('boom');`,
    );
    const res = await cli(['run', 'bad.js', '--dry-run'], dir);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toMatch(/failed: boom/);
    expect(res.stderr).toMatch(/maestro run --resume \S+/);
  });

  it('without --dry-run and without ANTHROPIC_API_KEY: explains and exits 1, nothing runs', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'demo.js'), SCRIPT);
    const res = await cli(['run', 'demo.js', '--args', '{}'], dir, {});
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(res.stderr).toMatch(/--dry-run/);
  });

  it('bad flags exit 1 with usage', async () => {
    const dir = await tmp();
    for (const argv of [
      ['run', 'x.js', '--budget', 'lots', '--dry-run'],
      ['run', 'x.js', '--args', '{nope', '--dry-run'],
      ['run', 'x.js', '--concurrency', '0', '--dry-run'],
      ['run', 'x.js', '--frobnicate'],
      ['run'],
    ]) {
      const res = await cli(argv, dir);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('usage:');
    }
  });
});

describe('maestro gc', () => {
  it('lists dirty worktrees and wf/* branches; deletes only with --delete', async () => {
    const repo = await tmp();
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'T');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'branch', 'wf/r1/merged');
    git(repo, 'branch', 'wf/r1/open');
    const wt = path.join(repo, '.maestro', 'worktrees', 'r1', 'open');
    git(repo, 'worktree', 'add', '-q', wt, 'wf/r1/open');
    await writeFile(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-q', '-m', 'b');
    await writeFile(path.join(wt, 'dirty.txt'), 'wip\n');

    const list = await cli(['gc', '--cwd', repo], os.tmpdir());
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('dirty worktrees:');
    expect(list.stdout).toContain(`${wt} [wf/r1/open]`);
    expect(list.stdout).toContain('1 untracked file');
    expect(list.stdout).toMatch(/merged wf\/\* branches:\n {2}wf\/r1\/merged/);
    expect(list.stdout).toMatch(/unmerged wf\/\* branches:\n {2}wf\/r1\/open/);
    expect(list.stdout).toContain('nothing deleted');
    expect(git(repo, 'branch', '--list', 'wf/*', '--format=%(refname:short)').split('\n')).toHaveLength(2);

    const del = await cli(['gc', '--delete'], repo);
    expect(del.code).toBe(0);
    expect(del.stdout).toMatch(/removed:\n/);
    expect(del.stdout).toContain('wf/r1/merged');
    // Unmerged branches and the dirty worktree survive without --force.
    expect(git(repo, 'branch', '--list', 'wf/*', '--format=%(refname:short)')).toBe('wf/r1/open');
    expect(existsSync(path.join(wt, 'dirty.txt'))).toBe(true);

    const forced = await cli(['gc', '--delete', '--force'], repo);
    expect(forced.code).toBe(0);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'wf/*')).toBe('');
  });
});

/** `maestro mcp` in-process: stdin/stdout are pipes a real MCP client talks over. */
function mcpCli(argv: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  let stderr = '';
  const code = main(['mcp', ...argv], {
    cwd,
    env,
    stdin: toServer,
    stdout: toClient,
    stderr: { write: (s: string) => (stderr += s), isTTY: false },
  });
  return { code, toServer, toClient, stderr: () => stderr };
}

describe('maestro mcp', () => {
  it('serves the Workflow tools over stdin/stdout and exits 0 when stdin ends', async () => {
    const dir = await tmp();
    const m = mcpCli(['--dry-run', '--budget', '50k', '--concurrency', '2'], dir);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StdioServerTransport(m.toClient, m.toServer));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'Workflow',
        'WorkflowGuide',
        'WorkflowInspect',
        'WorkflowMessage',
        'WorkflowReplay',
        'WorkflowResult',
        'WorkflowSkip',
        'WorkflowStop',
      ].sort(),
    );
    const started = await client.callTool({
      name: 'Workflow',
      arguments: { script: SCRIPT, args: '{"topic":"mcp"}' },
    });
    const { runId } = JSON.parse((started.content as any)[0].text);
    let last: any;
    for (let i = 0; i < 200; i++) {
      const res = await client.callTool({ name: 'WorkflowResult', arguments: { runId } });
      last = JSON.parse((res.content as any)[0].text);
      if (last.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(last).toMatchObject({ status: 'done', result: { topic: 'mcp' } });
    // Runs land under --cwd's .maestro; the dry run never needs a key, so nothing is warned.
    expect(readFileSync(path.join(dir, '.maestro', 'runs', runId, 'script.js'), 'utf8')).toBe(SCRIPT);
    expect(m.stderr()).toBe('');

    // The client disconnecting (stdin EOF) ends the command: the bin's top-level await settles.
    m.toServer.end();
    expect(await m.code).toBe(0);
  });

  it('without ANTHROPIC_API_KEY it warns on stderr and still starts; nothing goes to stdout', async () => {
    const dir = await tmp();
    const m = mcpCli([], dir, {});
    let stdout = '';
    m.toClient.on('data', (c) => (stdout += c));
    m.toServer.end();
    expect(await m.code).toBe(0);
    expect(m.stderr()).toMatch(/ANTHROPIC_API_KEY is not set; Workflow runs will fail/);
    expect(stdout).toBe('');
  });

  it('a stdin that already ended does not hang the command', async () => {
    const dir = await tmp();
    const stdin = new PassThrough();
    stdin.end();
    stdin.resume();
    await new Promise((r) => stdin.once('end', r));
    const code = await main(['mcp', '--dry-run'], {
      cwd: dir,
      env: {},
      stdin,
      stdout: new PassThrough(),
      stderr: { write: () => true, isTTY: false },
    });
    expect(code).toBe(0);
  });

  it('bad flags exit 1 with usage before anything is served', async () => {
    const dir = await tmp();
    for (const argv of [
      ['mcp', '--budget', 'lots', '--dry-run'],
      ['mcp', '--concurrency', '0', '--dry-run'],
      ['mcp', 'extra', '--dry-run'],
      ['mcp', '--frobnicate'],
    ]) {
      const res = await cli(argv, dir);
      expect(res.code, argv.join(' ')).toBe(1);
      expect(res.stderr).toContain('usage:');
    }
  });
});

describe('maestro (no command / unknown command / help)', () => {
  it('show refuses a runId that is a path, like viz does', async () => {
    const dir = await tmp();
    const r = await cli(['show', '../../etc'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('invalid runId');
  });

  it('unknown command → exit 1 with usage; help → exit 0', async () => {
    const dir = await tmp();
    const unknown = await cli(['frob'], dir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command "frob"');
    expect(unknown.stderr).toContain('usage:');
    const none = await cli([], dir);
    expect(none.code).toBe(1);
    expect(none.stdout).toContain('usage:');
    const help = await cli(['--help'], dir);
    expect(help.stdout).toMatch(/unique label.*unique key prefix/);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('maestro run <script.js>');
  });

  it('the bin entry starts with a node shebang', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src.split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});

describe('watchParent', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('calls onGone once when the parent changes, and not before', async () => {
    let parent = 4242;
    let gone = 0;
    const stop = watchParent(() => gone++, { ppid: () => parent, intervalMs: 5 });
    await tick(30);
    expect(gone).toBe(0);
    parent = 1;
    await tick(30);
    expect(gone).toBe(1);
    await tick(30);
    expect(gone).toBe(1);
    stop();
  });

  it('does nothing for a process that starts without a parent, or after stop()', async () => {
    let parent = 1;
    let gone = 0;
    watchParent(() => gone++, { ppid: () => parent, intervalMs: 5 });
    parent = 77;
    await tick(30);
    expect(gone).toBe(0);

    parent = 4242;
    const stop = watchParent(() => gone++, { ppid: () => parent, intervalMs: 5 });
    stop();
    parent = 1;
    await tick(30);
    expect(gone).toBe(0);
  });
});
