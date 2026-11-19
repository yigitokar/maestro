---
title: "Evaluating workflows"
description: "Run a workflow against expected outputs, inspect failing cases, and compare revisions."
---

## Write a case suite

Give each case a stable ID, workflow arguments, and the JSON value the workflow should return. Save this array as `cases.json`.

```json
[
  { "id": "duplicate-charge", "args": "I was billed twice", "expected": "billing" },
  { "id": "password-reset", "args": "I can't reset my password", "expected": "account" }
]
```

A suite contains at least one case. IDs must be unique. Omitting `args` passes `null`. Maestro compares the full JSON return value, including array order. Object property order can differ. A thrown workflow error fails its case, and subsequent cases still run. A workflow that handles a failed agent internally is graded on its return value.

Save the classifier in `triage.js`.

```js
export const meta = { name: 'triage', description: 'Route a support request' };
const summary = await agent('Summarize this request: ' + args, { label: 'summarize' });
const classification = await agent('Choose the support queue for: ' + summary, {
  label: 'classify',
  schema: {
    type: 'object',
    properties: { queue: { type: 'string', enum: ['billing', 'account'] } },
    required: ['queue']
  }
});
return classification?.queue ?? null;
```

## Run and inspect an eval

```sh
maestro eval triage.js --cases cases.json --dry-run
```

In this example the fake runner returns the first enum value, so `duplicate-charge` passes and `password-reset` fails. The report prints the expected and actual values for the mismatch, an eval ID for comparing revisions, and a workflow run ID for each case. `--json` emits the full report on stdout, including untruncated mismatches. For a provider run, choose a configured `--runner` and omit `--dry-run`.

```sh
maestro inspect <case-run-id> --compact
maestro show <case-run-id> classify
```

Use compact inspection for agent or script failures. When the workflow completed successfully but returned the wrong value, use the eval mismatch and `show` to trace the decision. `maestro eval` exits with code `0` when every case passes and `1` on a failed case or command error. A completed report is saved even when some cases fail. Progress on stderr includes the workflow run ID as each case starts.

Case runs use the usual runtime options, including `--cwd`, `--state-dir`, `--model`, `--runner`, `--tools-dir`, and `--structured-mode`. Cases run in suite order. `--concurrency` controls agents within a case. `--budget` is a single output-token allowance shared across the suite. Workflow records are stored under `<state-dir>/runs/<case-run-id>/` and completed evals under `<state-dir>/evals/<eval-id>.json`.

## Compare two revisions

After changing the workflow, run the suite again and pass the two eval IDs in chronological order.

```sh
maestro eval triage.js --cases cases.json --runner auto
maestro eval diff <first-eval-id> <second-eval-id>
maestro eval diff <first-eval-id> <second-eval-id> --json
```

The diff shows the pass count and token delta. It matches cases by ID even if their order changed. It labels a transition on identical inputs and expectations as `fixed` or `regressed`. It also identifies `added`, `removed`, and `case changed` rows when the suite itself changes. Each row includes the workflow run ID for inspection. JSON output includes both `beforeRunId` and `afterRunId`. Diff exits successfully after displaying both reports, including when they contain regressions.

| Metric | How Maestro measures it |
| --- | --- |
| Tokens | Input and output tokens from live agent calls, including provider cache reads and writes. The delta is measured in tokens. Provider tariffs determine dollar cost. |
| `[CACHE HIT]` | Completed agent calls that reused a journal entry divided by all completed agent calls. Reused calls contribute zero tokens to this eval. The ratio is `n/a` for a workflow with zero calls. |
| Prompt cache | Provider-reported cache-read tokens divided by total live input tokens. `n/a` means the runner reported no cache figures or there was no input. |

## Reuse upstream nodes across a suite

Fresh evals start independent runs. To test an edit to `classify` and reuse `summarize` from each matching case, supply the baseline eval ID and the label of the first node to run again.

```sh
maestro eval triage.js --cases cases.json --baseline <first-eval-id> --from classify --runner auto
maestro eval diff <first-eval-id> <new-eval-id>
```

Baseline replay matches cases by ID and arguments. New cases and changed arguments start fresh. For matching cases, the selected node and subsequent calls execute in a new child run. Earlier calls must have successful, compatible cache entries. An unavailable upstream entry or a missing target appears as a case failure. Start at an earlier node when editing its prompt, or run a fresh eval for a full comparison across models.

## Run evals from Node

```js
import { diffEvals, FakeRunner, formatEvalDiff, readEval, runEval } from 'maestro-workflows';

const baseline = await readEval('.maestro', previousEvalId);
const current = await runEval({
  scriptPath: 'triage.js',
  casesPath: 'cases.json',
  runner: new FakeRunner(),
  baseline: baseline.id,
  from: 'classify'
});
console.log(formatEvalDiff(diffEvals(baseline, current)));
```

`runEval()` resolves after all cases settle. Check `current.passed === current.total` for a passing suite. Its `signal` option accepts an `AbortSignal` to stop the active case and end the suite.
