// ProgressTree rendering and the terminal attachment (spec 3.7), from recorded event sequences.

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachTerminalProgress, formatEventLine, ProgressTree } from '../src/progress.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { Usage, WorkflowEvent } from '../src/types.js';
import { run } from '../src/workflow.js';

const R = 'run-1';
const U = (o: number) => ({ input_tokens: 10, output_tokens: o });
const K = (i: number) => `${String(i).repeat(64).slice(0, 64)}:0`;

const RECORDED: WorkflowEvent[] = [
  { type: 'log', runId: R, message: 'budget: total 500000, overrun ceiling 1012000' },
  { type: 'phase', runId: R, title: 'Find' },
  { type: 'agent_start', runId: R, id: 0, key: K(1), label: 'find:correctness', phase: 'Find' },
  { type: 'agent_start', runId: R, id: 1, key: K(2), phase: 'Find' },
  { type: 'budget_tick', runId: R, spent: 1200, total: 500_000, remaining: 498_800 },
  {
    type: 'agent_end',
    runId: R,
    id: 0,
    key: K(1),
    label: 'find:correctness',
    phase: 'Find',
    status: 'ok',
    cached: false,
    usage: U(1200),
  },
  { type: 'agent_start', runId: R, id: 2, key: K(3), label: 'verify:a.ts:3#0', phase: 'Verify' },
  {
    type: 'agent_end',
    runId: R,
    id: 2,
    key: K(3),
    label: 'verify:a.ts:3#0',
    phase: 'Verify',
    status: 'null',
    cached: false,
    usage: U(40),
  },
  { type: 'agent_start', runId: R, id: 3, key: K(4), label: 'cachedOne', phase: 'Find' },
  {
    type: 'agent_end',
    runId: R,
    id: 3,
    key: K(4),
    label: 'cachedOne',
    phase: 'Find',
    status: 'ok',
    cached: true,
    usage: U(77),
  },
  { type: 'phase', runId: R, title: 'Inner', group: 'child' },
  { type: 'agent_start', runId: R, id: 4, key: K(5), label: 'c1', phase: 'Inner', group: 'child' },
  {
    type: 'agent_end',
    runId: R,
    id: 4,
    key: K(5),
    label: 'c1',
    phase: 'Inner',
    group: 'child',
    status: 'skipped',
    cached: false,
    usage: U(0),
  },
  { type: 'log', runId: R, message: '1 bulgu oylamayı geçti' },
  { type: 'log', runId: R, message: 'child says hi', group: 'child' },
  { type: 'budget_tick', runId: R, spent: 1240, total: 500_000, remaining: 498_760 },
];

describe('ProgressTree', () => {
  it('renders header, budget, log lines, phases in first-seen order, nested groups and glyphs', () => {
    const tree = new ProgressTree({ name: 'review-changes' });
    for (const e of RECORDED) tree.push(e);
    expect(tree.render()).toBe(
      [
        'maestro: review-changes (run-1)',
        'budget: 1,240 / 500,000 output tokens (498,760 left)',
        '  · budget: total 500000, overrun ceiling 1012000',
        '  · 1 bulgu oylamayı geçti',
        '  · [child] child says hi',
        'Find [2/3]',
        '  ✓ find:correctness  1,200 tok',
        `  … ${'2'.repeat(12)}`,
        '  ↺ cachedOne  77 tok',
        'Verify [1/1]',
        '  ∅ verify:a.ts:3#0  40 tok',
        '▸ child',
        '  Inner [1/1]',
        '    ⤼ c1  0 tok',
      ].join('\n'),
    );
    expect(tree.counts()).toEqual({ running: 1, ok: 1, null: 1, skipped: 1, cached: 1 });
  });

  it('keeps only the latest log lines and says how many are hidden; no budget total → no limit', () => {
    const tree = new ProgressTree({ maxLogLines: 2 });
    for (let i = 0; i < 5; i++) tree.push({ type: 'log', runId: R, message: `m${i}` });
    tree.push({ type: 'budget_tick', runId: R, spent: 5, total: null, remaining: Number.POSITIVE_INFINITY });
    tree.push({ type: 'agent_start', runId: R, id: 0, key: K(7) });
    expect(tree.render().split('\n')).toEqual([
      'maestro: run-1',
      'budget: 5 output tokens spent (no limit)',
      '  · … 3 earlier log lines',
      '  · m3',
      '  · m4',
      '(no phase) [0/1]',
      `  … ${'7'.repeat(12)}`,
    ]);
  });
});

describe('attachTerminalProgress', () => {
  it('non-TTY: one line per agent_end / phase / log, nothing for starts and ticks; detach stops output', () => {
    const events = new EventEmitter();
    const out: string[] = [];
    const detach = attachTerminalProgress({ events }, { write: (s: string) => out.push(s), isTTY: false });
    for (const e of RECORDED) events.emit('event', e);
    detach();
    events.emit('event', { type: 'log', runId: R, message: 'late' });
    expect(out.join('')).toBe(
      [
        '· budget: total 500000, overrun ceiling 1012000',
        '== Find',
        '✓ Find / find:correctness  1,200 tok',
        '∅ Verify / verify:a.ts:3#0  40 tok',
        '↺ Find / cachedOne  77 tok',
        '▸ child == Inner',
        '▸ child ⤼ Inner / c1  0 tok',
        '· 1 bulgu oylamayı geçti',
        '▸ child · child says hi',
        '',
      ].join('\n'),
    );
    expect(formatEventLine(RECORDED[2]!)).toBeNull();
  });

  it('TTY: redraws the tree in place with ANSI and draws the final tree on detach', async () => {
    const events = new EventEmitter();
    const out: string[] = [];
    const detach = attachTerminalProgress(
      { events },
      { write: (s: string) => out.push(s), isTTY: true },
      { name: 'wf', throttleMs: 1 },
    );
    events.emit('event', RECORDED[1]);
    await new Promise((r) => setTimeout(r, 20));
    events.emit('event', RECORDED[2]);
    detach();
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('maestro: wf (run-1)\nbudget: 0 output tokens spent\nFind\n');
    // Second frame: cursor up over the 3 drawn lines, clear, redraw.
    expect(out[1]!.startsWith('\x1b[3F\x1b[J')).toBe(true);
    expect(out[1]).toContain('  … find:correctness');
  });

  it('follows a real run end to end', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-progress-'));
    try {
      const handle = run({
        cwd: dir,
        concurrency: 2,
        runner: new FakeRunner(),
        script: `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Go' }] };
phase('Go');
await parallel([() => agent('a', { label: 'A' }), () => agent('b', { label: 'B' })]);
log('done');
return 1;`,
      });
      const tree = new ProgressTree({ name: 'p' });
      handle.events.on('event', (e: WorkflowEvent) => tree.push(e));
      await handle.promise;
      const text = tree.render();
      expect(text).toContain('Go [2/2]');
      expect(text).toContain('  ✓ A  100 tok');
      expect(text).toContain('  ✓ B  100 tok');
      expect(text).toContain('  · done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('prompt-cache figures (v1.1)', () => {
  const end = (usage: Usage, cached = false): WorkflowEvent => ({
    type: 'agent_end',
    runId: R,
    id: 7,
    key: K(7),
    label: 'find:x',
    phase: 'Find',
    status: 'ok',
    cached,
    usage,
  });

  it('agent row and stream line show "cached N%" = cache reads / total input', () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 200,
    };
    const tree = new ProgressTree();
    tree.push(end(usage));
    expect(tree.render()).toContain('✓ find:x  50 tok, cached 70%');
    expect(formatEventLine(end(usage))).toBe('✓ Find / find:x  50 tok, cached 70%');
  });

  it('no suffix without cache figures, and none for journal hits', () => {
    expect(formatEventLine(end(U(50)))).toBe('✓ Find / find:x  50 tok');
    const usage = { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 9 };
    expect(formatEventLine(end(usage, true))).toBe('↺ Find / find:x  50 tok');
  });

  it('run() logs total input against cache reads at the end of the run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-cache-'));
    try {
      const runner = new FakeRunner(() => ({
        turns: 2,
        inputTokensPerTurn: 100,
        cacheReadTokensPerTurn: 800,
        cacheCreationTokensPerTurn: 100,
      }));
      const handle = run({
        cwd: dir,
        stateDir: path.join(dir, 'state'),
        runner,
        script: `export const meta = { name: 'c', description: 'd' };\nawait agent('a'); await agent('b'); return 1;`,
      });
      const messages: string[] = [];
      const ends: WorkflowEvent[] = [];
      handle.events.on('event', (e: WorkflowEvent) => {
        if (e.type === 'log') messages.push(e.message);
        if (e.type === 'agent_end') ends.push(e);
      });
      await handle.promise;
      expect(ends[0]).toMatchObject({
        usage: {
          input_tokens: 200,
          output_tokens: 200,
          cache_read_input_tokens: 1600,
          cache_creation_input_tokens: 200,
        },
      });
      expect(messages).toContain(
        'cache: 4,000 input tokens, 3,200 read from cache (80%), 400 written, 400 uncached; 400 output',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('run() logs no cache line when the runner reports no cache figures', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-cache-'));
    try {
      const handle = run({
        cwd: dir,
        stateDir: path.join(dir, 'state'),
        runner: new FakeRunner(),
        script: `export const meta = { name: 'c', description: 'd' };\nreturn agent('a');`,
      });
      const messages: string[] = [];
      handle.events.on('log', (e: { message: string }) => messages.push(e.message));
      await handle.promise;
      expect(messages.some((m) => m.startsWith('cache:'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
