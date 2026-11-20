---
title: "Runners"
description: "Run agents on Claude, Codex, or models through Vercel AI Gateway."
icon: "server"
---

A runner is what executes one agent. Choose one with `--runner` or the `runner` option of `run()`.

| Runner | Agents run on | Needs |
|---|---|---|
| `anthropic` (default) | The Claude API | `ANTHROPIC_API_KEY` |
| `codex` | The Codex CLI, one process per agent | Codex CLI installed and signed in |
| `gemini` | The Google Gemini Interactions API (`@google/genai`) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| `gateway` | Models through Vercel AI Gateway | `AI_GATEWAY_API_KEY` and a `provider/model` ID |
| `auto` | Direct Claude, Gemini, or Codex, chosen per agent by its model | Whatever the models in the script need |

`--dry-run` overrides every runner with a fake that answers from the schema and needs no API key.

## Claude

```bash
maestro run review.js --model claude-sonnet-5-5
```

The run's model defaults to `claude-opus-5-5`. Set it with `--model`, or per agent with `opts.model`.

Limits for one agent: at most 40 model turns, and 16,000 output tokens per request. A reply cut off by the token limit is continued once.

Prompt caching is on. The system prompt and tool definitions are cached across agents, and each agent's transcript is cached across its turns.

Live follow-up instructions are added before the next safe model request. A tool already in progress is allowed to finish; its result stays in order and the tool is not repeated. Undelivered messages fail when the agent ends or is cancelled. Public activity reports model turns and tool execution without exposing internal reasoning.

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

Each agent is its own Codex process, so memory use grows with `--concurrency`. Normal workflow calls use `codex app-server`, which accepts live instructions through `turn/steer` and reports tool activity and token usage. The app-server is an experimental part of the Codex CLI. If the installed CLI does not have it, Maestro says so in the log and runs the agents with `codex exec`; they work as before but cannot receive live messages (`canMessage: false`). A delivered message means Codex accepted it for the active turn; a message racing with completion can fail.

Direct `CodexRunner.run()` calls without the host message hook use legacy `codex exec`. The `ignoreUserConfig` and exec-only `extraArgs` options also retain that transport. These calls still report available activity but cannot accept messages (`canMessage: false`).

How Codex agents differ from Claude agents:

- **Model.** The order is: the model given to `new CodexRunner({ model })`, then the run's or agent's model, then your Codex configuration's default. A model name starting with `claude-` is never sent to Codex, so Maestro's default model does not override your Codex default.
- **Effort.** `low`, `medium`, `high` and `xhigh` pass through. `max` is sent as `xhigh`. Without an effort, your Codex default applies.
- **Tools.** Codex uses its own shell tools in place of Maestro's built-ins. A read-only agent runs in Codex's `read-only` sandbox, an isolated agent in `workspace-write`.
- **Your own tools.** Custom tools are served to Codex through a temporary MCP server named `maestro_tools`, and Codex calls them without asking for approval. The tool code runs in Maestro's process. Turn this off with `new CodexRunner({ customToolsMcp: false })`.
- **Commits.** A Codex agent does not commit: its sandbox keeps `.git` read-only. After a successful isolated agent, the runner commits the changes itself with your git identity and a message that starts with `maestro(codex): `. A failed agent is not committed, and its worktree is kept.
- **Structured answers.** There is one attempt, with no second try.
- **Limits.** The per-turn and per-request limits of the Claude runner do not apply. App-server cumulative token updates are reported as deltas; legacy exec reports usage on turn completion, which can cover several model calls.
- **Clean subagents ("dry mode").** By default, each Codex agent runs with the MCP servers of your Codex configuration switched off and with ambient Codex features disabled (`plugins`, `apps`, `browser_use`, `computer_use`, `image_generation`, `in_app_browser`, `skill_search`, `multi_agent`, and related plugin/skill flags) via `-c features.<name>=false`. This keeps startup fast, keeps your MCP servers out of the agents, and stops Codex from spawning nested agents outside Maestro's budget. The servers are switched off by name (`-c mcp_servers.<name>.enabled=false`), because Codex merges `-c mcp_servers={}` into your configuration and removes nothing. The runner reads the names from `codex mcp list --json` once and reuses them for a few minutes; that delays the first agent by a couple of seconds. If the list cannot be read, the agents run with your servers and the run log says so. A server whose name contains a dot or `=` cannot be switched off this way and stays on, which the run log also says. Maestro's own `maestro_tools` bridge stays on. Pass `minimal: false` to `new CodexRunner({ minimal: false })` to inherit your full Codex MCP and feature configuration.
- **Configuration.** The rest of your Codex configuration file is read as usual: model, providers, sandbox and approval settings. Pass `ignoreUserConfig: true` to the runner to skip the file; your MCP servers are then not listed, since none are loaded.

An agent's result requires a completed turn and valid final output. App-server is closed deliberately after completion; legacy exec additionally requires a successful process exit and no subsequent failure. Public progress is not a final answer. Stopping a run also stops the processes Codex started.

## Vercel AI Gateway

Set `AI_GATEWAY_API_KEY` in the process environment, then select a model:

```bash
maestro run review.js --runner gateway --model openai/gpt-5.4
maestro mcp --runner gateway --model openai/gpt-5.4
```

Use the exact `provider/model` ID from the [live catalog](https://ai-gateway.vercel.sh/v1/models). Gateway has no implicit model default: set `--model` or provide `opts.model` on every agent. Direct Claude model names are not converted to Gateway IDs.

The workflow default and per-agent selection work together:

```js
export const meta = { name: 'gateway-review', description: 'Review with two models' }

const findings = await agent('Review src/journal.ts.')
return agent(`Verify these findings: ${findings}`, { model: 'anthropic/claude-sonnet-4.6' })
```

Run this with `--model openai/gpt-5.4`: the first agent inherits that model and the second uses Claude through the same Gateway key. In library calls, set the default with `run({ model, runner: new GatewayRunner() })`. An explicit `new GatewayRunner({ apiKey })` overrides the environment key.

The runner reuses the existing SDK and tool loop through Gateway's [Anthropic-compatible Messages API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api). Usage accounting, aborts, retries, worktree isolation, and turn limits follow the Claude runner. The budget still counts output tokens, not Gateway spending.

Schema answers default to `submit-tool`, which returns the result through a schema-validated tool call. Override it with `--structured-mode` or `new GatewayRunner({ structuredMode })`. Choose a language model that supports tool calling; support for native structured outputs and `effort` varies by model.

When using the MCP server from Codex, make `AI_GATEWAY_API_KEY` available in Codex's environment and register it:

```bash
codex mcp add maestro -- npx -y maestro-workflows mcp --runner gateway --model openai/gpt-5.4
```

The host remains Codex, while workflow agents are billed through Gateway. Gateway mode sends every agent to Gateway; `auto` continues to route only between direct Anthropic and Codex.

## Gemini

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), then run with `--runner gemini`:

```bash
maestro run review.js --runner gemini --model gemini-4-hydrogen
maestro mcp --runner gemini --model gemini-4-carbon
```

`GeminiRunner` uses the official `@google/genai` Interactions API with client-side step history (`store: false` by default), preserving thought signatures across turns while keeping repo contents off remote retention.

- **Model.** Defaults to `gemini-4-hydrogen` when `--model` is omitted (Maestro's Claude default is ignored, like Codex). Supports `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.5-flash-lite`, `gemma-4-31b-it`, and strips an optional `google/` prefix.
- **Effort.** `low`, `medium` and `high` map directly to Gemini `thinking_level`; `xhigh` and `max` map to `high`.
- **Structured answers.** Supports `two-stage` (default), `submit-tool`, and `single-stage` via `--structured-mode` or `new GeminiRunner({ structuredMode })`.
- **Tools, isolation, live messages, usage.** Built-in read/write tools, custom `.maestro/tools/*.js`, worktree commit reminders, live follow-up instructions (`canMessage: true`), and per-turn cached input and thought token accounting all follow the Claude runner.

## Claude, Gemini and Codex in one run

```bash
maestro run review.js --runner auto
```

With `auto`, each agent goes to a runner by its model name:

- `claude-*` and `anthropic/*` go to Claude.
- `gemini-*`, `gemma-*` and `google/*` go to Gemini.
- Everything else goes to Codex. Use a model name your Codex account accepts.

```js
const context = await agent('Summarize the full repository layout.', { model: 'gemini-4-hydrogen', label: 'ingest' })
const findings = await agent(`Find bugs using this map:\n${context}`, { model: '<a-codex-model>', schema: FINDINGS })
const verdict = await agent(`Judge these findings: ${JSON.stringify(findings)}`, { model: 'claude-opus-5-5' })
```

All three runners share one journal, one concurrency limit, one budget and one worktree pool.

In a library you can supply your own rule:

```ts
import { RoutingRunner, run } from 'maestro-workflows';

const runner = new RoutingRunner({
  route: (model) => (model.startsWith('gemini-') ? 'gemini' : model.startsWith('claude-') ? 'anthropic' : 'codex'),
});
await run({ scriptPath: 'review.js', runner }).promise;
```
