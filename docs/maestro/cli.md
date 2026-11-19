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
| `--model <model>` | The run's model, overridden by `agent(..., { model })`. Default: `claude-opus-5-5`; Gateway requires an explicit `provider/model` here or on each agent. |
| `--runner <name>` | `anthropic` (default), `codex`, `gemini`, `gateway` or `auto`. See [Runners](/maestro/runners). |
| `--structured-mode <mode>` | `two-stage`, `submit-tool` or `single-stage`. Defaults to `two-stage` for Anthropic/Gemini and `submit-tool` for Gateway. See [Runners](/maestro/runners). |

## `maestro runs`

Lists the runs stored in a directory, newest first. `maestro ls` is the same command.

```text
maestro runs [--limit <n>] [--cwd <dir>] [--state-dir <dir>]
```

Each line shows the run id, its status (`done`, `failed` or `running`), the workflow name, the duration, agent counts and token usage.

## `maestro show`

```text
maestro show <runId> [label-or-live-id] [--compact] [--json] [--cwd <dir>] [--state-dir <dir>]
```

Without a label, lists the run's agents, outcome and latest recorded live activity. A live agent can be selected by label or numeric id. Recorded activity can be stale if its process died. For completed agents, a label or key prefix prints the trace, result, error and message audit. Passing `--compact` or `--json` delegates to `maestro inspect`.

## `maestro inspect`

```text
maestro inspect <runId> [label-or-key] [--compact] [--json] [--cwd <dir>] [--state-dir <dir>]
```

Produces a diagnostic summary designed for coding agents diagnosing failures without bloating their context window. With `--compact`, includes only failed (`null` / `skipped`) nodes with their exact input prompt, error, failed tool calls, raw/final text, and the most relevant upstream completed nodes (prioritizing upstream results referenced inside failing prompts). Pass `--json` for machine-readable structured JSON, or pass a label, `#index`, or key prefix to inspect one specific node.

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
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | The Gemini runner (`--runner gemini` and Gemini models in `--runner auto`). |
| `AI_GATEWAY_API_KEY` | The Vercel AI Gateway runner (`--runner gateway`). |

## Exit status

`maestro run` exits with 0 when the script returns, and with a non-zero status when the script fails, the run is stopped or the arguments are wrong.
