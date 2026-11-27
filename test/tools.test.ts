import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTools,
  checkReadOnlyCommand,
  globToRegExp,
  READ_TOOL_NAMES,
  shellWords,
  WRITE_TOOL_NAMES,
} from '../src/tools.js';
import { MaestroError, type ToolDef } from '../src/types.js';

const all = buildTools([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES], true);
const tool = (name: string): ToolDef => all.find((t) => t.name === name)!;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-tools-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\nworld\nhello again\n');
  await fs.mkdir(path.join(dir, 'src', 'deep'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'x.ts'), 'export const x = 1; // hello\n');
  await fs.writeFile(path.join(dir, 'src', 'deep', 'y.ts'), 'const y = 2;\n');
  await fs.writeFile(path.join(dir, 'b.md'), '# b\n');
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.ts'), 'hello from node_modules\n');
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

let repo: string;
const ctx = () => ({ cwd: repo, signal: new AbortController().signal });

beforeAll(async () => {
  repo = await makeRepo();
});
afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('buildTools', () => {
  it('defaults to the read-only set', () => {
    expect(buildTools(undefined, false).map((t) => t.name)).toEqual(['read_file', 'grep', 'glob', 'bash']);
    expect(buildTools(undefined, true).every((t) => !t.write)).toBe(true);
  });

  it('rejects unknown tools', () => {
    expect(() => buildTools(['read_file', 'nope'], true)).toThrowError(MaestroError);
    try {
      buildTools(['nope'], true);
    } catch (e) {
      expect((e as MaestroError).code).toBe('unknown_tool');
    }
  });

  it('rejects write tools without isolation (spec 3.6)', () => {
    for (const name of WRITE_TOOL_NAMES) {
      try {
        buildTools(['read_file', name], false);
        expect.unreachable();
      } catch (e) {
        expect((e as MaestroError).code).toBe('write_tool_without_isolation');
      }
    }
    expect(buildTools(['write_file', 'git_commit'], true).map((t) => t.name)).toEqual([
      'write_file',
      'git_commit',
    ]);
  });

  it('collapses duplicates', () => {
    expect(buildTools(['grep', 'grep', 'glob', 'grep'], false).map((t) => t.name)).toEqual(['grep', 'glob']);
  });

  it('every schema is strict and write flags are right', () => {
    const check = (s: any) => {
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    };
    for (const t of all) {
      check(t.inputSchema);
      expect(t.write).toBe((WRITE_TOOL_NAMES as readonly string[]).includes(t.name));
    }
  });
});

describe('shell-words and the bash allowlist', () => {
  it('tokenizes quotes', () => {
    expect(shellWords(`rg "a|b" 'c d' e\\ f`)).toEqual(['rg', 'a|b', 'c d', 'e f']);
    expect(() => shellWords(`cat "x`)).toThrow(/unterminated/);
  });

  it.each([
    'ls',
    'ls -la src',
    'cat a.txt',
    'git log --oneline -n 5',
    'git diff HEAD',
    'git status --porcelain',
    'git show HEAD --stat',
    'git --no-pager log',
    'git -C src log',
    'git diff --no-index a.txt b.md',
    'rg hello',
    "rg 'hello|world' src",
    "find . -name '*.ts'",
  ])('accepts %s', (cmd) => {
    expect(() => checkReadOnlyCommand(cmd, repo)).not.toThrow();
  });

  it.each([
    'rm a.txt',
    'ls; rm -rf x',
    'cat a > b',
    'cat a < b',
    'ls | wc -l',
    'ls && rm x',
    'ls & rm x',
    'git push',
    'git commit -m x',
    'git -c core.pager=x log',
    'git -C / log',
    'git -C .. log',
    'git --git-dir=/x log',
    'git diff --output=x',
    'git log --output x',
    'git log --ext-diff',
    'find . -delete',
    'find . -exec rm {} ;',
    'find . -exec rm {} \\;',
    'find . -execdir rm {} +',
    'find . -ok rm {} +',
    'find . -fprint out',
    'find . -fls out',
    'rg --pre sh x',
    'rg --pre=sh x',
    'rg --pre-glob x y',
    'echo hi',
    'cat `whoami`',
    'cat $(whoami)',
    'cat $HOME',
    'ls (x)',
    'ls\nrm x',
  ])('rejects %j', async (cmd) => {
    await expect(tool('bash').run({ command: cmd }, ctx())).rejects.toThrow(
      /not allowed|metacharacter|outside the working directory/,
    );
  });

  it('keeps read-only commands inside the working directory, patterns excepted', async () => {
    const b = tool('bash');
    const outside = path.join(path.dirname(repo), 'elsewhere.txt');
    for (const command of [
      `cat ${outside}`,
      'cat ../elsewhere.txt',
      'ls /',
      'find / -name x',
      'find . -newer /etc/hosts',
      `rg hello ${outside}`,
      'rg -e hello ..',
      'rg --file=/etc/hosts .',
      'git diff --no-index a.txt /etc/hosts',
      `git log -- ${outside}`,
    ]) {
      await expect(b.run({ command }, ctx()), command).rejects.toThrow(
        /outside the working directory|not allowed/,
      );
    }
    // A pattern may look like an absolute path; only path arguments are confined.
    expect(await b.run({ command: 'rg /no/such/text a.txt' }, ctx())).toBe('No matches.');
    expect(await b.run({ command: 'rg -e /no/such/text a.txt' }, ctx())).toBe('No matches.');
    expect(await b.run({ command: 'git log --oneline HEAD -- a.txt' }, ctx())).toContain('init');
    expect(await b.run({ command: "find . -name '*.txt' -maxdepth 1" }, ctx())).toContain('a.txt');
  });

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'AI_GATEWAY_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENAI_API_KEY',
  ])('agent commands do not see the runner credential %s', async (name) => {
    const saved = process.env[name];
    process.env[name] = 'test-not-a-key';
    try {
      const out = await tool('shell').run({ command: `echo "key=[$${name}]"` }, ctx());
      expect(out).toContain('key=[]');
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  it('runs allowed commands without a shell', async () => {
    const b = tool('bash');
    expect(await b.run({ command: 'ls' }, ctx())).toContain('a.txt');
    expect(await b.run({ command: 'cat a.txt' }, ctx())).toContain('hello again');
    expect(await b.run({ command: 'git log --oneline' }, ctx())).toContain('init');
    expect(await b.run({ command: 'git status --porcelain' }, ctx())).toBe('(no output)');
    expect(await b.run({ command: 'git show HEAD --stat' }, ctx())).toContain('a.txt');
    expect(await b.run({ command: 'git diff' }, ctx())).toBe('(no output)');
    expect(await b.run({ command: "rg -n 'hello|world' a.txt" }, ctx())).toContain('2:world');
    expect(await b.run({ command: 'rg zzz_not_there' }, ctx())).toBe('No matches.');
    expect(await b.run({ command: "find src -name '*.ts'" }, ctx())).toContain('src/deep/y.ts');
    // a quoted metacharacter is a literal argument, not shell syntax
    expect(await b.run({ command: 'cat "a.txt; rm a.txt"' }, ctx()).catch((e) => String(e))).toMatch(
      /exit code/,
    );
    await expect(fs.stat(path.join(repo, 'a.txt'))).resolves.toBeTruthy();
  });
});

describe('read tools', () => {
  it('read_file returns numbered lines and honours offset/limit', async () => {
    const r = tool('read_file');
    const out = await r.run({ path: 'a.txt', offset: null, limit: null }, ctx());
    expect(out).toContain('     1\thello');
    expect(out).toContain('     3\thello again');
    const part = await r.run({ path: 'a.txt', offset: 2, limit: 1 }, ctx());
    expect(part).toContain('     2\tworld');
    expect(part).not.toContain('hello again');
    expect(part).toContain('use offset 3');
  });

  it('read_file throws on a missing file or a path outside cwd', async () => {
    const r = tool('read_file');
    await expect(r.run({ path: 'missing.txt', offset: null, limit: null }, ctx())).rejects.toThrow(/ENOENT/);
    await expect(r.run({ path: '../etc/passwd', offset: null, limit: null }, ctx())).rejects.toThrow(
      /outside/,
    );
  });

  it('grep prints file:line:text, skips node_modules, filters by glob', async () => {
    const g = tool('grep');
    const out = await g.run({ pattern: 'hello', path: null, glob: null }, ctx());
    expect(out.split('\n')).toEqual([
      'a.txt:1:hello',
      'a.txt:3:hello again',
      'src/x.ts:1:export const x = 1; // hello',
    ]);
    expect(await g.run({ pattern: 'hello', path: null, glob: '*.ts' }, ctx())).toBe(
      'src/x.ts:1:export const x = 1; // hello',
    );
    expect(await g.run({ pattern: 'const', path: 'src', glob: 'src/deep/**' }, ctx())).toBe(
      'src/deep/y.ts:1:const y = 2;',
    );
    expect(await g.run({ pattern: 'nothing_here', path: null, glob: null }, ctx())).toBe('No matches.');
    await expect(g.run({ pattern: '(', path: null, glob: null }, ctx())).rejects.toThrow();
  });

  it('grep caps results with a truncated note', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-grep-'));
    await fs.writeFile(path.join(dir, 'many.txt'), 'x\n'.repeat(500));
    const out = await tool('grep').run({ pattern: 'x', path: null, glob: null }, { ...ctx(), cwd: dir });
    expect(out.split('\n').filter((l) => l.startsWith('many.txt:'))).toHaveLength(200);
    expect(out).toContain('truncated');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('glob matches **, *, ?, {a,b}, sorted', async () => {
    const g = tool('glob');
    expect(await g.run({ pattern: '**/*.ts' }, ctx())).toBe('src/deep/y.ts\nsrc/x.ts');
    expect(await g.run({ pattern: '*.{txt,md}' }, ctx())).toBe('a.txt\nb.md');
    expect(await g.run({ pattern: '?.md' }, ctx())).toBe('b.md');
    expect(await g.run({ pattern: '*.nope' }, ctx())).toBe('No files matched.');
  });

  it('globToRegExp', () => {
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b')).toBe(true);
    expect(globToRegExp('a.{js,ts}').test('a.ts')).toBe(true);
    expect(globToRegExp('a.{js,ts}').test('a.py')).toBe(false);
    expect(globToRegExp('a+b(1).txt').test('a+b(1).txt')).toBe(true);
  });
});

describe('write tools', () => {
  let wt: string;
  const wctx = () => ({ cwd: wt, signal: new AbortController().signal });
  beforeAll(async () => {
    wt = await makeRepo();
  });
  afterAll(async () => {
    await fs.rm(wt, { recursive: true, force: true });
  });

  it('write_file creates nested files and refuses paths outside cwd', async () => {
    await tool('write_file').run({ path: 'new/dir/f.txt', content: 'abc' }, wctx());
    expect(await fs.readFile(path.join(wt, 'new/dir/f.txt'), 'utf8')).toBe('abc');
    await expect(tool('write_file').run({ path: '../escape.txt', content: 'x' }, wctx())).rejects.toThrow(
      /outside/,
    );
  });

  it('edit_file requires old_string to occur exactly once', async () => {
    const e = tool('edit_file');
    await expect(e.run({ path: 'a.txt', old_string: 'hello', new_string: 'bye' }, wctx())).rejects.toThrow(
      /2 times/,
    );
    await expect(e.run({ path: 'a.txt', old_string: 'absent', new_string: 'x' }, wctx())).rejects.toThrow(
      /not found/,
    );
    await e.run({ path: 'a.txt', old_string: 'world', new_string: 'there' }, wctx());
    expect(await fs.readFile(path.join(wt, 'a.txt'), 'utf8')).toBe('hello\nthere\nhello again\n');
  });

  it('shell runs bash -c in cwd; non-zero exit is an error', async () => {
    const s = tool('shell');
    const out = await s.run({ command: 'pwd && echo err >&2' }, wctx());
    expect(out).toContain(wt);
    expect(out).toContain('err');
    await expect(s.run({ command: 'exit 3' }, wctx())).rejects.toThrow(/exit code 3/);
  });

  it('git_commit stages everything and commits; errors when nothing to commit', async () => {
    const c = tool('git_commit');
    await c.run({ message: 'agent work' }, wctx());
    expect(git(wt, 'log', '--oneline')).toContain('agent work');
    expect(git(wt, 'status', '--porcelain')).toBe('');
    await expect(c.run({ message: 'again' }, wctx())).rejects.toThrow(/nothing to commit/);
  });

  it('git tools work in cwd even when the environment points git at another repo (hooks set GIT_DIR)', async () => {
    const other = await makeRepo();
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    try {
      await fs.writeFile(path.join(wt, 'hooked.txt'), 'x');
      await tool('git_commit').run({ message: 'under a hook' }, wctx());
      expect(await tool('bash').run({ command: 'git log --oneline -1' }, wctx())).toContain('under a hook');
      expect(await tool('shell').run({ command: 'git rev-parse --show-toplevel' }, wctx())).toContain(
        path.basename(wt),
      );
    } finally {
      for (const [k, v] of [
        ['GIT_DIR', saved.dir],
        ['GIT_WORK_TREE', saved.tree],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(git(other, 'log', '--oneline')).not.toContain('under a hook');
    expect(git(wt, 'log', '--oneline')).toContain('under a hook');
    await fs.rm(other, { recursive: true, force: true });
  });
});
