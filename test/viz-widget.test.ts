// `maestro viz --widget`: a snapshot fragment that follows a chat host's inline-widget rules.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { EventLogLine } from '../src/event-log.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { exportVizWidget, type VizSnapshot } from '../src/viz.js';
import { vizWidget, WIDGET_MAX_AGENTS, WIDGET_PREVIEW_CHARS, widgetModel } from '../src/viz-widget.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-widget-'));
  dirs.push(d);
  return d;
}

const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o });
const start = (t: number, phases: string[] = ['Find']): EventLogLine => ({
  t,
  type: 'run_start',
  resume: false,
  name: 'w',
  description: 'd',
  phases,
  runner: 'CodexRunner',
  model: 'm',
  concurrency: 2,
  budget: null,
});

function snap(lines: EventLogLine[], now = 10_000): VizSnapshot {
  return { runId: 'r', lines, offset: 0, entries: [], now };
}

describe('widgetModel', () => {
  it('reads states from the latest attempt: queued, running, done, cached; cached tokens are not counted', () => {
    const lines: EventLogLine[] = [
      start(0),
      { t: 1, type: 'agent_start', id: 0, key: 'old:0', label: 'old', phase: 'Find' },
      { t: 2, type: 'run_end', ok: true },
      start(1000, ['Find', 'Judge']),
      { t: 1000, type: 'agent_start', id: 0, key: 'a:0', label: 'a', phase: 'Find' },
      {
        t: 1000,
        type: 'agent_end',
        id: 0,
        key: 'a:0',
        label: 'a',
        phase: 'Find',
        status: 'ok',
        cached: true,
        usage: usage(500, 50),
      },
      { t: 1100, type: 'agent_start', id: 1, key: 'b:0', label: 'b', phase: 'Find' },
      { t: 1200, type: 'agent_running', id: 1 },
      {
        t: 1900,
        type: 'agent_end',
        id: 1,
        key: 'b:0',
        label: 'b',
        phase: 'Find',
        status: 'null',
        cached: false,
        usage: usage(100, 10),
      },
      { t: 1300, type: 'agent_start', id: 2, key: 'c:0', label: 'c', phase: 'Judge' },
      { t: 1400, type: 'agent_running', id: 2 },
      { t: 1500, type: 'agent_start', id: 3, key: 'd:0', label: 'd', group: 'child', phase: 'Inner' },
    ];
    const m = widgetModel(snap(lines, 5000), { 'b:0|null': { result: '', error: 'boom' } });
    expect(m.attempts).toBe(2);
    expect(m.runner).toBe('codex');
    expect(m.status).toBe('running');
    expect(m.dur).toBe(4000);
    expect(m.lanes).toEqual(['Find', 'Judge', '▸ child · Inner']);
    expect(m.counts).toEqual({ queued: 1, running: 1, ok: 0, null: 1, skipped: 0, cached: 1 });
    expect([m.tokensIn, m.tokensOut]).toEqual([100, 10]);
    const byLabel = Object.fromEntries(m.agents.map((a) => [a[0], a]));
    expect(byLabel.old).toBeUndefined();
    expect(byLabel.b).toEqual(['b', 0, 100, 200, 900, 'null', 100, 10, 'boom', '']);
    expect(byLabel.c!.slice(2, 6)).toEqual([300, 400, null, 'running']);
    expect(byLabel.d!.slice(2, 6)).toEqual([500, null, null, 'queued']);
  });

  it('caps drawn agents and says how many were left out; cuts long previews', () => {
    const lines: EventLogLine[] = [start(0)];
    for (let i = 0; i < WIDGET_MAX_AGENTS + 7; i++) {
      lines.push({ t: i, type: 'agent_start', id: i, key: `k${i}:0`, label: `a${i}`, phase: 'Find' });
      lines.push({ t: i, type: 'agent_running', id: i });
      lines.push({
        t: i + 1,
        type: 'agent_end',
        id: i,
        key: `k${i}:0`,
        status: 'ok',
        cached: false,
        usage: usage(1, 1),
      });
    }
    const m = widgetModel(snap(lines), { 'k0:0': { result: 'x'.repeat(WIDGET_PREVIEW_CHARS + 20) } });
    expect(m.agents).toHaveLength(WIDGET_MAX_AGENTS);
    expect(m.omitted).toBe(7);
    expect(m.counts.ok).toBe(WIDGET_MAX_AGENTS + 7);
    expect(m.agents[0]![9]).toHaveLength(WIDGET_PREVIEW_CHARS + 1);
    expect(vizWidget(m)).toContain(`The first ${WIDGET_MAX_AGENTS} agents are drawn; 7 more are left out.`);
  });
});

describe('vizWidget fragment', () => {
  it('follows the inline-widget rules and embeds the data safely', async () => {
    const cwd = await tmp();
    const handle = run({
      cwd,
      runId: 'wid',
      runner: new FakeRunner(() => ({ result: '</script><script>alert(1)</script>' })),
      script: `export const meta = { name: 'w', description: 'd', phases: [{ title: 'Find' }] };
return parallel(['a', 'b'].map((k) => () => agent('find ' + k, { label: 'find:' + k, phase: 'Find' })));`,
    });
    await handle.promise;
    const html = await exportVizWidget(handle.runDir, 'wid');

    expect(html).not.toMatch(/<!doctype|<html|<head|<body/i);
    expect(html).not.toMatch(/position:\s*fixed/);
    expect(html).toMatch(/<h2 class="sr-only">Timeline of the run w: 2 agents/);
    for (const m of html.matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(11);
    for (const m of html.matchAll(/font-weight:\s*(\d+)/g)) expect(['400', '500']).toContain(m[1]);
    expect(html).not.toContain('</script><script>alert(1)');

    const script = html.split('<script>')[1]!.split('</script>')[0]!;
    expect(() => new Function(script)).not.toThrow();
    const model = JSON.parse(script.slice('var M = '.length, script.indexOf(';\n(function')));
    expect(model.agents.map((a: unknown[]) => a[0]).sort()).toEqual(['find:a', 'find:b']);
    expect(model.agents[0][9]).toContain('</script>');
  });
});

describe('maestro viz --widget', () => {
  it('prints the fragment, or writes it with --out', async () => {
    const cwd = await tmp();
    await run({
      cwd,
      runId: 'cliw',
      runner: new FakeRunner(),
      script: `export const meta = { name: 'w', description: 'd' };\nreturn agent('one');`,
    }).promise;
    const out: string[] = [];
    const io = {
      cwd,
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: () => {}, isTTY: false } as any,
    };
    expect(await main(['viz', 'cliw', '--widget'], io)).toBe(0);
    expect(out.join('')).toMatch(/^<style>/);
    expect(out.join('')).toContain('var M = ');
    out.length = 0;
    expect(await main(['viz', 'cliw', '--widget', '--out', 'w.html'], io)).toBe(0);
    expect(out.join('').trim()).toBe(path.join(cwd, 'w.html'));
    expect(await readFile(path.join(cwd, 'w.html'), 'utf8')).toMatch(/^<style>/);
  });
});
