// Unit tests for the journal (spec 3.1): canonical hashing, occurrence keys, latest-ok lookup,
// blobs, torn-line recovery, durable serialized appends and the unwritable-run-dir failure.

import { appendFileSync, chmodSync, existsSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, hashCall, Journal, makeKey, Occurrences } from '../src/journal.js';
import type { Entry } from '../src/types.js';
import { MaestroError } from '../src/types.js';

let dir: string;
const opened: Journal[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maestro-journal-'));
});

afterEach(async () => {
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

function entry(key: string, over: Partial<Entry> = {}): Entry {
  const [hash = key, n = '0'] = key.split(':');
  return {
    index: 0,
    hash,
    n: Number(n),
    key,
    result: { value: key },
    usage: { input_tokens: 1, output_tokens: 2 },
    status: 'ok',
    ...over,
  };
}

function fileLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('canonicalJSON', () => {
  it('sorts keys so {a,b} and {b,a} serialize and hash identically', () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
    expect(canonicalJSON({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    const s1 = { type: 'object', properties: { x: { type: 'string' } } };
    const s2 = { properties: { x: { type: 'string' } }, type: 'object' };
    expect(hashCall('p', { schema: s1, model: 'm' })).toBe(hashCall('p', { model: 'm', schema: s2 }));
  });

  it('sorts nested objects, including objects inside arrays, and keeps array order', () => {
    const a = { z: { y: 1, x: [{ q: 1, p: 2 }, 3] }, a: [2, 1] };
    const b = { a: [2, 1], z: { x: [{ p: 2, q: 1 }, 3], y: 1 } };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
    expect(canonicalJSON(a)).toBe('{"a":[2,1],"z":{"x":[{"p":2,"q":1},3],"y":1}}');
    expect(canonicalJSON([1, 2])).not.toBe(canonicalJSON([2, 1]));
  });

  it('sorts integer-like keys lexicographically like any other key', () => {
    expect(canonicalJSON({ 10: 'a', 9: 'b', x: 'c' })).toBe('{"10":"a","9":"b","x":"c"}');
  });

  it('follows JSON.stringify semantics otherwise', () => {
    expect(canonicalJSON({ a: undefined, b: () => 1, c: 1 })).toBe('{"c":1}');
    expect(canonicalJSON([undefined, Number.NaN, Infinity, 'x'])).toBe('[null,null,null,"x"]');
    expect(canonicalJSON(new Date(0))).toBe(JSON.stringify(new Date(0)));
    expect(canonicalJSON('a"b')).toBe('"a\\"b"');
    expect(canonicalJSON(null)).toBe('null');
    expect(() => canonicalJSON({ n: 1n })).toThrow(TypeError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJSON(cyc)).toThrow(TypeError);
    // A repeated (non-circular) reference is fine.
    const shared = { k: 1 };
    expect(canonicalJSON({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}');
  });
});

describe('hashCall / makeKey / Occurrences', () => {
  it('is sha256 hex and excludes label and phase from the hash', () => {
    const h = hashCall('prompt');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCall('prompt', {})).toBe(h);
    expect(hashCall('prompt', { label: 'x' })).toBe(h);
    expect(hashCall('prompt', { phase: 'y' })).toBe(h);
    expect(hashCall('prompt', { label: 'a', phase: 'b', model: 'm' })).toBe(
      hashCall('prompt', { model: 'm' }),
    );
    expect(hashCall('prompt', { model: 'm' })).not.toBe(h);
    expect(hashCall('prompt2')).not.toBe(h);
    expect(hashCall('prompt', { effort: 'low' })).not.toBe(hashCall('prompt', { effort: 'high' }));
  });

  it('makeKey joins hash and n', () => {
    expect(makeKey('abc', 3)).toBe('abc:3');
  });

  it('same prompt 5 times: same hash, n 0..4, 5 distinct keys, 5 rows', async () => {
    const occ = new Occurrences();
    const j = await openJournal();
    const keys: string[] = [];
    const hashes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const hash = hashCall('loop prompt', { label: `round ${i}` });
      hashes.add(hash);
      const n = occ.next(hash);
      expect(n).toBe(i);
      const key = makeKey(hash, n);
      keys.push(key);
      await j.append({ ...entry(key), index: i, hash, n, result: i });
    }
    expect(hashes.size).toBe(1);
    expect(new Set(keys).size).toBe(5);
    expect(j.entries()).toHaveLength(5);
    expect(fileLines(j.path)).toHaveLength(5);
    expect(keys.map((k) => j.get(k)?.result)).toEqual([0, 1, 2, 3, 4]);
    // Counters are per hash.
    expect(occ.next('other')).toBe(0);
    expect(occ.next(keys[0]!.split(':')[0]!)).toBe(5);
  });
});

describe('Journal.get', () => {
  it('returns undefined for unknown keys and for null/skipped-only keys', async () => {
    const j = await openJournal();
    await j.append(entry('h:0', { status: 'null', result: null }));
    await j.append(entry('h:1', { status: 'skipped', result: null }));
    expect(j.get('nope:0')).toBeUndefined();
    expect(j.get('h:0')).toBeUndefined();
    expect(j.get('h:1')).toBeUndefined();
  });

  it('null row then ok row returns the ok row', async () => {
    const j = await openJournal();
    await j.append(entry('h:0', { status: 'null', result: null, error: 'api 500' }));
    await j.append(entry('h:0', { status: 'ok', result: 'fresh' }));
    expect(j.get('h:0')?.status).toBe('ok');
    expect(j.get('h:0')?.result).toBe('fresh');
  });

  it('ok row then null row still returns the ok row', async () => {
    const j = await openJournal();
    await j.append(entry('h:0', { status: 'ok', result: 'kept' }));
    await j.append(entry('h:0', { status: 'null', result: null }));
    await j.append(entry('h:0', { status: 'skipped', result: null }));
    expect(j.get('h:0')?.result).toBe('kept');
  });

  it('returns the latest ok row when several exist, also after re-open', async () => {
    const j = await openJournal();
    await j.append(entry('h:0', { result: 'first' }));
    await j.append(entry('h:0', { result: 'second' }));
    await j.append(entry('h:0', { status: 'null', result: null }));
    expect(j.get('h:0')?.result).toBe('second');
    await j.close();
    const j2 = await openJournal();
    expect(j2.entries()).toHaveLength(3);
    expect(j2.get('h:0')?.result).toBe('second');
  });
});

describe('Journal blobs', () => {
  const big = { text: 'x'.repeat(200 * 1024), nested: { n: 1 } };

  it('stores a 200 KB result in blobs/<key>.json and get() resolves it', async () => {
    const j = await openJournal();
    await j.append(entry('big:0', { result: big }));

    const line = JSON.parse(fileLines(j.path)[0]!);
    expect(line.blob).toBe(true);
    expect(line.result).toEqual({ blob: 'big:0' });
    expect(readFileSync(j.path).length).toBeLessThan(1024);
    const blobFile = join(dir, 'blobs', 'big:0.json');
    expect(existsSync(blobFile)).toBe(true);
    expect(JSON.parse(readFileSync(blobFile, 'utf8'))).toEqual(big);

    expect(j.entries()[0]!.result).toEqual({ blob: 'big:0' });
    const got = j.get('big:0');
    expect(got?.result).toEqual(big);
    expect(got?.blob).toBeUndefined();

    await j.close();
    const j2 = await openJournal();
    expect(j2.get('big:0')?.result).toEqual(big);
  });

  it('keeps results at or under 64 KB inline', async () => {
    const j = await openJournal();
    // JSON.stringify adds 2 quote bytes: exactly 64 KB serialized.
    const exact = 'y'.repeat(64 * 1024 - 2);
    await j.append(entry('small:0', { result: exact }));
    const line = JSON.parse(fileLines(j.path)[0]!);
    expect(line.blob).toBeUndefined();
    expect(line.result).toBe(exact);
    expect(existsSync(join(dir, 'blobs', 'small:0.json'))).toBe(false);
    await j.append(entry('small:1', { result: `${exact}z` }));
    expect(JSON.parse(fileLines(j.path)[1]!).blob).toBe(true);
  });

  it('a missing blob file makes get() return undefined and logs', async () => {
    const j = await openJournal();
    await j.append(entry('big:0', { result: big }));
    await j.close();
    unlinkSync(join(dir, 'blobs', 'big:0.json'));

    const log = vi.fn();
    const j2 = await openJournal(log);
    expect(j2.get('big:0')).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('big:0');
    expect(j2.entries()).toHaveLength(1);
  });
});

describe('Journal crash recovery', () => {
  it('ignores a torn last line, logs it, truncates, and later appends stay valid', async () => {
    const j = await openJournal();
    await j.append(entry('a:0'));
    await j.append(entry('b:0'));
    await j.close();
    const goodSize = statSync(join(dir, 'journal.jsonl')).size;

    // Simulated crash mid-write: half a JSON row without the trailing newline.
    appendFileSync(join(dir, 'journal.jsonl'), '{"index":2,"hash":"c","n":0,"key":"c:0","res');

    const log = vi.fn();
    const j2 = await openJournal(log);
    expect(j2.entries().map((e) => e.key)).toEqual(['a:0', 'b:0']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/line 3/);
    expect(statSync(j2.path).size).toBe(goodSize);
    expect(j2.get('c:0')).toBeUndefined();

    await j2.append(entry('c:0'));
    await j2.close();

    const log3 = vi.fn();
    const j3 = await openJournal(log3);
    expect(log3).not.toHaveBeenCalled();
    expect(j3.entries().map((e) => e.key)).toEqual(['a:0', 'b:0', 'c:0']);
    for (const l of fileLines(j3.path)) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('a corrupt line in the middle drops it and every line after it', async () => {
    const j = await openJournal();
    await j.append(entry('a:0'));
    await j.close();
    const path = join(dir, 'journal.jsonl');
    const goodSize = statSync(path).size;
    appendFileSync(path, `{"broken":\n${JSON.stringify(entry('b:0'))}\n`);

    const log = vi.fn();
    const j2 = await openJournal(log);
    expect(j2.entries().map((e) => e.key)).toEqual(['a:0']);
    expect(j2.get('b:0')).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(statSync(path).size).toBe(goodSize);
  });

  it('treats an unterminated but parseable last line as torn', async () => {
    const path = join(dir, 'journal.jsonl');
    appendFileSync(path, `${JSON.stringify(entry('a:0'))}\n${JSON.stringify(entry('b:0'))}`);
    const log = vi.fn();
    const j = await openJournal(log);
    expect(j.entries().map((e) => e.key)).toEqual(['a:0']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('handles multi-byte UTF-8 content when truncating', async () => {
    const j = await openJournal();
    await j.append(entry('u:0', { result: 'çğışöü — 日本語 🎼' }));
    await j.close();
    const path = join(dir, 'journal.jsonl');
    const goodSize = statSync(path).size;
    appendFileSync(path, '{"key":"ü');
    const j2 = await openJournal();
    expect(statSync(path).size).toBe(goodSize);
    expect(j2.get('u:0')?.result).toBe('çğışöü — 日本語 🎼');
  });
});

describe('Journal append durability and ordering', () => {
  it('data is in the file as soon as append resolves', async () => {
    const j = await openJournal();
    expect(j.path).toBe(join(dir, 'journal.jsonl'));
    await j.append(entry('a:0', { result: 'one' }));
    const lines = fileLines(j.path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ key: 'a:0', result: 'one', status: 'ok' });
    await j.append(entry('b:0', { result: 'two' }));
    expect(fileLines(j.path)).toHaveLength(2);
  });

  it('concurrent appends do not interleave lines', async () => {
    const j = await openJournal();
    const big = 'z'.repeat(100 * 1024);
    const all = Array.from({ length: 50 }, (_, i) =>
      entry(`k${i}:0`, { index: i, result: i % 10 === 3 ? { big, i } : { text: 'w'.repeat(5000), i } }),
    );
    await Promise.all(all.map((e) => j.append(e)));

    const lines = readFileSync(j.path, 'utf8').split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(50);
    const parsed = lines.map((l) => JSON.parse(l) as Entry);
    // Serialized: rows land in call order.
    expect(parsed.map((e) => e.index)).toEqual(all.map((e) => e.index));
    expect(parsed.filter((e) => e.blob === true)).toHaveLength(5);
    expect(j.entries()).toHaveLength(50);
    for (let i = 0; i < 50; i++) expect(j.get(`k${i}:0`)?.result).toMatchObject({ i });
  });

  it('entries() returns every row as stored, including null and skipped', async () => {
    const j = await openJournal();
    await j.append(entry('a:0'));
    await j.append(entry('a:1', { status: 'null', result: null }));
    await j.append(entry('a:2', { status: 'skipped', result: null }));
    expect(j.entries().map((e) => e.status)).toEqual(['ok', 'null', 'skipped']);
  });

  it('close() waits for pending appends; append after close rejects', async () => {
    const j = await openJournal();
    const p = j.append(entry('a:0'));
    await j.close();
    await p;
    expect(fileLines(j.path)).toHaveLength(1);
    await expect(j.append(entry('b:0'))).rejects.toMatchObject({ code: 'journal_unwritable' });
  });
});

describe('Journal.open failures', () => {
  it.skipIf(process.getuid?.() === 0)(
    'rejects with journal_unwritable when the run dir is not writable',
    async () => {
      chmodSync(dir, 0o500);
      const err = await Journal.open(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MaestroError);
      expect((err as MaestroError).code).toBe('journal_unwritable');
    },
  );

  it('creates the run dir and blobs dir when missing', async () => {
    const runDir = join(dir, 'runs', 'r1');
    const j = await Journal.open(runDir);
    opened.push(j);
    expect(existsSync(join(runDir, 'blobs'))).toBe(true);
    expect(j.entries()).toEqual([]);
  });
});
