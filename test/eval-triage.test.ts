// eval/workflows/triage.js through run() with FakeRunner (one agent per candidate, fix cap, null agent,
// acceptance log), eval/review.ts (bugs deduped across fixes, accepted/rejected split) and
// eval/materialize.ts on a real temporary repo (nothing after the commit is reachable). Never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { materialize } from '../eval/materialize.js';
import type { MineResult } from '../eval/mine.js';
import { distinctBugs, reviewSheet, type TriageReport, type TriageRow } from '../eval/review.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { RunRequest, WorkflowEvent } from '../src/types.js';
import { run } from '../src/workflow.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const script = readFileSync(fileURLToPath(new URL('../eval/workflows/triage.js', import.meta.url)), 'utf8');

const sha = (n: number) => n.toString(16).padStart(40, '0');
const fix = (n: number) => ({
  sha: sha(n),
  subject: `fix: ${n}`,
  date: '',
  kinds: ['modified' as const],
  gapDays: n,
});
const candidate = (id: string, pr: number | null, fixes: number[]) => ({
  id,
  pr,
  merge: sha(9000 + fixes[0]!),
  base: sha(8000 + fixes[0]!),
  lines: 40,
  files: 2,
  kind: 'modified' as const,
  fixes: fixes.map(fix),
});

/** Verdict for every SHA in the prompt; the first one is a bug unless `none`. */
function verdict(req: RunRequest, none = false) {
  const shas = [...req.prompt.matchAll(/^- ([0-9a-f]{40}) /gm)].map((m) => m[1]!);
  return {
    fixes: shas.map((s, i) => ({
      sha: s,
      defect: !none && i === 0,
      introducedHere: !none && i === 0,
      visibleFromDiff: !none && i === 0,
      reason: 'test',
      bugs: !none && i === 0 ? [{ file: 'a.ts', line: 3, description: 'd', trigger: 't' }] : [],
    })),
  };
}

describe('triage workflow', () => {
  it('asks one agent per candidate with its fixes and returns verdicts by id', async () => {
    const cwd = await tmp('maestro-triage-');
    const runner = new FakeRunner([
      { match: 'PR #3', respond: { result: null, status: 'null', error: 'api error' } },
      { match: 'PR #2', respond: (req) => ({ result: verdict(req, true) }) },
      { match: 'etiketleme', respond: (req) => ({ result: verdict(req) }) },
    ]);
    const candidates = [
      candidate('r-1', 1, [1, 2]),
      candidate('r-2', 2, [3]),
      candidate('r-3', 3, [4]),
      candidate(
        'r-x',
        null,
        Array.from({ length: 10 }, (_, i) => 10 + i),
      ),
    ];
    const handle = run({ script, args: { candidates }, cwd, stateDir: path.join(cwd, 'state'), runner });
    const logs: string[] = [];
    handle.events.on('log', (e: WorkflowEvent & { type: 'log' }) => logs.push(e.message));
    const results = (await handle.promise) as { id: string; triage: ReturnType<typeof verdict> | null }[];

    expect(results.map((r) => r.id)).toEqual(['r-1', 'r-2', 'r-3', 'r-x']);
    expect(results[0]!.triage!.fixes.map((f) => f.sha)).toEqual([sha(1), sha(2)]);
    expect(results[2]!.triage).toBeNull();
    expect(results[3]!.triage!.fixes).toHaveLength(8); // capped, nearest to the merge first

    const req = runner.calls.find((c) => c.prompt.includes('PR #1'))!;
    expect(req.prompt).toContain(`"git diff ${sha(8001)} ${sha(9001)}"`);
    expect(req.prompt).toContain(`"git show ${sha(9001)}:<dosya>"`);
    expect(req.effort).toBe('medium');
    expect(runner.calls.find((c) => c.prompt.includes('merge 000000000'))).toBeDefined();
    expect(logs).toContain("r-x: 10 fix'ten ilk 8'i soruluyor");
    expect(logs).toContain('2/4 aday kabul edildi, 1 null');
  });

  it('passes args.effort and an empty list through', async () => {
    const cwd = await tmp('maestro-triage-');
    const runner = new FakeRunner([{ match: 'etiketleme', respond: (req) => ({ result: verdict(req) }) }]);
    const opts = { cwd, stateDir: path.join(cwd, 'state'), runner };
    await run({ script, args: { candidates: [candidate('r-1', 1, [1])], effort: 'high' }, ...opts }).promise;
    expect(runner.calls[0]!.effort).toBe('high');
    expect(await run({ script, args: { candidates: [] }, ...opts }).promise).toEqual([]);
  });
});

describe('materialize', () => {
  it('holds the commit and its ancestors only', async () => {
    const src = await tmp('maestro-materialize-src-');
    git(src, 'init', '-q', '-b', 'main');
    git(src, 'config', 'user.name', 'Test');
    git(src, 'config', 'user.email', 'test@example.com');
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(src, 'f.txt'), `${n}\n`);
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', `c${n}`);
    }
    const [c3, c2, c1] = git(src, 'log', '--format=%H').split('\n');
    const dir = path.join(await tmp('maestro-materialize-'), 'cell');

    expect(materialize(src, c2!, dir)).toBe(dir);
    expect(git(dir, 'log', '--all', '--format=%H').split('\n')).toEqual([c2, c1]);
    expect(() => git(dir, 'cat-file', '-t', c3!)).toThrow();
    expect(git(dir, 'for-each-ref')).toBe('');
    expect(git(dir, 'remote')).toBe('');
    expect(existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('2\n');

    expect(materialize(src, c2!, dir)).toBe(dir); // reused
    expect(() => materialize(src, c3!, dir)).toThrow(/another commit/);
  });
});

describe('review sheet', () => {
  const bug = (line: number) => ({ file: 'a.ts', line, description: `d${line}`, trigger: 't' });
  const fixOf = (n: number, keep: boolean, lines: number[]) => ({
    sha: sha(n),
    defect: true,
    introducedHere: keep,
    visibleFromDiff: true,
    reason: `r${n}`,
    bugs: lines.map(bug),
  });
  const row = (id: string, lines: number, fixes: ReturnType<typeof fixOf>[] | null): TriageRow => ({
    ...candidate(id, 1, [1]),
    kind: 'modified' as const,
    fixes: [fix(1)],
    mergedAt: '2026-06-12T00:00:00.000Z',
    subject: 'Merge',
    lines,
    triage: fixes && { fixes },
  });

  it('merges one bug reported by several fixes and ignores rejected fixes', () => {
    const r = row('r-1', 40, [fixOf(1, true, [3]), fixOf(2, true, [3, 9]), fixOf(3, false, [12])]);
    expect(distinctBugs(r)).toEqual([
      { ...bug(3), fixes: [sha(1).slice(0, 9), sha(2).slice(0, 9)] },
      { ...bug(9), fixes: [sha(2).slice(0, 9)] },
    ]);
  });

  it('splits accepted from rejected and lists the clean pool', () => {
    const triage: TriageReport = {
      runId: 'run-1',
      model: 'm',
      effort: 'medium',
      summary: { dollars: 1.5 },
      results: [
        row('r-big', 500, [fixOf(1, true, [3])]),
        row('r-no', 20, [fixOf(2, false, [])]),
        row('r-null', 30, null),
      ],
    };
    const clean = {
      id: 'r-c',
      pr: 9,
      merge: sha(9),
      lines: 50,
      added: 4,
      surviving: 3,
      mergedAt: '2026-01-01',
      subject: 's',
    };
    const mined = { clean: [clean] } as unknown as MineResult;
    const md = reviewSheet(triage, mined);
    expect(md).toContain(
      '3 aday, 1 kabul (≤200: 0, 201-800: 1, 801-2000: 0), 0 önceki turda kabul edilmişti, 1 null',
    );
    expect(md).toContain('### r-big: #1, 500 satır');
    expect(md).toContain('## Reddedilenler (2)');
    expect(md).not.toContain('Önceki turda kabul');
    expect(md).toContain('| r-null | 30 | fix: 1 | null (ajan sonuç vermedi) |');
    expect(md).toContain('| r-c | 50 | <=200 | 75% (3/4) |');

    // An earlier round accepted r-no: it moves out of the rejected table, with the earlier bugs.
    const earlier: TriageReport = { ...triage, results: [row('r-no', 20, [fixOf(2, true, [7])])] };
    const md2 = reviewSheet(triage, mined, earlier);
    expect(md2).toContain('1 önceki turda kabul edilmişti');
    expect(md2).toContain('## Önceki turda kabul, bu turda red (1)');
    expect(md2).toContain('- `a.ts:7` d7');
    expect(md2).toContain('Bu tur: r2');
    expect(md2).toContain('## Reddedilenler (1)');
  });
});
