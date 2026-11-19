// Direct Gemini Developer API. Only the tools supplied by Maestro can run.
import { checkPdfInputs } from './pdf-input.js';
import { RunState, validateValue } from './runner.js';
import {
  type AgentRunner,
  LIMITS,
  MaestroError,
  type RunRequest,
  type RunResult,
  type Usage,
} from './types.js';

export interface GeminiRunnerOptions {
  /** Defaults to GEMINI_API_KEY. */
  apiKey?: string;
  maxTurns?: number;
  maxTokens?: number;
}

interface FunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

interface Part {
  text?: string;
  inlineData?: { mimeType: 'application/pdf'; data: string };
  thought?: boolean;
  functionCall?: FunctionCall;
  functionResponse?: { id?: string; name: string; response: { output: string } | { error: string } };
}

interface Content {
  role: 'model' | 'user';
  parts: Part[];
}

interface GenerateResponse {
  candidates?: Array<{ finishReason?: string; finishMessage?: string; content?: Content }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
}

function usageOf(u: GenerateResponse['usageMetadata']): Usage {
  return {
    input_tokens:
      Math.max(0, (u?.promptTokenCount ?? 0) - (u?.cachedContentTokenCount ?? 0)) +
      (u?.toolUsePromptTokenCount ?? 0),
    output_tokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cache_read_input_tokens: u?.cachedContentTokenCount,
  };
}

async function callTool(req: RunRequest, st: RunState, call: FunctionCall): Promise<Part> {
  const { id, name, args = {} } = call;
  const audit = st.toolCall(name, args);
  const tool = req.tools.find((t) => t.name === name);
  let response: NonNullable<Part['functionResponse']>['response'];
  try {
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const errors = validateValue(tool.inputSchema, args);
    if (errors.length) throw new Error(`Invalid tool arguments: ${errors.join(', ')}`);
    req.onProgress?.({ activity: 'tool', summary: `Running ${name}`, tool: name, turns: st.turns });
    response = { output: await tool.run(args, { cwd: req.cwd, signal: req.signal }) };
    audit.ok = true;
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  return { functionResponse: { id, name, response } };
}

export class GeminiRunner implements AgentRunner {
  readonly #apiKey: string;
  readonly maxTurns: number;
  readonly maxRequestTokens: number;

  constructor(opts: GeminiRunnerOptions = {}) {
    this.#apiKey = (opts.apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    this.maxTurns = opts.maxTurns ?? LIMITS.maxTurns;
    this.maxRequestTokens = opts.maxTokens ?? LIMITS.maxTokensPerTurn;
  }

  async run(req: RunRequest): Promise<RunResult> {
    if (!req.isolated && req.tools.some((t) => t.write)) {
      throw new MaestroError("write tools require isolation: 'worktree'", 'write_tool_without_isolation');
    }
    const st = new RunState(req);
    try {
      req.signal.throwIfAborted();
      checkPdfInputs(req.pdfs, true);
      if (!this.#apiKey)
        return st.fail('GEMINI_API_KEY is missing or blank. Set it or pass apiKey to GeminiRunner.');
      const model = /^(?:(?:google|models)\/)?(gemini-[a-z0-9][a-z0-9.-]*)$/i.exec(req.model.trim())?.[1];
      if (!model)
        return st.fail(
          'Gemini requires a gemini-* model ID. Set --model, run({ model }), or agent opts.model.',
        );
      return await this.generate(req, st, model);
    } catch (error) {
      if (req.signal.aborted) return st.done(null, 'skipped', { error: 'aborted' });
      const message = error instanceof Error ? error.message : String(error);
      return st.fail(message.replaceAll(this.#apiKey, '[REDACTED]'));
    }
  }

  private async generate(req: RunRequest, st: RunState, model: string): Promise<RunResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const documents: Part[] = (req.pdfs ?? []).map((data) => ({
      inlineData: { mimeType: 'application/pdf', data },
    }));
    const contents: Content[] = [{ role: 'user', parts: [...documents, { text: req.prompt }] }];
    const functions = req.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      parametersJsonSchema: inputSchema,
    }));
    // Use a separate structured response after tool use, since some models cannot combine them.
    let formatting = !!req.schema && functions.length === 0;
    let formatRetried = false;
    while (st.turns < this.maxTurns) {
      req.signal.throwIfAborted();
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'x-goog-api-key': this.#apiKey, 'content-type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          generationConfig: {
            maxOutputTokens: this.maxRequestTokens,
            ...(formatting
              ? { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: req.schema } } }
              : {}),
          },
          ...(functions.length && !formatting ? { tools: [{ functionDeclarations: functions }] } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(
          `Gemini API error ${response.status}: ${body?.error?.message ?? response.statusText}`,
        );
      }
      const reply = (await response.json()) as GenerateResponse;
      st.turn(usageOf(reply.usageMetadata));
      const candidate = reply.candidates?.[0];
      const content = candidate?.content;
      const text = (content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? '')
        .join('');
      // Keep the public findings in the trace. The formatter's JSON is already in result or raw.
      if (text && (!formatting || functions.length === 0)) st.finalText = text;
      if (candidate?.finishReason !== 'STOP' || !content?.parts?.length) {
        const reason = candidate?.finishReason ?? reply.promptFeedback?.blockReason ?? 'missing candidate';
        const detail = candidate?.finishMessage?.replaceAll(this.#apiKey, '[REDACTED]');
        const error = `Gemini returned no complete answer (${reason})${detail ? `: ${detail}` : ''}`;
        req.log(error);
        return st.done(null, 'null', { error, raw: text || undefined });
      }
      // Replay full model parts verbatim, including the thought signatures needed for later tool calls.
      contents.push(content);
      const calls = content.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
      if (calls.length) {
        if (formatting) return st.fail('Gemini called a tool during structured output');
        if (st.turns >= this.maxTurns) break;
        const parts: Part[] = [];
        for (const call of calls) {
          req.signal.throwIfAborted();
          parts.push(await callTool(req, st, call));
        }
        contents.push({ role: 'user', parts });
        continue;
      }
      if (!text) return st.fail('Gemini returned no public answer');
      if (!req.schema) return st.done(text, 'ok');
      if (!formatting) {
        formatting = true;
        contents.push({
          role: 'user',
          parts: [{ text: 'Return your findings in the required JSON schema.' }],
        });
        continue;
      }
      let issue: string;
      try {
        const value: unknown = JSON.parse(text);
        const errors = validateValue(req.schema, value);
        if (!errors.length) return st.done(value, 'ok');
        issue = errors.join(', ');
      } catch {
        issue = 'invalid JSON';
      }
      if (formatRetried || st.turns >= this.maxTurns) {
        const error = `Gemini schema validation failed: ${issue}`;
        req.log(error);
        return st.done(null, 'null', { raw: text, error });
      }
      formatRetried = true;
      contents.push({ role: 'user', parts: [{ text: `Correct the JSON response: ${issue}` }] });
    }
    return st.fail(`turn cap: ${this.maxTurns} turns used`);
  }
}
