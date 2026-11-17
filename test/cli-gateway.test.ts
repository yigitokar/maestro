import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { CodexRunner } from '../src/codex-runner.js';
import { readEntries } from '../src/journal.js';
import { SUBMIT_RESULT_TOOL_NAME } from '../src/runner.js';
import { mockGateway, textReply, toolReply } from './gateway-helpers.js';

const SCRIPT = `export const meta = { name: 'gateway-cli', description: 'd' };
return await agent('hello');`;
const MIXED = `export const meta = { name: 'gateway-mixed', description: 'd' };
const a = await agent('default');
const b = await agent('override', { model: 'google/gemini-3.1-pro-preview' });
return { a, b };`;
const STRUCTURED = `export const meta = { name: 'gateway-structured', description: 'd' };
return await agent('hello', { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } });`;
const ENV = { AI_GATEWAY_API_KEY: 'cli-gateway-key' };
let cwd: string;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-cli-gateway-')));
  await writeFile(path.join(cwd, 'demo.js'), SCRIPT);
  vi.stubEnv('AI_GATEWAY_API_KEY', 'ambient-gateway-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-anthropic-key');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-anthropic-token');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://unrelated.invalid');
  vi.spyOn(CodexRunner.prototype, 'run').mockRejectedValue(new Error('Unexpected Codex call'));
  mockGateway();
});

afterEach(async () => {
  expect(CodexRunner.prototype.run).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

async function cli(flags: string[] = [], env: Record<string, string | undefined> = ENV) {
  let stdout = '';
  let stderr = '';
  const code = await main(['run', 'demo.js', '--runner', 'gateway', ...flags], {
    cwd,
    env,
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s), isTTY: false },
  });
  return { code, stdout, stderr };
}

async function mcp(flags: string[], env: Record<string, string | undefined>, script: string) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  let stderr = '';
  const code = main(['mcp', '--runner', 'gateway', ...flags], {
    cwd,
    env,
    stdin: toServer,
    stdout: toClient,
    stderr: { write: (s) => (stderr += s), isTTY: false },
  });
  const client = new Client({ name: 'gateway-tests', version: '0.0.0' });
  try {
    await client.connect(new StdioServerTransport(toClient, toServer));
    const started = await client.callTool({ name: 'Workflow', arguments: { script } });
    expect(started.isError).toBeFalsy();
    const { runId } = JSON.parse((started.content as any)[0].text);
    const completed = await client.callTool({ name: 'WorkflowResult', arguments: { runId, wait: true } });
    return {
      result: JSON.parse((completed.content as any)[0].text),
      stderr,
      rows: await readEntries(path.join(cwd, '.maestro', 'runs', runId)),
    };
  } finally {
    toServer.end();
    expect(await code).toBe(0);
    await client.close();
  }
}

function checkRequests(requests: ReturnType<typeof mockGateway>['requests'], models: string[]) {
  expect(requests.map((r) => r.body.model)).toEqual(models);
  for (const r of requests) {
    expect(r.url).toBe('https://ai-gateway.vercel.sh/v1/messages');
    expect(r.headers.get('authorization')).toBe('Bearer cli-gateway-key');
    expect(JSON.stringify([...r.headers])).not.toContain('ambient');
  }
}

describe('Gateway CLI/workflow wiring', () => {
  it('run passes io.env credentials, --model default and per-agent overrides to real SDK requests', async () => {
    await writeFile(path.join(cwd, 'demo.js'), MIXED);
    const { requests } = mockGateway(textReply('a'), textReply('b'));
    const res = await cli(['--model', 'openai/gpt-5.4']);
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ a: 'a', b: 'b' });
    checkRequests(requests, ['openai/gpt-5.4', 'google/gemini-3.1-pro-preview']);
    expect(res.stderr).not.toContain('cli-gateway-key');
  });

  it('allows a workflow with only per-agent models and no --model', async () => {
    await writeFile(
      path.join(cwd, 'demo.js'),
      SCRIPT.replace("agent('hello')", "agent('hello', { model: 'anthropic/claude-sonnet-4.6' })"),
    );
    const { requests } = mockGateway(textReply());
    const res = await cli();
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('done');
    checkRequests(requests, ['anthropic/claude-sonnet-4.6']);
  });

  it.each([{}, { AI_GATEWAY_API_KEY: '' }, { AI_GATEWAY_API_KEY: '  ' }])(
    'preflights missing/blank io.env key: %j',
    async (env) => {
      const res = await cli(['--model', 'openai/gpt-5.4'], env);
      expect(res.code).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('AI_GATEWAY_API_KEY is missing or blank');
      expect(res.stderr).toContain('--dry-run');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects the implicit direct Claude model with an actionable diagnostic', async () => {
    const res = await cli();
    expect(JSON.parse(res.stdout)).toBeNull();
    expect(res.stderr).toContain('Gateway requires an explicit provider/model ID');
    expect(res.stderr).toContain('--model');
    expect(res.stderr).toContain('agent opts.model');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('run --dry-run bypasses both model validation and auth', async () => {
    const res = await cli(['--dry-run'], {});
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('fake result for: hello');
    expect(res.stderr).not.toContain('AI_GATEWAY_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'single-stage', 'two-stage'] as const)(
    'run honors structured mode %s',
    async (mode) => {
      await writeFile(path.join(cwd, 'demo.js'), STRUCTURED);
      const replies =
        mode === undefined
          ? [toolReply(SUBMIT_RESULT_TOOL_NAME, { answer: 'yes' })]
          : mode === 'two-stage'
            ? [textReply('findings'), textReply('{"answer":"yes"}')]
            : [textReply('{"answer":"yes"}')];
      const { requests } = mockGateway(...replies);
      const res = await cli(['--model', 'openai/gpt-5.4', ...(mode ? ['--structured-mode', mode] : [])]);
      expect(res.code, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ answer: 'yes' });
      expect(requests[0]!.body.tools.some((t: any) => t.name === SUBMIT_RESULT_TOOL_NAME)).toBe(
        mode === undefined,
      );
      if (mode) expect(requests.at(-1)!.body.output_config.format.type).toBe('json_schema');
    },
  );

  it('mcp passes io.env, --model and per-agent overrides through Workflow', async () => {
    const { requests } = mockGateway(textReply('a'), textReply('b'));
    const res = await mcp(['--model', 'openai/gpt-5.4'], ENV, MIXED);
    expect(res.result).toMatchObject({ status: 'done', result: { a: 'a', b: 'b' } });
    expect(res.stderr).toBe('');
    checkRequests(requests, ['openai/gpt-5.4', 'google/gemini-3.1-pro-preview']);
    expect(res.rows.map((r) => r.usage.output_tokens)).toEqual([5, 5]);
  });

  it.each([{}, { AI_GATEWAY_API_KEY: ' ' }])(
    'mcp warns but starts with missing/blank io.env credentials: %j',
    async (env) => {
      const res = await mcp(['--model', 'openai/gpt-5.4'], env, SCRIPT);
      expect(res.stderr).toContain('AI_GATEWAY_API_KEY is missing or blank; Workflow runs will fail');
      expect(res.result).toMatchObject({ status: 'done', result: null });
      expect(res.rows[0]!.error).toContain('AI_GATEWAY_API_KEY is missing or blank');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('mcp --dry-run bypasses auth and model validation without warning', async () => {
    const res = await mcp(['--dry-run'], {}, SCRIPT);
    expect(res.result).toMatchObject({ status: 'done', result: 'fake result for: hello' });
    expect(res.stderr).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'single-stage'] as const)('mcp honors structured mode %s', async (mode) => {
    const { requests } = mockGateway(
      mode ? textReply('{"answer":"yes"}') : toolReply(SUBMIT_RESULT_TOOL_NAME, { answer: 'yes' }),
    );
    const res = await mcp(
      ['--model', 'openai/gpt-5.4', ...(mode ? ['--structured-mode', mode] : [])],
      ENV,
      STRUCTURED,
    );
    expect(res.result).toMatchObject({ status: 'done', result: { answer: 'yes' } });
    expect(requests[0]!.body.tools.some((t: any) => t.name === SUBMIT_RESULT_TOOL_NAME)).toBe(
      mode === undefined,
    );
  });
});
