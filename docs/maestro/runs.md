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
| `journal.jsonl` | One line per `agent()` call: its key, status, result, token usage, trace and live message audit. `model` is the model ID the runner reported sending, which differs from the requested one when the runner has its own model setting; it is `null` when the runner could not name the model and absent when it reported nothing. Failed and skipped calls also store `failureInput` with the full prompt, options, tool names and the model: the reported ID, else the requested one. |
| `blobs/` | Results, traces and failure inputs larger than 64 KB, one file each. A row with `failureInputBlob: true` stores its input in `blobs/<key>.input.json`. |
| `events.jsonl` | Every event with a wall-clock time. The `agent_end` line of a live call carries the same `model`, and `maestro eval` prices the call at it. Otherwise used only for display. |
| `outcome.json` | The final result or error, written when the run ends. |

Add `.maestro/` to your `.gitignore`.

## Resume

```bash
maestro run review.js --resume <runId>
```

Resume runs the script again from the top. Each `agent()` call is looked up in the journal by a key made from its prompt, its options (without `label` and `phase`) and how many times the same call has occurred. A call found with status `ok` returns its stored answer without running.

This gives resume three uses:

- **Edit and rerun.** Change one prompt, and only that agent and the agents that depend on its answer run again.
- **Continue after a stop.** Agents that were running when the run stopped are recorded as `skipped` and run on resume.
- **Raise the budget.** Agents that failed (`null`) or were skipped for lack of budget run again. Resume with a larger `--budget` to finish them.

Without a script argument, `--resume <runId>` reuses the stored `script.js` and `args.json`.

The key includes an agent's own `model` option, but not the run's model (`--model`) or the runner. If you resume with a different one of those, stored answers from the old one are still used, and the log says so.

Successful results produced after live messages are also reused, with an explicit log that steering was involved. Messages and delivery receipts stay in the journal and event log. Edit the workflow prompt when changing a durable instruction; sending a live message does not rewrite the script.

Answers are matched by content, so a script must be deterministic. See [Writing workflows](/maestro/workflows).

## Time-travel replay

```bash
maestro replay <runId> --from <node> [edited.js]
```

Unlike `--resume` (which mutates `<runId>` in place and reuses any unchanged `ok` call), `replay` creates a **new** `runId` seeded only with the upstream `ok` cache entries that ran before `<node>` (selected by unique label, unique key prefix, `#index` or `index`, or `phase:<title>` for the first node in that phase). `<node>` and everything after it execute live even when their prompts have not changed, and the original run stays untouched so both runs can be inspected or diffed side by side.

## Agent statuses

| Status | Meaning | On resume |
|---|---|---|
| `ok` | The agent returned a result. | Reused |
| `null` | The agent failed: an API error, an answer that did not fit the schema, a writer that did not commit. | Runs again |
| `skipped` | The agent did not finish: the run was stopped, the user skipped it, or the budget ran out. | Runs again |

## Budget

```bash
maestro run review.js --budget 500k
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

The MCP `WorkflowResult.liveAgents` and library `handle.liveAgents()` show queued/running state, elapsed time, public activity, turns and tokens. `canMessage` reports whether the active runner accepts follow-up instructions. Message receipts distinguish `queued`, `delivered` and `failed`; see [MCP controls](/maestro/claude-code#workflowmessage).

## Looking at runs

```bash
maestro runs --limit 10
```

Lists runs from newest to oldest with status, duration, agent counts and token usage. A replay counts seeded agents, but their tokens are charged only to the run that originally executed them.

```bash
maestro show <runId>
```

Lists a run's agents, outcome and latest recorded live activity. Select a live agent by label or numeric id. This reads files, so activity may be stale after a process dies. For a completed agent, its label selects the trace, result, error and message audit.

```bash
maestro show <runId> find:security
```

### The timeline

```bash
maestro viz <runId>
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
maestro gc
```

Lists dirty worktrees and branches, and says which branches are merged. A branch counts as merged if it is an ancestor of `HEAD` or all its commits have been cherry-picked.

```bash
maestro gc --delete
```

Deletes clean worktrees and merged branches. Worktrees with uncommitted work and unmerged branches are deleted only with `--delete --force`.
