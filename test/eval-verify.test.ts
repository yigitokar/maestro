// eval/workflows/verify.js through run() with FakeRunner (one agent per candidate, the claim without the
// triage's reasoning, null agent, log) and eval/review.ts applyVerdicts (confirmed bugs only, in the
// verifier's wording; no confirmed bug rejects; written and null-verdict candidates untouched). Never the network.

import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { applyVerdicts, type Labels, pickSet, type VerifyBug } from '../eval/review.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { RunRequest, WorkflowEvent } from '../src/types.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const script = readFileSync(fileURLToPath(new URL('../eval/workflows/verify.js', import.meta.url)), 'utf8');
const sha = (n: number) => n.toString(16).padStart(40, '0');
const claim = (line: number) => ({
  file: 'a.ts',
  line,
  description: `d${line}`,
  trigger: `t${line}`,
  fix: sha(line),
});
const candidate = (id: string, pr: number | null, lines: number[]) => ({
  id,
  pr,
  merge: sha(9000 + lines[0]!),
  base: sha(8000 + lines[0]!),
  lines: 40,
  files: 2,
  bugs: lines.map(claim),
});

/** A verdict for every claim in the prompt; only the first is confirmed unless `none`. */
function verdict(req: RunRequest, none = false) {
  const claims = [...req.prompt.matchAll(/^(\d+)\. (.+?):(\d+): /gm)];
  return {
    bugs: claims.map(([, i, file, line]) => {
      const yes = !none && i === '0';
      return {
        index: Number(i),
        exists: yes,
        introduced: yes,
        fixed: yes,
        visible: yes,
        corrected: false,
        file: file!,
        line: Number(line),
        description: 'd',
        trigger: 't',
        reason: 'r',
      };
    }),
  };
}

describe('verify workflow', () => {
  it('asks one agent per candidate with the claims and returns verdicts by id', async () => {
    const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-verify-')));
    dirs.push(cwd);
    const runner = new FakeRunner([
      { match: 'PR #3', respond: { result: null, status: 'null', error: 'api error' } },
      { match: 'PR #2', respond: (req) => ({ result: verdict(req, true) }) },
      { match: 'etiketlerini denetliyorsun', respond: (req) => ({ result: verdict(req) }) },
    ]);
    const candidates = [candidate('r-1', 1, [3, 9]), candidate('r-2', 2, [4]), candidate('r-3', 3, [5])];
    const handle = run({ script, args: { candidates }, cwd, stateDir: path.join(cwd, 'state'), runner });
    const logs: string[] = [];
    handle.events.on('log', (e: WorkflowEvent & { type: 'log' }) => logs.push(e.message));
    const results = (await handle.promise) as { id: string; verify: { bugs: VerifyBug[] } | null }[];

    expect(results.map((r) => r.id)).toEqual(['r-1', 'r-2', 'r-3']);
    expect(results[0]!.verify!.bugs.map((b) => b.index)).toEqual([0, 1]);
    expect(results[2]!.verify).toBeNull();
    const req = runner.calls.find((c) => c.prompt.includes('PR #1'))!;
    expect(req.prompt).toContain(`"git diff ${sha(8003)} ${sha(9003)}"`);
    expect(req.prompt).toContain(`0. a.ts:3: d3 Senaryo: t3 (fix: ${sha(3)})`);
    expect(req.prompt).toContain(`1. a.ts:9: d9 Senaryo: t9 (fix: ${sha(9)})`);
    expect(req.effort).toBe('high');
    expect(logs).toContain('1/3 aday doğrulandı, 1 null');
  });
});

describe('applyVerdicts', () => {
  const bug = (line: number) => ({ file: 'a.ts', line, description: `d${line}`, trigger: `t${line}` });
  const entry = (id: string, order: number, lines: number[]) => ({
    order,
    id,
    group: '<=200',
    lines: 40,
    merge: sha(9000 + order),
    base: sha(8000 + order),
    decision: null as 'accept' | 'reject' | null,
    note: '',
    bugs: lines.map((l) => ({ ...bug(l), fix: sha(l), link: 'modified' })),
  });
  const v = (index: number, ok: boolean, line: number, extra: Partial<VerifyBug> = {}): VerifyBug => ({
    index,
    exists: ok,
    introduced: ok,
    fixed: ok,
    visible: true,
    corrected: false,
    ...bug(line),
    reason: `r${index}`,
    ...extra,
  });

  it('accepts the confirmed bugs only, rejects the rest, and leaves decided and null ones alone', () => {
    const labels: Labels = {
      repo: 'lula',
      seed: 1,
      target: 2,
      candidates: [entry('a', 1, [3, 9]), entry('b', 2, [4]), entry('c', 3, [5]), entry('d', 4, [6])],
    };
    labels.candidates[2]!.decision = 'reject';
    const written = applyVerdicts(
      labels,
      [
        {
          id: 'a',
          verify: {
            bugs: [
              v(0, false, 3),
              v(1, true, 11, { corrected: true, description: 'better', trigger: 'exact' }),
            ],
          },
        },
        { id: 'b', verify: { bugs: [v(0, false, 4)] } },
        { id: 'c', verify: { bugs: [v(0, true, 5)] } },
        { id: 'd', verify: null },
      ],
      'run-1',
    );

    expect(written).toEqual(['a', 'b']);
    const [a, b, c, d] = labels.candidates;
    expect(a!.decision).toBe('accept');
    expect(a!.bugs).toEqual([
      { file: 'a.ts', line: 11, description: 'better', trigger: 'exact', fix: sha(9), link: 'modified' },
    ]);
    expect(a!.note).toBe('verify run-1: #0 red: r0 | #1 doğrulandı (düzeltildi): r1');
    expect(b!.decision).toBe('reject');
    expect(b!.bugs).toEqual(entry('b', 2, [4]).bugs); // kept for the record
    expect(c!.decision).toBe('reject'); // written before, not overwritten
    expect(d!.decision).toBeNull();
    expect(pickSet(labels)).toMatchObject({ rejected: 2, next: { id: 'd' } });
  });

  it('leaves a candidate undecided when the answer does not cover its claims one to one', () => {
    const labels: Labels = {
      repo: 'lula',
      seed: 1,
      target: 2,
      candidates: [entry('a', 1, [3]), entry('b', 2, [4]), entry('c', 3, [5, 6]), entry('d', 4, [7, 8])],
    };
    const written = applyVerdicts(
      labels,
      [
        { id: 'a', verify: { bugs: [] } }, // no verdict at all
        { id: 'b', verify: { bugs: [v(1, true, 4)] } }, // 1-based index
        { id: 'c', verify: { bugs: [v(0, true, 5), v(0, true, 6)] } }, // one claim twice
        { id: 'd', verify: { bugs: [v(1, false, 8), v(0, true, 7)] } }, // complete, any order
      ],
      'run-2',
    );
    expect(written).toEqual(['d']);
    expect(labels.candidates.map((c) => c.decision)).toEqual([null, null, null, 'accept']);
    expect(labels.candidates[0]!.note).toBe(entry('a', 1, [3]).note);
  });
});
