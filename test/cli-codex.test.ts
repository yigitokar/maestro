// Exercise runner selection through the real CLI/workflow and MCP paths, with model calls stubbed.

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { CodexRunner } from '../src/codex-runner.js';
import { AnthropicRunner } from '../src/runner.js';
import type { RunRequest, RunResult } from '../src/types.js';

const dirs: string[] = [];
const SCRIPT = `export const meta = { name: 'runner-selection', description: 'd' };
return await agent('hello');`;

function response(req: RunRequest, result: string): RunResult {
  const usage = { input_tokens: 12, output_tokens: 3 };
  req.onUsage(usage);
  return { status: 'ok', result, usage, turns: 1 };
}

beforeEach(() => {
  // Neither a Codex subprocess nor an Anthropic request can run in these CLI tests.
  vi.spyOn(CodexRunner.prototype, 'run').mockImplementation(async (req) => response(req, 'codex'));
  vi.spyOn(AnthropicRunner.prototype, 'run').mockImplementation(async (req) => response(req, 'anthropic'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-cli-codex-')));
  dirs.push(dir);
  await writeFile(path.join(dir, 'demo.js'), SCRIPT);
  return dir;
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

describe('CLI runner selection', () => {
  it('run --runner codex needs no Anthropic key and forwards --model through the workflow', async () => {
    const res = await cli(['run', 'demo.js', '--runner', 'codex', '--model', 'codex-model'], await tmp());
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('codex');
    expect(res.stderr).not.toContain('ANTHROPIC_API_KEY');
    expect(CodexRunner.prototype.run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ model: 'codex-model', prompt: 'hello' }),
    );
    expect(AnthropicRunner.prototype.run).not.toHaveBeenCalled();
  });

  it.each([{ flags: [] }, { flags: ['--runner', 'anthropic'] }])(
    'run $flags retains the Anthropic default',
    async ({ flags }) => {
      const res = await cli(['run', 'demo.js', ...flags], await tmp(), { ANTHROPIC_API_KEY: 'test-key' });
      expect(res.code, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toBe('anthropic');
      expect(AnthropicRunner.prototype.run).toHaveBeenCalledOnce();
      expect(CodexRunner.prototype.run).not.toHaveBeenCalled();
    },
  );

  it('run --dry-run wins over --runner codex', async () => {
    const res = await cli(['run', 'demo.js', '--runner=codex', '--dry-run'], await tmp());
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('fake result for: hello');
    expect(CodexRunner.prototype.run).not.toHaveBeenCalled();
    expect(AnthropicRunner.prototype.run).not.toHaveBeenCalled();
  });

  it.each([
    ['run', 'demo.js', '--runner', 'unknown'],
    ['run', 'demo.js', '--runner', 'unknown', '--dry-run'],
    ['mcp', '--runner', 'unknown'],
    ['mcp', '--runner', 'unknown', '--dry-run'],
  ])('%j rejects unknown runner values with usage', async (...argv) => {
    const res = await cli(argv, await tmp());
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('invalid --runner "unknown"');
    expect(res.stderr).toContain('usage:');
    expect(CodexRunner.prototype.run).not.toHaveBeenCalled();
    expect(AnthropicRunner.prototype.run).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'mcp --runner codex (dry-run=%s) uses the selected runner without a key',
    async (dryRun) => {
      const cwd = await tmp();
      const toServer = new PassThrough();
      const toClient = new PassThrough();
      let stderr = '';
      const code = main(
        ['mcp', '--runner', 'codex', '--model', 'codex-model', ...(dryRun ? ['--dry-run'] : [])],
        {
          cwd,
          env: {},
          stdin: toServer,
          stdout: toClient,
          stderr: { write: (s: string) => (stderr += s), isTTY: false },
        },
      );
      const client = new Client({ name: 'runner-selection', version: '0.0.0' });
      try {
        await client.connect(new StdioServerTransport(toClient, toServer));
        const started = await client.callTool({ name: 'Workflow', arguments: { script: SCRIPT } });
        const { runId } = JSON.parse((started.content as any)[0].text);
        const completed = await client.callTool({ name: 'WorkflowResult', arguments: { runId, wait: true } });
        expect(JSON.parse((completed.content as any)[0].text)).toMatchObject({
          status: 'done',
          result: dryRun ? 'fake result for: hello' : 'codex',
        });
        expect(stderr).toBe('');
        if (dryRun) expect(CodexRunner.prototype.run).not.toHaveBeenCalled();
        else {
          expect(CodexRunner.prototype.run).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ model: 'codex-model' }),
          );
        }
        expect(AnthropicRunner.prototype.run).not.toHaveBeenCalled();
      } finally {
        toServer.end();
        expect(await code).toBe(0);
        await client.close();
      }
    },
  );
});
