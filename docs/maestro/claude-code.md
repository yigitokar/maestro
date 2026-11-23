---
title: "Claude Code"
description: "Use Maestro from Claude Code through its MCP server."
icon: "plug"
---

Maestro ships an MCP server. With it connected, Claude Code can write a workflow script, start it, and collect the result while you keep working.

## Set up

Add the server. `npx` downloads Maestro from npm the first time it runs:

```bash
claude mcp add --scope user maestro -- npx -y maestro-workflows mcp
```

The server carries the guide that teaches Claude how to write scripts: Claude reads it with the `WorkflowGuide` tool before its first script. You can also add the same guide as a skill, available in every project. This is optional:

```bash
mkdir -p ~/.claude/skills/maestro-workflow-authoring && curl -fsSL https://raw.githubusercontent.com/yigitokar/maestro/main/skill/SKILL.md -o ~/.claude/skills/maestro-workflow-authoring/SKILL.md
```

With the default runner the server uses the `ANTHROPIC_API_KEY` in Claude Code's environment, and the agents' cost is billed to that key. To run agents on your Codex plan instead, add `--runner codex` to the server command.

## The eight tools

| Tool | What it does |
|---|---|
| `Workflow` | Starts a run and returns at once with `{ runId, scriptPath, status: 'started' }`. |
| `WorkflowGuide` | Returns the guide to writing a script. It takes no input and starts nothing. |
| `WorkflowResult` | Returns a run's state: `running` with the agents now live, then `done` with the result or `failed` with the error. |
| `WorkflowInspect` | Returns a compact, agent-friendly failure summary (failed nodes, prompt and schema previews, errors, tool failures, and relevant upstream state) in Markdown or JSON. Pass `full: true` for complete recorded fields. |
| `WorkflowReplay` | Forks upstream cached agents from a previous run into a new `runId` and re-executes live from a chosen node (`from`), keeping the original run untouched. |
| `WorkflowStop` | Stops a run. Its journal stays, so it can be resumed. |
| `WorkflowSkip` | Skips one running agent. That `agent()` call returns `null` and the run goes on. |
| `WorkflowMessage` | Queues a follow-up instruction for one live agent and returns a delivery receipt. |

### `Workflow`

Takes exactly one of:

- `script`: the script text,
- `scriptPath`: a path to a script file,
- `name`: a workflow saved as `.maestro/workflows/<name>.js`.

And optionally:

- `args`: the script's arguments, as a JSON string.
- `resumeFromRunId`: resume that run. Without a script, the stored script and arguments are reused.
- `cwd`: run in another directory.

A bad input, a missing or impure `meta` block, or a syntax error returns an error result at once; nothing starts.

### `WorkflowResult`

With `wait: true` the call stays open until the run ends, so there is no need to poll. Claude Code moves a call that takes longer than two minutes to the background and delivers the result as a notification.

With `wait: false`, `liveAgents` includes each agent's queued/running state, elapsed time, last public activity, turn count, token usage, `canMessage`, and message receipts. Waiting calls send bounded activity, usage and delivery summaries when the client requests progress notifications. Internal reasoning and full tool output are not included.

A finished run's outcome is also on disk, so `WorkflowResult` answers for an old `runId` after the server has restarted. If the run was started with a `cwd`, pass the same `cwd`.

A one-shot `claude -p` session ends when its turn ends and does not wait for a background result. Use an interactive session to collect results.

### `WorkflowInspect`

Takes:

- `runId`: the run to inspect. Required.
- `label`: one agent to report, by label, `#index` or key prefix. Without it, the failed agents are reported.
- `compact`: report only the failed agents and the upstream agents that fed them, with long fields shortened. Defaults to `true`. Pass `false` for the longer report with every agent listed.
- `full`: do not shorten recorded prompts, schemas, outputs and arguments.
- `format`: `markdown` (default) or `json`.
- `cwd`: the directory the run was started in, if it was started with a `cwd`.

It reads the run from disk, so it works for a finished run, a running one, and a run from an earlier session. For a failed agent the report names the node to pass as `from` to `WorkflowReplay`. The library form is [`inspectRun()`](/maestro/library#inspecting-a-run).

### `WorkflowReplay`

Takes:

- `fromRunId`: the earlier run to fork. Required. It is never changed.
- `from`: the node to run live from: a label or key prefix that matches one agent, `#index`, or `phase:<title>` for the first agent in that phase. Without it, every cached `ok` agent is copied and only agents without a cached answer run.
- `script` or `scriptPath`: at most one, an edited script. Without either, the source run's script is reused. `scriptPath` is resolved against `cwd`.
- `args`: the script's arguments, as a JSON string. Without it, the source run's arguments are reused.
- `cwd`: the directory the source run was started in. The source run is looked up under `<cwd>/.maestro`.

It returns at once with `{ runId, forkedFrom, from, seededAgents, invalidatedAgents, scriptPath, status: 'started' }`. The new run is a normal run: collect it with `WorkflowResult` and control it with `WorkflowStop`, `WorkflowSkip` and `WorkflowMessage`. An unknown or ambiguous `from`, a missing source run, or a script that does not parse returns an error result at once; nothing starts.

Agents before `from` are served from the source run's journal and cost no tokens. In an edited script, an agent whose prompt or options changed runs live. See [`maestro replay`](/maestro/cli#maestro-replay) and [`replay()`](/maestro/library#replaying-a-run).

### `WorkflowMessage`

Read `WorkflowResult` and choose an agent with `canMessage: true`, then call:

```json
{ "runId": "<runId>", "agentId": 0, "message": "Also check cancellation during file writes." }
```

The response contains `{ runId, agentId, message: { id, status: "queued", queuedAt } }`. Inspect that agent's `messages` in later live results for `delivered` or `failed`. Delivery means the runner accepted the instruction; it does not mean the requested work is finished.

Anthropic agents receive instructions before their next safe model request, preserving tools already in progress. Codex app-server agents use live steering. Queued agents and runners without this capability report `canMessage: false`. Each agent accepts at most 32 messages, each at most 16,000 characters. Only the server that owns the run can send them.

Messages are recorded in the journal and event log, so keep credentials out. Successful steered results are reused on resume with an explicit log. Put durable instructions in the workflow prompt when changing them. See [Runners](/maestro/runners) for transport limitations.

## Working on another repository

A run normally works in the directory the session was opened in. The `cwd` input moves it:

- Agents work in that directory, and writers branch from its git repository.
- The run is stored under `<cwd>/.maestro`.
- `scriptPath` is resolved against it.

This lets one session work on any repository. Prefer giving a worktree of the repository over a checkout someone is using. When you resume, pass the same `cwd`, or the run is not found.

## Server options

The server takes `--cwd`, `--state-dir`, `--tools-dir`, `--budget`, `--concurrency`, `--model`, `--runner`, `--structured-mode` and `--dry-run`. See [Command line](/maestro/cli).

`--budget` is one pool for the session: all runs the server starts spend from the same budget.

The server ends when Claude Code disconnects or exits. Runs in progress are stopped and can be resumed.

## Your own tools

The `Workflow` tool's description lists the custom tools found in `.maestro/tools/`, so the model writing a script knows their names. See [Agents and tools](/maestro/agents-and-tools).

## Watching a run

The timeline works for runs started through the server too:

```bash
maestro viz <runId> --cwd <repo>
```
