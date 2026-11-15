// Script runtime (spec 3.3): parse the pure-literal `meta` block, run the workflow body in a vm context
// whose only globals are the host API, and override the non-deterministic builtins inside that context.
// `vm` is a narrow global, not a security boundary (spec 3.3). Values thrown inside the context are
// context-realm objects, so nothing here relies on host `instanceof` for them.

import vm from 'node:vm';
import { parse } from 'acorn';
import { assertSatisfiableSchema } from './schema.js';
import type { AgentOpts, BudgetView, WorkflowMeta } from './types.js';
import { LIMITS, MaestroError } from './types.js';

export interface ParsedScript {
  meta: WorkflowMeta;
  /** The source with `export const meta` turned into `const meta` (same lines and columns). */
  body: string;
  source: string;
}

export interface HostHooks {
  agent(prompt: string, opts?: AgentOpts): Promise<unknown>;
  log(message: string): void;
  /** Called after the title passed validation. */
  onPhase?(title: string): void;
  workflow(ref: string | { scriptPath: string }, args?: unknown): Promise<unknown>;
  budget: BudgetView;
  /** Default: LIMITS.maxItemsPerCall. */
  checkItems?(count: number, where: 'parallel' | 'pipeline'): void;
  /**
   * Called when parallel()/pipeline() turns a throw (or a non-function slot/stage) into null, so the host
   * can log how many items dropped (spec Seviye 1 "kaç öğe düştüğünü log() ile söyler", Seviye 4 "No silent caps").
   */
  onSwallowed?(where: 'parallel' | 'pipeline', index: number, error: unknown): void;
}

type CheckItems = (count: number, where: 'parallel' | 'pipeline') => void;
type OnSwallowed = (where: 'parallel' | 'pipeline', index: number, error: unknown) => void;

/** Reports a swallowed throw; a broken observer must never make parallel()/pipeline() reject. */
function reportSwallowed(
  onSwallowed: OnSwallowed | undefined,
  where: 'parallel' | 'pipeline',
  i: number,
  e: unknown,
) {
  if (!onSwallowed) return;
  try {
    onSwallowed(where, i, e);
  } catch {
    // ignore
  }
}
type Stage = (prev: unknown, item: unknown, index: number) => unknown;

const ACORN_OPTS = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  locations: true,
} as const;

function metaInvalid(why: string): never {
  throw new MaestroError(`meta_invalid: ${why}`, 'meta_invalid');
}

// ---------------------------------------------------------------------------------------------------------
// Parsing

/** Parses a workflow script. Throws acorn's SyntaxError (with loc) or MaestroError('meta_invalid'). */
export function parseScript(source: string): ParsedScript {
  const program = parse(source, ACORN_OPTS) as any;
  const first = program.body[0];
  const decl = first?.type === 'ExportNamedDeclaration' ? first.declaration : undefined;
  const declarator = decl?.type === 'VariableDeclaration' && decl.kind === 'const' ? decl.declarations : [];
  if (
    declarator.length !== 1 ||
    declarator[0].id.type !== 'Identifier' ||
    declarator[0].id.name !== 'meta' ||
    declarator[0].init?.type !== 'ObjectExpression'
  ) {
    metaInvalid('the script must start with `export const meta = { ... }`');
  }
  const meta = validateMeta(literalValue(declarator[0].init, 'meta'));

  for (const stmt of program.body.slice(1)) {
    if (/^(Import|Export)/.test(stmt.type)) {
      metaInvalid(`line ${stmt.loc.start.line}: only \`export const meta\` may be imported/exported`);
    }
  }
  forbidModuleSyntax(program);

  // Blank out `export` (and a hashbang) with spaces so lines and columns stay identical.
  const blank = (s: string) => s.replace(/[^\n\r]/g, ' ');
  let body =
    source.slice(0, first.start) + blank(source.slice(first.start, decl.start)) + source.slice(decl.start);
  if (body.startsWith('#!')) {
    const eol = body.search(/[\n\r]|$/);
    body = blank(body.slice(0, eol)) + body.slice(eol);
  }
  return { meta, body, source };
}

/** Dynamic import() and import.meta cannot run inside the function wrapper (and would reach the FS). */
function forbidModuleSyntax(node: any): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) forbidModuleSyntax(n);
    return;
  }
  if (node.type === 'ImportExpression' || (node.type === 'MetaProperty' && node.meta?.name === 'import')) {
    metaInvalid(`line ${node.loc.start.line}: import() / import.meta are not available in workflow scripts`);
  }
  for (const key of Object.keys(node)) {
    if (key !== 'loc') forbidModuleSyntax(node[key]);
  }
}

// Spec "Meta bloğu": a pure literal, no variables, calls or spreads.
function literalValue(node: any, path: string): unknown {
  switch (node.type) {
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.computed || p.shorthand || p.method || p.kind !== 'init') {
          metaInvalid(`${path}: only plain \`key: literal\` properties are allowed`);
        }
        let key: string;
        if (p.key.type === 'Identifier') key = p.key.name;
        else if (
          p.key.type === 'Literal' &&
          (typeof p.key.value === 'string' || typeof p.key.value === 'number')
        ) {
          key = String(p.key.value);
        } else metaInvalid(`${path}: unsupported property key`);
        if (key === '__proto__') metaInvalid(`${path}: __proto__ is not allowed`);
        out[key] = literalValue(p.value, `${path}.${key}`);
      }
      return out;
    }
    case 'ArrayExpression':
      return node.elements.map((el: any, i: number) => {
        if (el === null || el.type === 'SpreadElement')
          metaInvalid(`${path}[${i}]: holes and spreads are not allowed`);
        return literalValue(el, `${path}[${i}]`);
      });
    case 'Literal':
      if (node.regex || node.bigint !== undefined)
        metaInvalid(`${path}: regex/bigint literals are not allowed`);
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length > 0) metaInvalid(`${path}: template literals may not contain expressions`);
      return node.quasis[0].value.cooked;
    case 'UnaryExpression':
      if (
        node.operator === '-' &&
        node.argument.type === 'Literal' &&
        typeof node.argument.value === 'number'
      ) {
        return -node.argument.value;
      }
      metaInvalid(`${path}: only unary minus on a number literal is allowed`);
      break;
    default:
      metaInvalid(`${path}: ${node.type} is not a pure literal`);
  }
}

export const KNOWN_META_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'phases',
  'maxAgents',
  'whenToUse',
]);

/** Keys in a parsed `meta` block that Maestro does not recognize (catches typos such as `maxAgent`). */
export function unknownMetaKeys(meta: WorkflowMeta | Record<string, unknown>): string[] {
  return Object.keys(meta).filter((k) => !KNOWN_META_KEYS.has(k));
}

// Known fields are validated; extra keys are pure literals too and pass through unchanged.
function validateMeta(v: unknown): WorkflowMeta {
  const m = v as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) metaInvalid('meta.name must be a non-empty string');
  if (typeof m.description !== 'string') metaInvalid('meta.description must be a string');
  if (m.whenToUse !== undefined && typeof m.whenToUse !== 'string')
    metaInvalid('meta.whenToUse must be a string');
  if (m.maxAgents !== undefined && !(Number.isInteger(m.maxAgents) && (m.maxAgents as number) > 0)) {
    metaInvalid('meta.maxAgents must be a positive integer');
  }
  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases)) metaInvalid('meta.phases must be an array');
    m.phases.forEach((p: unknown, i: number) => {
      const ph = p as Record<string, unknown>;
      if (typeof p !== 'object' || p === null || Array.isArray(p) || typeof ph.title !== 'string') {
        metaInvalid(`meta.phases[${i}] must be { title: string, detail?: string }`);
      }
      for (const k of Object.keys(ph)) {
        if (k !== 'title' && k !== 'detail') metaInvalid(`meta.phases[${i}]: unknown key "${k}"`);
      }
      if (ph.detail !== undefined && typeof ph.detail !== 'string') {
        metaInvalid(`meta.phases[${i}].detail must be a string`);
      }
    });
  }
  return m as unknown as WorkflowMeta;
}

// ---------------------------------------------------------------------------------------------------------
// parallel / pipeline (spec Level 1 null/throw table, ADR-2)

/**
 * Script/environment invariant codes that must reject the run even when raised inside a `parallel()` or
 * `pipeline()` slot. Agent/budget/schema slot failures (`schema_invalid`, `budget_exceeded`, `agent_cap`,
 * `run_stopped`) stay non-fatal so a single bad item or mid-run cap only nulls that slot.
 */
export const FATAL_SCRIPT_CODES: ReadonlySet<string> = new Set([
  'determinism',
  'unknown_tool',
  'unknown_phase',
  'write_tool_without_isolation',
  'nested_workflow',
  'duplicate_writer_branch',
  'item_limit',
  'journal_unwritable',
  'meta_invalid',
  'tool_invalid',
]);

/** Realm-independent check: catches programmer/invariant errors without relying on host `instanceof`. */
export function isFatalScriptError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && FATAL_SCRIPT_CODES.has(code)) return true;
  const name = (err as { name?: unknown }).name;
  return name === 'ReferenceError' || name === 'SyntaxError';
}

function defaultCheckItems(count: number, where: 'parallel' | 'pipeline'): void {
  if (count > LIMITS.maxItemsPerCall) {
    throw new MaestroError(
      `item_limit: ${where}() got ${count} items, the limit is ${LIMITS.maxItemsPerCall} per call`,
      'item_limit',
    );
  }
}

/**
 * parallel(thunks): turns per-slot runtime throws and non-function slots into null, while rethrowing
 * fatal script/environment invariant violations (`isFatalScriptError`).
 */
export function makeParallel(checkItems: CheckItems = defaultCheckItems, onSwallowed?: OnSwallowed) {
  return async function parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
    if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of functions');
    const count = thunks.length;
    checkItems(count, 'parallel');
    // Index loop, not map(): map skips holes, and a hole is a "not a function" slot that must be null.
    const slots: Promise<unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const thunk = thunks[i];
      slots.push(
        (async () => {
          try {
            if (typeof thunk !== 'function') throw new TypeError(`parallel() slot ${i} is not a function`);
            return await thunk();
          } catch (e) {
            if (isFatalScriptError(e)) throw e;
            reportSwallowed(onSwallowed, 'parallel', i, e);
            return null;
          }
        })(),
      );
    }
    return Promise.all(slots);
  };
}

/**
 * pipeline(items, ...stages): no barrier between stages; every item runs its own stage chain. Stage 1
 * gets (item, item, index), later stages (prev, item, index). A non-fatal throwing stage makes the item
 * null and skips its remaining stages; fatal script errors (`isFatalScriptError`) reject the pipeline.
 */
export function makePipeline(checkItems: CheckItems = defaultCheckItems, onSwallowed?: OnSwallowed) {
  return async function pipeline(items: unknown[], ...stages: Stage[]): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new TypeError('pipeline() expects an array of items');
    const count = items.length;
    checkItems(count, 'pipeline');
    // Index loop, not map(): every counted item (a hole included, as undefined) runs its own stage chain.
    const runs: Promise<unknown>[] = [];
    for (let index = 0; index < count; index++) {
      const item = items[index];
      runs.push(
        (async () => {
          let prev: unknown = item;
          try {
            for (const [s, stage] of stages.entries()) {
              if (typeof stage !== 'function') throw new TypeError(`pipeline() stage ${s} is not a function`);
              prev = await stage(prev, item, index);
            }
          } catch (e) {
            if (isFatalScriptError(e)) throw e;
            reportSwallowed(onSwallowed, 'pipeline', index, e);
            return null;
          }
          return prev;
        })(),
      );
    }
    return Promise.all(runs);
  };
}

// ---------------------------------------------------------------------------------------------------------
// Execution

// Spec 3.3 / determinism rule: overridden INSIDE the context, whose builtins differ from the host's.
const DETERMINISM_OVERRIDES = `(() => {
  'use strict';
  const fail = (what, hint) => {
    const e = new Error('determinism: ' + what + ' is forbidden in workflow scripts; ' + hint);
    e.code = 'determinism';
    throw e;
  };
  const CLOCK = 'pass timestamps in via args';
  Math.random = function random() { fail('Math.random()', 'vary prompts by index instead'); };
  const RealDate = Date;
  globalThis.Date = class Date extends RealDate {
    constructor(...a) { if (a.length === 0) fail('new Date() without arguments', CLOCK); super(...a); }
    static now() { fail('Date.now()', CLOCK); }
  };
  const proto = Intl.DateTimeFormat.prototype;
  const fmt = Object.getOwnPropertyDescriptor(proto, 'format');
  Object.defineProperty(proto, 'format', {
    configurable: true,
    enumerable: fmt.enumerable,
    get() {
      const bound = fmt.get.call(this);
      return (date) => { if (date === undefined) fail('Intl.DateTimeFormat#format() without a date', CLOCK); return bound(date); };
    },
  });
  const parts = proto.formatToParts;
  proto.formatToParts = function formatToParts(date) {
    if (date === undefined) fail('Intl.DateTimeFormat#formatToParts() without a date', CLOCK);
    return parts.call(this, date);
  };
  if (typeof Temporal !== 'undefined') delete Temporal.Now;
  delete globalThis.console;
})();`;

/**
 * Runs a parsed workflow script. Resolves with the script's top-level `return` value; rejects when the
 * script throws (spec null/throw table: the whole run dies).
 */
export async function runScript(
  parsed: ParsedScript,
  args: unknown,
  hooks: HostHooks,
  opts: { filename?: string } = {},
): Promise<unknown> {
  const filename = opts.filename ?? `${parsed.meta.name}.workflow.js`;
  // Compile first: a syntax error surfaces before any script code or hook runs. lineOffset -1 undoes
  // the wrapper's first line, so stack lines match the original file.
  const script = new vm.Script(`(async () => { 'use strict';\n${parsed.body}\n})()`, {
    filename,
    lineOffset: -1,
  });

  const phaseTitles = parsed.meta.phases?.map((p) => p.title);
  const checkPhase = (title: unknown, where: string): void => {
    if (phaseTitles && !phaseTitles.includes(title as string)) {
      throw new MaestroError(
        `unknown_phase: ${where} "${String(title)}" is not declared in meta.phases (${phaseTitles.join(', ')})`,
        'unknown_phase',
      );
    }
  };
  const checkItems: CheckItems = hooks.checkItems ? (n, w) => hooks.checkItems!(n, w) : defaultCheckItems;

  // Plain (non-async) so schema/phase violations throw at the call site (null/throw table).
  function agent(prompt: string, agentOpts?: AgentOpts): Promise<unknown> {
    if (typeof prompt !== 'string') throw new TypeError('agent(prompt): prompt must be a string');
    if (agentOpts !== undefined && (typeof agentOpts !== 'object' || agentOpts === null)) {
      throw new TypeError('agent(prompt, opts): opts must be an object');
    }
    if (agentOpts?.schema !== undefined) assertSatisfiableSchema(agentOpts.schema);
    if (agentOpts?.phase !== undefined) checkPhase(agentOpts.phase, 'agent opts.phase');
    return hooks.agent(prompt, agentOpts);
  }
  function phase(title: string): void {
    if (typeof title !== 'string') throw new TypeError('phase(title): title must be a string');
    checkPhase(title, 'phase');
    hooks.onPhase?.(title);
  }
  function log(message: string): void {
    hooks.log(typeof message === 'string' ? message : String(message));
  }
  function workflow(ref: string | { scriptPath: string }, wfArgs?: unknown): Promise<unknown> {
    return hooks.workflow(ref, wfArgs);
  }
  const budget: BudgetView = Object.freeze({
    get total() {
      return hooks.budget.total;
    },
    spent: () => hooks.budget.spent(),
    remaining: () => hooks.budget.remaining(),
  });

  const context = vm.createContext({
    agent,
    parallel: makeParallel(checkItems, hooks.onSwallowed?.bind(hooks)),
    pipeline: makePipeline(checkItems, hooks.onSwallowed?.bind(hooks)),
    phase,
    log,
    args,
    budget,
    workflow,
  });
  vm.runInContext(DETERMINISM_OVERRIDES, context);
  return await script.runInContext(context);
}
