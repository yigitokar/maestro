// Spec Seviye 4, Örnek 1: node examples/review-changes.js --dry-run [--args '{"diffRef":"main...HEAD"}']
import { runExample } from './_harness.js';

// Dry run: every finder reports two findings; skeptics refute the ones marked "flaky", so one
// finding per dimension survives the 2-of-3 vote and reaches the synthesis barrier.
const rules = [
  {
    match: 'ÇÜRÜTMEYE',
    respond: (req) => ({
      result: { refuted: req.prompt.includes('flaky'), reason: 'dry run' },
      outputTokensPerTurn: 150,
    }),
  },
  {
    match: 'doğrulanmış bulguları',
    respond: (req) => {
      const confirmed = JSON.parse(req.prompt.slice(req.prompt.indexOf('\n') + 1));
      return {
        result: {
          findings: confirmed.map(({ file, line, claim, failure }) => ({ file, line, claim, failure })),
        },
      };
    },
  },
  {
    match: 'Diff:',
    respond: (req) => {
      const dim = req.prompt.includes('güvenlik')
        ? 'security'
        : req.prompt.includes('Veri kaybı')
          ? 'data-loss'
          : 'correctness';
      return {
        turns: 3,
        result: {
          findings: [
            { file: `src/${dim}.ts`, line: 10, claim: `${dim}: sınır değer kaçıyor`, failure: 'boş girdi' },
            { file: `src/${dim}.ts`, line: 42, claim: `${dim}: flaky iddia`, failure: 'tekrar üretilemiyor' },
          ],
        },
      };
    },
  },
];

await runExample({ name: 'review-changes', args: { diffRef: 'HEAD~1...HEAD' }, rules });
