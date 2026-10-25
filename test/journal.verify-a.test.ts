// Adversarial verification of the journal against spec 3.1, Seviye 2 data-flow steps 1/2/7, ADR-4 and
// the implementation brief. Tests assert SPEC behaviour; failures are real contract violations.

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJSON, hashCall, Journal, makeKey, Occurrences } from '../src/journal.js';
import type { AgentOpts, Entry, EntryStatus } from '../src/types.js';
import { MaestroError } from '../src/types.js';

let dir: string;
const opened: Journal[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maestro-journal-va-'));
});

afterEach(async () => {
  for (const j of opened.splice(0)) await j.close().catch(() => {});
  for (const p of [dir, join(dir, 'journal.jsonl'), join(dir, 'blobs')]) {
    try {
      chmodSync(p, 0o700);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

async function openJ(log?: (m: string) => void): Promise<Journal> {
  const j = await Journal.open(dir, log ? { log } : undefined);
  opened.push(j);
  return j;
}

function row(key: string, status: EntryStatus = 'ok', result: unknown = `r-${key}`, index = 0): Entry {
  const i = key.lastIndexOf(':');
  return {
    index,
    hash: key.slice(0, i),
    n: Number(key.slice(i + 1)),
    key,
    result: status === 'ok' ? result : null,
    usage: { input_tokens: 1, output_tokens: 2 },
    status,
  };
}

function lines(): string[] {
  return readFileSync(join(dir, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('canonicalJSON / hashCall (spec 3.1, ADR-4, data-flow step 1)', () => {
  it('hash formula: sha256(prompt + "\\n" + canonicalJSON(opts minus label/phase)), opts undefined = {}', () => {
    const expected = sha('p\n{}');
    expect(hashCall('p')).toBe(expected);
    expect(hashCall('p', {})).toBe(expected);
    expect(hashCall('p', { label: 'x', phase: 'y' })).toBe(expected);
    expect(hashCall('p', { model: 'm', label: 'L' })).toBe(sha('p\n{"model":"m"}'));
  });

  it('key order is irrelevant recursively; undefined props dropped', () => {
    const a = { effort: 'high', schema: { b: 1, a: { d: 1, c: 2 } } } as unknown as AgentOpts;
    const b = { schema: { a: { c: 2, d: 1 }, b: 1 }, effort: 'high' } as unknown as AgentOpts;
    expect(hashCall('p', a)).toBe(hashCall('p', b));
    expect(hashCall('p', { model: undefined })).toBe(hashCall('p', {}));
    expect(hashCall('p', { schema: { a: undefined } })).toBe(hashCall('p', { schema: {} }));
  });

  it('things that change the call change the hash', () => {
    expect(hashCall('p', { tools: ['a', 'b'] })).not.toBe(hashCall('p', { tools: ['b', 'a'] }));
    expect(hashCall('p', { model: 'x' })).not.toBe(hashCall('p'));
    expect(hashCall('p')).not.toBe(hashCall('q'));
  });

  it('canonicalJSON follows JSON.stringify semantics for ordinary values', () => {
    const v = { z: [1, 'a', null, undefined, () => 1, Number.NaN, -0], a: new Date(0), m: true };
    expect(JSON.parse(canonicalJSON(v))).toEqual(JSON.parse(JSON.stringify(v)));
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  // Brief: "otherwise JSON.stringify semantics". JSON.stringify writes holes as null.
  it('sparse array holes serialize as null (valid JSON, same as JSON.stringify)', () => {
    // biome-ignore lint/suspicious/noSparseArray: probing JSON.stringify hole semantics
    const sparse = [1, , 3];
    const out = canonicalJSON(sparse);
    expect(out).toBe(JSON.stringify(sparse)); // "[1,null,3]"
    expect(() => JSON.parse(out)).not.toThrow();
    expect(canonicalJSON(new Array(2))).toBe('[null,null]');
  });

  it('sparse and explicit-null arrays in opts hash the same (JSON.stringify equivalence)', () => {
    // biome-ignore lint/suspicious/noSparseArray: probing JSON.stringify hole semantics
    const holey = { schema: { enum: [1, , 3] } } as unknown as AgentOpts;
    const dense = { schema: { enum: [1, null, 3] } } as unknown as AgentOpts;
    expect(hashCall('p', holey)).toBe(hashCall('p', dense));
  });

  // Script opts are created inside the vm context (other realm). JSON.stringify unboxes cross-realm
  // boxed primitives via internal slots; canonicalJSON must agree.
  it('cross-realm boxed primitives serialize like JSON.stringify', () => {
    const v = vm.runInNewContext('({ model: new String("m"), n: new Number(3), b: new Boolean(false) })');
    expect(canonicalJSON(v)).toBe(JSON.stringify({ b: false, model: 'm', n: 3 }));
  });

  it('cross-realm plain objects/arrays (vm script opts) hash like host ones', () => {
    const v = vm.runInNewContext('({ tools: ["read_file"], schema: { type: "object", properties: {} } })');
    expect(hashCall('p', v)).toBe(
      hashCall('p', { schema: { properties: {}, type: 'object' }, tools: ['read_file'] }),
    );
  });

  // Spec 3.1 hata halleri: "Prompt'u değişen çağrı cache'i ıskalar ... sessiz yanlış cache daha kötü".
  // A script truncating text with .slice() can cut a surrogate pair; two different prompts must not
  // collapse to one key (createHash.update(string) replaces lone surrogates with U+FFFD).
  it('different prompts with different lone surrogates get different hashes', () => {
    const a = 'summarize: abc\uD83D'; // first half of an emoji, e.g. cut by slice()
    const b = 'summarize: abc\uD83E'; // first half of a different emoji
    expect(a).not.toBe(b);
    expect(hashCall(a)).not.toBe(hashCall(b));
  });
});

describe('Occurrences / makeKey (data-flow step 1, ADR-4)', () => {
  it('same hash 5x -> n 0..4, distinct keys; other hash starts at 0; fresh counter restarts', () => {
    const o = new Occurrences();
    const h = hashCall('same');
    const ns = [0, 1, 2, 3, 4].map(() => o.next(h));
    expect(ns).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(ns.map((n) => makeKey(h, n))).size).toBe(5);
    expect(o.next('other')).toBe(0);
    expect(new Occurrences().next(h)).toBe(0);
    expect(makeKey('abc', 7)).toBe('abc:7');
  });
});

describe('get(): only ok, latest ok (spec 3.1)', () => {
  it('latest ok wins; null/skipped never hit', async () => {
    const j = await openJ();
    await j.append(row('k:0', 'ok', 'A'));
    await j.append(row('k:0', 'null'));
    expect(j.get('k:0')?.result).toBe('A');
    await j.append(row('k:0', 'ok', 'B'));
    await j.append(row('k:0', 'skipped'));
    expect(j.get('k:0')?.result).toBe('B');
    await j.append(row('s:0', 'skipped'));
    await j.append(row('n:0', 'null'));
    expect(j.get('s:0')).toBeUndefined();
    expect(j.get('n:0')).toBeUndefined();
    expect(j.get('missing:0')).toBeUndefined();
  });

  it('budget resume: 6 ok + 4 skipped, reopen -> 6 hits, 4 misses, 14 rows after 4 live appends', async () => {
    const j1 = await openJ();
    for (let i = 0; i < 10; i++) await j1.append(row(`h${i}:0`, i < 6 ? 'ok' : 'skipped', `v${i}`, i));
    await j1.close();
    const j2 = await openJ();
    const hits = Array.from({ length: 10 }, (_, i) => j2.get(`h${i}:0`));
    expect(hits.filter(Boolean)).toHaveLength(6);
    for (let i = 6; i < 10; i++) await j2.append(row(`h${i}:0`, 'ok', `live${i}`, i));
    expect(j2.entries()).toHaveLength(14);
    expect(lines()).toHaveLength(14);
    await j2.close();
    const j3 = await openJ();
    for (let i = 0; i < 10; i++) expect(j3.get(`h${i}:0`)?.result).toBe(i < 6 ? `v${i}` : `live${i}`);
  });

  it('get is synchronous and returns a copy', async () => {
    const j = await openJ();
    await j.append(row('k:0', 'ok', 'A'));
    const e = j.get('k:0');
    expect(e).not.toBeInstanceOf(Promise);
    (e as Entry).status = 'null';
    expect(j.get('k:0')?.status).toBe('ok');
  });
});

describe('blobs (spec 3.1: > 64 KB in blobs/<key>.json)', () => {
  it('200 KB result: row has reference, file exists, get merges, entries keep stored form', async () => {
    const big = { text: 'x'.repeat(200 * 1024) };
    const j = await openJ();
    await j.append(row('b:0', 'ok', big));
    const stored = JSON.parse(lines()[0] as string);
    expect(stored.result).toEqual({ blob: 'b:0' });
    expect(stored.blob).toBe(true);
    const file = join(dir, 'blobs', 'b:0.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(big);
    const got = j.get('b:0');
    expect(got?.result).toEqual(big);
    expect(got?.blob).toBeUndefined();
    expect(j.entries()[0]?.result).toEqual({ blob: 'b:0' });
    await j.close();
    expect((await openJ()).get('b:0')?.result).toEqual(big);
  });

  it('threshold is bytes of JSON.stringify(result): 65536 inline, 65537 blob, multibyte counted in bytes', async () => {
    const j = await openJ();
    const exact = 'a'.repeat(64 * 1024 - 2); // + 2 quotes = 65536 bytes
    const over = 'a'.repeat(64 * 1024 - 1);
    const multi = 'é'.repeat(40 * 1024); // 40k chars, 80 KB
    await j.append(row('e:0', 'ok', exact));
    await j.append(row('o:0', 'ok', over));
    await j.append(row('m:0', 'ok', multi));
    const [l0, l1, l2] = lines().map((l) => JSON.parse(l));
    expect(l0.blob).toBeUndefined();
    expect(l0.result).toBe(exact);
    expect(l1.blob).toBe(true);
    expect(l2.blob).toBe(true);
    expect(j.get('m:0')?.result).toBe(multi);
  });

  it('a real small { blob } result is returned verbatim and creates no file', async () => {
    const j = await openJ();
    await j.append(row('r:0', 'ok', { blob: 'whatever' }));
    expect(j.get('r:0')?.result).toEqual({ blob: 'whatever' });
    expect(existsSync(join(dir, 'blobs', 'r:0.json'))).toBe(false);
  });

  it('missing or unreadable blob -> undefined + log naming the key; run continues', async () => {
    const logs: string[] = [];
    const j = await openJ((m) => logs.push(m));
    await j.append(row('b:0', 'ok', 'y'.repeat(70 * 1024)));
    await j.append(row('c:0', 'ok', 'z'.repeat(70 * 1024)));
    unlinkSync(join(dir, 'blobs', 'b:0.json'));
    writeFileSync(join(dir, 'blobs', 'c:0.json'), '{"torn');
    expect(j.get('b:0')).toBeUndefined();
    expect(j.get('c:0')).toBeUndefined();
    expect(logs.some((m) => m.includes('b:0'))).toBe(true);
    expect(logs.some((m) => m.includes('c:0'))).toBe(true);
    await j.append(row('d:0'));
    expect(j.get('d:0')?.result).toBe('r-d:0');
  });
});

describe('durability and torn lines (spec 3.1 hata halleri, data-flow step 7)', () => {
  it('torn tail: ignored, logged, truncated; next append lands on a clean line', async () => {
    const j1 = await openJ();
    await j1.append(row('a:0'));
    await j1.close();
    const path = join(dir, 'journal.jsonl');
    const good = statSync(path).size;
    appendFileSync(path, '{"index":1,"hash":"b","n":0,"key":"b:0","res');
    const logs: string[] = [];
    const j2 = await openJ((m) => logs.push(m));
    expect(j2.entries()).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(statSync(path).size).toBe(good);
    await j2.append(row('c:0'));
    expect(lines().map((l) => JSON.parse(l).key)).toEqual(['a:0', 'c:0']);
  });

  it('corrupt middle line drops it and everything after', async () => {
    const path = join(dir, 'journal.jsonl');
    const a = `${JSON.stringify(row('a:0'))}\n`;
    writeFileSync(path, `${a}{garbage\n${JSON.stringify(row('b:0'))}\n`);
    const logs: string[] = [];
    const j = await openJ((m) => logs.push(m));
    expect(j.entries().map((e) => e.key)).toEqual(['a:0']);
    expect(j.get('b:0')).toBeUndefined();
    expect(logs.length).toBeGreaterThan(0);
    expect(statSync(path).size).toBe(Buffer.byteLength(a));
  });

  it('valid JSON that is not an Entry counts as corrupt', async () => {
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, `${JSON.stringify(row('a:0'))}\n[]\n${JSON.stringify(row('b:0'))}\n`);
    const j = await openJ();
    expect(j.entries().map((e) => e.key)).toEqual(['a:0']);
  });

  it('append resolves only after the line is on disk; concurrent appends serialize in call order', async () => {
    const j = await openJ();
    await j.append(row('first:0'));
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toContain('"first:0"');
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => j.append(row(`p${i}:0`, 'ok', 'x'.repeat(i * 100)))),
    );
    const keys = lines().map((l) => JSON.parse(l).key);
    expect(keys).toEqual(['first:0', ...Array.from({ length: 50 }, (_, i) => `p${i}:0`)]);
  });

  it('append after close rejects journal_unwritable', async () => {
    const j = await openJ();
    await j.close();
    await expect(j.append(row('a:0'))).rejects.toMatchObject({ code: 'journal_unwritable' });
  });
});

describe('unwritable journal: run must not start (spec 3.1)', () => {
  it.skipIf(isRoot)('read-only run dir with no journal -> journal_unwritable', async () => {
    chmodSync(dir, 0o500);
    const err = await Journal.open(dir).catch((e) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect(err.code).toBe('journal_unwritable');
  });

  it.skipIf(isRoot)('read-only existing journal.jsonl -> journal_unwritable', async () => {
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, `${JSON.stringify(row('a:0'))}\n`);
    chmodSync(path, 0o400);
    await expect(Journal.open(dir)).rejects.toMatchObject({ code: 'journal_unwritable' });
  });

  it('run dir path is a regular file -> journal_unwritable', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    await expect(Journal.open(file)).rejects.toMatchObject({ code: 'journal_unwritable' });
  });
});
