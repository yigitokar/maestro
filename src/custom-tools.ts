// Custom tools: defined outside the script, picked by name in agent opts.tools next to the built-ins.
// Two sources make one registry: RunOptions.tools (ToolDef objects) and the *.js files of the tools
// directory (default <stateDir>/tools), each default-exporting one ToolDef or an array of them. Every
// definition is checked before the script starts, so a bad one fails the run instead of an agent.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSatisfiableSchema } from './schema.js';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from './tools.js';
import { MaestroError, type ToolDef } from './types.js';

/** Custom tools by name. Built-in names never appear here (makeToolRegistry rejects them). */
export type ToolRegistry = ReadonlyMap<string, ToolDef>;

export const EMPTY_TOOL_REGISTRY: ToolRegistry = new Map();

/** The API's tool-name rule. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BUILTIN_NAMES = new Set<string>([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
const TOOL_FILE = /^[^._].*\.(?:js|mjs)$/;

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(where: string, why: string): never {
  throw new MaestroError(`tool_invalid: ${where}: ${why}`, 'tool_invalid');
}

/**
 * Checks one definition and returns it. The runner sends every tool with strict: true, so the input
 * schema must be strict (types.ts ToolDef): every object has additionalProperties: false and lists
 * every property in required. A tool that can change files must say write: true to get the isolation
 * guard, so write has no default.
 */
export function checkToolDef(value: unknown, where: string): ToolDef {
  if (!isObject(value)) invalid(where, 'a tool must be an object');
  const { name, description, inputSchema, write, run } = value;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
    invalid(where, `name must match ${TOOL_NAME} (got ${JSON.stringify(name)})`);
  }
  const at = `${where} (${name})`;
  if (typeof description !== 'string' || description.trim() === '') {
    invalid(at, 'description must be a non-empty string');
  }
  if (typeof write !== 'boolean') invalid(at, 'write must be true or false');
  if (typeof run !== 'function') invalid(at, 'run must be a function (input, ctx) => Promise<string>');
  try {
    assertSatisfiableSchema(inputSchema);
  } catch (e) {
    invalid(at, `inputSchema: ${(e as Error).message.replace(/^schema_invalid: /, '')}`);
  }
  checkStrict(inputSchema, '$', at);
  return value as unknown as ToolDef;
}

function checkStrict(node: unknown, at: string, where: string): void {
  if (!isObject(node)) return;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const props = isObject(node.properties) ? node.properties : undefined;
  if (types.includes('object') || props) {
    if (node.additionalProperties !== false) {
      invalid(where, `inputSchema ${at}: objects need additionalProperties: false (strict tool input)`);
    }
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    for (const k of Object.keys(props ?? {})) {
      if (!required.has(k)) {
        invalid(where, `inputSchema ${at}: "${k}" must be in required (make it nullable to be optional)`);
      }
    }
  }
  for (const [k, sub] of Object.entries(props ?? {})) checkStrict(sub, `${at}.properties.${k}`, where);
  if (Array.isArray(node.items)) {
    for (const [i, sub] of node.items.entries()) checkStrict(sub, `${at}.items[${i}]`, where);
  } else checkStrict(node.items, `${at}.items`, where);
  for (const kw of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = node[kw];
    if (!Array.isArray(list)) continue;
    for (const [i, sub] of list.entries()) checkStrict(sub, `${at}.${kw}[${i}]`, where);
  }
}

/** One registry from checked definitions; a built-in name or a name given twice is rejected. */
export function makeToolRegistry(entries: Array<{ tool: unknown; where: string }>): ToolRegistry {
  const out = new Map<string, ToolDef>();
  const from = new Map<string, string>();
  for (const { tool, where } of entries) {
    const def = checkToolDef(tool, where);
    if (BUILTIN_NAMES.has(def.name)) invalid(where, `"${def.name}" is a built-in tool name`);
    const first = from.get(def.name);
    if (first !== undefined) invalid(where, `"${def.name}" is already defined by ${first}`);
    out.set(def.name, def);
    from.set(def.name, where);
  }
  return out;
}

/**
 * The definitions in `dir`: every *.js / *.mjs file directly inside it, in name order, except names
 * starting with "_" or "." (helpers a tool file may import). A missing directory has none. The import
 * URL carries the file's mtime, so a long-lived process (maestro mcp) picks up an edited tool file.
 */
export async function loadToolsDir(dir: string): Promise<Array<{ tool: unknown; where: string }>> {
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && TOOL_FILE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: Array<{ tool: unknown; where: string }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const where = `tools/${name}`;
    let mod: Obj;
    try {
      const { mtimeMs } = await fs.stat(file);
      mod = await import(`${pathToFileURL(file).href}?mtime=${mtimeMs}`);
    } catch (e) {
      invalid(where, `cannot load: ${(e as Error)?.message ?? String(e)}`);
    }
    if (mod.default === undefined) invalid(where, 'no default export (export default { name, ... })');
    const defs = Array.isArray(mod.default) ? mod.default : [mod.default];
    for (const tool of defs) out.push({ tool, where });
  }
  return out;
}

/** The registry of one run: RunOptions.tools first, then the files of toolsDir. */
export async function loadCustomTools(opts: { tools?: ToolDef[]; toolsDir: string }): Promise<ToolRegistry> {
  const given = (opts.tools ?? []).map((tool, i) => ({ tool, where: `tools[${i}]` }));
  return makeToolRegistry([...given, ...(await loadToolsDir(opts.toolsDir))]);
}
