// `codex mcp list --json` for the Codex doubles: the runner asks it which MCP servers to switch off.
// FAKE_CODEX_MCP_LIST is the stdout to answer with (default: no servers), or "fail" for a CLI that
// has no such command. Each call's argv is appended to FAKE_CODEX_MCP_RECORD, apart from the agents' records.
// FAKE_CODEX_MCP_LIST_DELAY_MS makes the answer slow.
import { appendFileSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export async function answerMcpList(argv) {
  if (argv[0] !== 'mcp') return;
  if (process.env.FAKE_CODEX_MCP_RECORD) {
    appendFileSync(process.env.FAKE_CODEX_MCP_RECORD, `${JSON.stringify(argv)}\n`);
  }
  await delay(Number(process.env.FAKE_CODEX_MCP_LIST_DELAY_MS ?? 0));
  const listing = process.env.FAKE_CODEX_MCP_LIST ?? '[]';
  if (listing === 'fail') {
    writeSync(2, "error: unrecognized subcommand 'mcp'\n");
    process.exit(2);
  }
  writeSync(1, listing);
  process.exit(0);
}
