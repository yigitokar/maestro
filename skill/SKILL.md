---
name: maestro-workflow-authoring
description: Guide to writing a script for the Maestro Workflow tool (the meta block, the host API, what returns null and what throws, determinism, pipeline or parallel, patterns, resume). Read it before you give the Workflow tool a script.
---

# Writing a Maestro workflow script

The control flow is in code and the reasoning is in the agents. You write the script; a plain JavaScript runtime executes it. Every `agent()` starts with a clean context. Agents do not see each other, and data moves only through the script.

Give the script to the Workflow tool inline, in the `script` field (`scriptPath` or a saved `name` also work). The tool returns a `runId` at once; the result comes when the run ends.

The run works in the MCP server's directory (the folder the session was opened in). If the work is on another repository, pass that directory as `cwd`. Prefer a worktree of that repository over a main checkout that someone is using. The agents work there, writers branch from that git repository, and `.maestro/` is written there. When you resume, pass the same `cwd`.

## The meta block

Every script starts with `export const meta = {...}`. It must be a **pure literal**: no variables, no function calls, no spread, no template strings with expressions.

```js
export const meta = {
  name: 'review-changes',                       // required
  description: 'Review a diff from three angles', // required, shown in the permission dialog
  phases: [{ title: 'Find' }, { title: 'Verify' }],
  maxAgents: 60,                                // optional hard cap (default 1000)
}
```

When `meta.phases` is present, `phase(title)` and `opts.phase` accept only the titles listed there; any other title throws. Unknown `meta` fields (for example the typo `maxAgent`) produce a warning log at the start of the run; the valid fields are `name`, `description`, `phases`, `maxAgents` and `whenToUse`. Do not put a cap in a prompt ("stay under 10 agents"); put it in code with `maxAgents`.

## Host API

The script body is async: `await` and a top-level `return` are allowed. The returned value is the result of the run.

| API | Behavior |
|---|---|
| `agent(prompt, opts?)` | Runs an agent. With a `schema` it returns the validated object, otherwise the final text. A terminal API error, a skip by the user, or the budget running out while it runs → **null**. An invalid schema (root is not `object`, `required ⊄ properties`), not enough budget at entry, the agent cap reached, or a write tool requested without isolation → **throw**. |
| `parallel(thunks)` | Waits for all of them (a barrier). The slot of a thunk that fails with an agent or runtime error becomes **null**; programmer and configuration errors (`ReferenceError`, `Math.random()`, `unknown_tool`, `unknown_phase`, a write tool without isolation and so on) **throw** directly. |
| `pipeline(items, ...stages)` | Each item goes through the stages on its own, with no barrier between stages. A stage receives `(prev, item, index)`; in the first stage `prev === item`. A stage that fails with a runtime error makes the item null and skips its remaining stages; programmer and configuration errors **throw** directly. A stage that **returns** null has returned a normal value, which goes to the next stage. |
| `phase(title)` | Puts the agents that follow in this progress box. In parallel code use `opts.phase`. |
| `log(msg)` | A narrator line above the progress tree. |
| `args` | The `args` of the tool call, as given. Do not turn an array into a string. |
| `budget` | `{ total, spent(), remaining() }`. Without a total, `total` is null and `remaining()` is Infinity. The pool is shared and the limit is hard. |
| `workflow(nameOrRef, args?)` | Runs another workflow as a sub-step, with the same semaphore, counter and budget. One level only: `workflow()` inside the child throws. |

`opts`: `label` (display name), `phase`, `schema`, `model`, `effort` (`low` … `max`), `isolation: 'worktree'`, `tools` (the allowed tools). When the server runs with `--runner auto`, `opts.model` routes each agent to a provider (`claude-*` → Anthropic, `gemini-*` / `google/gemini-*` → Gemini with `GEMINI_API_KEY`, `gpt-*` / `o3` → Codex). The default tools are read-only: `read_file`, `grep`, `glob`, `bash` (ls, cat, git log/diff/status/show, rg, find). Write tools (`write_file`, `edit_file`, `shell`, `git_commit`) are given only with `isolation: 'worktree'`. Custom tools defined outside the script (`.maestro/tools/*.js`, for example `arxiv_search`) are selected by name too; the end of the Workflow tool's description lists the ones that exist. `tools` replaces the default set, it does not extend it: next to a custom tool, list the read tools the agent needs as well.

With `--runner gateway`, every agent uses Vercel AI Gateway. Set `opts.model` to an exact `provider/model` ID, or inherit the server's `--model`; the direct Claude default is not a Gateway ID. The server needs `AI_GATEWAY_API_KEY` in its environment. Keep credentials out of workflow scripts and `args`. Choose models that support tool calling; structured output and effort support depend on the model.

The rule: an error at agent level falls to null silently, an error at script level ends the run. Apply `.filter(Boolean)` to results and say with `log()` how many items were dropped.

An agent's final text is raw data for the caller. The agent knows what is wanted only from its prompt, so the prompt must be enough by itself.

## Live feedback and status

While a run is active, call `WorkflowResult({ runId, wait: false })` to inspect `liveAgents`: queued/running state, elapsed time, public activity, turns, usage, `canMessage` and message receipts. To add an instruction, call `WorkflowMessage({ runId, agentId, message })` for an agent with `canMessage: true`. The returned receipt is initially `queued`; check later status for `delivered` or `failed`. Delivery means acceptance, not completion of the requested work. Waiting result calls also provide concise progress when supported by the client.

Anthropic receives feedback before the next safe model request; running tools are not interrupted or repeated. Codex app-server uses live steering. Queued agents, custom runners without a handler and legacy Codex exec cannot receive feedback. Each agent accepts at most 32 messages of 16,000 characters each. Messages are audited, so never send credentials. Successful steered results are reused on resume with an explicit log; edit the prompt in the script when changing a durable instruction.

## Determinism

`Date.now()`, `Math.random()` and `new Date()` without arguments throw. `process`, `require`, `fetch`, `console` and `setTimeout` are not defined. The reason is resume: the cache key is `sha256(prompt + opts)` plus which call with that content it is. If a prompt changes on every run, the cache never hits.

- If you need a timestamp, pass it in `args`: `new Date(args.ts)` works.
- Instead of randomness, vary the prompt by index.
- Changes to `label`, `phase` and the audit-only `upstream` field preserve the cache key.

## Pipeline is the default

For work with several stages, use `pipeline`. A barrier (`parallel`, then `parallel`) is justified only when stage N needs **all** the results of stage N-1: dedup over all results, an early exit such as "no findings → skip verification", or "compare with the other findings".

Smell test:

```js
const a = await parallel(...)
const b = transform(a)          // map/filter/flatten, no dependency between items
const c = await parallel(b.map(...))
```

The transform in the middle needs no barrier; move it into a pipeline stage. If the slowest finder takes three times as long as the fastest, the barrier wastes two thirds of the fast ones' time in waiting.

## Patterns

- **Adversarial verify**: N independent skeptics per finding, each trying to REFUTE it; drop the finding if the majority refutes it. Tell them "if you are not sure, refuted=true".
- **Perspective diversity**: instead of calling the same skeptic N times, give each a different lens (reproducibility, intent and edge cases, the existing tests).
- **Judge panel**: produce designs from N angles (MVP-first, risk-first, user-first), score them with a parallel jury, synthesize from the winner.
- **Loop-until-dry**: for discovery of unknown size, loop until two rounds in a row bring nothing new. Dedup against `seen`, not against `confirmed`; otherwise a finding the jury rejected comes back every round.
- **Multi-modal sweep**: give the same question to parallel agents with different search routes (file name, content, symbol, git log).
- **Completeness critic**: a last agent asks "what is missing?"; what it finds is the work of the next round.
- **No silent caps**: say every limit (top-N, sampling, a round cap) with `log()`.
- **Fan-out writers → coordinator merge**: N isolated writer agents (`isolation: 'worktree'`, write tools) work in parallel. Each commits to the branch the runtime opened, `wf/<runId>/<label>`, and returns `{ summary, filesTouched }`; the runtime adds `branchName`. An agent that does not commit, or that changes branch, returns null. Do not bring diff text into the script. One isolated coordinator cherry-picks the branches and resolves conflicts; merging is not the script's job. Give writers unique `label`s.

## Example: find → verify → synthesize

```js
export const meta = { name: 'review-changes', description: 'Three dimensions, three skeptics per finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }] }

const DIMENSIONS = ['correctness', 'security', 'data-loss']
const perDim = await pipeline(DIMENSIONS,
  d => agent(`Diff: ${args.diffRef}. Look only for ${d} problems.`, { label: `find:${d}`, phase: 'Find', schema: FINDINGS }),
  async (found, d) => {
    if (!found) { log(`${d}: finder returned null`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1, 2].map(i => () =>
        agent(`Try to REFUTE this claim: ${f.claim} (${f.file}:${f.line}). If you are not sure, refuted=true. Perspective ${i}.`,
          { label: `verify:${f.file}:${f.line}#${i}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
      return votes.filter(Boolean).filter(v => !v.refuted).length >= 2 ? { ...f, dimension: d } : null
    }))
  })
const confirmed = perDim.filter(Boolean).flat().filter(Boolean)
log(`${confirmed.length} findings passed the vote`)
if (!confirmed.length) return { findings: [] }
return agent(`Order by severity and suggest a one-sentence fix for each:\n${JSON.stringify(confirmed)}`,
  { phase: 'Synthesize', schema: FINDINGS })
```

`Verify` does not wait for `Find` to finish; the only barrier is the synthesis.

## Example: loop-until-dry

```js
export const meta = { name: 'find-edge-cases', description: 'Search until nothing new turns up',
  phases: [{ title: 'Find' }, { title: 'Verify' }] }

const LENSES = ['boundary values', 'concurrency', 'error paths']
const seen = new Set(), confirmed = []
let dry = 0, round = 0
while (dry < 2 && round < 6) {
  round++
  const found = (await parallel(LENSES.map((lens, i) => () =>
    agent(`Look for edge cases in ${args.target}. Lens: ${lens}. Already known: ${[...seen].join(', ') || 'none'}`,
      { label: `find:${i}:r${round}`, phase: 'Find', schema: BUGS })))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(b.key))
  if (!fresh.length) { dry++; continue }
  dry = 0
  fresh.forEach(b => seen.add(b.key))
  const judged = await parallel(fresh.map(b => () =>
    agent(`Is "${b.desc}" a real bug? Show evidence.`, { phase: 'Verify', schema: VERDICT })
      .then(v => v && v.real ? b : null)))
  confirmed.push(...judged.filter(Boolean))
}
if (round >= 6) log('round cap reached')
return { confirmed, rounds: round }
```

The full versions, with the `FINDINGS`, `VERDICT` and `BUGS` schemas, are in the repository: https://github.com/yigitokar/maestro/tree/main/examples/workflows

## Resume and the journal

Every run keeps `script.js`, `args.json`, `journal.jsonl` and `blobs/` under `.maestro/runs/<runId>/`. When you edit the script and run it again with `resumeFromRunId`, every call that did not change comes from the cache. A hit is decided per call: if one prompt in the middle changes, only that call and the calls that take its result into their prompt run live, and independent siblings come from the cache. The same script with the same args means zero live calls. Only `ok` records are cache hits: null records (an API error) and skipped records (budget or a skip) run again on resume. This is how raising the budget and resuming revives the agents that were cut off.

For a failed agent, run `maestro inspect <runId> --compact --cwd <cwd>` for its invocation ID, reason, input, output and relevant state. A pipeline stage supplies its item and prior value automatically. In other control flow, include selected JSON values in `agent(prompt, { label, upstream: { ... } })` for inspection. Use `maestro show <runId> <label>` when you need the full trace for a successful call.

For a refinement loop, save a JSON array of cases with `id`, `args` and `expected`, then run `maestro eval workflow.js --cases cases.json --json`. Each case has its own workflow run ID. After an edit, try `maestro replay <case-run-id> --from <label> --script workflow.js`. Replay creates a fresh run, restores successful calls before the selected invocation, and runs the selected invocation and subsequent calls live. Rerun the suite with `--baseline <first-eval-id> --from <label>`, then compare scores, tokens and cache hits with `maestro eval diff <first-eval-id> <second-eval-id>`.

If the user wants to watch the run, give them this command:

```bash
npx -y maestro-workflows viz <runId> --cwd <the run's cwd>
```

It opens a live timeline in the browser. With `--out report.html` it writes a one-file report. When each agent started, waited for a slot and finished is recorded in `events.jsonl`.

When the run has ended and the session has an inline widget tool (such as `show_widget` in the Claude desktop app), show the timeline in the chat:

```bash
npx -y maestro-workflows viz <runId> --cwd <the run's cwd> --widget
```

Give the command's stdout to the widget code unchanged. If the tool's own rule asks for a setup call before first use, make that call first. The fragment is a snapshot: if you show it while the run is going, produce it again when the run ends. For very large runs (hundreds of agents) the fragment is long; suggest the browser command unless the user asks for the widget.
