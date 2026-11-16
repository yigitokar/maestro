// node examples/review-changes.js --dry-run [--args '{"diffRef":"main...HEAD"}']
import { runExample } from './_harness.js';

// Dry run: every finder reports two findings; skeptics refute the ones marked "flaky", so one
// finding per dimension survives the 2-of-3 vote and reaches the synthesis barrier.
const rules = [
  {
    match: 'Try to REFUTE',
    respond: (req) => ({
      result: { refuted: req.prompt.includes('flaky'), reason: 'dry run' },
      outputTokensPerTurn: 150,
    }),
  },
  {
    match: 'verified findings',
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
      const dim = req.prompt.includes('security problems')
        ? 'security'
        : req.prompt.includes('data loss')
          ? 'data-loss'
          : 'correctness';
      return {
        turns: 3,
        result: {
          findings: [
            {
              file: `src/${dim}.ts`,
              line: 10,
              claim: `${dim}: a boundary value is missed`,
              failure: 'empty input',
            },
            {
              file: `src/${dim}.ts`,
              line: 42,
              claim: `${dim}: flaky claim`,
              failure: 'cannot be reproduced',
            },
          ],
        },
      };
    },
  },
];

await runExample({ name: 'review-changes', args: { diffRef: 'HEAD~1...HEAD' }, rules });
