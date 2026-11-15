---
title: "Runs, resume and budget"
description: "What a run leaves on disk, how resume works, budgets, and watching a run."
icon: "clock-rotate-left"
---

## What a run leaves on disk

Every run gets an id such as `20261025-150301-a1b2c3` and a directory `.maestro/runs/<runId>/` in the directory it ran in.

| File | Contents |
|---|---|
| `script.js` | The script as it ran. |
| `args.json` | The arguments. |
| `run.json` | The run's model and runner. |
| `journal.jsonl` | One line per `agent()` call: its key, status, result, token usage and a trace. |
| `blobs/` | Results larger than 64 KB, one file each. |
| `events.jsonl` | Every event with a wall-clock time. Used only for display. |
| `outcome.json` | The final result or error, written when the run ends. |

Add `.maestro/` to your `.gitignore`.

## Resume

```bash
node bin/maestro run review.js --resume <runId>
```

Resume runs the script again from the top. Each `agent()` call is looked up in the journal by a key made from its prompt, its options (without `label` and `phase`) and how many times the same call has occurred. A call found with status `ok` returns its stored answer without running.

This gives resume three uses:

- **Edit and rerun.** Change one prompt, and only that agent and the agents that depend on its answer run again.
- **Continue after a stop.** Agents that were running when the run stopped are recorded as `skipped` and run on resume.
- **Raise the budget.** Agents that failed (`null`) or were skipped for lack of budget run again. Resume with a larger `--budget` to finish them.

Without a script argument, `--resume <runId>` reuses the stored `script.js` and `args.json`.

The key includes an agent's own `model` option, but not the run's model (`--model`) or the runner. If you resume with a different one of those, stored answers from the old one are still used, and the log says so.

Answers are matched by content, so a script must be deterministic. See [Writing workflows](workflows.md).

## Agent statuses

| Status | Meaning | On resume |
|---|---|---|
| `ok` | The agent returned a result. | Reused |
| `null` | The agent failed: an API error, an answer that did not fit the schema, a writer that did not commit. | Runs again |
| `skipped` | The agent did not finish: the run was stopped, the user skipped it, or the budget ran out. | Runs again |

## Budget

```bash
node bin/maestro run review.js --budget 500k
```

A budget is a number of **output tokens** for the whole run. It accepts `20000`, `500k` or `1.5m`.

- Before an agent starts, a share of the budget is reserved for it. If the remaining budget cannot cover the reservation, `agent()` throws.
- If the budget runs out while agents are running, they are stopped and return `null`.
- A run can exceed its budget by a bounded amount: at most the concurrency times the largest single request.

A script can read the budget and adapt:

```js
if (budget.remaining() < 50_000) log('low on budget, skipping the deep pass')
```

`meta.maxAgents` is the other limit: a cap on how many agents a run may start, 1000 by default.

## Concurrency

At most N agents run at once. N defaults to the number of CPUs minus two, at most 16 and at least 1. Set it with `--concurrency`.

An agent holds its slot for as long as it is running, including while its tools execute. Waiting agents show as queued.

## Looking at runs

```bash
node bin/maestro runs --limit 10
```

Lists runs from newest to oldest with status, duration, agent counts and token usage.

```bash
node bin/maestro show <runId>
```

Lists a run's agents and its outcome. Add an agent's label to print that agent's trace: its tool calls, the start of its final text, its result and any error.

```bash
node bin/maestro show <runId> find:security
```

### The timeline

```bash
node bin/maestro viz <runId>
```

Opens a page in the browser:

- Each phase is a lane, each agent a bar. The thin line before a bar is the time the agent waited for a slot.
- Colors show running, done, null, skipped and reused from cache.
- Clicking a bar shows the prompt, result, error, tool calls and tokens.
- The header shows agent counts, duration, tokens, cache ratio and budget.
- For a resumed run you can switch between attempts.

The page reads the run's files once a second, so it follows a run that is still going, including one started by another process. The server listens on `127.0.0.1` only and stops with Ctrl-C.

| Flag | Effect |
|---|---|
| `--out report.html` | Writes one self-contained HTML file instead of starting a server. It opens offline and can be shared. |
| `--port <n>` | Uses a fixed port. |
| `--no-open` | Does not open the browser. |
| `--widget` | Prints a snapshot as an HTML fragment for a chat interface's inline widget. |

## Cleaning up

Agents that write leave git worktrees and `wf/*` branches behind.

```bash
node bin/maestro gc
```

Lists dirty worktrees and branches, and says which branches are merged. A branch counts as merged if it is an ancestor of `HEAD` or all its commits have been cherry-picked.

```bash
node bin/maestro gc --delete
```

Deletes clean worktrees and merged branches. Worktrees with uncommitted work and unmerged branches are deleted only with `--delete --force`.
