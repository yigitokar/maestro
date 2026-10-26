// Shared host for the example launchers: reads examples/workflows/<name>.js and runs it with
// run(). --dry-run uses FakeRunner with canned answers (no network); otherwise AnthropicRunner.
// Needs a build first: npm run build. MAESTRO_MODEL picks the model for real runs.

import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicRunner, attachTerminalProgress, FakeRunner, run } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} o
 * @param {string} o.name            workflow file under examples/workflows/
 * @param {unknown} o.args           default args (overridable with --args '<json>')
 * @param {import('../dist/index.js').FakeRule[]} o.rules  canned dry-run answers
 * @param {(dryRun: boolean) => Promise<{ cwd: string }>} [o.setup]  prepares the working dir
 */
export async function runExample({ name, args, rules, setup }) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const i = argv.indexOf('--args');
  const effectiveArgs = i !== -1 ? JSON.parse(argv[i + 1]) : args;
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      `${name}: ANTHROPIC_API_KEY is not set. Run with --dry-run to use the in-memory fake runner, ` +
        'or export the key to run real agents.',
    );
    process.exitCode = 1;
    return;
  }
  const { cwd } = setup ? await setup(dryRun) : { cwd: process.cwd() };
  const stateDir = dryRun ? await mkdtemp(path.join(os.tmpdir(), `maestro-${name}-`)) : undefined;
  const script = await readFile(path.join(here, 'workflows', `${name}.js`), 'utf8');
  const handle = run({
    script,
    args: effectiveArgs,
    cwd,
    ...(stateDir ? { stateDir } : {}),
    model: process.env.MAESTRO_MODEL, // undefined → DEFAULT_MODEL
    ...(process.env.MAESTRO_BUDGET ? { budget: Number(process.env.MAESTRO_BUDGET) } : {}), // output-token ceiling
    runner: dryRun ? new FakeRunner(rules) : new AnthropicRunner(),
    ...(dryRun ? { concurrency: 4 } : {}),
  });
  console.error(`${name}: run ${handle.runId}${dryRun ? ' (dry run)' : ''}, journal in ${handle.runDir}`);
  const detach = attachTerminalProgress(handle, process.stderr);
  try {
    const result = await handle.promise;
    console.log(JSON.stringify(result, null, 2));
    return { result, handle, cwd };
  } catch (err) {
    console.error(`${name}: run failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    detach();
  }
}
