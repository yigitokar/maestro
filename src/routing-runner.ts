import { CodexRunner, type CodexRunnerOptions } from './codex-runner.js';
import { GeminiRunner, type GeminiRunnerOptions } from './gemini-runner.js';
import { AnthropicRunner, type AnthropicRunnerOptions } from './runner.js';
import { type AgentRunner, LIMITS, type RunRequest, type RunResult } from './types.js';

type BuiltinTarget = 'anthropic' | 'codex' | 'gemini';
export type RouteTarget = BuiltinTarget | AgentRunner;

export interface RoutingRunnerOptions {
  /** Pre-built runner or options for `AnthropicRunner` (built lazily on first `anthropic` route). */
  anthropic?: AgentRunner | AnthropicRunnerOptions;
  /** Pre-built runner or options for `CodexRunner` (built lazily on first `codex` route). */
  codex?: AgentRunner | CodexRunnerOptions;
  /** Pre-built runner or options for the direct Gemini API. */
  gemini?: AgentRunner | GeminiRunnerOptions;
  /** Custom model router. Defaults to defaultModelRoute. */
  route?: (model: string, req: RunRequest) => RouteTarget;
}

function isAgentRunner(v: unknown): v is AgentRunner {
  return v !== null && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'function';
}

export function defaultModelRoute(model: string): BuiltinTarget {
  if (/^(?:(?:google|models)\/)?gemini-/i.test(model.trim())) return 'gemini';
  return /^(?:claude-|anthropic\/)/i.test(model.trim()) ? 'anthropic' : 'codex';
}

export class RoutingRunner implements AgentRunner {
  #anthropic: AgentRunner | undefined;
  #codex: AgentRunner | undefined;
  #gemini: AgentRunner | undefined;
  readonly #geminiOpts: GeminiRunnerOptions | undefined;
  readonly #anthropicOpts: AnthropicRunnerOptions | undefined;
  readonly #codexOpts: CodexRunnerOptions | undefined;
  readonly #route: (model: string, req: RunRequest) => RouteTarget;
  readonly maxRequestTokens: number | undefined;

  constructor(opts: RoutingRunnerOptions = {}) {
    if (isAgentRunner(opts.anthropic)) {
      this.#anthropic = opts.anthropic;
      if (opts.anthropic instanceof AnthropicRunner) {
        this.maxRequestTokens = opts.anthropic.maxRequestTokens;
      }
    } else {
      this.#anthropicOpts = opts.anthropic;
      if (opts.anthropic?.maxTokens !== undefined) {
        this.maxRequestTokens = new AnthropicRunner(opts.anthropic).maxRequestTokens;
      }
    }
    if (isAgentRunner(opts.codex)) this.#codex = opts.codex;
    else this.#codexOpts = opts.codex;
    if (isAgentRunner(opts.gemini)) this.#gemini = opts.gemini;
    else this.#geminiOpts = opts.gemini;
    const geminiMax =
      this.#gemini instanceof GeminiRunner
        ? this.#gemini.maxRequestTokens
        : (this.#geminiOpts?.maxTokens ?? LIMITS.maxTokensPerTurn);
    if (this.maxRequestTokens !== undefined || geminiMax > LIMITS.maxTokensPerTurnRaised) {
      this.maxRequestTokens = Math.max(this.maxRequestTokens ?? LIMITS.maxTokensPerTurnRaised, geminiMax);
    }
    this.#route = opts.route ?? ((model) => defaultModelRoute(model));
  }

  private getAnthropic(): AgentRunner {
    this.#anthropic ??= new AnthropicRunner(this.#anthropicOpts);
    return this.#anthropic;
  }

  private getCodex(): AgentRunner {
    this.#codex ??= new CodexRunner(this.#codexOpts);
    return this.#codex;
  }

  resolveRunner(req: RunRequest): AgentRunner {
    const target = this.#route(req.model, req);
    if (target === 'anthropic') return this.getAnthropic();
    if (target === 'codex') return this.getCodex();
    if (target === 'gemini') {
      this.#gemini ??= new GeminiRunner(this.#geminiOpts);
      return this.#gemini;
    }
    return target;
  }

  run(req: RunRequest): Promise<RunResult> {
    return this.resolveRunner(req).run(req);
  }
}
