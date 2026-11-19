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
| `run.json` | The run's model and runner, plus the source run and boundary for replays. |
| `journal.jsonl` | One line per `agent()` call: its key, status, result, token usage, trace and live message audit. |
| `blobs/` | Large results, traces and failed-call inputs referenced by journal rows. |
| `events.jsonl` | Invocation order, cache hits and progress for each run attempt. |
| `outcome.json` | The final result or error, written when the run ends. |

Add `.maestro/` to your `.gitignore`.

## Resume

```bash
maestro run review.js --resume <runId>
```

Resume runs the script again from the top. Each `agent()` call is looked up in the journal by a key made from its prompt, its execution options and how many times the same call has occurred. Display fields (`label`, `phase`) and inspection metadata (`upstream`) are excluded. A call found with status `ok` returns its stored answer without running.

This gives resume three uses:

- **Edit and rerun.** Change one prompt, and only that agent and the agents that depend on its answer run again.
- **Continue after a stop.** Agents that were running when the run stopped are recorded as `skipped` and run on resume.
- **Raise the budget.** Agents that failed (`null`) or were skipped for lack of budget run again. Resume with a larger `--budget` to finish them.

Without a script argument, `--resume <runId>` reuses the stored `script.js` and `args.json`.

The key includes an agent's own `model` option, but not the run's model (`--model`) or the runner. If you resume with a different one of those, stored answers from the old one are still used, and the log says so.

Successful results produced after live messages are also reused, with an explicit log that steering was involved. Messages and delivery receipts stay in the journal and event log. Edit the workflow prompt when changing a durable instruction; sending a live message does not rewrite the script.

Answers are matched by content, so a script must be deterministic. See [Writing workflows](/maestro/workflows).

## Replay from a node

```bash
maestro replay <runId> --from classify
maestro replay <runId> --from '#2' --script edited-review.js
```

Replay creates a new run with its own journal. Use a unique agent label, a zero-based invocation ID such as `2` or `'#2'`, or the full journal key. The boundary follows the order the script called `agent()` in the source run's latest attempt, including parallel and nested calls. Earlier calls return their recorded results. The selected call and everything issued after it execute live, even when their prompts are identical to the originals.

The command uses the stored script, arguments, runner and model, and inherits the recorded budget and concurrency. Pass `--script` to run your edited workflow. Supply `--structured-mode` or `--tools-dir` again if you used a custom value. A label lets you edit the target prompt. A numeric ID lets you replace the target entirely. If any earlier call has changed inputs or has no successful cached result, replay fails and identifies the earlier node to select.

The new run ID appears on stderr. Its copied upstream results and traces can be inspected and reused on future runs. Token totals for the new run count only live calls.

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

Lists runs from newest to oldest with status, duration, agent counts and token usage.

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
