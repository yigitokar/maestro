// Tool adapter: the Workflow tool a harness hands to its main agent (Anthropic tool-use shape),
// plus the handler that starts a run and reports completion out of band. Policy (when to use the
// tool) lives in the description text; capability lives in the engine (spec Seviye 2, Policy row).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { parseScript } from './runtime.js';
import { type RunOptions, run } from './workflow.js';

export const WORKFLOW_TOOL_NAME = 'Workflow';

export const WORKFLOW_TOOL_DESCRIPTION = `Run a deterministic multi-agent workflow script. Control flow lives in the script; judgment lives in the agents it calls.

Use it only when the user asked for multi-agent orchestration, or when the work clearly needs it: a sweep too large for one context (a 400-file audit, a 60-call-site migration), or findings that must be adversarially verified by independent agents before you rely on them. Do not use it for a handful of tool calls, a single lookup, or anything you can finish yourself; every agent costs tokens.

The script is plain JavaScript (no TypeScript) and must start with a pure-literal meta block (no variables, calls, spreads or template interpolation):
  export const meta = { name: 'review-changes', description: 'one line', phases: [{ title: 'Find' }, { title: 'Verify' }], maxAgents: 60 }
The body may use top-level await and return; its return value is the run result. Globals: agent(prompt, opts) → value | null, parallel(thunks) (barrier, never rejects; a throwing thunk becomes null), pipeline(items, ...stages) (no barrier; the default for multi-stage work), phase(title), log(message), args, budget { total, spent(), remaining() }, workflow(nameOrRef, args) (one nesting level). Date.now(), Math.random() and argless new Date() throw: they would break resume. Pass timestamps via args.
agent opts: label, phase, schema (JSON Schema with root type object; returns the validated object), model, effort ('low'|'medium'|'high'|'xhigh'|'max'), isolation: 'worktree', tools. Write tools (write_file, edit_file, shell, git_commit) require isolation: 'worktree'; a writer commits to the branch wf/<runId>/<label> that the runtime opens and gets branchName added to its result.

Give the script inline in "script" (preferred), or "scriptPath", or a registered "name" (.maestro/workflows/<name>.js): exactly one. "args" is the JSON-encoded value the script sees as args. The call returns a runId at once; the result arrives later. To edit and re-run cheaply, pass the edited script with "resumeFromRunId": unchanged agent() calls return their journaled results.`;

/** Input as the model sends it. Under strict mode every field is present and absent ones are null. */
export interface WorkflowToolInput {
  script?: string | null;
  scriptPath?: string | null;
  name?: string | null;
  /** JSON-encoded args (strict schemas cannot express "any JSON"); a non-string value is taken as is. */
  args?: unknown;
  resumeFromRunId?: string | null;
}

export type WorkflowOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export interface WorkflowToolContext
  extends Omit<RunOptions, 'script' | 'scriptPath' | 'name' | 'args' | 'resumeFromRunId'> {
  /** Called once when the run settles, so the harness can hand the result back to the model. */
  onComplete?(runId: string, outcome: WorkflowOutcome): void;
}

export type WorkflowToolResult =
  | { runId: string; scriptPath: string; status: 'started' }
  | { is_error: true; content: string };

const nullableString = (description: string) => ({ type: ['string', 'null'], description });

/** The Workflow tool definition for `tools: [...]` (strict, additionalProperties false). */
export function maestroToolDefinition(): Anthropic.Tool {
  return {
    name: WORKFLOW_TOOL_NAME,
    description: WORKFLOW_TOOL_DESCRIPTION,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        script: nullableString('Inline workflow script source starting with export const meta = {...}.'),
        scriptPath: nullableString('Path to a workflow script file, relative to the working directory.'),
        name: nullableString('Name of a registered workflow in .maestro/workflows/<name>.js.'),
        args: nullableString('JSON-encoded value passed verbatim to the script as args.'),
        resumeFromRunId: nullableString(
          'runId of an earlier run to resume; unchanged agent() calls are cached.',
        ),
      },
      required: ['script', 'scriptPath', 'name', 'args', 'resumeFromRunId'],
      additionalProperties: false,
    },
  } as Anthropic.Tool;
}

function present(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message);
  return String(err);
}

/**
 * Starts the run and returns at once with its runId; the run continues in the background and
 * `ctx.onComplete` receives the outcome. Invalid input, a missing or impure meta block and syntax
 * errors come back as `{ is_error: true, content }` (a tool_result error), never as a throw.
 */
export async function handleWorkflowToolCall(
  input: unknown,
  ctx: WorkflowToolContext = {},
): Promise<WorkflowToolResult> {
  const fail = (content: string): WorkflowToolResult => ({ is_error: true, content });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('input must be an object');
  const inp = input as WorkflowToolInput;
  const sources = (['script', 'scriptPath', 'name'] as const).filter((k) => present(inp[k]));
  const resume = present(inp.resumeFromRunId) ? inp.resumeFromRunId : undefined;
  if (sources.length > 1)
    return fail(`give exactly one of script, scriptPath, name (got ${sources.join(', ')})`);
  if (sources.length === 0 && !resume) return fail('give exactly one of script, scriptPath, name');

  let args: unknown;
  if (typeof inp.args === 'string') {
    if (inp.args.trim() !== '') {
      try {
        args = JSON.parse(inp.args);
      } catch (err) {
        return fail(`args is not valid JSON: ${errorText(err)}`);
      }
    }
  } else if (inp.args !== null && inp.args !== undefined) {
    args = inp.args;
  }

  const cwd = ctx.cwd ?? process.cwd();
  const stateDir = ctx.stateDir ?? path.join(cwd, '.maestro');
  let script: string | undefined;
  try {
    if (present(inp.script)) script = inp.script;
    else if (present(inp.scriptPath)) script = await fs.readFile(path.resolve(cwd, inp.scriptPath), 'utf8');
    else if (present(inp.name)) {
      if (!/^[A-Za-z0-9._-]+$/.test(inp.name) || inp.name.startsWith('.'))
        return fail(`invalid workflow name: ${inp.name}`);
      const dir = ctx.workflowsDir ?? path.join(stateDir, 'workflows');
      script = await fs.readFile(path.join(dir, `${inp.name}.js`), 'utf8');
    }
  } catch (err) {
    return fail(`cannot read workflow script: ${errorText(err)}`);
  }
  if (script !== undefined) {
    try {
      parseScript(script);
    } catch (err) {
      return fail(`invalid workflow script: ${errorText(err)}`);
    }
  }

  const { onComplete, ...runOpts } = ctx;
  let handle: ReturnType<typeof run>;
  try {
    handle = run({ ...runOpts, cwd, stateDir, script, args, resumeFromRunId: resume });
  } catch (err) {
    return fail(errorText(err));
  }
  handle.promise.then(
    (result) => onComplete?.(handle.runId, { ok: true, result }),
    (err) => onComplete?.(handle.runId, { ok: false, error: errorText(err) }),
  );
  return { runId: handle.runId, scriptPath: path.join(handle.runDir, 'script.js'), status: 'started' };
}

/** Wraps a handler result as the tool_result block to send back to the model. */
export function toToolResultBlock(
  toolUseId: string,
  res: WorkflowToolResult,
): Anthropic.ToolResultBlockParam {
  if ('is_error' in res)
    return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: res.content };
  return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(res) };
}
