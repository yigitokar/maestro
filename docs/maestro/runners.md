---
title: "Runners"
description: "Run agents on Claude, on Codex, or on both in one run."
icon: "server"
---

A runner is what executes one agent. Maestro has three, chosen with `--runner` or the `runner` option of `run()`.

| Runner | Agents run on | Needs |
|---|---|---|
| `anthropic` (default) | The Claude API | `ANTHROPIC_API_KEY` |
| `codex` | The Codex CLI, one `codex exec` process per agent | Codex CLI installed and signed in |
| `auto` | Either, chosen per agent by its model | Whatever the models in the script need |

`--dry-run` overrides all three with a fake runner that answers from the schema.

## Claude

```bash
maestro run review.js --model claude-sonnet-5-5
```

The run's model defaults to `claude-opus-5-5`. Set it with `--model`, or per agent with `opts.model`.

Limits for one agent: at most 40 model turns, and 16,000 output tokens per request. A reply cut off by the token limit is continued once.

Prompt caching is on. The system prompt and tool definitions are cached across agents, and each agent's transcript is cached across its turns.

### How a structured answer is obtained

When an agent has a `schema`, the runner has three ways to get the answer. Choose with `--structured-mode` or `new AnthropicRunner({ structuredMode })`.

| Mode | How it works |
|---|---|
| `two-stage` (default) | The agent works and answers in prose. A second request then asks for the answer in the schema. |
| `submit-tool` | The agent gets one more tool, `__maestro_submit_result`, and hands in its answer by calling it. There is no second request. |
| `single-stage` | The schema is applied to the agent's own requests. There is no second request, but everything the agent writes must fit the schema. |

`two-stage` pays for the agent's whole transcript a second time, uncached. In a small measurement on one review task the other two modes cost about 30% less. The default has not changed because answer quality has not been compared yet; the measurement is in the project's [decision notes](https://github.com/yigitokar/maestro/blob/main/docs/decisions.md) (in Turkish).

## Codex

```bash
maestro run review.js --runner codex --concurrency 4
```

Each agent is its own `codex exec` process, so memory use grows with `--concurrency`.

How Codex agents differ from Claude agents:

- **Model.** The order is: the model given to `new CodexRunner({ model })`, then the run's or agent's model, then your Codex configuration's default. A model name starting with `claude-` is never sent to Codex, so Maestro's default model does not override your Codex default.
- **Effort.** `low`, `medium`, `high` and `xhigh` pass through. `max` is sent as `xhigh`. Without an effort, your Codex default applies.
- **Tools.** Codex uses its own shell tools in place of Maestro's built-ins. A read-only agent runs in Codex's `read-only` sandbox, an isolated agent in `workspace-write`.
- **Your own tools.** Custom tools are served to Codex through a temporary MCP server named `maestro_tools`, and Codex calls them without asking for approval. The tool code runs in Maestro's process. Turn this off with `new CodexRunner({ customToolsMcp: false })`.
- **Commits.** A Codex agent does not commit: its sandbox keeps `.git` read-only. After a successful isolated agent, the runner commits the changes itself with your git identity and a message that starts with `maestro(codex): `. A failed agent is not committed, and its worktree is kept.
- **Structured answers.** There is one attempt, with no second try.
- **Limits.** The per-turn and per-request limits of the Claude runner do not apply. Usage is reported to the budget when Codex reports it, which can be once for several model calls.
- **Configuration.** Your Codex configuration file is read. Pass `ignoreUserConfig: true` to the runner to skip it.

An agent's result counts only if Codex reported a completed turn, reported no error and exited with status 0. Stopping a run also stops the processes Codex started.

## Both in one run

```bash
maestro run review.js --runner auto
```

With `auto`, each agent goes to a runner by its model name:

- `claude-*` and `anthropic/*` go to Claude.
- Everything else goes to Codex. Use a model name your Codex account accepts.

```js
const findings = await agent('Find bugs in src/journal.ts.', { model: '<a-codex-model>', schema: FINDINGS })
const verdict = await agent(`Judge these findings: ${JSON.stringify(findings)}`, { model: 'claude-opus-5-5' })
```

Both kinds of agent share one journal, one concurrency limit, one budget and one worktree pool.

In a library you can supply your own rule:

```ts
import { RoutingRunner, run } from 'maestro-workflows';

const runner = new RoutingRunner({ route: (model) => (model.startsWith('claude-') ? 'anthropic' : 'codex') });
await run({ scriptPath: 'review.js', runner }).promise;
```
