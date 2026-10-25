// Seviye 4 "Fan-out writers → coordinator merge": node examples/fanout-writers.js --dry-run
// The dry run builds a throwaway git repo; writers really commit in their worktrees and the
// coordinator really cherry-picks their branches, so isolation and exit verification run for real.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runExample } from './_harness.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

const TASKS = [
  { key: 'docs', brief: 'notes/docs.md dosyasına kullanım notu ekle' },
  { key: 'util', brief: 'notes/util.md dosyasına yardımcı fonksiyon taslağı ekle' },
  { key: 'tests', brief: 'notes/tests.md dosyasına test planı ekle' },
];

const rules = [
  {
    match: 'cherry-pick',
    respond: (req) => ({
      effect: () => {
        for (const b of req.prompt.match(/wf\/[^\s:]+/g) ?? []) git(req.cwd, 'cherry-pick', b);
      },
      result: {
        summary: 'üç branch sırayla cherry-pick edildi, çatışma yok',
        filesTouched: TASKS.map((t) => `notes/${t.key}.md`),
      },
    }),
  },
  {
    match: 'Bitince değişikliklerini commit et',
    respond: (req) => {
      const file = /(notes\/\w+\.md)/.exec(req.prompt)[1];
      return {
        turns: 2,
        effect: async () => {
          await writeFile(path.join(req.cwd, file), `# ${file}\n\n${req.prompt.split('.')[0]}\n`, {
            flag: 'a',
          });
          git(req.cwd, 'add', '-A');
          git(req.cwd, 'commit', '-q', '-m', `add ${file}`);
        },
        result: { summary: `${file} yazıldı`, filesTouched: [file] },
      };
    },
  },
];

async function setup(dryRun) {
  if (!dryRun) return { cwd: process.cwd() };
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-fanout-repo-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'dry-run@example.invalid');
  git(cwd, 'config', 'user.name', 'maestro dry run');
  await writeFile(path.join(cwd, '.gitignore'), '.maestro/\nnode_modules/\n');
  await writeFile(path.join(cwd, 'README.md'), '# demo\n');
  execFileSync('mkdir', ['-p', path.join(cwd, 'notes')]);
  await writeFile(path.join(cwd, 'notes', '.keep'), '');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  return { cwd };
}

const out = await runExample({ name: 'fanout-writers', args: { tasks: TASKS }, rules, setup });
if (out?.result?.branchName) {
  console.error(`\ncoordinator branch ${out.result.branchName}:`);
  console.error(git(out.cwd, 'log', '--oneline', out.result.branchName));
}
