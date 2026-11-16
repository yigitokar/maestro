// node examples/find-edge-cases.js --dry-run [--args '{"target":"src/journal.ts"}']
import { runExample } from './_harness.js';

// Dry run: round 1 finds one bug per lens, round 2 one new bug, rounds 3 and 4 only repeat known
// keys, so the loop dries up after two empty rounds. The judge rejects bugs whose desc says "fake".
const rules = [
  {
    match: 'a real bug?',
    respond: (req) => ({ result: { real: !req.prompt.includes('fake') } }),
  },
  {
    match: 'Look for edge cases',
    respond: (req) => {
      const round = Number(/Round (\d+)/.exec(req.prompt)?.[1] ?? 1);
      const lens = /Lens: ([^.]+)\./.exec(req.prompt)?.[1] ?? 'x';
      const slug = lens.split(' ')[0];
      const bugs =
        round === 1
          ? [{ key: `${slug}-1`, desc: `${lens}: first finding` }]
          : round === 2 && slug === 'empty'
            ? [{ key: 'empty-2', desc: 'fake: the empty array is already guarded' }]
            : [{ key: `${slug}-1`, desc: 'repeat' }];
      return { result: { bugs } };
    },
  },
];

await runExample({ name: 'find-edge-cases', args: { target: 'src/journal.ts' }, rules });
