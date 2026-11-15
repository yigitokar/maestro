---
title: "Writing workflows"
description: "The script API: agent, parallel, pipeline, phase, log, args, budget and workflow."
icon: "code"
---

A workflow is one JavaScript file. Maestro runs it in a restricted context: the script sees JavaScript's built-ins and the functions on this page, and nothing else. `process`, `require`, `fetch`, `console` and `setTimeout` are not defined.

The script body is async. `await` and a top-level `return` are allowed, and the returned value is the result of the run.

## The meta block

Every script starts with `export const meta = { ... }`.

```js
export const meta = {
  name: 'review-changes',                  // required
  description: 'Review a diff from three angles',  // required
  phases: [{ title: 'Find' }, { title: 'Verify' }],
  maxAgents: 60,
}
```

| Key | Meaning |
|---|---|
| `name` | Required. The workflow's name. |
| `description` | Required. Shown where the run is started. |
| `phases` | Optional. The phase titles the script may use. With it, any other title is an error. |
| `maxAgents` | Optional. A hard cap on agents started over the whole run. Default 1000. |
| `whenToUse` | Optional. A note for whoever picks the workflow. |

The block must be a pure literal: no variables, function calls, spreads or template strings with expressions. Maestro reads it without running the script. An unknown key, such as a misspelled `maxAgent`, is ignored and reported in the log when the run starts.

## The functions

| Function | Returns |
|---|---|
| `agent(prompt, opts?)` | With `opts.schema`, an object validated against it. Without, the agent's final text. |
| `parallel(thunks)` | An array with one result per thunk, after all have finished. |
| `pipeline(items, ...stages)` | An array with each item's result from the last stage. |
| `phase(title)` | Nothing. Puts the agents that follow under this title in the progress view. |
| `log(message)` | Nothing. Adds a line to the progress view and the log. |
| `args` | The arguments the run was started with, unchanged. |
| `budget` | `{ total, spent(), remaining() }`. Without a budget, `total` is `null` and `remaining()` is `Infinity`. |
| `workflow(nameOrRef, args?)` | The return value of another workflow, run as a child. |

### `agent(prompt, opts?)`

Starts one agent with a clean context. Agents do not see each other; data moves between them only through your script.

```js
const summary = await agent('Summarize what src/journal.ts does.')

const found = await agent('List the exported functions of src/journal.ts.', {
  label: 'exports',
  schema: { type: 'object', required: ['names'], properties: { names: { type: 'array', items: { type: 'string' } } } },
})
```

The options are described in [Agents and tools](agents-and-tools.md).

### `parallel(thunks)`

Takes an array of functions, runs them together and waits for all of them.

```js
const [a, b] = await parallel([
  () => agent('Review the tests.'),
  () => agent('Review the docs.'),
])
```

Pass functions, not promises: `() => agent(...)`, not `agent(...)`.

### `pipeline(items, ...stages)`

Sends each item through the stages on its own. There is no barrier between stages: one item can be in stage three while another is still in stage one.

A stage receives `(prev, item, index)`. In the first stage `prev` is the item itself.

```js
const reports = await pipeline(
  files,
  file => agent(`Find bugs in ${file}.`, { schema: FINDINGS }),
  (found, file) => found ? agent(`Rank these findings for ${file}: ${JSON.stringify(found)}`) : null,
)
```

Use `pipeline` when each item has its own chain of steps. Use `parallel` when you need every result before going on.

### `workflow(nameOrRef, args?)`

Runs another workflow as a child and returns its result. The child shares the parent's concurrency limit, agent count and budget. Nesting goes one level deep: calling `workflow()` inside a child is an error. The child's own `meta.maxAgents` is not applied.

A name resolves to `.maestro/workflows/<name>.js`.

## When a call returns null and when it throws

Maestro separates two kinds of failure. Something that went wrong with one agent gives you `null`, so the rest of the run can go on. A mistake in the script or its configuration throws, so you find out.

| Situation | Result |
|---|---|
| The API fails for good for one agent | `agent()` returns `null` |
| The user skips a running agent | `agent()` returns `null` |
| The budget runs out while an agent is running | `agent()` returns `null` |
| The schema is invalid (root is not an object, or `required` names a missing property) | `agent()` throws |
| The budget cannot cover a new agent at the start | `agent()` throws |
| The `maxAgents` cap is reached | `agent()` throws |
| A write tool is requested without isolation | `agent()` throws |

Inside `parallel` and `pipeline`:

- A thunk or stage that throws because of an agent, the budget or a schema becomes `null` in its slot, and the failure is logged. In a pipeline the item's remaining stages are skipped.
- A programming or configuration error rejects the whole call: `ReferenceError`, `SyntaxError`, a non-deterministic call, an unknown tool or phase, a write tool without isolation, a nested workflow, two writers on one branch, or a journal that cannot be written.
- More than 4096 items in one call rejects.
- A stage that returns `null` is a normal value and goes on to the next stage.

Always check for `null`:

```js
const votes = await parallel(skeptics)
const cast = votes.filter(Boolean)
```

## Determinism

A script must do the same thing every time it runs with the same answers, because resume replays it. So these throw inside a script:

- `Date.now()`
- `Math.random()`
- `new Date()` without arguments

If you need a timestamp, pass it in `args`: `new Date(args.ts)` works.

## Patterns

**Find, then verify.** Finders propose, skeptics try to refute, and only what survives is kept. The first workflow in [Getting started](getting-started.md) does this.

**Loop until dry.** Ask for new items, give the next agent the list so far, and stop after a round that adds nothing. `examples/workflows/find-edge-cases.js` does this.

**Fan out writers.** Several isolated agents each change code on their own branch, and one coordinator collects the branches. `examples/workflows/fanout-writers.js` does this; see [Agents and tools](agents-and-tools.md).

**Put limits in code.** Do not ask an agent to "stay under 10 agents". Set `maxAgents` and a budget.
