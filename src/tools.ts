// Runner-side tools (spec 3.2, Açık soru 2): the read-only default set (read_file, grep, glob, bash
// read-only allowlist) and the write set for isolated agents (write_file, edit_file, shell, git_commit).
// Every input schema is strict: additionalProperties:false and every property in `required`.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolRegistry } from './custom-tools.js';
import { childGitEnv } from './git-env.js';
import { MaestroError, type ToolDef } from './types.js';

export const READ_TOOL_NAMES = ['read_file', 'grep', 'glob', 'bash'] as const;
export const WRITE_TOOL_NAMES = ['write_file', 'edit_file', 'shell', 'git_commit'] as const;

const OUTPUT_CAP = 100_000; // characters returned to the model per tool call
const LINE_CAP = 2_000; // characters per returned line
const READ_DEFAULT_LIMIT = 2_000; // lines
const GREP_MATCH_CAP = 200;
const GLOB_RESULT_CAP = 1_000;
const WALK_FILE_CAP = 50_000;
const GREP_FILE_SIZE_CAP = 2 * 1024 * 1024;
const BASH_TIMEOUT_MS = 30_000;
const SHELL_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// ---------------------------------------------------------------------------------------------
// Helpers

const nullableInt = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

function strictObject(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function str(input: any, key: string): string {
  const v = input?.[key];
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function optStr(input: any, key: string): string | undefined {
  const v = input?.[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function optInt(input: any, key: string): number | undefined {
  const v = input?.[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Resolve `p` against cwd and refuse anything that escapes it. */
export function resolveInside(cwd: string, p: string): string {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path is outside the working directory: ${p}`);
  }
  return abs;
}

function capOutput(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n... (truncated: output exceeded ${cap} characters)`;
}

function capLine(line: string): string {
  return line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…` : line;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Files under `dir` (recursive), skipping .git/node_modules and symlinks. Paths are absolute. */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= WALK_FILE_CAP) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Small glob → RegExp: `**`, `*`, `?`, `{a,b}`; everything else literal. Matches whole posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
      depth++;
    } else if (c === ',' && depth > 0) {
      re += '|';
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth--;
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  if (depth > 0) throw new Error(`unbalanced braces in glob: ${glob}`);
  return new RegExp(`^${re}$`);
}

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** execFile without a shell; stdin is closed so tools like rg never wait on it. */
function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; timeout: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: MAX_BUFFER,
        signal: opts.signal,
        env: opts.env ?? process.env,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, timedOut: false, truncated: false });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string };
        if (e.name === 'AbortError') {
          reject(new Error('aborted'));
          return;
        }
        if (e.code === 'ENOENT') {
          reject(new Error(`command not found: ${file}`));
          return;
        }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            code: 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: false,
            truncated: true,
          });
          return;
        }
        const timedOut = e.killed === true && e.signal === 'SIGTERM';
        resolve({
          code: typeof e.code === 'number' ? e.code : 1,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut,
          truncated: false,
        });
      },
    );
    child.stdin?.end();
  });
}

function formatProc(r: ProcResult): string {
  let out = r.stdout;
  if (r.stderr.trim() !== '') out += `${out && !out.endsWith('\n') ? '\n' : ''}[stderr]\n${r.stderr}`;
  if (r.truncated) out += '\n... (truncated: output exceeded buffer)';
  return capOutput(out);
}

// ---------------------------------------------------------------------------------------------
// bash (read-only allowlist)

const SHELL_META = new Set([';', '|', '&', '>', '<', '`', '$', '(', ')', '\n', '\r']);

/** Minimal shell-words tokenizer: '…' and "…" quoting, backslash escapes; metacharacters outside quotes throw. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated single quote');
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < command.length) {
        const d = command[i]!;
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1]!)) {
          cur += command[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      if (!closed) throw new Error('unterminated double quote');
      inWord = true;
    } else if (c === '\\') {
      if (i + 1 >= command.length) throw new Error('trailing backslash');
      const next = command[i + 1]!;
      if (next === '\n') throw new Error('line continuation is not allowed');
      cur += next;
      inWord = true;
      i += 2;
    } else if (c === ' ' || c === '\t') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      i++;
    } else if (SHELL_META.has(c)) {
      throw new Error(`shell metacharacter not allowed: ${JSON.stringify(c)}`);
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

const FIND_FORBIDDEN = new Set([
  '-exec',
  '-execdir',
  '-delete',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);
/** rg flags that make ripgrep execute a program (--pre/--pre-glob preprocessors, --hostname-bin). */
const RG_FORBIDDEN = new Set(['--pre', '--pre-glob', '--hostname-bin']);
const GIT_SUBCOMMANDS = new Set(['log', 'diff', 'status', 'show']);

/** Validate a read-only command line; returns argv or throws "not allowed: …". */
export function checkReadOnlyCommand(command: string, cwd: string): string[] {
  const argv = shellWords(command.trim());
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error('empty command');
  switch (cmd) {
    case 'ls':
    case 'cat':
      return argv;
    case 'find':
      for (const a of args) if (FIND_FORBIDDEN.has(a)) throw new Error(`not allowed: find ${a}`);
      return argv;
    case 'rg':
      for (const a of args) {
        const flag = a.split('=')[0]!;
        if (RG_FORBIDDEN.has(flag)) throw new Error(`not allowed: rg ${flag}`);
      }
      return argv;
    case 'git': {
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) {
        const opt = args[i]!;
        if (opt === '--no-pager') {
          i++;
        } else if (opt === '-C') {
          const dir = args[i + 1];
          if (dir === undefined) throw new Error('not allowed: git -C without a directory');
          resolveInside(cwd, dir); // throws when outside cwd
          i += 2;
        } else {
          throw new Error(`not allowed: git option ${opt}`);
        }
      }
      const sub = args[i];
      if (!sub || !GIT_SUBCOMMANDS.has(sub)) {
        throw new Error(`not allowed: git ${sub ?? ''} (only log, diff, status, show)`.trim());
      }
      for (const a of args.slice(i + 1)) {
        if (a === '--ext-diff' || a === '--output' || a.startsWith('--output=')) {
          throw new Error(`not allowed: git ${sub} ${a.split('=')[0]}`);
        }
      }
      return argv;
    }
    default:
      throw new Error(`command not allowed: ${cmd} (allowed: ls, cat, git log|diff|status|show, rg, find)`);
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = childGitEnv({ GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });
  delete env.GIT_EXTERNAL_DIFF;
  return env;
}

// ---------------------------------------------------------------------------------------------
// Tool definitions

const readFileTool: ToolDef = {
  name: 'read_file',
  description:
    'Read a text file (path relative to the working directory). Returns numbered lines. ' +
    'offset is the 1-based first line (null = 1), limit the number of lines (null = 2000).',
  inputSchema: strictObject({ path: { type: 'string' }, offset: nullableInt, limit: nullableInt }),
  write: false,
  async run(input, ctx) {
    const abs = resolveInside(ctx.cwd, str(input, 'path'));
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(`${str(input, 'path')} is a directory`);
    const text = await fs.readFile(abs, 'utf8');
    if (text === '') return '(empty file)';
    const lines = text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const offset = Math.max(1, optInt(input, 'offset') ?? 1);
    const limit = Math.max(1, optInt(input, 'limit') ?? READ_DEFAULT_LIMIT);
    if (offset > lines.length) return `(offset ${offset} is past the end of the file: ${lines.length} lines)`;
    const end = Math.min(lines.length, offset - 1 + limit);
    let out = '';
    for (let n = offset; n <= end; n++) {
      const row = `${String(n).padStart(6)}\t${capLine(lines[n - 1]!)}\n`;
      if (out.length + row.length > OUTPUT_CAP) {
        return `${out}... (truncated at line ${n - 1} of ${lines.length}; use offset to read more)`;
      }
      out += row;
    }
    if (end < lines.length)
      out += `... (${lines.length - end} more lines; use offset ${end + 1} to continue)`;
    return out;
  },
};

const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. path (null = working directory) may be a ' +
    'file or directory; glob (null = all files) filters file paths, e.g. "**/*.ts". Skips .git and ' +
    'node_modules. Returns "file:line:text" lines.',
  inputSchema: strictObject({ pattern: { type: 'string' }, path: nullableString, glob: nullableString }),
  write: false,
  async run(input, ctx) {
    const re = new RegExp(str(input, 'pattern'));
    const root = path.resolve(ctx.cwd);
    const start = resolveInside(root, optStr(input, 'path') ?? '.');
    const stat = await fs.stat(start);
    const files = stat.isDirectory() ? await walk(start) : [start];
    const glob = optStr(input, 'glob');
    const globRe = glob ? globToRegExp(glob) : undefined;
    const results: string[] = [];
    let truncated = false;
    outer: for (const file of files) {
      const rel = toPosix(path.relative(root, file));
      if (globRe && !globRe.test(glob!.includes('/') ? rel : path.basename(file))) continue;
      const fst = await fs.stat(file);
      if (fst.size > GREP_FILE_SIZE_CAP) continue;
      const buf = await fs.readFile(file);
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          if (results.length >= GREP_MATCH_CAP) {
            truncated = true;
            break outer;
          }
          results.push(`${rel}:${i + 1}:${capLine(lines[i]!)}`);
        }
      }
    }
    if (results.length === 0) return 'No matches.';
    let out = results.join('\n');
    if (truncated)
      out += `\n... (truncated: more than ${GREP_MATCH_CAP} matches; narrow the pattern or path)`;
    return capOutput(out);
  },
};

const globTool: ToolDef = {
  name: 'glob',
  description:
    'List files whose path (relative to the working directory) matches a glob: ** (any depth), * , ?, ' +
    '{a,b}. Skips .git and node_modules. Sorted.',
  inputSchema: strictObject({ pattern: { type: 'string' } }),
  write: false,
  async run(input, ctx) {
    const re = globToRegExp(str(input, 'pattern'));
    const root = path.resolve(ctx.cwd);
    const matches = (await walk(root))
      .map((f) => toPosix(path.relative(root, f)))
      .filter((rel) => re.test(rel));
    matches.sort();
    if (matches.length === 0) return 'No files matched.';
    const shown = matches.slice(0, GLOB_RESULT_CAP);
    let out = shown.join('\n');
    if (matches.length > shown.length) {
      out += `\n... (truncated: ${matches.length} files matched, showing ${GLOB_RESULT_CAP})`;
    }
    return capOutput(out);
  },
};

const bashTool: ToolDef = {
  name: 'bash',
  description:
    'Run ONE read-only command without a shell: ls, cat, git log|diff|status|show, rg, find. Quoting works; ' +
    'pipes, redirections, ;, &, $, backticks and subshells are rejected, as are find -exec/-delete, ' +
    'rg --pre/--hostname-bin and git -c/--output/--ext-diff.',
  inputSchema: strictObject({ command: { type: 'string' } }),
  write: false,
  async run(input, ctx) {
    const [cmd, ...args] = checkReadOnlyCommand(str(input, 'command'), ctx.cwd);
    const r = await runProcess(cmd!, args, {
      cwd: ctx.cwd,
      timeout: BASH_TIMEOUT_MS,
      signal: ctx.signal,
      env: cmd === 'git' ? gitEnv() : process.env,
    });
    if (r.timedOut) throw new Error(`command timed out after ${BASH_TIMEOUT_MS} ms`);
    if (cmd === 'rg' && r.code === 1 && r.stdout === '' && r.stderr === '') return 'No matches.';
    if (r.code !== 0) throw new Error(`exit code ${r.code}\n${formatProc(r)}`);
    return formatProc(r) || '(no output)';
  },
};

const writeFileTool: ToolDef = {
  name: 'write_file',
  description: 'Create or overwrite a file (path relative to the working directory) with content.',
  inputSchema: strictObject({ path: { type: 'string' }, content: { type: 'string' } }),
  write: true,
  async run(input, ctx) {
    const p = str(input, 'path');
    const abs = resolveInside(ctx.cwd, p);
    const content = str(input, 'content');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  },
};

const editFileTool: ToolDef = {
  name: 'edit_file',
  description: 'Replace old_string with new_string in a file. old_string must occur exactly once.',
  inputSchema: strictObject({
    path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
  }),
  write: true,
  async run(input, ctx) {
    const p = str(input, 'path');
    const abs = resolveInside(ctx.cwd, p);
    const oldS = str(input, 'old_string');
    const newS = str(input, 'new_string');
    if (oldS === '') throw new Error('old_string must not be empty');
    const text = await fs.readFile(abs, 'utf8');
    const count = text.split(oldS).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${p}`);
    if (count > 1) throw new Error(`old_string occurs ${count} times in ${p}; it must be unique`);
    const idx = text.indexOf(oldS);
    await fs.writeFile(abs, text.slice(0, idx) + newS + text.slice(idx + oldS.length), 'utf8');
    return `Edited ${p}`;
  },
};

const shellTool: ToolDef = {
  name: 'shell',
  description: 'Run a bash command (bash -c) in the working directory. Returns stdout and stderr.',
  inputSchema: strictObject({ command: { type: 'string' } }),
  write: true,
  async run(input, ctx) {
    const r = await runProcess('bash', ['-c', str(input, 'command')], {
      cwd: ctx.cwd,
      timeout: SHELL_TIMEOUT_MS,
      signal: ctx.signal,
      // The command may run git: it must act on the worktree, not on a repo the parent's env names.
      env: childGitEnv(),
    });
    if (r.timedOut) throw new Error(`command timed out after ${SHELL_TIMEOUT_MS} ms\n${formatProc(r)}`);
    if (r.code !== 0) throw new Error(`exit code ${r.code}\n${formatProc(r)}`);
    return formatProc(r) || '(no output)';
  },
};

const gitCommitTool: ToolDef = {
  name: 'git_commit',
  description: 'Stage every change (git add -A) and commit it on the current branch with message.',
  inputSchema: strictObject({ message: { type: 'string' } }),
  write: true,
  async run(input, ctx) {
    const message = str(input, 'message');
    if (message.trim() === '') throw new Error('commit message must not be empty');
    const opts = { cwd: ctx.cwd, timeout: SHELL_TIMEOUT_MS, signal: ctx.signal, env: gitEnv() };
    const add = await runProcess('git', ['add', '-A'], opts);
    if (add.code !== 0) throw new Error(`git add failed\n${formatProc(add)}`);
    const status = await runProcess('git', ['status', '--porcelain'], opts);
    if (status.code !== 0) throw new Error(`git status failed\n${formatProc(status)}`);
    if (status.stdout.trim() === '') throw new Error('nothing to commit (working tree clean)');
    const commit = await runProcess('git', ['commit', '-m', message], opts);
    if (commit.code !== 0) throw new Error(`git commit failed\n${formatProc(commit)}`);
    return formatProc(commit);
  },
};

// A Map, not a plain object: inherited keys ('constructor', '__proto__', …) must not resolve to a tool.
const ALL_TOOLS: ReadonlyMap<string, ToolDef> = new Map(
  [readFileTool, grepTool, globTool, bashTool, writeFileTool, editFileTool, shellTool, gitCommitTool].map(
    (t) => [t.name, t],
  ),
);

/**
 * Tool set for one agent. undefined → the read-only default set. A name is a built-in or a custom tool
 * of `custom` (src/custom-tools.ts). Unknown name → 'unknown_tool'; a write tool without isolation →
 * 'write_tool_without_isolation' (spec 3.6: writer = isolated agent), custom write tools included.
 */
export function buildTools(
  names: string[] | undefined,
  isolated: boolean,
  custom: ToolRegistry = new Map(),
): ToolDef[] {
  const requested = names ?? [...READ_TOOL_NAMES];
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    const tool = ALL_TOOLS.get(name) ?? custom.get(name);
    if (!tool) {
      const known = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES, ...custom.keys()];
      throw new MaestroError(`unknown tool "${name}" (known: ${known.join(', ')})`, 'unknown_tool');
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(tool);
  }
  const writers = out.filter((t) => t.write).map((t) => t.name);
  if (writers.length > 0 && !isolated) {
    throw new MaestroError(
      `write tools (${writers.join(', ')}) require isolation: 'worktree'`,
      'write_tool_without_isolation',
    );
  }
  return out;
}
