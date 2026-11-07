import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../src/codex-runner.js';
import { WRITER_INSTRUCTION } from '../src/runner.js';
import { buildTools } from '../src/tools.js';
import { DEFAULT_MODEL, MaestroError, type RunRequest, type ToolDef, type Usage } from '../src/types.js';

const bin = path.join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
let cwd: string;
let recordPath: string;
const controllers: AbortController[] = [];

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-codex-test-')));
  recordPath = path.join(cwd, 'calls.jsonl');
  vi.stubEnv('FAKE_CODEX_RECORD', recordPath);
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  scenario({ finalText: 'done', steps: [{ event: turn({}) }] });
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  // Reap fixture descendants even when a cancellation assertion fails.
  let calls: RecordOfCall[] = [];
  try {
    calls = records();
  } catch {
    // Tests that fail before spawning have no record.
  }
  for (const call of calls) {
    for (const pid of [-call.pid, call.pid, call.grandchildPid]) {
      if (pid === undefined) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

interface Scenario {
  finalText?: string;
  exitCode?: number;
  stderr?: string;
  ignoreTerm?: boolean;
  hold?: boolean;
  exitBeforeStdin?: boolean;
  grandchild?: 'group' | 'escaped';
  files?: Record<string, string>;
  steps?: Array<{ event?: unknown; raw?: string; delayMs?: number; waitForFile?: string }>;
}

function scenario(value: Scenario): void {
  vi.stubEnv('FAKE_CODEX_SCENARIO', JSON.stringify(value));
}

interface RecordOfCall {
  argv: string[];
  cwd: string;
  pid: number;
  grandchildPid?: number;
  stdin: string;
  prompt: string;
  schema?: any;
}

function records(): RecordOfCall[] {
  return readFileSync(recordPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function makeReq(overrides: Partial<RunRequest> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  const usages: Usage[] = [];
  const logs: string[] = [];
  const req: RunRequest = {
    prompt: 'do the thing',
    system: 'Return the result.',
    tools: buildTools(undefined, false),
    model: DEFAULT_MODEL,
    cwd,
    // A broken stdin implementation must fail promptly, rather than leak a hanging child.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    isolated: false,
    onUsage: (usage) => usages.push(usage),
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { req, usages, logs, controller };
}

const message = (text: string) => ({ type: 'item.completed', item: { type: 'agent_message', text } });
const turn = (usage: Record<string, number>) => ({ type: 'turn.completed', usage });

async function expectTempsRemoved(argv: string[]): Promise<void> {
  const output = flag(argv, '-o')!;
  expect(path.dirname(output)).not.toBe(cwd);
  await expect(access(path.dirname(output))).rejects.toMatchObject({ code: 'ENOENT' });
}

function git(dir: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
    delete env[key];
  }
  return execFileSync('git', args, {
    cwd: dir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function makeWorktree(): Promise<{ repo: string; worktree: string; base: string }> {
  const repo = path.join(cwd, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test Writer');
  git(repo, 'config', 'user.email', 'writer@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repo, 'a.txt'), 'original\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const base = git(repo, 'rev-parse', 'HEAD');
  const worktree = path.join(cwd, 'writer');
  git(repo, 'worktree', 'add', '-q', '-b', 'writer', worktree);
  return { repo, worktree, base };
}

describe('CodexRunner: results and subprocess protocol', () => {
  it('closes stdin, returns the output file and cleans its temporary directory', async () => {
    scenario({ finalText: 'file result', steps: [{ event: message('stream result') }, { event: turn({}) }] });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: 'file result', status: 'ok', turns: 1 });
    expect(result.trace?.finalText).toBe('stream result');
    const [call] = records();
    expect(call!.argv.at(-1)).toBe('-');
    expect(call!.prompt).toBe(call!.stdin);
    expect(call!.cwd).toBe(cwd);
    expect(call!.argv.slice(0, 4)).toEqual(['exec', '--json', '--ephemeral', '--skip-git-repo-check']);
    expect(flag(call!.argv, '-C')).toBe(cwd);
    expect(flag(call!.argv, '-s')).toBe('read-only');
    expect(call!.argv).not.toContain('--add-dir');
    expect(call!.argv).not.toContain('--ignore-user-config');
    expect(call!.argv).not.toContain('--output-schema');
    expect(call!.argv).not.toContain('-m');
    expect(call!.argv).not.toContain('-c');
    const prompt = call!.stdin;
    expect(prompt).toContain('Return the result.');
    expect(prompt).toContain('do the thing');
    expect(prompt.indexOf('Return the result.')).toBeLessThan(prompt.indexOf('do the thing'));
    expect(prompt).toContain('\n\n');
    await expectTempsRemoved(call!.argv);
  });

  it('falls back to the last agent message, including a final line without a newline', async () => {
    const final = JSON.stringify(message('fallback ✓'));
    scenario({
      steps: [
        { raw: 'non-json diagnostic\nnull\n' },
        { event: { type: 'future.event', data: true } },
        { event: message('earlier') },
        { event: turn({}) },
        { raw: final.slice(0, 12) },
        { raw: final.slice(12), delayMs: 10 },
      ],
    });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: 'fallback ✓', status: 'ok' });
    expect(result.trace?.finalText).toBe('fallback ✓');
  });

  it('returns null when there is no final text', async () => {
    scenario({ steps: [{ event: turn({}) }] });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    await expectTempsRemoved(records()[0]!.argv);
  });

  it.each([
    { type: 'turn.failed', error: { message: 'turn failed detail' } },
    { type: 'error', message: 'stream error detail' },
  ])('uses $type error messages on unsuccessful exits', async (event) => {
    scenario({ exitCode: 7, stderr: 'unrelated stderr noise', steps: [{ event }] });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    expect(result.error).toContain(
      event.type === 'turn.failed' ? 'turn failed detail' : 'stream error detail',
    );
    await expectTempsRemoved(records()[0]!.argv);
  });

  it('uses the stderr tail on non-zero exit without an error event', async () => {
    scenario({ exitCode: 4, stderr: `discard me ${'x'.repeat(900)} final diagnostic` });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    expect(result.error).toContain('final diagnostic');
    expect(result.error).not.toContain('discard me');
    expect(result.error!.length).toBeLessThan(650);
  });

  it.each([
    { name: 'turn.failed', event: { type: 'turn.failed', error: { message: 'failed turn' } }, exitCode: 0 },
    { name: 'error', event: { type: 'error', message: 'recorded error' }, exitCode: 0 },
    { name: 'non-zero exit', exitCode: 4 },
    { name: 'no turn.completed', exitCode: 0 },
  ])('rejects a progress message after $name, keeping the raw text', async ({ event, exitCode }) => {
    scenario({ steps: [{ event: message('working on it') }, ...(event ? [{ event }] : [])], exitCode });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: null, status: 'null', raw: 'working on it' });
    expect(result.error).toBeTruthy();
  });

  it.each([
    { name: 'non-zero exit', exitCode: 1, steps: [{ event: turn({}) }] },
    {
      name: 'failure after completion',
      exitCode: 0,
      steps: [{ event: turn({}) }, { event: { type: 'turn.failed', error: { message: 'late failure' } } }],
    },
    {
      name: 'error before completion',
      exitCode: 0,
      steps: [{ event: { type: 'error', message: 'earlier error' } }, { event: turn({}) }],
    },
  ])('rejects a final output file on $name', async ({ exitCode, steps }) => {
    scenario({ finalText: 'final result', exitCode, steps, stderr: 'shutdown error' });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result).toMatchObject({ result: null, status: 'null', raw: 'final result' });
    expect(result.error).toBeTruthy();
  });

  it('passes a prompt larger than 1 MiB through stdin without expanding argv', async () => {
    const prompt = 'large prompt '.repeat(100_000);
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(1024 * 1024);
    const result = await new CodexRunner({ bin }).run(makeReq({ prompt }).req);
    expect(result).toMatchObject({ result: 'done', status: 'ok' });
    const call = records()[0]!;
    expect(call.argv.at(-1)).toBe('-');
    expect(call.argv.join(' ').length).toBeLessThan(1_000);
    expect(call.stdin).toBe(`System instructions:\nReturn the result.\n\nTask:\n${prompt}`);
  });

  it('handles EPIPE when Codex exits before consuming a large stdin prompt', async () => {
    scenario({ exitBeforeStdin: true });
    const result = await new CodexRunner({ bin }).run(makeReq({ prompt: 'x'.repeat(2 * 1024 * 1024) }).req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    expect(result.error).toBeTruthy();
  });

  it('returns null and an error when the binary cannot spawn', async () => {
    const result = await new CodexRunner({ bin: path.join(cwd, 'missing-codex') }).run(makeReq().req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    expect(result.error).toMatch(/ENOENT|not found/);
    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('CodexRunner: schema', () => {
  const schema = {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 1 } },
    required: ['count'],
  };

  it('returns a parsed and locally validated schema result', async () => {
    scenario({ finalText: '{"count":2}', steps: [{ event: turn({}) }] });
    const result = await new CodexRunner({ bin }).run(makeReq({ schema }).req);
    expect(result).toMatchObject({ result: { count: 2 }, status: 'ok' });
    const [call] = records();
    expect(call!.schema).toMatchObject({ additionalProperties: false, required: ['count'] });
    expect(call!.schema.properties.count.minimum).toBeUndefined();
    expect(call!.schema.properties.count.description).toContain('minimum');
    expect(path.dirname(flag(call!.argv, '--output-schema')!)).toBe(path.dirname(flag(call!.argv, '-o')!));
    await expectTempsRemoved(call!.argv);
  });

  it('rejects valid schema text when the turn failed, preserving raw text', async () => {
    scenario({
      finalText: '{"count":2}',
      steps: [
        { event: turn({}) },
        { event: { type: 'turn.failed', error: { message: 'schema turn failed' } } },
      ],
    });
    expect(await new CodexRunner({ bin }).run(makeReq({ schema }).req)).toMatchObject({
      result: null,
      status: 'null',
      raw: '{"count":2}',
      error: 'schema turn failed',
    });
  });

  it('requires all object properties recursively without changing the input schema', async () => {
    const nested = {
      type: 'object',
      properties: {
        child: { type: ['object', 'null'], properties: { x: { type: 'string' } } },
        rows: {
          type: 'array',
          items: { type: 'object', properties: { n: { type: 'integer' } } },
        },
        variant: { oneOf: [{ type: 'object', properties: { yes: { type: 'boolean' } } }] },
      },
      required: ['child'],
    };
    const original = structuredClone(nested);
    scenario({
      finalText: '{"child":{"x":"ok"},"rows":[{"n":1}],"variant":{"yes":true}}',
      steps: [{ event: turn({}) }],
    });
    expect((await new CodexRunner({ bin }).run(makeReq({ schema: nested }).req)).status).toBe('ok');
    const sent = records()[0]!.schema;
    expect(sent.required).toEqual(['child', 'rows', 'variant']);
    expect(sent.additionalProperties).toBe(false);
    expect(sent.properties.child).toMatchObject({ additionalProperties: false, required: ['x'] });
    expect(sent.properties.rows.items).toMatchObject({ additionalProperties: false, required: ['n'] });
    expect(sent.properties.variant.anyOf[0]).toMatchObject({
      additionalProperties: false,
      required: ['yes'],
    });
    expect(nested).toEqual(original);
  });

  it.each(['not JSON', '{"count":"two"}', '{"count":0}'])(
    'rejects %s with raw text and no retry',
    async (text) => {
      scenario({ finalText: text, steps: [{ event: turn({}) }] });
      const result = await new CodexRunner({ bin }).run(makeReq({ schema }).req);
      expect(result).toMatchObject({ result: null, status: 'null', raw: text });
      expect(result.error).toBeTruthy();
      expect(records()).toHaveLength(1);
      await expectTempsRemoved(records()[0]!.argv);
    },
  );
});

describe('CodexRunner: usage and trace', () => {
  it('reports each turn immediately, subtracts cached input and does not count reasoning twice', async () => {
    const usageAck = path.join(cwd, 'usage-ack');
    scenario({
      finalText: 'done',
      steps: [
        {
          event: turn({
            input_tokens: 100,
            cached_input_tokens: 30,
            cache_write_input_tokens: 4,
            output_tokens: 7,
            reasoning_output_tokens: 3,
          }),
        },
        { event: turn({ input_tokens: 3, cached_input_tokens: 8, output_tokens: 2 }), waitForFile: usageAck },
      ],
    });
    const { req, usages } = makeReq();
    req.onUsage = (usage) => {
      // The child cannot finish until this callback acknowledges its first usage event.
      if (usages.length === 0) {
        const output = flag(records()[0]!.argv, '-o')!;
        expect(() => readFileSync(output)).toThrow();
        writeFileSync(usageAck, 'received');
      }
      usages.push(usage);
    };
    const result = await new CodexRunner({ bin }).run(req);
    expect(usages).toEqual([
      { input_tokens: 70, output_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 },
      { input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 8 },
    ]);
    expect(result.turns).toBe(2);
    expect(result.usage).toEqual({
      input_tokens: 70,
      output_tokens: 9,
      cache_read_input_tokens: 38,
      cache_creation_input_tokens: 4,
    });
  });

  it('records completed shell calls and limits trace text to the existing 200 / 2,000 chars', async () => {
    const command = `echo ${'a'.repeat(300)}`;
    const final = 'f'.repeat(2_500);
    scenario({
      finalText: final,
      steps: [
        { event: { type: 'item.started', item: { type: 'command_execution', command } } },
        { event: { type: 'item.completed', item: { type: 'command_execution', command, exit_code: 0 } } },
        {
          event: {
            type: 'item.completed',
            item: { type: 'command_execution', command: 'false', exit_code: 1 },
          },
        },
        { event: message('earlier') },
        { event: message(final) },
        { event: turn({}) },
      ],
    });
    const result = await new CodexRunner({ bin }).run(makeReq().req);
    expect(result.result).toBe(final);
    expect(result.trace).toEqual({
      toolCalls: [
        { tool: 'shell', inputSummary: command.slice(0, 200), ok: true },
        { tool: 'shell', inputSummary: 'false', ok: false },
      ],
      finalText: final.slice(0, 2_000),
    });
  });
});

describe('CodexRunner: arguments, tools and isolation', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('maps effort %s', async (effort) => {
    await new CodexRunner({ bin }).run(makeReq({ effort }).req);
    expect(flag(records()[0]!.argv, '-c')).toBe(
      `model_reasoning_effort="${effort === 'max' ? 'xhigh' : effort}"`,
    );
  });

  it.each([
    { request: DEFAULT_MODEL, expected: undefined },
    { request: 'claude-sonnet-custom', expected: undefined },
    { request: 'gpt-codex-test', expected: 'gpt-codex-test' },
  ])('selects model for $request', async ({ request, expected }) => {
    await new CodexRunner({ bin }).run(makeReq({ model: request }).req);
    expect(flag(records()[0]!.argv, '-m')).toBe(expected);
  });

  it('gives the option model precedence and places extra args before the prompt', async () => {
    await new CodexRunner({
      bin,
      model: 'option-model',
      ignoreUserConfig: true,
      extraArgs: ['--config', 'test_setting=true'],
    }).run(makeReq({ model: 'request-model' }).req);
    const argv = records()[0]!.argv;
    expect(flag(argv, '-m')).toBe('option-model');
    expect(argv).toContain('--ignore-user-config');
    expect(argv.slice(-3, -1)).toEqual(['--config', 'test_setting=true']);
    expect(argv.at(-1)).toBe('-');
    expect(records()[0]!.stdin).toContain('do the thing');
  });

  it('uses workspace-write without --add-dir and delegates committing to Maestro', async () => {
    const { worktree } = await makeWorktree();
    const { req } = makeReq({
      cwd: worktree,
      isolated: true,
      tools: buildTools(['shell', 'git_commit'], true),
      system: WRITER_INSTRUCTION,
    });
    expect((await new CodexRunner({ bin }).run(req)).status).toBe('ok');
    const call = records()[0]!;
    expect(flag(call.argv, '-s')).toBe('workspace-write');
    expect(flag(call.argv, '-C')).toBe(worktree);
    expect(call.argv).not.toContain('--add-dir');
    expect(call.stdin).toContain(WRITER_INSTRUCTION);
    expect(call.stdin).toMatch(/do not run git commit/i);
    expect(call.stdin).toMatch(/read-only/i);
    expect(call.stdin).toMatch(/Maestro commits/);
  });

  it('rejects write tools without isolation before spawning', async () => {
    const req = makeReq({ tools: buildTools(['shell'], true) }).req;
    await expect(new CodexRunner({ bin }).run(req)).rejects.toBeInstanceOf(MaestroError);
    await expect(new CodexRunner({ bin }).run(req)).rejects.toMatchObject({
      code: 'write_tool_without_isolation',
    });
    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('warns once with all unsupported custom tools and never calls their implementations', async () => {
    const custom = (name: string): ToolDef => ({
      name,
      description: 'custom tool',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      write: false,
      run: vi.fn(async () => 'must not be called'),
    });
    const tools = [custom('search_papers'), custom('lookup_database')];
    const { req, logs } = makeReq({ tools: [...buildTools(undefined, false), ...tools] });
    expect((await new CodexRunner({ bin }).run(req)).status).toBe('ok');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('search_papers');
    expect(logs[0]).toContain('lookup_database');
    expect(logs[0]).toMatch(/own shell tools/i);
    for (const tool of tools) expect(tool.run).not.toHaveBeenCalled();
  });

  it('does not warn for built-in tools', async () => {
    const { req, logs } = makeReq();
    await new CodexRunner({ bin }).run(req);
    expect(logs).toEqual([]);
  });
});

describe('CodexRunner: runner-side commits', () => {
  it('commits isolated edits once with a clean tree, local identity and a 72-character subject', async () => {
    const { worktree, base } = await makeWorktree();
    scenario({
      files: { 'written.txt': 'created by fake Codex\n', 'a.txt': 'changed\n' },
      finalText: 'written',
      steps: [{ event: turn({}) }],
    });
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) {
      vi.stubEnv(key, path.join(cwd, 'foreign-git-location'));
    }
    const firstLine = `  Implement ${'a useful change '.repeat(10)}  `;
    const result = await new CodexRunner({ bin }).run(
      makeReq({ cwd: worktree, isolated: true, prompt: `${firstLine}\nDo not include the second line.` }).req,
    );
    expect(result).toMatchObject({ result: 'written', status: 'ok' });
    expect(git(worktree, 'rev-list', '--count', `${base}..HEAD`)).toBe('1');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'log', '-1', '--format=%s')).toBe(
      `maestro(codex): ${firstLine.trim()}`.slice(0, 72),
    );
    expect(git(worktree, 'log', '-1', '--format=%an <%ae>')).toBe('Test Writer <writer@example.com>');
    expect(git(worktree, 'show', 'HEAD:written.txt')).toBe('created by fake Codex');
    expect(git(worktree, 'show', 'HEAD:a.txt')).toBe('changed');
    expect(records()[0]!.argv).not.toContain('--add-dir');
  });

  it('does not create an empty commit for a successful unchanged isolated run', async () => {
    const { worktree, base } = await makeWorktree();
    expect(await new CodexRunner({ bin }).run(makeReq({ cwd: worktree, isolated: true }).req)).toMatchObject({
      result: 'done',
      status: 'ok',
    });
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it.each([
    { name: 'invalid JSON', finalText: 'not JSON', steps: [{ event: turn({}) }], schema: { type: 'object' } },
    {
      name: 'schema violation',
      finalText: '{"count":0}',
      steps: [{ event: turn({}) }],
      schema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] },
    },
    {
      name: 'failed turn',
      steps: [
        { event: message('still working') },
        { event: { type: 'turn.failed', error: { message: 'writer failed' } } },
      ],
    },
    { name: 'non-zero exit', finalText: 'written', exitCode: 1, steps: [{ event: turn({}) }] },
    { name: 'missing completion', finalText: 'written' },
    { name: 'no final text', steps: [{ event: turn({}) }] },
  ])('leaves changes uncommitted on $name', async ({ name: _name, schema, ...failed }) => {
    const { worktree, base } = await makeWorktree();
    scenario({ ...failed, files: { 'written.txt': 'audit me' } });
    const result = await new CodexRunner({ bin }).run(makeReq({ cwd: worktree, isolated: true, schema }).req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    expect(result.error).toBeTruthy();
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(worktree, 'status', '--porcelain')).toBe('?? written.txt');
  });

  it('does not commit a successful read-only run even if the fake writes files', async () => {
    const { worktree, base } = await makeWorktree();
    scenario({ files: { 'written.txt': 'audit me' }, finalText: 'done', steps: [{ event: turn({}) }] });
    const result = await new CodexRunner({ bin }).run(makeReq({ cwd: worktree, isolated: false }).req);
    expect(result).toMatchObject({ result: 'done', status: 'ok' });
    expect(flag(records()[0]!.argv, '-s')).toBe('read-only');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(worktree, 'status', '--porcelain')).toBe('?? written.txt');
  });

  it('returns null with git stderr when the runner-side commit fails', async () => {
    const { repo, worktree, base } = await makeWorktree();
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf "  hook rejected writer commit  " >&2\nexit 1\n');
    await chmod(hook, 0o755);
    scenario({ files: { 'written.txt': 'audit me' }, finalText: 'done', steps: [{ event: turn({}) }] });
    const result = await new CodexRunner({ bin }).run(makeReq({ cwd: worktree, isolated: true }).req);
    expect(result).toMatchObject({ result: null, status: 'null' });
    expect(result.error).toMatch(/runner-side commit failed/i);
    expect(result.error).toContain('hook rejected writer commit');
    expect(result.error).not.toContain('  hook rejected writer commit  ');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(worktree, 'status', '--porcelain')).toBe('A  written.txt');
  });

  it('leaves an aborted writer dirty even after receiving turn.completed', async () => {
    const { worktree, base } = await makeWorktree();
    scenario({ files: { 'written.txt': 'audit me' }, hold: true, steps: [{ event: turn({}) }] });
    const { req, controller } = makeReq({ cwd: worktree, isolated: true });
    req.onUsage = () => controller.abort();
    expect(await new CodexRunner({ bin, killGraceMs: 30 }).run(req)).toMatchObject({
      result: null,
      status: 'skipped',
      error: 'aborted',
    });
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(worktree, 'status', '--porcelain')).toBe('?? written.txt');
  });
});

describe('CodexRunner: abort', () => {
  it('does not spawn for an already-aborted request', async () => {
    const { req, controller, usages } = makeReq();
    controller.abort();
    expect(await new CodexRunner({ bin }).run(req)).toMatchObject({
      result: null,
      status: 'skipped',
      error: 'aborted',
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(usages).toEqual([]);
    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])(
    'kills a running child (ignores SIGTERM: %s) and preserves usage',
    async (ignoreTerm) => {
      scenario({
        ignoreTerm,
        hold: true,
        steps: [{ event: turn({ input_tokens: 12, cached_input_tokens: 2, output_tokens: 4 }) }],
      });
      const { req, usages, controller } = makeReq();
      req.onUsage = (usage) => {
        usages.push(usage);
        controller.abort();
      };
      const result = await new CodexRunner({ bin, killGraceMs: 30 }).run(req);
      expect(result).toMatchObject({
        result: null,
        status: 'skipped',
        error: 'aborted',
        turns: 1,
        usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 4 },
      });
      expect(usages).toHaveLength(1);
      const [call] = records();
      expect(() => process.kill(call!.pid, 0)).toThrow();
      await expectTempsRemoved(call!.argv);
    },
  );

  it.each([false, true])(
    'kills a SIGTERM-ignoring grandchild that inherits stdout (leader already exited: %s)',
    async (leaderExited) => {
      scenario({ grandchild: 'group', hold: !leaderExited });
      const { req, controller } = makeReq();
      const pending = new CodexRunner({ bin, killGraceMs: 30 }).run(req);
      await vi.waitFor(() => expect(records()[0]!.grandchildPid).toBeGreaterThan(0));
      const call = records()[0]!;
      if (leaderExited) await vi.waitFor(() => expect(() => process.kill(call.pid, 0)).toThrow());
      const started = Date.now();
      controller.abort();
      expect(await pending).toMatchObject({ result: null, status: 'skipped', error: 'aborted' });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(() => process.kill(call.pid, 0)).toThrow();
      await vi.waitFor(() => expect(() => process.kill(call.grandchildPid!, 0)).toThrow());
      await expectTempsRemoved(call.argv);
    },
  );

  it('bounds cancellation when an escaped descendant still holds stdout open', async () => {
    scenario({ grandchild: 'escaped', hold: true });
    const { req, controller } = makeReq();
    const pending = new CodexRunner({ bin, killGraceMs: 30 }).run(req);
    await vi.waitFor(() => expect(records()[0]!.grandchildPid).toBeGreaterThan(0));
    const call = records()[0]!;
    const started = Date.now();
    controller.abort();
    expect(await pending).toMatchObject({ result: null, status: 'skipped', error: 'aborted' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(() => process.kill(call.pid, 0)).toThrow();
    // It escaped the process group, so only stream destruction can let run() settle.
    expect(() => process.kill(call.grandchildPid!, 0)).not.toThrow();
    await expectTempsRemoved(call.argv);
  });

  it('reacts to an external abort while waiting for output', async () => {
    scenario({ hold: true });
    const { req, controller } = makeReq();
    const result = new CodexRunner({ bin, killGraceMs: 30 }).run(req);
    await vi.waitFor(async () => expect(await readFile(recordPath, 'utf8')).not.toBe(''));
    controller.abort();
    expect(await result).toMatchObject({ result: null, status: 'skipped', error: 'aborted' });
    expect(() => process.kill(records()[0]!.pid, 0)).toThrow();
  });
});
