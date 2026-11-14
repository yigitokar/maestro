// The example custom tool examples/tools/arxiv_search.js, called directly with a fake fetch: the query
// it sends, how it formats arXiv's Atom feed, its errors and the shared spacing between requests.
// Never the network.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ToolDef } from '../src/types.js';

// A non-literal specifier: the example is plain JavaScript without type declarations.
const EXAMPLE = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'tools', 'arxiv_search.js'),
).href;
const { createArxivSearch, default: defaultTool } = await import(EXAMPLE);

const LONG_ABSTRACT = `We study ${'causal effects '.repeat(80)}in depth.`;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">93</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2012.00370v5</id>
    <published>2020-12-01T09:00:00Z</published>
    <title>Evaluating dynamic treatment effects
      by double machine learning</title>
    <summary>  Short &amp; sweet: &lt;b&gt; is not markup.  </summary>
    <author><name>Hugo Bodory</name></author>
    <author><name>Martin Huber</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="econ.EM" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2104.10334v1</id>
    <published>2021-04-21T00:00:00Z</published>
    <title>A big collaboration</title>
    <summary>${LONG_ABSTRACT}</summary>
    ${['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => `<author><name>${n}</name></author>`).join('\n    ')}
  </entry>
</feed>`;

const EMPTY_FEED = `<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
</feed>`;

const ERROR_FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id>
  <title>Error</title><summary>incorrect id format for 1234</summary>
</entry></feed>`;

/** A fetch that answers every call with `body` and remembers the URLs and when each call came. */
function fakeFetch(body: string, status = 200) {
  const calls: Array<{ url: URL; at: number }> = [];
  const fetch = async (url: string) => {
    calls.push({ url: new URL(url), at: Date.now() });
    return new Response(body, { status });
  };
  return { fetch, calls };
}

function tool(body = FEED, opts: { status?: number; minIntervalMs?: number } = {}) {
  const f = fakeFetch(body, opts.status);
  const t: ToolDef = createArxivSearch({ fetch: f.fetch, minIntervalMs: opts.minIntervalMs ?? 0 });
  return { t, calls: f.calls };
}

const ctx = (signal = new AbortController().signal) => ({ cwd: '.', signal });
const input = (query: string, more: { max_results?: number | null; sort_by?: string | null } = {}) => ({
  query,
  max_results: null,
  sort_by: null,
  ...more,
});

describe('arxiv_search (example custom tool)', () => {
  it('is a read tool named arxiv_search', () => {
    expect(defaultTool.name).toBe('arxiv_search');
    expect(defaultTool.write).toBe(false);
  });

  it('formats each paper: title and year, authors, id with category and link, the abstract', async () => {
    const { t } = tool();
    const out = await t.run(input('double machine learning'), ctx());
    expect(out).toContain('93 papers match; showing 2.');
    expect(out).toContain(
      [
        '1. Evaluating dynamic treatment effects by double machine learning (2020)',
        '   Hugo Bodory, Martin Huber',
        '   arXiv:2012.00370v5 [econ.EM] https://arxiv.org/abs/2012.00370v5',
        '   Short & sweet: <b> is not markup.',
      ].join('\n'),
    );
    // More than five authors are cut with "et al."; a long abstract is cut at 600 characters.
    expect(out).toContain(
      '2. A big collaboration (2021)\n   A, B, C, D, E et al.\n   arXiv:2104.10334v1 https://',
    );
    const abstract = out.split('\n').at(-1)!.trim();
    expect(abstract).toHaveLength(601);
    expect(abstract.endsWith('…')).toBe(true);
  });

  it('sends plain words as all:word AND all:word and keeps a query written in arXiv syntax', async () => {
    const { t, calls } = tool();
    await t.run(input('"double machine learning" treatment'), ctx());
    await t.run(input('au:Chernozhukov AND ti:debiased'), ctx());
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(calls[0]!.url.searchParams.get('search_query')).toBe(
      'all:"double machine learning" AND all:treatment',
    );
    expect(calls[1]!.url.searchParams.get('search_query')).toBe('au:Chernozhukov AND ti:debiased');
  });

  it('max_results defaults to 5 and stays within 1-20; sort_by picks the newest first', async () => {
    const { t, calls } = tool();
    await t.run(input('x'), ctx());
    await t.run(input('x', { max_results: 500 }), ctx());
    await t.run(input('x', { max_results: 0, sort_by: 'submittedDate' }), ctx());
    const p = calls.map((c) => c.url.searchParams);
    expect(p.map((s) => s.get('max_results'))).toEqual(['5', '20', '1']);
    expect(p.map((s) => s.get('sortBy'))).toEqual(['relevance', 'relevance', 'submittedDate']);
  });

  it('no match is "No results."', async () => {
    expect(await tool(EMPTY_FEED).t.run(input('zzzz'), ctx())).toBe('No results.');
  });

  it('errors become tool errors the agent sees: empty query, HTTP failure, arXiv rejecting the query', async () => {
    await expect(tool().t.run(input('  '), ctx())).rejects.toThrow('query must be a non-empty string');
    await expect(tool(FEED, { status: 503 }).t.run(input('x'), ctx())).rejects.toThrow(
      'arXiv returned HTTP 503',
    );
    await expect(tool(ERROR_FEED).t.run(input('id:1234'), ctx())).rejects.toThrow(
      'arXiv rejected the query: incorrect id format for 1234',
    );
  });

  it('concurrent calls are spaced by minIntervalMs, in call order', async () => {
    const { t, calls } = tool(FEED, { minIntervalMs: 80 });
    await Promise.all([t.run(input('a'), ctx()), t.run(input('b'), ctx()), t.run(input('c'), ctx())]);
    expect(calls.map((c) => c.url.searchParams.get('search_query'))).toEqual(['all:a', 'all:b', 'all:c']);
    // Slots are 80 ms apart; a request leaves a little after its slot when the event loop is busy, so
    // the gaps between requests are checked with room for that.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(40);
    expect(calls[2]!.at - calls[0]!.at).toBeGreaterThanOrEqual(120);
  });

  it('an agent that is stopped while waiting for its turn does not send the request', async () => {
    const { t, calls } = tool(FEED, { minIntervalMs: 5_000 });
    await t.run(input('first'), ctx());
    const c = new AbortController();
    const second = t.run(input('second'), ctx(c.signal));
    c.abort(new Error('skipped by user'));
    await expect(second).rejects.toThrow('skipped by user');
    expect(calls).toHaveLength(1);
  });
});
