// `maestro viz` data path: events.jsonl written by run(), read back by the viz server and the export.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { EVENT_LOG_FILE, EVENT_LOG_PROMPT_CHARS, EventLog, type EventLogLine } from '../src/event-log.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { exportVizHtml, readEventLines, readSnapshot, serveViz } from '../src/viz.js';
import { scriptJson, vizPage } from '../src/viz-page.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-viz-'));
  dirs.push(d);
  return d;
}

const SCRIPT = `export const meta = { name: 'viz-demo', description: 'two finders and a judge', phases: [{ title: 'Find' }, { title: 'Judge' }] };
log('start');
const found = await parallel(['a', 'b', 'c'].map((k) => () => agent('find ' + k, { label: 'find:' + k, phase: 'Find' })));
return agent('judge ' + found.filter(Boolean).length, { label: 'judge', phase: 'Judge', effort: 'high' });`;

async function readLines(runDir: string): Promise<EventLogLine[]> {
  return (await readEventLines(runDir)).lines;
}

describe('events.jsonl', () => {
  it('records run_start, every event with a time, prompts, slot waits and run_end', async () => {
    const cwd = await tmp();
    const runner = new FakeRunner((req) => ({ delayMs: req.prompt.startsWith('find') ? 30 : 5 }));
    const handle = run({ cwd, runId: 'r1', runner, concurrency: 2, script: SCRIPT });
    await handle.promise;
    const lines = await readLines(handle.runDir);

    expect(lines[0]).toMatchObject({
      type: 'run_start',
      resume: false,
      name: 'viz-demo',
      description: 'two finders and a judge',
      phases: ['Find', 'Judge'],
      runner: 'FakeRunner',
      concurrency: 2,
      budget: null,
    });
    expect(lines.at(-1)).toMatchObject({ type: 'run_end', ok: true });
    // Times never go backwards and no line carries the runId (the file belongs to one run).
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.t).toBeGreaterThanOrEqual(lines[i - 1]!.t);
    expect(lines.some((l) => 'runId' in l)).toBe(false);

    const types = lines.map((l) => l.type);
    expect(types.filter((t) => t === 'agent_start')).toHaveLength(4);
    expect(types.filter((t) => t === 'agent_end')).toHaveLength(4);
    expect(types.filter((t) => t === 'agent_running')).toHaveLength(4);
    expect(types).toContain('log');

    const judgePrompt = lines.find((l) => l.type === 'agent_prompt' && l.prompt.startsWith('judge'));
    expect(judgePrompt).toMatchObject({ prompt: 'judge 3', effort: 'high', schema: false });

    // concurrency 2 with three finders: the third waits for a slot, so its running line comes later.
    const startOf = (id: number) => lines.find((l) => l.type === 'agent_start' && l.id === id)!.t;
    const runOf = (id: number) => lines.find((l) => l.type === 'agent_running' && l.id === id)!.t;
    const waits = [0, 1, 2].map((id) => runOf(id) - startOf(id));
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(20);
  });

  it('a resume appends a second attempt whose cached agents start and end without running', async () => {
    const cwd = await tmp();
    const runner = new FakeRunner();
    await run({ cwd, runId: 'r2', runner, script: SCRIPT }).promise;
    const resumed = run({ cwd, resumeFromRunId: 'r2', runner });
    await resumed.promise;
    const lines = await readLines(resumed.runDir);
    const starts = lines.filter((l) => l.type === 'run_start');
    expect(starts.map((l) => (l as { resume: boolean }).resume)).toEqual([false, true]);
    const second = lines.slice(lines.indexOf(starts[1]!));
    const ends = second.filter((l) => l.type === 'agent_end');
    expect(ends).toHaveLength(4);
    expect(ends.every((l) => (l as { cached: boolean }).cached)).toBe(true);
    expect(second.some((l) => l.type === 'agent_running')).toBe(false);
    expect(second.filter((l) => l.type === 'agent_prompt')).toHaveLength(4);
  });

  it('a failing script ends with run_end ok:false and its error', async () => {
    const cwd = await tmp();
    const handle = run({
      cwd,
      runId: 'r3',
      runner: new FakeRunner(),
      script: `export const meta = { name: 'x', description: 'd' };\nawait agent('one');\nthrow new Error('boom');`,
    });
    await expect(handle.promise).rejects.toThrow(/boom/);
    const lines = await readLines(handle.runDir);
    expect(lines.at(-1)).toMatchObject({ type: 'run_end', ok: false, error: expect.stringMatching(/boom/) });
  });

  it('cuts long prompts and marks them truncated', async () => {
    const cwd = await tmp();
    const long = 'x'.repeat(EVENT_LOG_PROMPT_CHARS + 50);
    const handle = run({
      cwd,
      runId: 'r4',
      runner: new FakeRunner(),
      script: `export const meta = { name: 'x', description: 'd' };\nreturn agent(args.p);`,
      args: { p: long },
    });
    await handle.promise;
    const prompt = (await readLines(handle.runDir)).find((l) => l.type === 'agent_prompt') as {
      prompt: string;
      truncated?: true;
    };
    expect(prompt.prompt).toHaveLength(EVENT_LOG_PROMPT_CHARS);
    expect(prompt.truncated).toBe(true);
  });

  it('EventLog never throws: an unopenable file is reported once and later lines are dropped', async () => {
    const errors: string[] = [];
    const log = new EventLog((m) => errors.push(m));
    log.record({ type: 'run_end', ok: true });
    await log.open(path.join(await tmp(), 'missing', 'dir'));
    log.record({ type: 'run_end', ok: true });
    await log.close();
    expect(errors).toEqual([expect.stringMatching(/event log disabled/)]);
  });
});

describe('readEventLines', () => {
  it('reads from a byte offset and leaves a torn last line for the next read', async () => {
    const dir = await tmp();
    const file = path.join(dir, EVENT_LOG_FILE);
    await writeFile(
      file,
      '{"t":1,"type":"log","message":"a"}\nnot json\n{"t":2,"type":"log","message":"b"}\n{"t":3,',
    );
    const first = await readEventLines(dir);
    expect(first.lines.map((l) => l.t)).toEqual([1, 2]);
    await writeFile(file, `${await readFile(file, 'utf8')}"type":"log","message":"c"}\n`);
    const next = await readEventLines(dir, first.offset);
    expect(next.lines).toEqual([{ t: 3, type: 'log', message: 'c' }]);
    expect(await readEventLines(await tmp())).toEqual({ lines: [], offset: 0 });
  });
});

describe('viz server', () => {
  it('serves the page, incremental polls and agent details on 127.0.0.1', async () => {
    const cwd = await tmp();
    const handle = run({
      cwd,
      runId: 'srv',
      runner: new FakeRunner((req) => ({
        result: req.prompt.startsWith('judge') ? 'verdict text' : undefined,
        trace: {
          toolCalls: [{ tool: 'grep', inputSummary: '{"pattern":"x"}', ok: true }],
          finalText: 'done',
        },
      })),
      script: SCRIPT,
    });
    await handle.promise;
    const server = await serveViz({ runDir: handle.runDir, runId: 'srv' });
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await fetch(server.url);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(await page.text()).toContain('"mode":"live"');

      const poll: any = await (await fetch(`${server.url}api/poll?from=0`)).json();
      expect(poll.runId).toBe('srv');
      expect(poll.lines[0].type).toBe('run_start');
      expect(poll.entries).toHaveLength(4);
      expect(typeof poll.now).toBe('number');
      const again: any = await (await fetch(`${server.url}api/poll?from=${poll.offset}`)).json();
      expect(again.lines).toEqual([]);

      const judge = poll.lines.find((l: any) => l.type === 'agent_end' && l.label === 'judge');
      const detail: any = await (await fetch(`${server.url}api/entry?key=${judge.key}&status=ok`)).json();
      expect(detail).toMatchObject({
        label: 'judge',
        status: 'ok',
        result: 'verdict text',
        resultTruncated: false,
      });
      expect(detail.trace.toolCalls[0].tool).toBe('grep');

      expect((await fetch(`${server.url}api/entry?key=../../etc`)).status).toBe(400);
      expect((await fetch(`${server.url}api/entry?key=abc:0`)).status).toBe(404);
      expect((await fetch(`${server.url}nope`)).status).toBe(404);
      expect((await fetch(server.url, { method: 'POST' })).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it('a snapshot of a run without events.jsonl still lists its journal rows', async () => {
    const cwd = await tmp();
    const handle = run({ cwd, runId: 'old', runner: new FakeRunner(), script: SCRIPT });
    await handle.promise;
    await rm(path.join(handle.runDir, EVENT_LOG_FILE));
    const snap = await readSnapshot(handle.runDir, 'old');
    expect(snap.lines).toEqual([]);
    expect(snap.entries.map((e) => e.label).sort()).toEqual(['find:a', 'find:b', 'find:c', 'judge']);
  });
});

describe('export', () => {
  it('embeds events, rows and details in one file, safe against </script> in results', async () => {
    const cwd = await tmp();
    const handle = run({
      cwd,
      runId: 'exp',
      runner: new FakeRunner(() => ({ result: '</script><script>alert(1)</script>' })),
      script: SCRIPT,
    });
    await handle.promise;
    const html = await exportVizHtml(handle.runDir, 'exp');
    expect(html).toContain('"mode":"static"');
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script\\u003e');
    const boot = JSON.parse(html.split('window.__MAESTRO__ = ')[1]!.split(';</script>')[0]!);
    expect(boot.snapshot.lines.length).toBeGreaterThan(5);
    expect(Object.keys(boot.details).length).toBeGreaterThanOrEqual(4);
  });

  it('the page script is valid JavaScript and the boot JSON round-trips', () => {
    const html = vizPage({ mode: 'live', runId: 'x<y' });
    const scripts = html
      .split('<script>')
      .slice(1)
      .map((s) => s.split('</script>')[0]!);
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(html).toContain('<title>x&#60;y · maestro viz</title>');
    const tricky = { a: '</script>\u2028&' };
    expect(JSON.parse(scriptJson(tricky))).toEqual(tricky);
  });
});

describe('maestro viz CLI', () => {
  it('--out writes the self-contained page; a missing run or bad runId fails', async () => {
    const cwd = await tmp();
    await run({ cwd, runId: 'cli', runner: new FakeRunner(), script: SCRIPT }).promise;
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s), isTTY: false } as any,
    };
    expect(await main(['viz', 'cli', '--out', 'report.html'], io)).toBe(0);
    expect(out.join('')).toContain(path.join(cwd, 'report.html'));
    expect(await readFile(path.join(cwd, 'report.html'), 'utf8')).toContain('"mode":"static"');

    expect(await main(['viz', 'nope', '--out', 'x.html'], io)).toBe(1);
    expect(err.join('')).toMatch(/no run nope/);
    expect(await main(['viz', '../x'], io)).toBe(1);
    expect(err.join('')).toMatch(/invalid runId/);
    expect(await main(['viz'], io)).toBe(1);
  });
});
