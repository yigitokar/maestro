// Example custom tool: search arXiv papers (public API, no key). Copy this file into .maestro/tools/
// and an agent gets it with tools: ['arxiv_search', ...]. Tool files run in Maestro's own process,
// outside the script sandbox, so they may use fetch, timers and module state like the request queue below.

const API = 'https://export.arxiv.org/api/query';
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;
const SUMMARY_CAP = 600; // characters of each abstract
const AUTHOR_CAP = 5;
const TIMEOUT_MS = 20_000;
/** arXiv asks API clients to leave 3 seconds between requests; every agent of the process shares it. */
const MIN_INTERVAL_MS = 3_000;
const FIELD_PREFIX = /\b(?:ti|au|abs|co|jr|cat|rn|id|all):|\b(?:AND|OR|ANDNOT)\b/;

/**
 * Builds the tool. `fetch` and `minIntervalMs` are injectable for tests; the default export uses the
 * global fetch and arXiv's 3-second spacing.
 */
export function createArxivSearch({ fetch = globalThis.fetch, minIntervalMs = MIN_INTERVAL_MS } = {}) {
  let nextAt = 0;

  /** Reserves the next free request slot synchronously, so concurrent agents queue in call order. */
  async function waitTurn(signal) {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + minIntervalMs;
    if (at > now) await sleep(at - now, signal);
  }

  return {
    name: 'arxiv_search',
    description:
      'Search arXiv papers. Returns title, year, authors, arXiv id, category and the start of the abstract. ' +
      'query is plain words (all must match) or arXiv syntax: ti:, au:, abs:, cat: prefixes, AND/OR/ANDNOT, ' +
      `"quoted phrases". max_results is 1-${MAX_RESULTS} (null = ${DEFAULT_RESULTS}); sort_by is ` +
      '"relevance" (null) or "submittedDate" for the newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        sort_by: { anyOf: [{ type: 'string', enum: ['relevance', 'submittedDate'] }, { type: 'null' }] },
      },
      required: ['query', 'max_results', 'sort_by'],
      additionalProperties: false,
    },
    write: false,
    async run(input, ctx) {
      const query = typeof input?.query === 'string' ? input.query.trim() : '';
      if (query === '') throw new Error('query must be a non-empty string');
      const n = Number.isInteger(input.max_results)
        ? Math.min(Math.max(input.max_results, 1), MAX_RESULTS)
        : DEFAULT_RESULTS;
      const params = new URLSearchParams({
        search_query: toArxivQuery(query),
        start: '0',
        max_results: String(n),
        sortBy: input.sort_by === 'submittedDate' ? 'submittedDate' : 'relevance',
        sortOrder: 'descending',
      });
      await waitTurn(ctx.signal);
      const res = await fetch(`${API}?${params}`, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!res.ok) throw new Error(`arXiv returned HTTP ${res.status}`);
      const { total, entries } = parseFeed(await res.text());
      if (entries.length === 0) return 'No results.';
      const head = `${total ?? entries.length} papers match; showing ${entries.length}.`;
      return [head, ...entries.map((e, i) => formatEntry(e, i + 1))].join('\n\n');
    },
  };
}

export default createArxivSearch();

/** Plain words become all:word AND all:word; a query already written in arXiv syntax is kept. */
export function toArxivQuery(query) {
  if (FIELD_PREFIX.test(query)) return query;
  return (query.match(/"[^"]+"|\S+/g) ?? []).map((term) => `all:${term}`).join(' AND ');
}

/** The entries of an arXiv Atom feed. An arXiv error entry (bad query) is thrown as an error. */
export function parseFeed(xml) {
  const totalMatch = /<opensearch:totalResults[^>]*>(\d+)</.exec(xml);
  const entries = [];
  for (const [, body] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = text(body, 'id');
    if (id.includes('/api/errors')) throw new Error(`arXiv rejected the query: ${text(body, 'summary')}`);
    entries.push({
      id: id.replace(/^https?:\/\/arxiv\.org\/abs\//, ''),
      url: id.replace(/^http:/, 'https:'),
      title: text(body, 'title'),
      summary: text(body, 'summary'),
      published: text(body, 'published'),
      authors: [...body.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1])),
      category: /<arxiv:primary_category[^>]*\bterm="([^"]+)"/.exec(body)?.[1] ?? '',
    });
  }
  return { total: totalMatch ? Number(totalMatch[1]) : undefined, entries };
}

function formatEntry(e, n) {
  const year = e.published.slice(0, 4);
  const authors =
    e.authors.length > AUTHOR_CAP
      ? `${e.authors.slice(0, AUTHOR_CAP).join(', ')} et al.`
      : e.authors.join(', ');
  const summary = e.summary.length > SUMMARY_CAP ? `${e.summary.slice(0, SUMMARY_CAP)}…` : e.summary;
  return [
    `${n}. ${e.title}${year ? ` (${year})` : ''}`,
    `   ${authors}`,
    `   arXiv:${e.id}${e.category ? ` [${e.category}]` : ''} ${e.url}`,
    `   ${summary}`,
  ].join('\n');
}

function text(body, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? clean(m[1]) : '';
}

function clean(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
