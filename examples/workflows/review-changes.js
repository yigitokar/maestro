export const meta = {
  name: 'review-changes',
  description: 'Review a diff from three angles, three skeptics vote on every finding',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

// Find → adversarial verify → synthesize.
// args: { diffRef: string, skepticEffort?: 'low'|'medium'|'high'|'xhigh'|'max' }  e.g. { "diffRef": "main...HEAD" }
// skepticEffort: the effort of the skeptics, default 'high'.

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: {
      type: 'object',
      properties: {
        file: { type: 'string' }, line: { type: 'integer' },
        claim: { type: 'string' }, failure: { type: 'string' },
      },
      required: ['file', 'line', 'claim', 'failure'],
    } },
  },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const DIFF = `Diff: ${args.diffRef}. Read the change with "git diff ${args.diffRef}", and read the code around the files it touches.`
const DIMENSIONS = [
  { key: 'correctness', prompt: `${DIFF} Look only for logic errors: wrong condition, boundary value, null/undefined, ordering, wrong return value.` },
  { key: 'security',    prompt: `${DIFF} Look only for security problems: injection, authorization bypass, secret leak, untrusted input that is not validated.` },
  { key: 'data-loss',   prompt: `${DIFF} Look only for data loss and irreversible operations: delete, overwrite, migration, a write that stops halfway.` },
]

const perDimension = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS }),
  async (found, d) => {
    if (!found) { log(`${d.key}: finder returned null`); return [] }
    return parallel(found.findings.map(f => async () => {
      const votes = await parallel([0, 1, 2].map(i => () =>
        agent(`Try to REFUTE this claim: ${f.claim} (${f.file}:${f.line}). Scenario: ${f.failure}. ` +
              `The claim is about this change: "git diff ${args.diffRef}". Read the diff first, then the code in the working tree; ` +
              `the claim describes the state the diff brings. If you are not sure, refuted=true. ` +
              `Perspective ${i}: ${['reproducibility','intent and edge cases','existing tests'][i]}.`,
          { label: `verify:${f.file}:${f.line}#${i}`, phase: 'Verify', schema: VERDICT, effort: args.skepticEffort ?? 'high' })))
      const alive = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
      return alive ? { ...f, dimension: d.key, votes } : null
    }))
  },
)

const confirmed = perDimension.filter(Boolean).flat().filter(Boolean)
log(`${confirmed.length} findings passed the vote`)
if (!confirmed.length) return { findings: [] }

const summary = await agent(
  `Order these verified findings by severity and suggest a one-sentence fix for each:\n${JSON.stringify(confirmed)}`,
  { phase: 'Synthesize', schema: FINDINGS })
return summary
