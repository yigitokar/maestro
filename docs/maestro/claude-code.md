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

## The five tools

| Tool | What it does |
|---|---|
| `Workflow` | Starts a run and returns at once with `{ runId, scriptPath, status: 'started' }`. |
| `WorkflowGuide` | Returns the guide to writing a script. It takes no input and starts nothing. |
| `WorkflowResult` | Returns a run's state: `running` with the agents now live, then `done` with the result or `failed` with the error. |
| `WorkflowStop` | Stops a run. Its journal stays, so it can be resumed. |
| `WorkflowSkip` | Skips one running agent. That `agent()` call returns `null` and the run goes on. |

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

A finished run's outcome is also on disk, so `WorkflowResult` answers for an old `runId` after the server has restarted. If the run was started with a `cwd`, pass the same `cwd`.

A one-shot `claude -p` session ends when its turn ends and does not wait for a background result. Use an interactive session to collect results.

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
