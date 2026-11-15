# Command line

The command is `node bin/maestro` from the repository root, after `npm run build`. The examples below write `maestro` for short.

## `maestro run`

Runs a workflow script.

```text
maestro run <script.js> [options]
maestro run --resume <runId> [options]
```

The script's return value goes to stdout as JSON. Progress goes to stderr. Ctrl-C stops the run and prints the command that resumes it.

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
| `--model <model>` | The run's model. Default: `claude-opus-5-5`. |
| `--runner <name>` | `anthropic` (default), `codex` or `auto`. See [Runners](runners.md). |
| `--structured-mode <mode>` | `two-stage` (default), `submit-tool` or `single-stage`. See [Runners](runners.md). |

## `maestro runs`

Lists the runs stored in a directory, newest first. `maestro ls` is the same command.

```text
maestro runs [--limit <n>] [--cwd <dir>] [--state-dir <dir>]
```

Each line shows the run id, its status (`done`, `failed` or `running`), the workflow name, the duration, agent counts and token usage.

## `maestro show`

```text
maestro show <runId> [label] [--cwd <dir>] [--state-dir <dir>]
```

Without a label, lists the run's agents and its outcome. With a label, or the start of an agent's key, prints that agent's trace: tool calls, final text, result and error.

## `maestro viz`

```text
maestro viz <runId> [--port <n>] [--no-open] [--out <file.html>] [--widget] [--cwd <dir>] [--state-dir <dir>]
```

Opens a run's timeline in the browser and follows it while it runs. See [Runs, resume and budget](runs.md).

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

Serves Maestro as an MCP server over stdio. See [Claude Code](claude-code.md).

Here `--budget` is one pool for the whole session: every run the server starts spends from it.

The server exits when its client disconnects or is gone. Runs in progress are stopped, and their journals stay for resume.

## Environment

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | The Claude runner. |

## Exit status

`maestro run` exits with 0 when the script returns, and with a non-zero status when the script fails, the run is stopped or the arguments are wrong.
