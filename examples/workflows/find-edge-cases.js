export const meta = {
  name: 'find-edge-cases',
  description: 'Search for edge cases until two rounds in a row find nothing new',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

// Loop until dry: discovery of unknown size.
// args: { target: string }  e.g. { "target": "src/journal.ts" }

const BUGS = { type: 'object', properties: { bugs: { type: 'array', items: {
  type: 'object', properties: { key: { type: 'string' }, desc: { type: 'string' } }, required: ['key', 'desc'] } } },
  required: ['bugs'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] }

const LENSES = ['empty input and boundary values', 'concurrency and ordering', 'error paths and partial success']
const seen = new Set(), confirmed = []
let dry = 0, round = 0

while (dry < 2 && round < 6) {
  round++
  const found = (await parallel(LENSES.map((lens, i) => () =>
    agent(`Look for edge cases in ${args.target}. Lens: ${lens}. Round ${round}. ` +
          `Already found (do not repeat): ${[...seen].join(', ') || 'none'}`,
      { label: `find:${i}:r${round}`, phase: 'Find', schema: BUGS }))))
    .filter(Boolean).flatMap(r => r.bugs)

  const fresh = found.filter(b => !seen.has(b.key))
  if (!fresh.length) { dry++; log(`round ${round}: nothing new (${dry}/2)`); continue }
  dry = 0
  fresh.forEach(b => seen.add(b.key))          // add to seen, not to confirmed

  const judged = await parallel(fresh.map(b => () =>
    agent(`Is "${b.desc}" a real bug? Read the code and show evidence.`, { phase: 'Verify', schema: VERDICT })
      .then(v => v && v.real ? b : null)))
  confirmed.push(...judged.filter(Boolean))
  log(`round ${round}: ${fresh.length} new, ${confirmed.length} confirmed`)
}
if (round >= 6) log('round cap reached, the search may not be complete')
return { confirmed, rounds: round }
