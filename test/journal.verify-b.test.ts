// Adversarial verification of the journal (spec 3.1, Seviye 2 adım 1/2/7, ADR-4): edge cases and
// failure modes. Tests assert SPEC behaviour; some fail against the current implementation on purpose.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, hashCall, Journal, makeKey, Occurrences } from '../src/journal.js';
import type { Entry } from '../src/types.js';
import { MaestroError } from '../src/types.js';

let dir: string;
const opened: Journal[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maestro-journal-vb-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const j of opened.splice(0)) await j.close().catch(() => {});
  try {
    chmodSync(dir, 0o700);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function openJournal(log?: (m: string) => void): Promise<Journal> {
  const j = await Journal.open(dir, log ? { log } : undefined);
  opened.push(j);
  return j;
}

function entry(key: string, status: Entry['status'], result: unknown, index = 0): Entry {
  const [hash, n] = key.split(':');
  return {
    index,
    hash: hash ?? key,
    n: Number(n ?? 0),
    key,
    result,
    usage: { input_tokens: 1, output_tokens: 2 },
    status,
  };
}

const journalFile = () => join(dir, 'journal.jsonl');
const lines = () =>
  readFileSync(journalFile(), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);

describe('canonicalJSON keeps JSON.stringify semantics on boundary inputs', () => {
  it('sparse array holes serialize as null, like JSON.stringify', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point of the test
    const sparse = [, 1];
    expect(canonicalJSON(sparse)).toBe(JSON.stringify(sparse));
    expect(canonicalJSON(new Array(3))).toBe('[null,null,null]');
    expect(() => JSON.parse(canonicalJSON({ tools: new Array(2) }))).not.toThrow();
  });

  it('sparse and explicit-undefined arrays hash the same (same JSON => same key)', () => {
    const holes = new Array<string>(2);
    expect(hashCall('p', { tools: holes })).toBe(hashCall('p', { tools: [undefined, undefined] as never }));
  });

  it('cross-realm (vm) boxed primitives unbox like JSON.stringify', () => {
    const ctx = vm.createContext({});
    const boxed = vm.runInContext('({ a: new Number(5), b: new String("xy"), c: new Boolean(false) })', ctx);
    expect(JSON.stringify(boxed)).toBe('{"a":5,"b":"xy","c":false}');
    expect(canonicalJSON(boxed)).toBe('{"a":5,"b":"xy","c":false}');
  });

  it('different cross-realm boxed opts do not collide on one cache key (no silent wrong cache)', () => {
    const ctx = vm.createContext({});
    // e.g. a schema built in the script with boxed numbers: maxItems 1 vs maxItems 2.
    const o1 = vm.runInContext('({ schema: { type: "array", maxItems: new Number(1) } })', ctx);
    const o2 = vm.runInContext('({ schema: { type: "array", maxItems: new Number(2) } })', ctx);
    expect(JSON.stringify(o1)).not.toBe(JSON.stringify(o2));
    expect(hashCall('same prompt', o1)).not.toBe(hashCall('same prompt', o2));
  });

  it('cross-realm plain objects, arrays and dates serialize like same-realm ones (passing probe)', () => {
    const ctx = vm.createContext({});
    const v = vm.runInContext(
      '({ z: [1, { y: 2, x: [3] }], a: new Date(Date.UTC(2026, 0, 1)), u: undefined, f() {} })',
      ctx,
    );
    const local = { a: new Date(Date.UTC(2026, 0, 1)), z: [1, { x: [3], y: 2 }] };
    expect(canonicalJSON(v)).toBe(canonicalJSON(local));
    expect(canonicalJSON(v)).toBe('{"a":"2026-01-01T00:00:00.000Z","z":[1,{"x":[3],"y":2}]}');
  });

  it('cross-realm opts hash equal to same-realm opts and ignore label/phase (passing probe)', () => {
    const ctx = vm.createContext({});
    const vmOpts = vm.runInContext(
      '({ label: "L", phase: "P", schema: { type: "object", properties: { b: {}, a: {} } }, effort: "high" })',
      ctx,
    );
    expect(hashCall('p', vmOpts)).toBe(
      hashCall('p', { effort: 'high', schema: { properties: { a: {}, b: {} }, type: 'object' } }),
    );
  });

  it('prompt newlines cannot forge another (prompt, opts) pair; empty prompt is valid (passing probe)', () => {
    // canonicalJSON never contains a raw newline, so the last "\n" in the hashed text is the separator.
    expect(canonicalJSON({ s: 'a\nb' })).not.toContain('\n');
    expect(hashCall('x\n{}', {})).not.toBe(hashCall('x', { model: '{}' }));
    expect(hashCall('', undefined)).toBe(hashCall('', {}));
    expect(hashCall('p', { label: undefined, model: undefined })).toBe(hashCall('p'));
    expect(makeKey(hashCall(''), 0)).toMatch(/^[0-9a-f]{64}:0$/);
  });

  it('Occurrences counts per hash independently, 0-based (passing probe)', () => {
    const occ = new Occurrences();
    expect([occ.next('a'), occ.next('b'), occ.next('a'), occ.next('a'), occ.next('b')]).toEqual([
      0, 0, 1, 2, 1,
    ]);
    expect(new Occurrences().next('a')).toBe(0);
  });
});

describe('blob threshold is strictly "above 64 KB" (passing probes)', () => {
  it('exactly 65536 serialized bytes stays inline; 65537 goes to blobs/', async () => {
    const j = await openJournal();
    const exact = 'a'.repeat(64 * 1024 - 2); // + 2 quote bytes = 65536
    const over = 'a'.repeat(64 * 1024 - 1); // 65537
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(65536);
    await j.append(entry('h1:0', 'ok', exact));
    await j.append(entry('h2:0', 'ok', over));
    const [r1, r2] = lines().map((l) => JSON.parse(l));
    expect(r1.blob).toBeUndefined();
    expect(r1.result).toBe(exact);
    expect(r2.blob).toBe(true);
    expect(r2.result).toEqual({ blob: 'h2:0' });
    expect(existsSync(join(dir, 'blobs', 'h1:0.json'))).toBe(false);
    expect(existsSync(join(dir, 'blobs', 'h2:0.json'))).toBe(true);
    expect(j.get('h2:0')?.result).toBe(over);
  });

  it('threshold counts UTF-8 bytes, not string length', async () => {
    const j = await openJournal();
    const multi = 'ş'.repeat(40 * 1024); // 40k chars, 80 KB
    await j.append(entry('m:0', 'ok', multi));
    expect(JSON.parse(lines()[0] as string).blob).toBe(true);
    const reopened = await openJournal();
    expect(reopened.get('m:0')?.result).toBe(multi);
  });

  it('a real { blob } result without the blob flag is not resolved as a reference', async () => {
    const j = await openJournal();
    await j.append(entry('r:0', 'ok', { blob: 'r:0' }));
    const reopened = await openJournal();
    expect(reopened.get('r:0')?.result).toEqual({ blob: 'r:0' });
  });
});

describe('append failure modes (passing probes)', () => {
  it('a failed fsync rolls the line back, rejects journal_unwritable, and the next append is clean', async () => {
    const j = await openJournal();
    await j.append(entry('a:0', 'ok', 1));
    const before = readFileSync(journalFile());

    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    vi.spyOn(proto, 'sync').mockRejectedValueOnce(new Error('EIO'));

    const err = await j.append(entry('b:0', 'ok', 2)).catch((e) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
    expect(readFileSync(journalFile()).equals(before)).toBe(true);
    expect(j.get('b:0')).toBeUndefined();

    await j.append(entry('c:0', 'ok', 3));
    const reopened = await openJournal();
    expect(reopened.entries().map((e) => e.key)).toEqual(['a:0', 'c:0']);
  });

  it('a row never references a blob that failed to be written', async () => {
    const j = await openJournal();
    rmSync(join(dir, 'blobs'), { recursive: true, force: true });
    const err = await j.append(entry('big:0', 'ok', 'x'.repeat(70 * 1024))).catch((e) => e);
    expect((err as MaestroError).code).toBe('journal_unwritable');
    expect(existsSync(journalFile()) ? readFileSync(journalFile(), 'utf8') : '').toBe('');
    expect(j.entries()).toHaveLength(0);
  });

  it('a non-serializable result rejects without corrupting the file or the chain', async () => {
    const j = await openJournal();
    const err = await j.append(entry('bi:0', 'ok', { n: 1n })).catch((e) => e);
    expect((err as MaestroError).code).toBe('journal_unwritable');
    await j.append(entry('ok:0', 'ok', 'fine'));
    expect(lines()).toHaveLength(1);
  });

  it('50 concurrent appends land in call order, each durable when its promise resolves', async () => {
    const j = await openJournal();
    const seenOnDisk: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        j.append(entry(`k${i}:0`, 'ok', i, i)).then(() => {
          seenOnDisk.push(lines().length);
          expect(lines().some((l) => JSON.parse(l).key === `k${i}:0`)).toBe(true);
        }),
      ),
    );
    expect(lines().map((l) => JSON.parse(l).index)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(seenOnDisk.every((n, i) => n >= i + 1)).toBe(true);
  });
});

describe('reopen after interruption (passing probes)', () => {
  it('torn last line: ignored, logged once, truncated; next append yields a clean file', async () => {
    const j = await openJournal();
    await j.append(entry('a:0', 'ok', 'A'));
    await j.append(entry('b:0', 'ok', 'B'));
    await j.close();
    writeFileSync(journalFile(), `${readFileSync(journalFile(), 'utf8')}{"index":2,"key":"c:0","sta`);

    const log = vi.fn();
    const r = await openJournal(log);
    expect(r.entries().map((e) => e.key)).toEqual(['a:0', 'b:0']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(readFileSync(journalFile(), 'utf8').endsWith('\n')).toBe(true);
    await r.append(entry('c:0', 'ok', 'C'));
    expect(lines().map((l) => JSON.parse(l).key)).toEqual(['a:0', 'b:0', 'c:0']);
  });

  it.each(['{}', '[]', '"x"', 'null', '{"key":"k","status":"done"}'])(
    'a parseable non-entry line %s drops it and everything after',
    async (bad) => {
      writeFileSync(
        journalFile(),
        `${JSON.stringify(entry('a:0', 'ok', 1))}\n${bad}\n${JSON.stringify(entry('b:0', 'ok', 2))}\n`,
      );
      const log = vi.fn();
      const r = await openJournal(log);
      expect(r.entries().map((e) => e.key)).toEqual(['a:0']);
      expect(log).toHaveBeenCalled();
      expect(r.get('b:0')).toBeUndefined();
    },
  );

  it('empty journal file and fresh dir both open with zero rows (passing probe)', async () => {
    writeFileSync(journalFile(), '');
    const r = await openJournal();
    expect(r.entries()).toHaveLength(0);
    expect(r.get('x:0')).toBeUndefined();
  });

  it('a journal path that is a directory makes open throw journal_unwritable', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(journalFile());
    const err = await Journal.open(dir).catch((e) => e);
    expect((err as MaestroError).code).toBe('journal_unwritable');
  });
});

describe('get: latest ok only, blob failures count as null (passing probes)', () => {
  it('a later skipped/null row does not shadow the latest ok row; a newer ok row wins', async () => {
    const j = await openJournal();
    await j.append(entry('k:0', 'null', null));
    expect(j.get('k:0')).toBeUndefined();
    await j.append(entry('k:0', 'ok', 'first'));
    await j.append(entry('k:0', 'skipped', null));
    expect(j.get('k:0')?.result).toBe('first');
    await j.append(entry('k:0', 'ok', 'second'));
    const r = await openJournal();
    expect(r.get('k:0')?.result).toBe('second');
    expect(r.entries()).toHaveLength(4);
  });

  it.each([
    ['missing', (p: string) => rmSync(p)],
    ['empty', (p: string) => writeFileSync(p, '')],
    ['garbled', (p: string) => writeFileSync(p, '{"half":')],
  ])('%s blob → undefined + log, and the journal keeps working', async (_name, damage) => {
    const log = vi.fn();
    const j = await openJournal(log);
    await j.append(entry('b:0', 'ok', { big: 'z'.repeat(70 * 1024) }));
    damage(join(dir, 'blobs', 'b:0.json'));
    expect(j.get('b:0')).toBeUndefined();
    expect(log).toHaveBeenCalled();
    await j.append(entry('c:0', 'ok', 'after'));
    expect(j.get('c:0')?.result).toBe('after');
  });
});
