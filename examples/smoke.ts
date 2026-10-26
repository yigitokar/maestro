// Real-API smoke test (not part of `npm test`): npm run smoke
// MAESTRO_MODEL=claude-haiku-5-5 npm run smoke   picks a cheaper model for the two agents.
// Runs a two-agent workflow against the Anthropic API: one schema agent with read-only tools,
// one plain-text agent fed from the first. Exits with an explanation when no API key is set.
// Runs on Node's built-in type stripping and imports the build, so `npm run build` comes first.

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnthropicRunner, attachTerminalProgress, Budget, run } from '../dist/index.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'smoke: ANTHROPIC_API_KEY is not set, so there is nothing to smoke-test. This script calls the real ' +
      'Anthropic API (a few thousand output tokens). Export a key and run `npm run smoke` again; ' +
      'everything else in the repo runs offline with `npm test` or `--dry-run`.',
  );
  process.exit(1);
}

const script = `export const meta = {
  name: 'smoke',
  description: 'İki ajanlı gerçek API duman testi',
  phases: [{ title: 'Read' }, { title: 'Summarize' }],
  maxAgents: 2,
}
const FILES = { type: 'object', properties: {
  files: { type: 'array', items: { type: 'string' } },
  entry: { type: 'string' } }, required: ['files', 'entry'] }
const listing = await agent('src/ dizinindeki .ts dosyalarını glob ile listele ve paketin giriş noktasını (index) söyle.',
  { label: 'list', phase: 'Read', schema: FILES, effort: 'low' })
if (!listing) return { ok: false, reason: 'listing agent returned null' }
log(listing.files.length + ' dosya bulundu')
const summary = await agent('Şu dosya listesine bakarak bu paketin ne yaptığını tek cümleyle söyle: ' + listing.files.join(', '),
  { label: 'summary', phase: 'Summarize', effort: 'low' })
return { ok: summary !== null, files: listing.files.length, entry: listing.entry, summary }`;

const handle = run({
  script,
  cwd: process.cwd(),
  stateDir: await mkdtemp(path.join(os.tmpdir(), 'maestro-smoke-')),
  model: process.env.MAESTRO_MODEL, // undefined → DEFAULT_MODEL (claude-opus-5-5)
  runner: new AnthropicRunner(),
  budget: new Budget({ total: 200_000 }),
});
const detach = attachTerminalProgress(handle, process.stderr);
try {
  const result = await handle.promise;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = (result as { ok?: boolean })?.ok ? 0 : 1;
} catch (err) {
  console.error(`smoke: run ${handle.runId} failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  detach();
}
