#!/usr/bin/env node
// A Codex CLI from before `app-server`: that subcommand is unknown; everything else is the exec double.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
// The record is of the transports agents ran on, so the runner's `mcp list` question is left out of it.
if (process.env.FAKE_CODEX_OLD_RECORD && argv[0] !== 'mcp') {
  appendFileSync(process.env.FAKE_CODEX_OLD_RECORD, `${argv[0]}\n`);
}
if (argv[0] === 'app-server') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n");
  process.exit(2);
}
await import('./fake-codex.mjs');
