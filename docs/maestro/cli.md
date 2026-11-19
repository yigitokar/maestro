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

## `maestro replay`

```text
maestro replay <runId> [--from <node>] [script.js] [options]
```

Time-travel replay: forks upstream `ok` cached agents from `<runId>` into a brand-new `runId` and re-executes live from `<node>` onward, leaving the original run directory untouched for comparison and audit. Select a node by unique label or unique key prefix, by index (`#index` or `index`), or by `phase:<title>` for the first node in that phase. Pass an edited `script.js` to iterate on prompts or graph logic without re-running expensive upstream LLM calls. Accepts the same runner, model, budget, args and directory flags as `maestro run`.

## `maestro runs`

Lists the runs stored in a directory, newest first. `maestro ls` is the same command.

```text
maestro runs [--limit <n>] [--cwd <dir>] [--state-dir <dir>]
```

Each line shows the run id, its status (`done`, `failed` or `running`), the workflow name, the duration, agent counts and token usage. A replay counts seeded agents, but their tokens are charged only to the run that originally executed them.

## `maestro show`

```text
maestro show <runId> [label-or-live-id] [--compact] [--full] [--json] [--cwd <dir>] [--state-dir <dir>]
```

Without a label, lists the run's agents, outcome and latest recorded live activity. A live agent can be selected by label or numeric id. Recorded activity can be stale if its process died. For completed agents, a label or key prefix prints the trace, result, error and message audit. Passing `--compact`, `--full`, or `--json` delegates to `maestro inspect`.

## `maestro inspect`

```text
maestro inspect <runId> [label-or-key] [--compact] [--full] [--json] [--cwd <dir>] [--state-dir <dir>]
```

Produces a diagnostic summary designed for coding agents diagnosing failures without bloating their context window. With `--compact`, includes only failed (`null` / `skipped`) nodes with their prompt and schema previews, error, failed tool calls, raw/final text, and the most relevant upstream completed nodes (prioritizing upstream results referenced inside failing prompts). Pass `--full` for complete workflow arguments, recorded prompts, schemas and outputs. Markdown reports display recorded schemas in fenced JSON blocks. Older failures may have only an event preview. Agent counts and upstream state reflect the latest attempt, including cache hits. A label, `#index`, or key prefix selects from that attempt first, then from earlier rows if needed. Pass `--json` for structured output.

Live instructions are sent through `WorkflowMessage` on the owning MCP connection or the library's `sendMessage` handle, not through a separate CLI process.

## `maestro eval`

```text
maestro eval <script.js> --cases <file.json|jsonl> [--grader <file.js>] [--name <evalId>]
             [--from-eval <evalId>] [--from <node>] [--only <id,...>] [--limit <n>]
             [--case-concurrency <n>] [--json] [run options]
maestro eval diff <run-a> <run-b> [--json] [--fail-on-regression] [--cwd <dir>] [--state-dir <dir>]
maestro eval ls [--limit <n>] [--json] [--cwd <dir>] [--state-dir <dir>]
```

Runs a workflow across a JSON or JSONL case dataset, grades each case via declarative `expect` rules (`equals`, `match`, `contains`, `notContains`, `regex`) or a custom ESM `--grader` module, and saves the eval record under `<state-dir>/evals/<evalId>/eval.json`.

Pass `--from-eval <prevEvalId>` (optionally paired with `--from <node>`) to time-travel replay every matching case from an earlier eval run so unchanged upstream agents are served from cache. Compare any two eval runs—or two individual workflow `runId`s—with `maestro eval diff <run-a> <run-b>` to see score delta, fixed vs. regressed cases, token/cost delta, and `[CACHE HIT]` ratio.

Eval prices each live call at the model its runner reported sending, which the run records on the call's `agent_end` event. A model set on the runner itself (`new GeminiRunner({ model })`, `new CodexRunner({ model })`, a custom `route`) is therefore priced as what ran, not as what the workflow asked for. Codex on its configuration default runs on a model Maestro does not learn. The runner records that as `model: null`, and the call has no estimate, however it was routed to Codex. When no model was recorded at all, eval falls back to the requested model, resolved through default routing. That is the case for a custom runner that does not set `RunResult.model` and for runs recorded before the model was recorded. Journal cache hits cost zero. If any live tokens have an unknown or unpriced model, the case and suite estimates are `null`. Without a `run_start` event, eval uses live journal rows for token usage and reports `null` cost for nonzero usage. Case and suite costs are each rounded to six decimal places after summing. The summary and `eval ls` show the resolved default model or `(runner default)` when the runner chooses it internally. That label is worked out from the run's default model and the runner's class, not from the recorded calls, so it does not show a model set on the runner itself. The built-in `MODEL_PRICES` table is a reference snapshot in USD per million tokens. The programmatic `prices` option overrides entries by model ID.

The diff lists cases with edited arguments or expectations under **Changed Cases** and excludes them from `--fail-on-regression`. Changed cases that fail include the reason when available and an inspect command. Older records without case hashes and individual workflow runs are compared by status.

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
