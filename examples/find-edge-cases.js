// Spec Seviye 4, Örnek 2: node examples/find-edge-cases.js --dry-run [--args '{"target":"src/journal.ts"}']
import { runExample } from './_harness.js';

// Dry run: round 1 finds one bug per lens, round 2 one new bug, rounds 3 and 4 only repeat known
// keys, so the loop dries up after two empty rounds. The judge rejects bugs whose desc says "fake".
const rules = [
  {
    match: 'gerçek bir hata mı',
    respond: (req) => ({ result: { real: !req.prompt.includes('fake') } }),
  },
  {
    match: 'edge case ara',
    respond: (req) => {
      const round = Number(/Tur (\d+)/.exec(req.prompt)?.[1] ?? 1);
      const lens = /Mercek: ([^.]+)\./.exec(req.prompt)?.[1] ?? 'x';
      const slug = lens.split(' ')[0];
      const bugs =
        round === 1
          ? [{ key: `${slug}-1`, desc: `${lens}: ilk bulgu` }]
          : round === 2 && slug === 'boş'
            ? [{ key: 'boş-2', desc: 'fake: boş dizi zaten korunuyor' }]
            : [{ key: `${slug}-1`, desc: 'tekrar' }];
      return { result: { bugs } };
    },
  },
];

await runExample({ name: 'find-edge-cases', args: { target: 'src/journal.ts' }, rules });
