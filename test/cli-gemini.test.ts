import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { GeminiRunner } from '../src/gemini-runner.js';
import { readEntries } from '../src/journal.js';

const SCRIPT = `export const meta = { name: 'gemini-cli', description: 'd' };
return await agent('hello', { label: 'greet' });`;

let cwd: string;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-cli-gemini-')));
  await writeFile(path.join(cwd, 'demo.js'), SCRIPT);
  vi.stubEnv('GEMINI_API_KEY', 'ambient-gemini-key');
  vi.stubEnv('GOOGLE_API_KEY', 'ambient-google-key');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

async function cli(args: string[], env: Record<string, string | undefined>) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    cwd,
    env,
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s), isTTY: false },
  });
  return { code, stdout, stderr };
}

describe('Gemini CLI/MCP wiring', () => {
  it.each([{}, { GEMINI_API_KEY: '' }, { GEMINI_API_KEY: '   ' }])(
    'preflights missing/blank io.env credentials for --runner gemini: %j',
    async (env) => {
      const res = await cli(['run', 'demo.js', '--runner', 'gemini'], env);
      expect(res.code).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('GEMINI_API_KEY');
      expect(res.stderr).toContain('--dry-run');
    },
  );

  it('accepts GOOGLE_API_KEY fallback and forwards requests to GeminiRunner', async () => {
    const spy = vi.spyOn(GeminiRunner.prototype, 'run').mockResolvedValue({
      status: 'ok',
      result: 'gemini-ok',
      usage: { input_tokens: 10, output_tokens: 5 },
      turns: 1,
    });
    const res = await cli(['run', 'demo.js', '--runner', 'gemini', '--model', 'gemini-4-carbon'], {
      GOOGLE_API_KEY: 'cli-google-key',
    });
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('gemini-ok');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].model).toBe('gemini-4-carbon');
  });

  it('--runner auto routes gemini-* agents to GeminiRunner without requiring ANTHROPIC_API_KEY', async () => {
    await writeFile(
      path.join(cwd, 'auto.js'),
      `export const meta = { name: 'auto-gemini', description: 'd' };
return await agent('ingest', { model: 'gemini-4-hydrogen' });`,
    );
    const spy = vi.spyOn(GeminiRunner.prototype, 'run').mockResolvedValue({
      status: 'ok',
      result: 'auto-routed',
      usage: { input_tokens: 12, output_tokens: 6 },
      turns: 1,
    });
    const res = await cli(['run', 'auto.js', '--runner', 'auto'], { GEMINI_API_KEY: 'cli-gemini-key' });
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('auto-routed');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('--runner gemini --dry-run bypasses credentials', async () => {
    const res = await cli(['run', 'demo.js', '--runner', 'gemini', '--dry-run'], {});
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('fake result for: hello');
  });

  it('mcp --runner gemini warns when credentials are missing and isolates io.env', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    let stderr = '';
    const code = main(['mcp', '--runner', 'gemini'], {
      cwd,
      env: {},
      stdin: toServer,
      stdout: toClient,
      stderr: { write: (s) => (stderr += s), isTTY: false },
    });
    const client = new Client({ name: 'gemini-mcp-test', version: '0.0.0' });
    try {
      await client.connect(new StdioServerTransport(toClient, toServer));
      const started = await client.callTool({ name: 'Workflow', arguments: { script: SCRIPT } });
      const { runId } = JSON.parse((started.content as any)[0].text);
      const completed = await client.callTool({ name: 'WorkflowResult', arguments: { runId, wait: true } });
      expect(stderr).toContain('GEMINI_API_KEY (or GOOGLE_API_KEY) is missing or blank');
      expect(JSON.parse((completed.content as any)[0].text)).toMatchObject({ status: 'done', result: null });
      const rows = await readEntries(path.join(cwd, '.maestro', 'runs', runId));
      expect(rows[0]!.error).toContain('GEMINI_API_KEY');
    } finally {
      toServer.end();
      expect(await code).toBe(0);
      await client.close();
    }
  });
});
