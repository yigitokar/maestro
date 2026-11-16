# Maestro

> **Documentation:** [docs.careresearch.ai/maestro](https://docs.careresearch.ai/maestro). Start with the [Quickstart](https://docs.careresearch.ai/maestro/quickstart). On npm: `maestro-workflows`.

Maestro is a multi-agent orchestration layer. The control flow is in code and the reasoning is in the agents: a deterministic JavaScript script calls agents that each start with a clean context, merges their results, puts them to a vote and fans them out again. The main agent writes the script. A plain runtime executes it, not an LLM.

The design and the contracts are in [docs/spec.md](docs/spec.md) (v0.3.2, written in Turkish). The decisions taken where the spec leaves a point open are in [docs/decisions.md](docs/decisions.md) (written in Turkish). The skill that teaches the model to write scripts is in [skill/SKILL.md](skill/SKILL.md).

## Install

Node 22.18 or later is required. The package is published on npm as `maestro-workflows`:

```bash
npm install -g maestro-workflows
```

The command is `maestro`. To run it without an install, write `npx -y maestro-workflows` in its place. To use it from Claude Code without writing code, see the [Quickstart](https://docs.careresearch.ai/maestro/quickstart) page.

If you work in this repository, the command is `node bin/maestro` after `npm install` and `npm run build`. The examples below use this form.

The package is ESM and its only dependency layer is the Anthropic TypeScript SDK (`@anthropic-ai/sdk`). It also brings `zod`, `acorn` and, for the MCP server, `@modelcontextprotocol/sdk`. The default Anthropic runner needs the `ANTHROPIC_API_KEY` environment variable. The Codex runner uses the Codex CLI, installed and signed in. The Gateway runner uses `AI_GATEWAY_API_KEY` for Vercel AI Gateway. The tests and `--dry-run` never touch the network.

Runs are stored under `.maestro/` in the working directory (`runs/<runId>/`, `worktrees/`, `workflows/`, `tools/`). Add this directory to the `.gitignore` of your own repository.

## The first script

`review.js`:

```js
export const meta = {
  name: 'quick-review',
  description: "Review the diff in two dimensions, vote on each finding with two skeptics",
  phases: [{ title: 'Find' }, { title: 'Verify' }],
  maxAgents: 40,
}

const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
  type: 'object', required: ['file', 'claim'], properties: { file: { type: 'string' }, claim: { type: 'string' } } } } } }
const VERDICT = { type: 'object', required: ['refuted'], properties: { refuted: { type: 'boolean' } } }

const perDim = await pipeline(
  ['correctness', 'security'],
  d => agent(`Diff: git diff ${args.diffRef}. Look only for ${d} problems.`,
    { label: `find:${d}`, phase: 'Find', schema: FINDINGS }),
  async (found, d) => {
    if (!found) { log(`${d}: finder returned null`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1].map(i => () =>
        agent(`Try to REFUTE this claim: ${f.claim} (${f.file}). If you are not sure, refuted=true. Perspective ${i}.`,
          { label: `verify:${f.file}#${i}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
      return votes.filter(Boolean).every(v => !v.refuted) ? { ...f, dimension: d } : null
    }))
  })

const confirmed = perDim.flat().filter(Boolean)
log(`${confirmed.length} findings confirmed`)
return confirmed
```

Run it:

```bash
node bin/maestro run review.js --args '{"diffRef":"main...HEAD"}' --budget 300k
```

To see the flow without touching the network, add `--dry-run`. Every agent then returns a fake answer made from the schema. To edit the script and run it again cheaply:

```bash
node bin/maestro run review.js --resume <runId>
```

Every `agent()` call that did not change comes from the journal. Only the changed call and the calls derived from its result run live.

As a library:

```ts
import { run, AnthropicRunner, attachTerminalProgress } from 'maestro-workflows';

const handle = run({ scriptPath: 'review.js', args: { diffRef: 'main...HEAD' }, budget: 300_000 });
const detach = attachTerminalProgress(handle);       // progress tree on stderr
const result = await handle.promise;                 // the script's return value
detach();
```

`run()` returns `{ runId, runDir, promise, events, stop, skip }` at once. The `agent_start`, `agent_end`, `phase`, `log` and `budget_tick` events arrive through `events`.

## Running agents with Codex

If the Codex CLI is installed and signed in with a ChatGPT account, the agents can run on the Codex plan. `ANTHROPIC_API_KEY` is not needed. Each agent gets its own `codex exec` process:

```bash
node bin/maestro run review.js --runner codex --args '{"diffRef":"main...HEAD"}' --concurrency 4
node bin/maestro mcp --runner codex --concurrency 4
```

As a library:

```ts
import { CodexRunner, run } from 'maestro-workflows';

const result = await run({ scriptPath: 'review.js', runner: new CodexRunner() }).promise;
```

The default of `--runner` is `anthropic`. `codex` runs all agents through the Codex CLI. `auto` (`RoutingRunner`) routes each call by its model name (`claude-*` / `anthropic/*` → `AnthropicRunner`, other models such as `gpt-*` / `o3` / `codex-*` → `CodexRunner`). So in one run, for example, GPT/Codex finders and a Claude Opus jury can share the same journal, semaphore, budget and worktree pool. `--dry-run` overrides the chosen runner. The model order is `new CodexRunner({ model })`, then the workflow's `model` option (including `--model`), then the Codex config default. A workflow model that starts with `claude-` is not sent to Codex, so Maestro's default Claude model does not change the Codex model. `effort: 'low' | 'medium' | 'high' | 'xhigh'` passes through unchanged and `'max'` is sent as `'xhigh'`. Without an effort, the Codex default applies.

Codex uses its own shell tools for built-in operations. Custom `ToolDef` tools that are not built in are bridged to the `codex exec` process through a temporary stdio MCP server (`maestro_tools`) by default (turn this off with `customToolsMcp: false`). The bridge opens no socket. It runs the `tool.run(input, ctx)` function in the main Maestro process through an atomic file queue in a temporary directory, with `AbortSignal` support, and records the calls in the agent's trace. An agent without isolation runs in the `read-only` sandbox, an agent in a worktree in the `workspace-write` sandbox. A writer does not commit inside Codex. It leaves its changes in the working tree. A real execution on 2026-11-07 showed that the Codex sandbox keeps the `.git` metadata read-only and that passing the shared Git directory with `--add-dir` does not change this. After a successful isolated agent that was not cancelled, the runner commits with the user's Git identity if there are changes. The message starts with `maestro(codex): ` and is cut to 72 characters in total from the first line of the task prompt. A failed agent is not committed, and the dirty worktree stays for inspection. If the runner's commit fails, the result is `null` too, with the error information.

The user's Codex config is read by default. In the API, turn this off with `ignoreUserConfig: true`. Each concurrent agent is its own process, so watch memory use at high `--concurrency` values. The prompt is sent over stdin and stdin is closed at once, so large prompts do not hit the command-line argument limit.

Usage is reported to the budget on every `turn.completed` event. The CLI can collect all the model calls it makes into one turn for this event. The Anthropic runner's turn and token limits per model call do not apply in the Codex runner.

A result can be used only if `turn.completed` was seen, no failure came after it, no `error` event was recorded and the process exited with 0. Without these conditions a progress message does not count as a successful result. A cancel stops the process group, which includes the child processes Codex started.

## Running agents through Vercel AI Gateway

Set `AI_GATEWAY_API_KEY` in the environment, then choose a model from the [Gateway model catalog](https://ai-gateway.vercel.sh/v1/models):

```bash
node bin/maestro run review.js --runner gateway --model openai/gpt-5.4 --args '{"diffRef":"main...HEAD"}'
node bin/maestro mcp --runner gateway --model openai/gpt-5.4
```

The existing SDK sends requests through Gateway's [Anthropic-compatible Messages API](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api). No additional package or Anthropic key is needed. Models must use their exact `provider/model` IDs; Maestro does not convert direct-provider names or choose a Gateway default.

`--model` supplies the workflow default. Inside a workflow, override it for any agent:

```js
const findings = await agent('Review src/journal.ts.') // inherits --model
const verdict = await agent(`Verify these findings: ${findings}`, {
  model: 'anthropic/claude-sonnet-4.6',
})
```

To connect it to Codex, start Codex with `AI_GATEWAY_API_KEY` in its environment and register the server:

```bash
codex mcp add maestro -- npx -y maestro-workflows mcp --runner gateway --model openai/gpt-5.4
```

Codex writes and starts the workflows; their agents use Gateway and are billed through the Gateway key. `--runner gateway` applies to every agent, including those with different model providers. `--runner auto` retains its existing Claude/Codex routing.

Gateway defaults to `submit-tool` for schema answers. Set `--structured-mode` to override it. Choose a language model that supports tool calling; structured output modes and `effort` support depend on the selected model. For library use, see [`GatewayRunner`](docs/maestro/library.md#runners).

## Host API

This is the surface the script sees (spec "Seviye 1"). Beyond it there are only the JS built-ins. `process`, `require`, `fetch`, `console` and `setTimeout` are not defined.

| API | Returns | Null and throw |
|---|---|---|
| `agent(prompt, opts?)` | With a `schema` the validated object, otherwise the final text | A terminal API error, a skip of the agent (`handle.skip(id)`) and the budget running out while it runs return **null**. An invalid schema, not enough budget for the reservation at entry, the `meta.maxAgents` cap and a write tool without isolation **throw**. |
| `parallel(thunks)` | The array of results (a barrier) | On agent and runtime errors (`Error`, `schema_invalid`, `budget_exceeded`, `agent_cap`, `run_stopped`) the slot of the thunk that throws becomes null and the error is logged. Programmer and configuration errors (`ReferenceError`, `SyntaxError`, `determinism`, `unknown_tool`, `unknown_phase`, `write_tool_without_isolation`, `nested_workflow`, `duplicate_writer_branch`, `journal_unwritable`) and more than 4096 items reject directly. |
| `pipeline(items, ...stages)` | The result of the last stage for each item | There is no barrier between stages. A stage receives `(prev, item, index)`; in the first stage `prev === item`. A stage that throws a runtime error makes the item null and skips the remaining stages. Programmer and configuration errors (the same set as `parallel`) reject directly. A stage that **returns** null has returned a normal value. |
| `phase(title)` | | With `meta.phases` defined, any other title throws. |
| `log(message)` | | |
| `args` | The `args` value of the tool call, unchanged | |
| `budget` | `{ total, spent(), remaining() }` | Without a `total` it is null and `remaining()` is Infinity. |
| `workflow(nameOrRef, args?)` | The return value of the child workflow | Nesting goes one level only; inside the child it throws. The same semaphore, counter and budget are shared. |

`agent` opts: `label`, `phase`, `schema`, `model`, `effort` (`low` … `max`), `isolation: 'worktree'`, `tools`. The default tools are read-only: `read_file`, `grep`, `glob` and an allowlisted `bash` (ls, cat, git log/diff/status/show, rg, find). The path arguments of `bash` commands, like `read_file`, cannot leave the working directory. Commands run through `bash` and `shell` do not see the `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or `AI_GATEWAY_API_KEY` variables. `write_file`, `edit_file`, `shell` and `git_commit` are given only with `isolation: 'worktree'`. A writer commits to the branch the runtime opened, `wf/<runId>/<label>`. In `AnthropicRunner`, a writer that finishes its work and forgets to call `git_commit` gets one reminder turn. At exit the branch, a clean status and at least one commit are verified from Git, and `branchName` is added to the result. Unknown keys in the `meta` block (for example the typo `maxAgent`) go to the log as a warning at the start of the run.

`AnthropicRunner` supports three structured output modes for agents with a schema (`--structured-mode` / `structuredMode`): `two-stage` (the default, the two-stage parse of spec 3.2), `submit-tool` (adds the schema to the Stage 1 tool list as the strict `__maestro_submit_result` tool; this stops Stage 2 from breaking the prompt cache of the transcript) and `single-stage` (gives the `output_config.format` schema directly to the Stage 1 requests).

### Custom tools

To give agents an ability that is not built in (a paper or web search, a database, an internal API), define the tool outside the script. The script only selects its name:

```js
// .maestro/tools/arxiv_search.js
export default {
  name: 'arxiv_search',
  description: 'Search arXiv papers. ...',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  write: false,
  async run(input, ctx) { /* ctx.cwd, ctx.signal */ return '...'; },
};
```

```js
// script
const papers = await agent('Find papers on DML', { tools: ['read_file', 'arxiv_search'] })
```

- The directory is `.maestro/tools/` by default and changes with `--tools-dir`. Each `*.js`/`*.mjs` file does an `export default` of one tool or an array of tools. Files that start with `_` or `.` are helpers and are not loaded as tools. As a library, `run({ tools: [...] })` works too.
- The checks are done before the run starts, and a bad definition stops the run from starting with `tool_invalid`: the name does not clash with a built-in tool or another definition, `write` is stated explicitly and the input schema is strict (`additionalProperties: false` on every object, every property in `required`; an optional field is made nullable).
- A tool with `write: true` is a write tool and is given only with `isolation: 'worktree'`.
- Tool code runs in Maestro's own process, not in the script's sandbox. It can reach the network. Giving a read-only agent a tool that reaches the network means the agent can send out what it reads.
- The files under `.maestro/tools/` are executable code, like `package.json` scripts: Maestro loads them when a run starts, and `maestro mcp` loads them every time it lists its tools. Run Maestro only in repositories you trust.
- The description of the Workflow tool lists the custom tools that exist (`maestro mcp` reads them from disk again on every `tools/list`), so the model that writes the script knows their names.
- The journal key holds only the tool's name: changing the tool's code does not invalidate earlier results. Deleting a tool that a run used breaks the resume of that run, including the agents in the cache.

The ready example `examples/tools/arxiv_search.js` searches arXiv for papers and needs no API key. To use it, copy the file into `.maestro/tools/`.

Determinism: in a script `Date.now()`, `Math.random()` and `new Date()` without arguments throw, because the resume cache key is derived from `sha256(prompt + opts)` and from which call with that content it is. Pass a timestamp in `args` (`new Date(args.ts)` works).

## Connecting to your own harness

`maestroToolDefinition()` produces the Anthropic tool definition to give to the main agent (`name: "Workflow"`, `strict: true`). The description text carries the opt-in policy: when to use it and when not to use it. `handleWorkflowToolCall()` validates the call, starts the run in the background and returns at once. The result arrives through `onComplete`.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { handleWorkflowToolCall, maestroToolDefinition, toToolResultBlock } from 'maestro-workflows';

const client = new Anthropic();
const tools = [maestroToolDefinition(), /* your own tools */];

// When the model calls the Workflow tool:
const res = await handleWorkflowToolCall(toolUse.input, {
  cwd: repoDir,
  budget: 500_000,
  onComplete: (runId, outcome) => queueForModel(runId, outcome),   // give the result to the model on a later turn
});
messages.push({ role: 'user', content: [toToolResultBlock(toolUse.id, res)] });
```

The input takes exactly one of the `script`, `scriptPath` and `name` fields. `name` resolves to the file `.maestro/workflows/<name>.js`. With `resumeFromRunId` the edited script continues from the cache. Without a script, the `script.js` and `args.json` in the run directory are reused. A strict schema cannot express an arbitrary JSON value, so `args` is sent as a JSON string. An invalid input, a missing or impure `meta`, a syntax error and a resume of a run that does not exist (or that has no `script.js`) do not throw. They return `{ is_error: true, content }` at once.

The optional `cwd` field moves the run to another directory. It can be an absolute path or a path relative to the server's directory. The agents work in that directory, writers branch from the git repository of that directory, and the run is written under `<cwd>/.maestro`. `scriptPath` is resolved against this directory too. So one server (for example a Claude Code session opened in `scratchpad`) can work on another repository. It is safer to give a worktree of that repository than a main checkout that someone else is using. When you resume, pass the same `cwd`, or the run is not found. `null` or an empty string means the server's directory. A `cwd` that does not exist or is not a directory returns `is_error` at once.

Runs started with the tool are controlled by runId (spec "Seviye 1", the user rows of the null/throw table):

```ts
import { liveWorkflowAgents, skipWorkflowAgent, stopWorkflowRun } from 'maestro-workflows';

liveWorkflowAgents(runId);       // [{ id, label, phase, group }]: the live agents; null once the run has ended
skipWorkflowAgent(runId, id);    // agent() returns null, the journal line is 'skipped', the run goes on
stopWorkflowRun(runId, 'enough'); // live agents are recorded as 'skipped', onComplete gets ok:false (run_stopped)
```

All three return `false`/`null` for an unknown or finished run. To make the main loop and all workflows share the same budget pool (spec 3.5), give one `new Budget({ total })` instance as `budget` in place of a number, and pass the same instance in every call.

## Connecting to Claude Code

The same Workflow tool is served as an MCP server over stdio, and `tools/list` returns five tools:

- `Workflow`: starts the run and returns `{ runId, scriptPath, status: 'started' }` at once. With a `cwd`, the run works in that repository and not in the session's directory (see the `cwd` paragraph above).
- `WorkflowResult({ runId, wait?, cwd? })`: returns `{ status: 'running', liveAgents }` while the run is going, then `done` or `failed`. The final result of a finished run is also written to `<runDir>/outcome.json`, so `WorkflowResult` can read it from disk for an old `runId` even after the MCP server has restarted (if the `cwd` was different, pass it too). With `wait: true` the call stays open until the run ends, and there is no need to poll: Claude Code moves an MCP call that takes longer than 2 minutes to the background and gives the result to the model as a notification. If the client sent a `progressToken`, the waiting call sends `notifications/progress` every 30 seconds with the names of the live agents, so the idle-call timeout does not cut the call. A one-shot `claude -p` session closes when its turn ends, so it does not wait for a background result. Use an interactive session to collect the result.
- `WorkflowGuide()`: returns the script-writing guide ([skill/SKILL.md](skill/SKILL.md)) as Markdown. It takes no input and starts nothing. The server's `instructions` field and the `Workflow` description tell the model to call it before the first script, so a client that has not installed the skill separately reaches the guide too.
- `WorkflowStop({ runId })`: stops the run. The script rejects with `run_stopped`, the journal stays and the run can be resumed later with `resumeFromRunId`.
- `WorkflowSkip({ runId, agentId })`: skips one agent in `liveAgents`. That `agent()` call returns `null`.

To use it in your own project, add the server to Claude Code. The package is published on npm as `maestro-workflows`. `npx maestro` downloads the unrelated `maestro` package on npm; do not use it. To run from this repository, make the end of the command `node "$PWD/bin/maestro" mcp` (after `npm run build`).

```bash
claude mcp add --scope user maestro -- npx -y maestro-workflows mcp
```

The server carries the script-writing guide too: the model reads it with the `WorkflowGuide` tool before its first script. You can also add the same guide as a skill that is visible in every project (optional):

```bash
mkdir -p ~/.claude/skills/maestro-workflow-authoring && cp skill/SKILL.md ~/.claude/skills/maestro-workflow-authoring/SKILL.md
```

With the default runner the server uses the `ANTHROPIC_API_KEY` in Claude Code's environment. The agents' cost is billed to the account of this key. `mcp --runner codex` uses the Codex CLI session. `mcp --runner gateway --model <provider/model>` uses `AI_GATEWAY_API_KEY` and bills through Vercel AI Gateway.

The `maestro mcp` server takes the `--cwd`, `--state-dir`, `--tools-dir`, `--budget`, `--concurrency`, `--model`, `--runner` and `--dry-run` options. `--budget` is one pool for the whole session: every run the server starts spends from the same `Budget` instance. stdout is the MCP channel and diagnostics go to stderr. When the client closes the connection (stdin ends) or the client process is gone, the server shuts down, runs in progress are stopped (their journals stay for resume) and the command exits with 0.

## CLI

```text
maestro run <script.js> [--args <json>] [--args-file f] [--resume <runId>] [--budget 500k]
                        [--dry-run] [--cwd d] [--state-dir d] [--tools-dir d] [--concurrency n] [--model m]
                        [--runner <anthropic|codex|gateway|auto>]
                        [--structured-mode <two-stage|submit-tool|single-stage>]
maestro runs [--cwd d] [--state-dir d] [--limit n]          (alias: ls)
maestro gc [--delete] [--force] [--cwd d]
maestro show <runId> [label] [--cwd d] [--state-dir d]
maestro viz <runId> [--cwd d] [--state-dir d] [--port n] [--no-open] [--out f.html] [--widget]
maestro mcp [--cwd d] [--state-dir d] [--tools-dir d] [--budget 500k] [--concurrency n] [--model m]
            [--runner <anthropic|codex|gateway|auto>]
            [--structured-mode <two-stage|submit-tool|single-stage>] [--dry-run]
```

`maestro run` writes the result to stdout as JSON, and progress goes to stderr. Ctrl-C stops the run and shows the resume command. `maestro runs` (`ls`) lists the stored runs from newest to oldest with status, duration, agent count and a token/cache summary. `maestro mcp` exits with 0 when stdin ends. There, `--budget` is not per run; it is one pool shared for the whole session.

`maestro gc` lists dirty worktrees and `wf/*` branches. The branches that count as merged are those that are an ancestor of HEAD or whose commits have all been cherry-picked. `--delete` deletes the worktrees that stayed clean and the merged branches. Dirty worktrees (uncommitted work) and unmerged branches are deleted only with `--delete --force`.

## The run directory and resume

The directory `.maestro/runs/<runId>/` holds `script.js`, `args.json`, `run.json`, `journal.jsonl`, `outcome.json` and `blobs/`. `run.json` keeps the run's model and runner: the cache key does not include them, so if one changes on resume, the log warns that the journaled results came from the old model. The journal keeps one line per `agent()` call (`key = sha256(prompt + "\n" + canonicalJSON(opts \ {label, phase})) + ":" + n`). Only `status: 'ok'` lines are cache hits. `null` lines (an API error) and `skipped` lines (budget, a skip, a stop) run again on resume. This is how raising the budget and resuming revives the agents that were cut off. Results larger than 64 KB are written to the file `blobs/<key>.json` (on Windows `-` replaces `:` in the file name; reading accepts both namings). `outcome.json` keeps the final result or the error when the run ends. Every live line also carries a `trace`: the agent's tool calls and the first 2,000 characters of its final text. `maestro show <runId>` lists the agents and the run's `outcome` summary, and `maestro show <runId> <label>` prints the trace of one agent in readable form.

The run directory also has `events.jsonl`: every event (an agent started, got a slot, finished, a phase, a log, the budget) is one line with a wall-clock time. The agent's prompt (the first 4,000 characters), model, effort and tools are written here too. The file is only for display. Resume and the cache work from the journal and do not look at this file. If it cannot be written, the run does not stop and one line goes to the log. Every start and every resume is appended to the file with its own `run_start` line.

## Watching a run: `maestro viz`

```bash
npx -y maestro-workflows viz <runId> --cwd <repo>
```

The command opens the run's timeline in the browser:
- **Lanes:** each phase is a lane.
- **Bars:** each agent is a bar. The thin line before a bar is the time the agent waited for a concurrency slot.
- **Colors:** running, done, null, skipped and reused from cache.
- **Detail:** clicking a bar shows the prompt, result, error, tool calls and tokens.

The header shows agent counts, duration, tokens, cache ratio and budget. For a resumed run you can switch between attempts.

The page reads the files once a second. So it also follows live a run that goes on in another process: this can be the MCP server of a Claude Code session or a `maestro run` in another terminal. The server binds to `127.0.0.1` only and stops with Ctrl-C.

- `--out report.html` writes one HTML file without starting a server: all events and agent details are embedded, it opens offline and it can be shared.
- `--port` selects a fixed port, `--no-open` does not open the browser.
- For old runs that have no `events.jsonl`, only the journal lines are listed.
- `--widget` prints a snapshot of the last attempt to stdout as an HTML fragment for the inline widget tool of a chat interface (`show_widget` in the Claude desktop app). The fragment follows these rules: no doctype, `html` or `body`; a transparent background; the host's `--text-*`, `--surface-*` and `--border*` variables; weights 400/500; no text under 11px; no fixed position and no inner scroll. Clicking a bar shows the wait and run time, the tokens, the error and the first 280 characters of the result. It is not live; the data is embedded. At most 400 agents are drawn, and the rest is stated in text. In Claude Code the skill says to show this fragment in the chat when the run ends.

## Examples

```bash
npm run build
```

```bash
node examples/review-changes.js --dry-run
```

```bash
node examples/find-edge-cases.js --dry-run
```

```bash
node examples/fanout-writers.js --dry-run
```

- `review-changes`: spec "Seviye 4", "Örnek 1": find → vote with three skeptics → synthesize.
- `find-edge-cases`: spec "Seviye 4", "Örnek 2": loop-until-dry.
- `fanout-writers`: isolated writers commit in parallel, and one coordinator cherry-picks the branches. The dry run sets up a temporary git repository; the worktree, the commit and the exit verification really run.

The workflow scripts are under `examples/workflows/`. The `examples/<name>.js` files are thin launchers that run them with `run()`. Without `--dry-run` the real API is used. If `ANTHROPIC_API_KEY` is missing, the launcher explains and exits.

A short smoke test with the real API, outside the default test run:

```bash
npm run smoke
```

## Cost and effort

`review-changes` with the real API, `MAESTRO_MODEL=claude-sonnet-5-5`, `MAESTRO_BUDGET=250000`. "Buggy setup": a temporary worktree opened for `2a877f1a^1` in the lula repository, `diffRef: "2a877f1a 2a877f1a^1"`. This diff contains a known count-upsert race in `lib/moderation/image-moderation-queue.ts` and a missing `next_attempt_at <= now()` check in `claim_image_moderation`. Total input = uncached input + cache writes + cache reads. Dollars are computed at Sonnet 5.5 prices: input $2/M, cache writes $2.50/M (5 minutes), cache reads $0.10/M, output $10/M.

| Run | Skeptic effort | Total input | Read from cache | Output | Dollars | Findings → skeptics → passed → synthesis |
|---|---|---:|---:|---:|---:|---|
| v1, clean PR diff, no cache | high | not measured | none | not measured | $0.77 | 0 findings |
| v1, buggy setup, no cache | high | 3.36M | none | 135k | $8.08 | 13 → 39 → 11 → 6, both bugs found |
| v1.1, buggy setup, cache | high | 2.97M | 2.02M (68%) | 102k | $3.36 | 10 → 30 → 9 → 6, both bugs (ranks 2 and 3) |
| v1.1, buggy setup, cache | medium | 2.28M | 1.64M (72%) | 79k | $2.39 | 11 → 33 → 10 → 5, both bugs (ranks 1 and 2) |

The v1.1 runs were made on 2026-10-25 (runs `20261025-212908-d1a8b7` and `20261025-213146-43651c`). Reading notes:

- **Cache.** The input cost is $6.72 in v1 (3.36M × $2) and $2.34 in the v1.1 high run: a 65% drop. The finders produce a different number of findings in each run (10 in place of 13), so it is fairer to look per agent: the input cost per agent goes from $0.156 down to $0.069 (56%). The single-turn synthesis agent reads only the tools + system prefix from the cache (16%). The multi-turn skeptics read about 70%.
- **Effort.** The cost per skeptic is $0.103 at high and $0.064 at medium (a 38% drop; these two figures were computed with cache reads at $0.20/M, and the correct price is $0.10/M, so both are a few cents high). The output per skeptic goes from 2.9k down to 2.0k tokens. In both runs exactly one finding was refuted and the two known bugs passed. At medium the votes split more often (2-1 on 3 of 11 findings, against 1 of 10 at high), so the medium skeptics gave fewer automatic approvals. This is one run, not statistics.
- Conclusion: the cache is on in every run. In this measurement the `medium` skeptics are cheaper without losing finding quality. The default stays `high` because this rests on one run.

The skeptic effort changes with `args.skepticEffort`; the default is `high`:

```bash
node examples/review-changes.js --args '{"diffRef":"main...HEAD","skepticEffort":"medium"}'
```

## Development

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run build
```

The tests use Vitest and do not touch the network. The Anthropic runner tests run the real SDK `toolRunner` and `parse` code on top of a fake `fetch`. The Codex runner tests use a fake executable that produces JSONL; the real Codex is not called. The isolation tests open real worktrees in temporary git repositories. Everything else runs with `FakeRunner` (`src/testing/fake-runner.ts`).

| Component | Source | Spec |
|---|---|---|
| Journal | `src/journal.ts` | 3.1 |
| Agent runner, tools | `src/runner.ts`, `src/codex-runner.ts`, `src/codex-tool-mcp.ts`, `src/routing-runner.ts`, `src/tools.ts`, `src/custom-tools.ts` | 3.2 |
| Script runtime, schema | `src/runtime.ts`, `src/schema.ts` | 3.3 |
| Scheduler | `src/scheduler.ts` | 3.4 |
| Budget | `src/budget.ts` | 3.5 |
| Isolation | `src/isolation.ts` | 3.6 |
| Observability | `src/progress.ts`, `src/event-log.ts`, `src/viz.ts`, `src/viz-page.ts`, `src/viz-widget.ts` | 3.7 |
| Tool surface | `src/workflow.ts`, `src/tool.ts`, `src/mcp.ts`, `src/cli.ts` | "Seviye 2" |

## Deviations from the spec

The items that did not pass from the spec into the code one to one, and the reasons, are below. The choices that the spec leaves open and that do not count as deviations are in [docs/decisions.md](docs/decisions.md) (written in Turkish).

- **JSON Schema helpers in place of `betaZodTool` and `zodOutputFormat` (3.2).** Scripts give the schema as JSON Schema, and the tools are defined with JSON Schema too. The runner gives the tools to `toolRunner` as `BetaRunnableTool` objects with `strict: true`. In the final stage it uses `betaJSONSchemaOutputFormat` and a local strict conversion. Converting JSON Schema to zod and back to JSON Schema would lose information. The SDK's own conversion drops the `properties` of `type: ['object','null']` nodes. The result is also validated against the script's original schema.
- **`toolRunner` runs with `thread: false` (3.2).** The SDK (since 1.3.0) uses a server-side thread by default. The transcript is kept locally for the runner-level retry, the single `max_tokens` continuation and the parse "on the same transcript".
- **In the strict tool schema `args` is a JSON string (scope addition, `src/tool.ts`).** Strict mode requires `additionalProperties: false` on every object and does not support an untyped schema. So it cannot be expressed as `args?: any`. The handler parses the string and also accepts a real value. All fields are in the `required` list and have the type `string | null`.
- **The path of a dirty writer is not written to the return value (3.6).** In one place the spec says that the path and the `git diff --stat` summary are written "to the return value and to the log". In another place it says that an agent that does not commit falls into the gc lane and does not reach the coordinator. A dirty agent returns null. The path and the diff summary are written to the `worktree` field of the journal line and to the log.
- **The semaphore slot is held for the agent's whole live run (3.4).** The slot is held not only during the HTTP request but for the whole of `runner.run`, including tool executions. Worktree setup, journal writes, script code, `parallel`/`pipeline` waits and `workflow()` hold no slot. This keeps the meaning "at most N live agents at once".
- **The example scripts are split in two, a launcher + a script ("Seviye 4").** The spec script (`export const meta` + a top-level `return`) is neither a valid ES module nor a CommonJS script. So the file `node examples/<name>.js` is a launcher that runs the script `examples/workflows/<name>.js` with `run()`.
- **The `fanout-writers` example does not call the coordinator if no branch arrives ("Seviye 4").** The spec snippet would call the coordinator with an empty list. That call finds nothing to commit and returns null with "no handoff".
- **The `workflow gc` command has the name `maestro gc` (3.6).** Also, the "merged" detection looks at patch equivalence with `git cherry` next to the ancestor relation, because the coordinator pattern uses cherry-pick and `git branch --merged` shows cherry-picked branches as unmerged.
- **There is no `/workflows` panel (3.7).** There is a terminal progress tree (`src/progress.ts`) and an event stream (`handle.events`). The panel is the host's interface. However, there is a view of a run in the browser (`maestro viz`), because the user asked for it. The Non-goals say "no per-agent UI". The view is read-only and does not manage the run.
- **The Policy component is not a separate module ("Seviye 2").** The opt-in rule lives as text in the Workflow tool description (`WORKFLOW_TOOL_DESCRIPTION`) and in the skill. The numeric limits are in code (`meta.maxAgents`, the global cap, the budget).
- **In a nested workflow the child's `meta.maxAgents` value is not applied (3.4).** The counter is shared, so the cap of the parent run applies. The child's value is written to the log.
- **The determinism override does not resist an attacker (3.3).** `Object.getPrototypeOf(Date)` still reaches the original `Date`. As the spec also says, `vm` is not a security boundary. However, `Intl.DateTimeFormat#format` without arguments, which reads the clock, is overridden too.
- **The MCP server lists five tools, not two (scope addition).** Next to `Workflow` and `WorkflowResult` there are `WorkflowStop`, `WorkflowSkip` and `WorkflowGuide`. The rows "Kullanıcı run'ı durdurur" and "Kullanıcı ajanı canlı atlar" of the null/throw table could not be produced in any other way for runs started with the tool or with MCP.
- **A root `{ type: 'object' }` schema is accepted without `properties` ("Seviye 1").** The table counts only a root that is not an object and the `required ⊄ properties` case as a throw. An empty object satisfies this schema.
- **In Stage 2 a `max_tokens` stop is retried with a larger `max_tokens`, not with "continue" (3.2).** A continuation turn would produce a new document, not the rest of the cut JSON document. In the tool loop the rule is applied one to one.
- **In the Codex runner a writer does not commit (3.6).** The Codex sandbox keeps `.git` read-only. After a successful isolated agent the runner makes the commit, and the agent gets one instruction ("do not commit"). The schema answer is also one attempt; there is no second parse attempt.
- **Additions that are not in the spec (scope addition).** The `cwd` input of the Workflow tool, the `wait` mode of `WorkflowResult`, custom tools defined outside the script (`.maestro/tools`, `--tools-dir`), `events.jsonl`, `run.json` and `outcome.json` in the run directory, `maestro show`, `maestro runs` and `maestro viz`.
- **There is no Agent SDK binding ("Açık sorular", item 2).** The spec leaves this to v2. The single-stage / cache-preserving schema output of "Açık sorular", item 1, is supported in `AnthropicRunner` as the optional `structuredMode: 'submit-tool' | 'single-stage'` (`--structured-mode`). The default `two-stage` keeps backward compatibility.

## License

Apache-2.0. Details are in the [LICENSE](LICENSE) file.
