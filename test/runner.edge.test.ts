// Edge cases and failure modes of the agent runner and the tools it hands to an agent, checked against
// docs/spec.md 3.2 (abort at every point of a run, turn cap, refusal, isolation rule; 3.6 for write
// tools). Never hits the network: the real SDK runs over a scripted fetch.

import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicRunner, systemPrompt } from '../src/runner.js';
import {
  buildTools,
  checkReadOnlyCommand,
  READ_TOOL_NAMES,
  shellWords,
  WRITE_TOOL_NAMES,
} from '../src/tools.js';
import { MaestroError, type RunRequest, type ToolDef, type Usage } from '../src/types.js';

// ---- scripted Messages API (no network) -----------------------------------------------------

type Step =
  | { status: number; body: unknown }
  | ((body: any, signal: AbortSignal | undefined) => Promise<Response> | Response);

let idCounter = 0;
function reply(
  content: unknown[],
  stop_reason: string,
  usage: Partial<Usage> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    status: 200,
    body: {
      id: `msg_edge_${++idCounter}`,
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
    },
  };
}
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const json = (s: { status: number; body: unknown }) =>
  new Response(JSON.stringify(s.body), { status: s.status, headers: { 'content-type': 'application/json' } });

/** A fetch that never answers until its signal aborts (then rejects like real fetch). */
function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    if (signal?.aborted) return fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/** A request that is in flight (its fetch is pending on the signal) at the moment `ac` aborts. */
const abortInFlight =
  (ac: AbortController): Step =>
  (_body, signal) => {
    const pending = hang(signal);
    ac.abort();
    return pending;
  };

function scripted(steps: Step[]) {
  const bodies: any[] = [];
  const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    const step = steps[bodies.length - 1];
    if (!step) {
      return json({
        status: 400,
        body: { type: 'error', error: { type: 'invalid_request_error', message: 'script exhausted' } },
      });
    }
    if (typeof step === 'function') return step(body, init?.signal ?? undefined);
    return json(step);
  };
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: fetch as any });
  return { client, bodies };
}

let cwd: string;
beforeAll(async () => {
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-runner-edge-')));
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(cwd, 'f.txt'), 'alpha\nbeta\n');
});
afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function makeReq(overrides: Partial<RunRequest> = {}) {
  const usages: Usage[] = [];
  const logs: string[] = [];
  const req: RunRequest = {
    prompt: 'do the thing',
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

const runnerFor = (client: Anthropic, opts: { maxTurns?: number; retryDelayMs?: number } = {}) =>
  new AnthropicRunner({ client, retryDelayMs: 0, ...opts });

const SCHEMA = {
  type: 'object',
  properties: { n: { type: 'integer' } },
  required: ['n'],
};

function hasBinary(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const rgAvailable = hasBinary('rg');

function git(dir: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

// ---- abort at every point (spec 3.2 "AbortSignal: devam eden istek iptal, status: 'skipped'") ----

describe('runner: abort at every point of a run → skipped', () => {
  it('abort while a tool is running → skipped, the tool sees the signal, no further model request', async () => {
    const ac = new AbortController();
    const slowTool: ToolDef = {
      name: 'slow',
      description: 'waits until aborted',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      write: false,
      // Settles only through ctx.signal: if the run's signal did not reach the tool, the test times out.
      run: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          ac.abort();
        }),
    };
    const { client, bodies } = scripted([
      reply([toolUse('t1', 'slow', {})], 'tool_use'),
      reply([text('should never be asked')], 'end_turn'),
    ]);
    const { req, usages } = makeReq({ tools: [slowTool], signal: ac.signal });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', error: 'aborted', turns: 1 });
    expect(res.trace?.toolCalls).toEqual([{ tool: 'slow', inputSummary: '{}', ok: false }]);
    expect(usages).toHaveLength(1);
    // The tool result is never sent back: only the first request reached the API.
    expect(bodies).toHaveLength(1);
  });

  it('abort during the runner-level retry wait → skipped without waiting out the delay', async () => {
    const ac = new AbortController();
    const { client, bodies } = scripted([
      { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } },
      reply([text('late')], 'end_turn'),
    ]);
    const logs: string[] = [];
    const { req } = makeReq({
      signal: ac.signal,
      log: (m) => {
        logs.push(m);
        // The runner logs, then starts the wait: the abort lands once the 20 s wait is under way.
        if (m.includes('retrying once')) setImmediate(() => ac.abort());
      },
    });
    const t0 = Date.now();
    const res = await runnerFor(client, { retryDelayMs: 20_000 }).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 0 });
    expect(logs.join('\n')).toMatch(/429.*retrying once in 20000 ms/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(bodies).toHaveLength(1);
  }, 10_000);

  it('abort while the stage-2 parse request is in flight → skipped; stage-1 usage still reported', async () => {
    const ac = new AbortController();
    const { client, bodies } = scripted([
      reply([text('found n = 3')], 'end_turn', { output_tokens: 7 }),
      abortInFlight(ac),
    ]);
    const { req, usages } = makeReq({ signal: ac.signal, schema: SCHEMA });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 1 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].output_config.format.type).toBe('json_schema'); // it was the parse request
    expect(usages).toEqual([{ input_tokens: 10, output_tokens: 7 }]);
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 7 });
  });

  it('budget exceeded on the final stage-1 turn (onUsage aborts) → skipped, stage 2 never sent', async () => {
    const ac = new AbortController();
    const { client, bodies } = scripted([
      reply([text('done')], 'end_turn', { output_tokens: 999 }),
      reply([text('{"n":1}')], 'end_turn'),
    ]);
    const { req } = makeReq({
      signal: ac.signal,
      schema: SCHEMA,
      onUsage: (u) => {
        if (u.output_tokens > 100) ac.abort();
      },
    });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 1 });
    expect(res.usage.output_tokens).toBe(999);
    expect(bodies).toHaveLength(1);
  });

  it('budget exceeded on the stage-2 turn → skipped even though the object parsed', async () => {
    const ac = new AbortController();
    let calls = 0;
    const { client, bodies } = scripted([
      reply([text('found')], 'end_turn', { output_tokens: 5 }),
      reply([text('{"n":1}')], 'end_turn', { output_tokens: 500 }),
    ]);
    const { req } = makeReq({
      signal: ac.signal,
      schema: SCHEMA,
      onUsage: () => {
        if (++calls === 2) ac.abort();
      },
    });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 2 });
    expect(res.usage.output_tokens).toBe(505);
    expect(bodies).toHaveLength(2);
  });

  it('abort while the max_tokens continuation request is in flight → skipped', async () => {
    const ac = new AbortController();
    const { client, bodies } = scripted([reply([text('partial')], 'max_tokens'), abortInFlight(ac)]);
    const { req } = makeReq({ signal: ac.signal });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 1 });
    expect(bodies).toHaveLength(2);
    const sent = bodies[1].messages;
    expect(sent[sent.length - 1].content).toMatch(/devam et.*continue/); // it was the continuation
  });
});

// ---- turn cap and refusal -------------------------------------------------------------------

describe('runner: turn cap boundary and refusal with a schema', () => {
  it('finishing exactly on the last allowed turn is ok; one more tool turn is the turn cap', async () => {
    const read = (id: string) => toolUse(id, 'read_file', { path: 'notes.txt', offset: null, limit: null });
    const ok = scripted([
      reply([read('a')], 'tool_use'),
      reply([read('b')], 'tool_use'),
      reply([text('fine')], 'end_turn'),
    ]);
    const r1 = await runnerFor(ok.client, { maxTurns: 3 }).run(makeReq().req);
    expect(r1).toMatchObject({ status: 'ok', result: 'fine', turns: 3 });
    expect(ok.bodies).toHaveLength(3);

    const capped = scripted([
      reply([read('a')], 'tool_use'),
      reply([read('b')], 'tool_use'),
      reply([read('c')], 'tool_use'),
      reply([text('too late')], 'end_turn'),
    ]);
    const { req, logs } = makeReq();
    const r2 = await runnerFor(capped.client, { maxTurns: 3 }).run(req);
    expect(r2).toMatchObject({ result: null, status: 'null', turns: 3 });
    expect(capped.bodies).toHaveLength(3);
    expect(logs.join('\n')).toMatch(/turn cap: agent still calling tools after 3 turns/);
  });

  it('refusal in stage 1 → null, category logged, no stage-2 parse even with a schema', async () => {
    const { client, bodies } = scripted([
      reply(
        [text('no')],
        'refusal',
        {},
        { stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
      ),
      reply([text('{"n":1}')], 'end_turn'),
    ]);
    const { req, logs } = makeReq({ schema: SCHEMA });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', turns: 1 });
    expect(res.error).toMatch(/refusal \(category: cyber\)/);
    expect(bodies).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/category: cyber/);
  });
});

// ---- isolation enforcement (spec 3.2 / 3.6) -------------------------------------------------

describe('buildTools and the runner: unknown names and the isolation rule', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'an Object.prototype name (%s) is not a tool → MaestroError unknown_tool',
    (name) => {
      let err: unknown;
      try {
        buildTools([name], false);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MaestroError);
      expect((err as MaestroError).code).toBe('unknown_tool');
    },
  );

  it('every write tool is refused without isolation, in buildTools and in the runner; allowed with it', async () => {
    const isolatedSet = buildTools([...WRITE_TOOL_NAMES], true);
    for (const name of WRITE_TOOL_NAMES) {
      expect(() => buildTools([name], false)).toThrow(
        expect.objectContaining({
          code: 'write_tool_without_isolation',
          message: expect.stringMatching(/isolation/),
        }),
      );
      expect(buildTools(['read_file', name], true).map((t) => t.name)).toEqual(['read_file', name]);
      const t = isolatedSet.find((x) => x.name === name)!;
      const { client, bodies } = scripted([reply([text('x')], 'end_turn')]);
      await expect(runnerFor(client).run(makeReq({ tools: [t], isolated: false }).req)).rejects.toMatchObject(
        { code: 'write_tool_without_isolation' },
      );
      expect(bodies).toHaveLength(0);
    }
  });

  it('the default set is exactly READ_TOOL_NAMES and contains no write tool', () => {
    const tools = buildTools(undefined, false);
    expect(tools.map((t) => t.name)).toEqual([...READ_TOOL_NAMES]);
    expect(tools.every((t) => !t.write)).toBe(true);
  });
});

// ---- read-only bash allowlist escapes -------------------------------------------------------

describe('read-only bash: cannot execute programs or write', () => {
  // rg --hostname-bin=<PROG> makes ripgrep execute PROG (same class as --pre).
  it.each([
    'rg --hostname-bin=./evil.sh a notes.txt',
    'rg --hostname-bin ./evil.sh a notes.txt',
    'rg --hostname-bin=./evil.sh --hyperlink-format=default alpha f.txt',
  ])('rejects %j as not allowed', (cmd) => {
    expect(() => checkReadOnlyCommand(cmd, cwd)).toThrow(/not allowed/);
  });

  it
    .skipIf(!rgAvailable)
    .each([
      'rg --hostname-bin=./evil.sh a f.txt',
      'rg --hostname-bin=./evil.sh --hyperlink-format=default a f.txt',
    ])('end to end: the bash tool refuses %j and the program does not run', async (command) => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-runner-edge-rg-')));
    try {
      await fs.writeFile(path.join(dir, 'f.txt'), 'a\n');
      // An executable that already lives in the tree; running it leaves a marker file.
      await fs.writeFile(path.join(dir, 'evil.sh'), '#!/bin/sh\ntouch PWNED\necho host\n', { mode: 0o755 });
      const bash = buildTools(undefined, false).find((t) => t.name === 'bash')!;
      const ctx = { cwd: dir, signal: new AbortController().signal };
      await expect(bash.run({ command }, ctx)).rejects.toThrow(/not allowed/);
      expect(existsSync(path.join(dir, 'PWNED'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Variants of the commands test/tools.test.ts rejects: other argument forms, quoted flags, more programs.
  it.each([
    'rg --pre=./evil.sh alpha',
    'rg --pre ./evil.sh alpha',
    'rg --pre=cat a',
    "rg '--pre' cat a",
    'rg --pre-glob=* alpha',
    'git -c core.pager=./evil.sh log',
    'git -c core.pager=touch log',
    'git --git-dir=/tmp log',
    'git --git-dir=/tmp/x log',
    'git --exec-path=/tmp log',
    'git diff --output=x.txt',
    'git log --output x.txt',
    'git diff --ext-diff',
    'git show --ext-diff',
    'find . -exec rm {} +',
    "find . '-exec' touch x ;",
    'find . "-delete"',
    'find . -okdir rm {} +',
    'find . -okdir rm {} ;',
    'find . -fprint out.txt',
    'rm f.txt',
    'touch x',
    'env touch x',
    'sh -c ls',
    'cat f.txt; touch x',
    'ls; touch x',
    'ls && touch x',
    'ls & touch x',
    'ls\ntouch x',
    'cat f.txt | tee x',
    'cat a | tee b',
    'cat f.txt > x',
    'cat $(echo f.txt)',
    'cat $(touch x)',
    'cat `echo f.txt`',
    'cat `touch x`',
  ])('rejects %j', (cmd) => {
    expect(() => checkReadOnlyCommand(cmd, cwd)).toThrow(
      /not allowed|metacharacter|outside the working directory/,
    );
  });

  it('quoted metacharacters are literal argv; an allowed command returns its argv', () => {
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

  it('a quoted "$(touch PWNED)" is a literal file name (no shell): nothing runs', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-runner-edge-q-')));
    try {
      const bash = buildTools(undefined, false).find((t) => t.name === 'bash')!;
      const ctx = { cwd: dir, signal: new AbortController().signal };
      await expect(bash.run({ command: "ls '$(touch PWNED)'" }, ctx)).rejects.toThrow();
      expect(existsSync(path.join(dir, 'PWNED'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a blocking read-only command is killed when the agent is aborted', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-runner-edge-fifo-')));
    try {
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      const bash = buildTools(undefined, false).find((t) => t.name === 'bash')!;
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      const t0 = Date.now();
      await expect(bash.run({ command: 'cat pipe' }, { cwd: dir, signal: ac.signal })).rejects.toThrow(
        /abort/,
      );
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- write tools stay inside cwd; parallel commits do not fight over git locks ----------------

describe('write tools: confinement, abort and git contention', () => {
  let repo: string;
  let outside: string;
  const all = buildTools([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES], true);
  const tool = (n: string) => all.find((t) => t.name === n)!;

  beforeAll(async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-runner-edge-git-')));
    repo = path.join(base, 'repo');
    outside = path.join(base, 'outside');
    await fs.mkdir(repo);
    await fs.mkdir(outside);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterAll(async () => {
    await fs.rm(path.dirname(repo), { recursive: true, force: true });
  });

  it('write_file / edit_file refuse lexical escapes from cwd', async () => {
    const ctx = { cwd: repo, signal: new AbortController().signal };
    for (const p of ['../outside/x.txt', path.join(outside, 'x.txt'), 'sub/../../outside/x.txt']) {
      await expect(tool('write_file').run({ path: p, content: 'x' }, ctx), p).rejects.toThrow(/outside/);
    }
    await fs.writeFile(path.join(outside, 'e.txt'), 'old\n');
    await expect(
      tool('edit_file').run({ path: '../outside/e.txt', old_string: 'old', new_string: 'new' }, ctx),
    ).rejects.toThrow(/outside/);
    expect(await fs.readFile(path.join(outside, 'e.txt'), 'utf8')).toBe('old\n');
    expect(await fs.readdir(outside)).toEqual(['e.txt']);
  });

  it('shell is killed on abort and returns promptly', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    await expect(
      tool('shell').run({ command: 'sleep 30' }, { cwd: repo, signal: ac.signal }),
    ).rejects.toThrow(/abort/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('8 parallel git_commit calls in 8 worktrees of one repo all succeed (no lock contention)', async () => {
    const wts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const wt = path.join(path.dirname(repo), `wt${i}`);
      git(repo, 'worktree', 'add', '-q', '-B', `wf/verify/${i}`, wt, 'HEAD');
      await fs.writeFile(path.join(wt, `f${i}.txt`), `${i}\n`);
      wts.push(wt);
    }
    const results = await Promise.allSettled(
      wts.map((wt, i) =>
        tool('git_commit').run({ message: `agent ${i}` }, { cwd: wt, signal: new AbortController().signal }),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (let i = 0; i < 8; i++) {
      expect(git(wts[i]!, 'status', '--porcelain')).toBe('');
      expect(git(repo, 'rev-list', '--count', `main..wf/verify/${i}`).trim()).toBe('1');
    }
  });
});
