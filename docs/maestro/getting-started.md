---
title: "Getting started"
description: "Install Maestro, write a first workflow, run it and resume it."
icon: "rocket"
---

## Requirements

- Node.js 22.18 or newer.
- For agents on Claude: an `ANTHROPIC_API_KEY` in the environment.
- For agents on Codex: the Codex CLI, installed and signed in. No Anthropic key is needed. See [Runners](runners.md).

## Install

Maestro is not published to npm. Clone the repository and build it.

```bash
git clone https://github.com/yigitokar/maestro && cd maestro
```

```bash
npm install
```

```bash
npm run build
```

The command is `node bin/maestro` from the repository root. Do not use `npx maestro`: that downloads an unrelated npm package with the same name.

## A first workflow

Save this as `review.js`. It looks for problems in a change from two angles, then asks two skeptics to try to refute each finding. A finding survives only if no skeptic refutes it.

```js
export const meta = {
  name: 'quick-review',
  description: 'Review a diff from two angles and have two skeptics vote on each finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
  maxAgents: 40,
}

const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: {
  type: 'object', required: ['file', 'claim'], properties: { file: { type: 'string' }, claim: { type: 'string' } } } } } }
const VERDICT = { type: 'object', required: ['refuted'], properties: { refuted: { type: 'boolean' } } }

const perAngle = await pipeline(
  ['correctness', 'security'],
  angle => agent(`Look only for ${angle} problems in the change \`git diff ${args.diffRef}\`.`,
    { label: `find:${angle}`, phase: 'Find', schema: FINDINGS }),
  async (found, angle) => {
    if (!found) { log(`${angle}: the finder returned nothing`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1].map(i => () =>
        agent(`Try to refute this claim: ${f.claim} (${f.file}). If you are not sure, set refuted=true. View ${i}.`,
          { label: `verify:${f.file}#${i}`, phase: 'Verify', schema: VERDICT, effort: 'high' })))
      return votes.filter(Boolean).every(v => !v.refuted) ? { ...f, angle } : null
    }))
  })

const confirmed = perAngle.flat().filter(Boolean)
log(`${confirmed.length} findings confirmed`)
return confirmed
```

A script starts with `export const meta` and ends with a top-level `return`. Everything between is ordinary JavaScript plus the functions Maestro provides. [Writing workflows](workflows.md) describes them.

## Try it without spending anything

`--dry-run` replaces every agent with a fake that answers from the schema. Nothing goes to the network.

```bash
node bin/maestro run review.js --args '{"diffRef":"main...HEAD"}' --dry-run
```

Progress is printed to stderr as a tree of phases and agents. The script's return value is printed to stdout as JSON.

## Run it for real

```bash
node bin/maestro run review.js --args '{"diffRef":"main...HEAD"}' --budget 300k
```

Agents run in the current directory and can read it. `--budget 300k` stops the run from spending more than about 300,000 output tokens. See [Runs, resume and budget](runs.md).

Maestro writes its state under `.maestro/` in the directory you run it in. Add `.maestro/` to that repository's `.gitignore`.

## Change the script and run again cheaply

Every run has an id, printed when it starts. Resume reuses the answers of every `agent()` call that did not change.

```bash
node bin/maestro run review.js --resume <runId>
```

Only the calls you changed, and the calls that depend on their answers, run again.

## Look at a run

```bash
node bin/maestro runs
```

```bash
node bin/maestro show <runId>
```

```bash
node bin/maestro viz <runId>
```

`runs` lists the runs in this directory, `show` prints one run's agents and outcome, and `viz` opens a timeline of the run in the browser.

## Next

- [Writing workflows](workflows.md) for the full script API.
- [Claude Code](claude-code.md) to let Claude write and start workflows for you.
- The `examples/` directory: `review-changes`, `find-edge-cases` and `fanout-writers`, each runnable with `node examples/<name>.js --dry-run`.
