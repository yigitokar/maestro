---
title: "Library"
description: "Call Maestro from your own Node program or agent harness."
icon: "book"
---

Maestro is an ES module named `maestro-workflows`. Install it from npm:

```bash
npm install maestro-workflows
```

## Running a workflow

```ts
import { attachTerminalProgress, run } from 'maestro-workflows';

const handle = run({ scriptPath: 'review.js', args: { diffRef: 'main...HEAD' }, budget: 300_000 });
const detach = attachTerminalProgress(handle);   // progress tree on stderr
const result = await handle.promise;             // the script's return value
detach();
```

`run()` returns at once with a handle:

| Field | Meaning |
|---|---|
| `runId` | The run's id. |
| `runDir` | The run's directory. |
| `promise` | Resolves with the script's return value. Rejects on a setup error, a throw in the script, or `stop()`. |
| `events` | An `EventEmitter`. |
| `stop(reason?)` | Stops every running agent. The promise rejects with code `run_stopped`. |
| `skip(agentId)` | Skips one running agent. Its `agent()` call returns `null`. |
| `liveAgents()` | Returns snapshots of queued/running agents: activity, elapsed time, turns, usage, `canMessage` and message receipts. |
| `sendMessage(agentId, message)` | Returns a queued receipt, or `null` when unavailable. Invalid or excessive messages throw. |

While `handle.promise` is pending, choose an agent from `handle.liveAgents()` with `canMessage: true` and send a follow-up:

```ts
const agent = handle.liveAgents().find((agent) => agent.canMessage);
if (agent) {
  const receipt = handle.sendMessage(agent.id, 'Also check cancellation.');
  // Later snapshots report receipt.id as delivered or failed.
}
```

Each agent accepts at most 32 messages of up to 16,000 characters. Messages are audited; a queued receipt is not a delivery guarantee. See [MCP controls](/maestro/claude-code#workflowmessage) for delivery and resume semantics.

### Options

| Option | Meaning | Default |
|---|---|---|
| `script`, `scriptPath`, `name` | Exactly one: the script text, a file, or a workflow saved in `workflowsDir`. | |
| `args` | The script's `args`. | |
| `resumeFromRunId` | Resume this run. The script may then be left out. | |
| `runner` | The runner. | `new AnthropicRunner()` |
| `cwd` | The agents' working directory and git repository. | `process.cwd()` |
| `stateDir` | Where runs are stored. | `<cwd>/.maestro` |
| `workflowsDir` | Where `name` and `workflow('<name>')` are looked up. | `<stateDir>/workflows` |
| `tools` | Custom tools, as objects. | |
| `toolsDir` | A directory of custom tool files. | `<stateDir>/tools` |
| `budget` | A number of output tokens, a shared `Budget`, or `null` for no limit. | `null` |
| `concurrency` | How many agents may run at once. | CPUs minus 2, at most 16 |
| `model` | The run's model. | `claude-opus-5-5` |
| `runId` | An id of your choice. | Generated |

### Events

Every event is emitted under its own type name and under `'event'`.

```ts
handle.events.on('agent_end', (e) => console.error(e.label, e.status, e.usage.output_tokens));
```

| Event | When |
|---|---|
| `agent_start` | An agent starts. Carries `id`, `key`, `label`, `phase`. |
| `agent_status` | A live snapshot changes. Carries `agent`, including public activity and usage. |
| `agent_message` | A message is queued, delivered or failed. Carries `agentId` and the receipt plus message text. |
| `agent_end` | An agent ends. Adds `status`, `cached` and `usage`, and for a live call `model`: the model ID the runner reported sending, `null` when it could not name the model, absent when it reported nothing. |
| `phase` | The script calls `phase()`. |
| `log` | The script calls `log()`, or Maestro reports something. |
| `budget_tick` | Budget use changes. Carries `spent`, `total`, `remaining`. |

## Runners

```ts
import { AnthropicRunner, CodexRunner, GatewayRunner, OpenAIRunner, FakeRunner, RoutingRunner, run } from 'maestro-workflows';

await run({ scriptPath: 'review.js', runner: new CodexRunner() }).promise;
```

- `AnthropicRunner({ client?, maxTurns?, maxTokens?, structuredMode? })`
- `CodexRunner({ model?, ignoreUserConfig?, customToolsMcp? })`
- `GatewayRunner({ apiKey?, maxTurns?, maxTokens?, structuredMode? })`: uses `AI_GATEWAY_API_KEY` unless `apiKey` is supplied; defaults to `submit-tool` for schema answers.
- `OpenAIRunner({ apiKey?, baseURL?, maxTurns?, maxTokens?, maxRetries?, structuredMode? })`: calls the OpenAI Responses API with `OPENAI_API_KEY` unless `apiKey` is supplied; defaults to `submit-tool` for schema answers.
- `RoutingRunner({ anthropic?, codex?, route? })`
- `FakeRunner`, for tests and dry runs: it answers from the schema and never touches the network.

A runner of your own is any object with `run(req): Promise<RunResult>`. If it can send a model other than `req.model` (its own setting, a default, a mapping), return the ID it really sent as `RunResult.model`, or `null` when it cannot name that model. Maestro records the value with the call. `maestro eval` prices the call at a reported ID and gives no estimate for `null`. A runner that leaves the field unset is priced at the requested model. The built-in runners report it; `CodexRunner` returns `null` when your Codex configuration picks the model, because it does not learn which one that is.

Gateway models use exact `provider/model` IDs. Set a workflow default; individual agents can override it with `opts.model`:

```ts
await run({
  scriptPath: 'review.js',
  runner: new GatewayRunner(),
  model: 'openai/gpt-5.4',
}).promise;
```

See [Runners](/maestro/runners) for model capabilities and CLI/MCP setup.

## Giving the Workflow tool to your own agent

If you run your own agent loop on the Claude API, you can hand it the same `Workflow` tool Claude Code gets.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { handleWorkflowToolCall, maestroToolDefinition, toToolResultBlock } from 'maestro-workflows';

const client = new Anthropic();
const tools = [maestroToolDefinition() /* , your other tools */];

// When the model calls the Workflow tool:
const res = await handleWorkflowToolCall(toolUse.input, {
  cwd: repoDir,
  budget: 500_000,
  onComplete: (runId, outcome) => queueForModel(runId, outcome),   // give the result to the model on a later turn
});
messages.push({ role: 'user', content: [toToolResultBlock(toolUse.id, res)] });
```

- `maestroToolDefinition()` returns the tool definition. Its description tells the model when a workflow is worth starting and when it is not.
- `handleWorkflowToolCall()` validates the call, starts the run in the background and returns at once. A bad call returns `{ is_error: true, content }`; it does not throw.
- The result arrives through `onComplete` as `{ ok: true, result }` or `{ ok: false, error }`.

Runs started this way are controlled by id:

```ts
import { liveWorkflowAgents, sendWorkflowAgentMessage, skipWorkflowAgent, stopWorkflowRun } from 'maestro-workflows';

liveWorkflowAgents(runId);        // live snapshots, or null once the run has ended
sendWorkflowAgentMessage(runId, id, 'Focus on cancellation.'); // queued receipt, or null if unavailable
skipWorkflowAgent(runId, id);     // that agent() returns null, the run goes on
stopWorkflowRun(runId, 'enough'); // running agents are recorded as skipped, onComplete gets ok: false
```

These helpers return `false` or `null` for an unknown or finished run. Invalid or excessive messages throw.

Custom runners can report public activity with `req.onProgress?.(...)` and register a message handler with `req.registerMessageHandler?.(handler)`. The handler resolves when it accepts an instruction, rejects delivery failures, and unregisters when the runner ends. Without a registered handler, `canMessage` stays false.

### One budget for several runs

To make your main loop's workflows share one pool, create a `Budget` and pass the same instance to every call:

```ts
import { Budget } from 'maestro-workflows';

const budget = new Budget({ total: 2_000_000 });
await handleWorkflowToolCall(input, { budget });
```

## Reading runs

```ts
import { readEntries, readOutcome, readTrace } from 'maestro-workflows';

const rows = await readEntries(runDir);     // the journal's rows
const outcome = await readOutcome(runDir);  // { ok, result } or { ok: false, error }; undefined while running
```

## Replaying a run

`replay()` forks an earlier run into a new run. Agents before a chosen node are served from the source run's journal, and that node and every agent after it run live. The source run directory is not changed, so the two runs can be compared.

```ts
import { replay } from 'maestro-workflows';

const handle = replay({ fromRunId: '20261120-101500-a1b2c3', from: 'judge', scriptPath: 'review.js' });
const result = await handle.promise;
```

`replay()` takes the same options as `run()`, except `resumeFromRunId`, and returns the same handle. It adds:

| Option | Meaning |
|---|---|
| `fromRunId` | The source run. It must be stored under the same `stateDir`. Required. |
| `from` | The node to run live from. Without it, every `ok` agent of the source run is copied and only agents without a cached answer run. |

`from` selects a node of the source run's last attempt, in this order:

- `phase:<title>`: the first agent in that phase,
- `#<index>`: the agent with that index,
- a label, when exactly one agent has it,
- a bare index,
- a key prefix, when exactly one agent matches.

An ambiguous label or key prefix fails and lists the indexes to use instead. A selector that matches nothing fails and lists some of the available nodes. Both fail before the new run directory is created.

Without `script`, `scriptPath` or `name`, the source run's `script.js` is reused, and without `args`, its `args.json`. Pass an edited script to change a prompt or the graph without paying again for the agents before `from`. An agent whose prompt or options changed in the edited script no longer matches its cached answer and runs live. The new run must have its own id: a `runId` equal to `fromRunId` fails.

`replay(opts)` is a wrapper around `run({ ...opts, replayFrom: { runId, from } })`. `run()` accepts `replayFrom` directly, but not together with `resumeFromRunId`.

The new run records its source in `run.json` (`replayedFrom`: source run, `from`, seeded and invalidated agent counts) and in its first `run_start` event. Seeded agents count as cache hits, and their tokens stay charged to the run that first executed them. See [`maestro replay`](/maestro/cli#maestro-replay) for the command.

### From a tool call

`handleWorkflowReplayCall(input, ctx)` is the replay counterpart of `handleWorkflowToolCall()`, with the input of the [`WorkflowReplay`](/maestro/claude-code#workflowreplay) tool and the same context:

```ts
import { handleWorkflowReplayCall } from 'maestro-workflows';

const res = await handleWorkflowReplayCall(
  { fromRunId, from: 'judge' },
  { cwd: repoDir, onComplete: (runId, outcome) => queueForModel(runId, outcome) },
);
// { runId, forkedFrom, from, seededAgents, invalidatedAgents, scriptPath, status: 'started' }
```

It validates the input and the source run, starts the replay in the background, and returns at once. A bad input or an unknown node returns `{ is_error: true, content }` and does not throw. `args` may be a JSON string, as the tool sends it, or a value. The new run is controlled by id like any tool-started run: `liveWorkflowAgents`, `sendWorkflowAgentMessage`, `skipWorkflowAgent` and `stopWorkflowRun` all work on it.

## Evaluating a workflow

`runEval()` runs one workflow across a set of cases, grades each result and saves the record as `<stateDir>/evals/<evalId>/eval.json`. Each case is its own run.

```ts
import { formatEvalSummary, runEval } from 'maestro-workflows';

const record = await runEval({
  scriptPath: 'classify.js',
  casesPath: 'cases.jsonl',
  evalId: 'v1',
  caseConcurrency: 4,
});
console.log(formatEvalSummary(record));
```

| Option | Meaning | Default |
|---|---|---|
| `script`, `scriptPath` | Exactly one: the workflow's text or file. | |
| `cases`, `casesPath` | Exactly one: an array of cases, or a `.json` or `.jsonl` file. | |
| `grader`, `graderPath` | A grader function, or an ES module whose default export is one. | |
| `evalId` | The record's id. | `eval-<date>-<time>-<hex>` |
| `fromEvalId` | Replay each case from its run in this earlier eval, matched by case id. | |
| `fromNode` | With `fromEvalId`, the node each replay runs live from. | |
| `only` | Run only these case ids. | |
| `limit` | Run at most this many cases. | |
| `caseConcurrency` | How many cases run at once. | `1` |
| `concurrency`, `budget`, `runner`, `model`, `cwd`, `stateDir`, `toolsDir` | Passed to each case's `run()`. The budget is per case. | As for `run()` |
| `prices` | USD prices per million tokens, keyed by model ID. Replaces `MODEL_PRICES`. | `MODEL_PRICES` |
| `onCaseComplete(result, index, total)` | Called as each case settles. | |

A case is `{ id, args?, expect?, expected?, tags?, description? }`. A `.json` file holds an array of cases or `{ "cases": [...] }`; a `.jsonl` file holds one case per line. A case without an `id` is named `case-<n>`, and duplicate ids fail.

A case is graded by the first of these that applies:

1. A grader. It gets `{ case, output, ok, error?, runId, runDir }` and returns a boolean or `{ pass, score?, reason? }`. A grader that throws marks the case `error`.
2. A failed run marks the case `error`.
3. `expect`, with any of `equals` (deep equality), `match` (recursive subset), `contains` and `notContains` (substrings of the JSON output), and `regex`.
4. `expected`, compared with deep equality.
5. Otherwise the case passes when the workflow returns anything but `null` or `undefined`.

Each case result has its `status` (`pass`, `fail` or `error`), `score`, `reason`, `runId`, tokens, journal cache hits and an estimated cost. A case that passes while some of its agents returned `null` or were skipped is marked `degraded`. The summary adds the pass rate, average score, token totals, cost and cache ratios. Costs are estimated from each call's recorded model, as described under [`maestro eval`](/maestro/cli#maestro-eval).

### Comparing two evals

```ts
import { diffEvalRuns, formatEvalDiff } from 'maestro-workflows';

const diff = await diffEvalRuns('.maestro', 'v1', 'v2');
console.log(formatEvalDiff(diff));
if (diff.cases.regressions.length > 0) process.exitCode = 1;
```

`diffEvalRuns(stateDir, a, b, prices?)` takes two eval ids or paths to `eval.json` files. When one side is not an eval, it is read as a workflow `runId` and compared as a one-case eval. The report has the score and pass-rate change, the cases that were fixed, regressed, still fail, were added or removed, and the token, cost, cache and duration changes. Cases whose arguments or expectations changed between the two evals are listed under `cases.changed` and not counted as fixed or regressed. `diffEvalRecords(a, b)` compares two records already in memory.

`readEvalRecord(stateDir, idOrPath)` reads one record, and `listEvalRecords(stateDir, limit?)` returns the stored records, newest first.

## Inspecting a run

`inspectRun()` builds the diagnostic report that [`maestro inspect`](/maestro/cli#maestro-inspect) and the [`WorkflowInspect`](/maestro/claude-code#workflowinspect) tool print:

```ts
import { formatInspectMarkdown, inspectRun } from 'maestro-workflows';

const report = await inspectRun(handle.runDir, handle.runId, { compact: true });
console.log(formatInspectMarkdown(report));
```

| Option | Meaning | Default |
|---|---|---|
| `compact` | Report only the failed agents and the upstream agents that fed them. | `false` |
| `full` | Do not shorten the recorded prompts, schemas, outputs and arguments. | `false` |
| `selector` | Report one agent: a label, `#<index>`, a bare index or a key prefix. | |
| `maxFieldChars` | The longest prompt, text or raw field, when `full` is off. | 1,200 compact, 2,500 otherwise |
| `maxUpstream` | How many upstream agents to include. | 5 compact, 15 otherwise |

The report has the run's status (`done`, `failed` or `running`), `degraded` when the run succeeded with some agents `null` or skipped, the outcome, the source of a replay, and agent and token counts. `nodes` holds the selected agents: the failed ones by default, or the one `selector` names. Each has its status, error, usage, recorded input, result preview, final text and tool calls. `upstream` summarizes the completed agents that fed them. `firstFailureReplaySelector` names the node to pass to `replay()` as `from` to retry the first failure. A compact report leaves out the full agent list (`overview`) unless nothing failed. The library defaults to the long report; the tool defaults to compact. `inspectRun()` throws when the run directory does not exist.
