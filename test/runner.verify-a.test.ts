// Adversarial verification of the runner component (spec 3.2, Level 1 null/throw table, 3.6
// "isolation istenmeyen ajan yazma aracı alamaz"). Tests assert SPEC behaviour and pin tricky
// invariants as a regression suite; all pass since the fixes. Never hits the real API (scripted fetch).

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicRunner, RETURN_CONTRACT, systemPrompt } from '../src/runner.js';
import { buildTools, checkReadOnlyCommand, READ_TOOL_NAMES, shellWords } from '../src/tools.js';
import { MaestroError, type RunRequest, type ToolDef, type Usage } from '../src/types.js';

// ---- scripted Messages API ------------------------------------------------------------------

let idCounter = 0;
function reply(content: unknown[], stop_reason: string, usage: Partial<Usage> = {}, extra = {}) {
  return {
    id: `msg_v_${++idCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: { input_tokens: usage.input_tokens ?? 10, output_tokens: usage.output_tokens ?? 5 },
    ...extra,
  };
}
const text = (t: string) => ({ type: 'text', text: t });

function scripted(steps: unknown[]) {
  const bodies: any[] = [];
  const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const step = steps[bodies.length - 1];
    if (!step) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'script exhausted' },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(step), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { client: new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: fetch as any }), bodies };
}

let cwd: string;
let hasRg = false;
beforeAll(async () => {
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-verify-a-')));
  await fs.writeFile(path.join(cwd, 'f.txt'), 'alpha\nbeta\n');
  // An executable that already lives in the repo (e.g. a project script). Running it mutates the tree.
  await fs.writeFile(path.join(cwd, 'evil.sh'), '#!/bin/sh\ntouch PWNED\necho host\n', { mode: 0o755 });
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    hasRg = true;
  } catch {
    hasRg = false;
  }
});
afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function makeReq(overrides: Partial<RunRequest> = {}) {
  const usages: Usage[] = [];
  const logs: string[] = [];
  const req: RunRequest = {
    prompt: 'p',
    system: systemPrompt({ cwd, writer: false }),
    tools: buildTools(undefined, false),
    model: 'claude-opus-5-5',
    cwd,
    signal: new AbortController().signal,
    isolated: false,
    onUsage: (u) => usages.push(u),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { req, usages, logs };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

// ---- FAILING: spec violations ---------------------------------------------------------------

describe('buildTools: unknown names (brief: unknown name → unknown_tool)', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    it(`"${name}" is not a tool → MaestroError unknown_tool`, () => {
      let err: unknown;
      try {
        buildTools([name], false);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MaestroError);
      expect((err as MaestroError).code).toBe('unknown_tool');
    });
  }
});

describe('read-only bash cannot execute programs (spec 3.2 bash(ro), 3.6 no write tool without isolation)', () => {
  it('rg --hostname-bin (runs an arbitrary program) is rejected by the allowlist', () => {
    expect(() =>
      checkReadOnlyCommand('rg --hostname-bin=./evil.sh --hyperlink-format=default alpha f.txt', cwd),
    ).toThrow(/not allowed/);
  });

  it('a non-isolated agent cannot mutate the working tree through the read set (end to end)', async () => {
    if (!hasRg) return; // rg not installed: the pure allowlist test above still covers it
    const bash = buildTools(undefined, false).find((t) => t.name === 'bash')!;
    const marker = path.join(cwd, 'PWNED');
    await fs.rm(marker, { force: true });
    try {
      await bash.run(
        { command: 'rg --hostname-bin=./evil.sh --hyperlink-format=default alpha f.txt' },
        { cwd, signal: new AbortController().signal },
      );
    } catch {
      // rejection is the desired outcome
    }
    const mutated = await exists(marker);
    await fs.rm(marker, { force: true });
    expect(mutated).toBe(false);
  });
});

// ---- PASSING: tricky invariants (regression suite) ------------------------------------------

describe('read-only allowlist (regression)', () => {
  const rejected = [
    'rg --pre=./evil.sh alpha',
    'rg --pre ./evil.sh alpha',
    'rg --pre-glob=* alpha',
    'git -c core.pager=./evil.sh log',
    'git --git-dir=/tmp log',
    'git --exec-path=/tmp log',
    'git diff --output=x.txt',
    'git log --output x.txt',
    'git diff --ext-diff',
    'git -C .. log',
    'git commit -m x',
    'find . -delete',
    'find . -execdir rm {} +',
    'find . -exec rm {} +',
    'find . -okdir rm {} +',
    'find . -fprint out.txt',
    'rm f.txt',
    'sh -c ls',
    'cat f.txt; touch x',
    'cat f.txt | tee x',
    'cat f.txt > x',
    'cat $(echo f.txt)',
    'cat `echo f.txt`',
    'ls & touch x',
  ];
  for (const cmd of rejected) {
    it(`rejects: ${cmd}`, () => {
      expect(() => checkReadOnlyCommand(cmd, cwd)).toThrow();
    });
  }

  it('quoted metacharacters are literal argv (no shell is involved)', () => {
    expect(shellWords(`cat 'a;b' "c|d" e\\ f`)).toEqual(['cat', 'a;b', 'c|d', 'e f']);
    expect(checkReadOnlyCommand('git --no-pager -C . log --oneline', cwd)).toEqual([
      'git',
      '--no-pager',
      '-C',
      '.',
      'log',
      '--oneline',
    ]);
  });
});

describe('buildTools isolation rule (regression)', () => {
  it('undefined → exactly the read set, none of them write tools', () => {
    const tools = buildTools(undefined, false);
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOL_NAMES]);
    expect(tools.every((t) => !t.write)).toBe(true);
  });

  for (const name of ['write_file', 'edit_file', 'shell', 'git_commit']) {
    it(`${name} without isolation → write_tool_without_isolation; with isolation → allowed`, () => {
      expect(() => buildTools(['read_file', name], false)).toThrow(
        expect.objectContaining({ code: 'write_tool_without_isolation' }),
      );
      expect(buildTools(['read_file', name], true).map((t) => t.name)).toEqual(['read_file', name]);
    });
  }

  it('every tool input schema is strict (additionalProperties:false, required = all properties)', () => {
    const all = buildTools(
      ['read_file', 'grep', 'glob', 'bash', 'write_file', 'edit_file', 'shell', 'git_commit'],
      true,
    );
    for (const t of all) {
      const s = t.inputSchema as any;
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    }
  });
});

describe('AnthropicRunner contract (regression)', () => {
  it('system prompt carries the literal return contract sentence', () => {
    expect(RETURN_CONTRACT).toContain(
      'Son mesajın bu çağrının dönüş değeridir. Açıklama, selamlama, özet ekleme.',
    );
    expect(systemPrompt({ cwd, writer: false })).toContain(RETURN_CONTRACT);
  });

  it('a write ToolDef handed to a non-isolated run throws before any request', async () => {
    const { client, bodies } = scripted([reply([text('x')], 'end_turn')]);
    const writeTool: ToolDef = buildTools(['write_file'], true)[0]!;
    const { req } = makeReq({ tools: [writeTool], isolated: false });
    await expect(new AnthropicRunner({ client, retryDelayMs: 0 }).run(req)).rejects.toMatchObject({
      code: 'write_tool_without_isolation',
    });
    expect(bodies).toHaveLength(0);
  });

  it('usage is reported before the abort check: the aborting turn is still counted → skipped', async () => {
    const ac = new AbortController();
    const { client, bodies } = scripted([
      reply([{ type: 'tool_use', id: 't1', name: 'glob', input: { pattern: '*' } }], 'tool_use', {
        output_tokens: 9,
      }),
      reply([text('never')], 'end_turn'),
    ]);
    const { req, usages } = makeReq({
      signal: ac.signal,
      onUsage: (u) => {
        usages.push(u);
        ac.abort(); // budget exceeded on this turn
      },
    });
    const res = await new AnthropicRunner({ client, retryDelayMs: 0 }).run(req);
    expect(res.status).toBe('skipped');
    expect(res.result).toBeNull();
    expect(usages).toEqual([{ input_tokens: 10, output_tokens: 9 }]);
    expect(res.usage.output_tokens).toBe(9);
    expect(bodies).toHaveLength(1);
  });

  it('refusal in stage 1 → null, one request, category logged, no stage-2 parse even with a schema', async () => {
    const { client, bodies } = scripted([
      reply(
        [text('no')],
        'refusal',
        {},
        { stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
      ),
    ]);
    const { req, logs } = makeReq({
      schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    });
    const res = await new AnthropicRunner({ client, retryDelayMs: 0 }).run(req);
    expect(res).toMatchObject({ result: null, status: 'null' });
    expect(bodies).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/category: cyber/);
  });
});
