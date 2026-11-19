---
title: "Command line"
description: "Every maestro command and flag."
icon: "terminal"
---

The command is `maestro`, after `npm install -g maestro-workflows`. Without an install, write `npx maestro-workflows` in its place.

## `maestro run`

Runs a workflow script.

```text
maestro run <script.js> [options]
maestro run --resume <runId> [options]
```

The script's return value goes to stdout as JSON. Progress goes to stderr. Ctrl-C stops the run and prints the command that resumes it.

The terminal progress tree updates live agent activity and token usage when attached to a TTY.

| Flag | Meaning |
|---|---|
| `--args <json>` | The script's `args`, as JSON. |
| `--args-file <file>` | The script's `args`, read from a JSON file. |
| `--resume <runId>` | Resume a run. Without a script, the stored script and arguments are reused. |
| `--budget <n>` | Output-token budget for the run: `20000`, `500k`, `1.5m`. |
| `--dry-run` | Replace every agent with a fake that answers from the schema. No network. |
| `--cwd <dir>` | The directory agents work in. Default: the current directory. |
| `--state-dir <dir>` | Where runs are stored. Default: `<cwd>/.maestro`. |
| `--tools-dir <dir>` | Where custom tools are loaded from. Default: `<state-dir>/tools`. |
| `--concurrency <n>` | How many agents may run at once. |
| `--model <model>` | The run's model, overridden by `agent(..., { model })`. Default: `claude-opus-5-5`; Gemini takes a Gemini model ID. Gateway requires an explicit `provider/model` here or on each agent. |
| `--runner <name>` | `anthropic` (default), `codex`, `gemini`, `gateway` or `auto`. See [Runners](/maestro/runners). |
| `--structured-mode <mode>` | `two-stage`, `submit-tool` or `single-stage`. Defaults to `two-stage` for Anthropic and `submit-tool` for Gateway. See [Runners](/maestro/runners). |

## `maestro eval`

```sh
maestro eval triage.js --cases cases.json --runner auto
maestro eval triage.js --cases cases.json --baseline <eval-id> --from classify --runner auto
maestro eval diff <first-eval-id> <second-eval-id>
```

The suite is a JSON array of cases with a unique `id`, optional `args`, and an `expected` return value. The report gives each case a workflow run ID for inspection. Both commands accept `--json`, `--cwd`, and `--state-dir`. See [Evaluating workflows](/maestro/evals) for a runnable example and the cache metric definitions.

## `maestro inspect`

```sh
maestro inspect [runId] --compact [--cwd <dir>] [--state-dir <dir>]
```

Omit the run ID to inspect the newest run from `maestro runs`. Compact mode prints a JSON object for the latest attempt. Each failed or skipped agent includes its numeric ID, label, reason, prompt, agent options, effective model and tools, returned value, and any raw invalid answer. Delivered live instructions appear with the input. A top-level error appears in `runError`. Calls that fail validation or budget admission appear in `rejectedCalls` with the submitted inputs and reason. Their diagnostic IDs are separate from the numeric IDs assigned when agents start. Errors caught by `parallel()` or `pipeline()` appear in `stepErrors`, even if the workflow itself returned successfully.

For pipeline calls, `upstream.pipeline` contains the item index, stage number, previous stage’s value, and the original item when it differs. Non-JSON stage inputs are marked unavailable. For ordinary JavaScript control flow, include selected upstream values with the audit-only `upstream` option. For example:

```js
await agent(prompt, { label: 'judge', upstream: { sourceId, acceptedFindings } })
```

This state is saved when the call fails. Existing journals can supply their recorded prompt preview. The report marks incomplete or unavailable input explicitly. Without `--compact`, inspect shows the usual run overview.

## `maestro replay`

```sh
maestro replay <runId> --from <node> [--script <edited.js>] [run options]
```

Creates a new run, reuses successful earlier calls, and runs the selected call and its suffix live. Select the node by invocation ID, unique label, or full journal key. Use `--script` to try an edit against the stored arguments. See [Replaying a run](/maestro/runs#replay-from-a-node).

## `maestro runs`

Lists the runs stored in a directory, newest first. `maestro ls` is the same command.

```text
maestro runs [--limit <n>] [--cwd <dir>] [--state-dir <dir>]
```

Each line shows the run id, its status (`done`, `failed` or `running`), the workflow name, the duration, agent counts and token usage.

## `maestro show`

```text
maestro show <runId> [label-or-live-id] [--cwd <dir>] [--state-dir <dir>]
```

Without a label, lists the run's agents, outcome and latest recorded live activity. A live agent can be selected by label or numeric id. Recorded activity can be stale if its process died. For completed agents, a label or key prefix prints the trace, result, error and message audit.

Live instructions are sent through `WorkflowMessage` on the owning MCP connection or the library's `sendMessage` handle, not through a separate CLI process.

## `maestro viz`

```text
maestro viz <runId> [--port <n>] [--no-open] [--out <file.html>] [--widget] [--cwd <dir>] [--state-dir <dir>]
```

Opens a run's timeline in the browser and follows it while it runs. See [Runs, resume and budget](/maestro/runs).

## `maestro gc`

```text
maestro gc [--delete] [--force] [--cwd <dir>]
```

Lists the worktrees and `wf/*` branches that writing agents left behind. `--delete` removes clean worktrees and merged branches. `--force` also removes worktrees with uncommitted work and unmerged branches.

## `maestro mcp`

```text
maestro mcp [--cwd <dir>] [--state-dir <dir>] [--tools-dir <dir>] [--budget <n>] [--concurrency <n>]
            [--model <model>] [--runner <name>] [--structured-mode <mode>] [--dry-run]
```

Serves Maestro as an MCP server over stdio. See [Claude Code](/maestro/claude-code).

Here `--budget` is one pool for the whole session: every run the server starts spends from it.

The server exits when its client disconnects or is gone. Runs in progress are stopped, and their journals stay for resume.

## Environment

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | The Claude runner. |
| `AI_GATEWAY_API_KEY` | The Vercel AI Gateway runner (`--runner gateway`). |

## Exit status

`maestro run` exits with 0 when the script returns, and with a non-zero status when the script fails, the run is stopped or the arguments are wrong.
