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
| `agent_end` | An agent ends. Adds `status`, `cached` and `usage`. |
| `phase` | The script calls `phase()`. |
| `log` | The script calls `log()`, or Maestro reports something. |
| `budget_tick` | Budget use changes. Carries `spent`, `total`, `remaining`. |

## Runners

```ts
import { AnthropicRunner, CodexRunner, FakeRunner, RoutingRunner, run } from 'maestro-workflows';

await run({ scriptPath: 'review.js', runner: new CodexRunner() }).promise;
```

- `AnthropicRunner({ client?, maxTurns?, maxTokens?, structuredMode? })`
- `CodexRunner({ model?, ignoreUserConfig?, customToolsMcp? })`
- `RoutingRunner({ anthropic?, codex?, route? })`
- `FakeRunner`, for tests and dry runs: it answers from the schema and never touches the network.

See [Runners](/maestro/runners).

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
