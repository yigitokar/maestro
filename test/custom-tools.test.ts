// Custom tools (src/custom-tools.ts): defined outside the script, picked by name in agent opts.tools.
// The definition checks, the tools directory loader, buildTools with a registry, run() end to end (the
// FakeRunner calls the tool itself) and the Workflow description that names the custom tools.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkToolDef, loadToolsDir, makeToolRegistry } from '../src/custom-tools.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { maestroToolDefinition, maestroToolDefinitionFor } from '../src/tool.js';
import { buildTools } from '../src/tools.js';
import { MaestroError, type ToolDef } from '../src/types.js';
import { run } from '../src/workflow.js';

const EXAMPLE_TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'tools');

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-custom-tools-')));
  dirs.push(d);
  return d;
}

const strict = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

function echoTool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: strict({ text: { type: 'string' } }),
    write: false,
    run: async (input) => `echo: ${input.text}`,
    ...overrides,
  };
}

const ECHO_FILE = (description = 'Echo the text back.') => `export default {
  name: 'echo',
  description: ${JSON.stringify(description)},
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  write: false,
  async run(input) { return 'echo: ' + input.text; },
};
`;

function toolInvalid(fn: () => unknown, fragment: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, `expected tool_invalid with "${fragment}"`).toBeInstanceOf(MaestroError);
  expect((err as MaestroError).code).toBe('tool_invalid');
  expect((err as Error).message).toContain(fragment);
}

describe('custom tool definitions', () => {
  it('a valid definition passes and keeps its own run function', async () => {
    const reg = makeToolRegistry([{ tool: echoTool(), where: 'tools[0]' }]);
    expect([...reg.keys()]).toEqual(['echo']);
    const ctx = { cwd: '.', signal: new AbortController().signal };
    expect(await reg.get('echo')!.run({ text: 'hi' }, ctx)).toBe('echo: hi');
  });

  it('rejects what the runner or the isolation guard could not use', () => {
    const at = (tool: unknown) => () => checkToolDef(tool, 'tools/x.js');
    toolInvalid(at(null), 'a tool must be an object');
    toolInvalid(at(echoTool({ name: 'web search' })), 'name must match');
    toolInvalid(at(echoTool({ description: ' ' })), 'description must be a non-empty string');
    toolInvalid(at({ ...echoTool(), write: undefined }), 'write must be true or false');
    toolInvalid(at({ ...echoTool(), run: 'nope' }), 'run must be a function');
    toolInvalid(at(echoTool({ inputSchema: { type: 'string' } })), "root schema must have type: 'object'");
    toolInvalid(
      at(
        echoTool({ inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }),
      ),
      'objects need additionalProperties: false',
    );
    toolInvalid(
      at(
        echoTool({
          inputSchema: strict({
            rows: {
              type: 'array',
              items: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
            },
          }),
        }),
      ),
      '$.properties.rows.items: "a" must be in required',
    );
  });

  it('a built-in name or a name defined twice is rejected, naming both places', () => {
    toolInvalid(
      () => makeToolRegistry([{ tool: echoTool({ name: 'grep' }), where: 'tools/grep.js' }]),
      '"grep" is a built-in tool name',
    );
    toolInvalid(
      () =>
        makeToolRegistry([
          { tool: echoTool(), where: 'tools[0]' },
          { tool: echoTool(), where: 'tools/echo.js' },
        ]),
      'tools/echo.js: "echo" is already defined by tools[0]',
    );
  });
});

describe('loadToolsDir', () => {
  it('a missing directory has no tools', async () => {
    expect(await loadToolsDir(path.join(await tmp(), 'nope'))).toEqual([]);
  });

  it('loads *.js and *.mjs in name order, one tool or an array per file; helpers and other files are skipped', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, '_shared.js'), 'export const prefix = "shared";\n');
    await writeFile(
      path.join(dir, 'b.mjs'),
      `import { prefix } from './_shared.js';
const mk = (name) => ({ name, description: prefix + ' ' + name, write: false,
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run() { return name; } });
export default [mk('b_one'), mk('b_two')];
`,
    );
    await writeFile(path.join(dir, 'a.js'), ECHO_FILE());
    await writeFile(path.join(dir, '.hidden.js'), 'throw new Error("never loaded")\n');
    await writeFile(path.join(dir, 'notes.txt'), 'not a tool\n');
    const loaded = await loadToolsDir(dir);
    expect(loaded.map((l) => [l.where, (l.tool as ToolDef).name])).toEqual([
      ['tools/a.js', 'echo'],
      ['tools/b.mjs', 'b_one'],
      ['tools/b.mjs', 'b_two'],
    ]);
    expect((loaded[1]!.tool as ToolDef).description).toBe('shared b_one');
  });

  it('a file that fails to import or has no default export is tool_invalid with its name', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'bad.js'), 'throw new Error("boom at import");\n');
    await expect(loadToolsDir(dir)).rejects.toThrow(/tools\/bad\.js: cannot load: boom at import/);
    await rm(path.join(dir, 'bad.js'));
    await writeFile(path.join(dir, 'named.js'), 'export const tool = {};\n');
    await expect(loadToolsDir(dir)).rejects.toThrow(/tools\/named\.js: no default export/);
  });

  it('an edited tool file is loaded again (long-lived maestro mcp)', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'echo.js');
    await writeFile(file, ECHO_FILE('first'));
    expect(((await loadToolsDir(dir))[0]!.tool as ToolDef).description).toBe('first');
    await writeFile(file, ECHO_FILE('second'));
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    expect(((await loadToolsDir(dir))[0]!.tool as ToolDef).description).toBe('second');
  });
});

describe('buildTools with custom tools', () => {
  const reg = makeToolRegistry([
    { tool: echoTool(), where: 'tools[0]' },
    { tool: echoTool({ name: 'stamp', write: true }), where: 'tools[1]' },
  ]);

  it('picks custom tools by name next to the built-ins', () => {
    expect(buildTools(['read_file', 'echo', 'echo'], false, reg).map((t) => t.name)).toEqual([
      'read_file',
      'echo',
    ]);
  });

  it('an unknown name lists the custom tools among the known ones', () => {
    expect(() => buildTools(['nope'], false, reg)).toThrow(
      /unknown tool "nope" \(known: .*git_commit, echo, stamp\)/,
    );
  });

  it('a custom write tool gets the same isolation guard as the built-in ones', () => {
    expect(() => buildTools(['stamp'], false, reg)).toThrow(
      expect.objectContaining({ code: 'write_tool_without_isolation' }),
    );
    expect(buildTools(['stamp'], true, reg).map((t) => t.name)).toEqual(['stamp']);
  });
});

describe('run() with custom tools', () => {
  const SCRIPT = `export const meta = { name: 'custom-tools', description: 'd' };
return await agent('look it up', { label: 'look', tools: ['read_file', 'echo'] });`;

  /** A fake agent that calls the echo tool the way the real runner would, then returns its output. */
  function callingRunner(): FakeRunner {
    let out = '';
    return new FakeRunner(() => ({
      effect: async (req) => {
        const echo = req.tools.find((t) => t.name === 'echo')!;
        out = await echo.run({ text: 'hi' }, { cwd: req.cwd, signal: req.signal });
      },
      result: () => out,
    }));
  }

  it('reads <stateDir>/tools by default; the agent gets the tool and the tool runs in the host', async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, '.maestro', 'tools'), { recursive: true });
    await writeFile(path.join(cwd, '.maestro', 'tools', 'echo.js'), ECHO_FILE());
    const runner = callingRunner();
    const h = run({ script: SCRIPT, cwd, runner });
    const logs: string[] = [];
    h.events.on('log', (e) => logs.push(e.message));
    expect(await h.promise).toBe('echo: hi');
    expect(runner.calls[0]!.tools.map((t) => t.name)).toEqual(['read_file', 'echo']);
    // Loaded code is never silent: the run says which custom tools it has.
    expect(logs).toContain('custom tools: echo');
  });

  it('RunOptions.tools works without any directory', async () => {
    const cwd = await tmp();
    const h = run({ script: SCRIPT, cwd, runner: callingRunner(), tools: [echoTool()] });
    expect(await h.promise).toBe('echo: hi');
  });

  it('a broken tool file fails the run before it starts: no run directory is left behind', async () => {
    const cwd = await tmp();
    const toolsDir = path.join(cwd, 'my-tools');
    await mkdir(toolsDir);
    await writeFile(path.join(toolsDir, 'echo.js'), ECHO_FILE().replace('write: false,', ''));
    const runner = new FakeRunner();
    const h = run({ script: SCRIPT, cwd, runner, toolsDir: 'my-tools' });
    await expect(h.promise).rejects.toThrow(
      /tool_invalid: tools\/echo\.js \(echo\): write must be true or false/,
    );
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(h.runDir)).toBe(false);
  });

  it('a name that is not defined throws unknown_tool into the script', async () => {
    const cwd = await tmp();
    const script = `export const meta = { name: 'unknown', description: 'd' };
try { await agent('x', { tools: ['web_search'] }); return 'no throw'; } catch (e) { return e.message; }`;
    const h = run({ script, cwd, runner: new FakeRunner(), tools: [echoTool()] });
    expect(await h.promise).toMatch(/unknown tool "web_search" \(known: .*, echo\)/);
  });

  it('the example arXiv tool in examples/tools passes the checks and reaches the agent', async () => {
    const cwd = await tmp();
    const runner = new FakeRunner();
    const script = `export const meta = { name: 'arxiv', description: 'd' };
return await agent('find papers', { tools: ['arxiv_search'] });`;
    await run({ script, cwd, runner, toolsDir: EXAMPLE_TOOLS }).promise;
    expect(runner.calls[0]!.tools.map((t) => [t.name, t.write])).toEqual([['arxiv_search', false]]);
  });
});

describe('Workflow tool description', () => {
  it('lists the custom tools so the model writing a script knows their names', () => {
    const def = maestroToolDefinition([
      echoTool({ description: 'Echo the text back.\nSecond line is left out.' }),
      echoTool({ name: 'stamp', write: true, description: 'Stamp a file.' }),
    ]);
    expect(def.description).toContain(
      'Custom tools for agent opts.tools:\n- echo: Echo the text back.\n- stamp (write tool: needs isolation): Stamp a file.',
    );
    expect(def.description).not.toContain('Second line');
    expect(maestroToolDefinition().description).not.toContain('Custom tools for agent opts.tools');
  });

  it('maestroToolDefinitionFor reads the same directory a run would, and says when it cannot load it', async () => {
    const cwd = await tmp();
    expect((await maestroToolDefinitionFor({ cwd, toolsDir: EXAMPLE_TOOLS })).description).toContain(
      '- arxiv_search: Search arXiv papers.',
    );
    await mkdir(path.join(cwd, '.maestro', 'tools'), { recursive: true });
    await writeFile(path.join(cwd, '.maestro', 'tools', 'bad.js'), 'export default 42;\n');
    expect((await maestroToolDefinitionFor({ cwd })).description).toContain(
      'Custom tools failed to load, runs fail until fixed: tool_invalid: tools/bad.js: a tool must be an object',
    );
  });
});
