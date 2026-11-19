// Mixed-model runner: routes each agent() call to AnthropicRunner, GeminiRunner or CodexRunner based on
// req.model (or a caller-supplied route function), so one workflow script can pair e.g. Gemini ingestion,
// Codex finders and a Claude Opus judge under one shared journal, scheduler, budget and worktree pool.

import { CodexRunner, type CodexRunnerOptions } from './codex-runner.js';
import { GeminiRunner, type GeminiRunnerOptions } from './gemini-runner.js';
import { AnthropicRunner, type AnthropicRunnerOptions } from './runner.js';
import type { AgentRunner, RunRequest, RunResult } from './types.js';

export type RouteTarget = 'anthropic' | 'codex' | 'gemini' | AgentRunner;

export interface RoutingRunnerOptions {
  /** Pre-built runner or options for `AnthropicRunner` (built lazily on first `anthropic` route). */
  anthropic?: AgentRunner | AnthropicRunnerOptions;
  /** Pre-built runner or options for `CodexRunner` (built lazily on first `codex` route). */
  codex?: AgentRunner | CodexRunnerOptions;
  /** Pre-built runner or options for `GeminiRunner` (built lazily on first `gemini` route). */
  gemini?: AgentRunner | GeminiRunnerOptions;
  /**
   * Custom model router. Default: `claude-*` / `anthropic/*` → `'anthropic'`,
   * `gemini-*` / `gemma-*` / `google/*` → `'gemini'`, everything else → `'codex'`.
   */
  route?: (model: string, req: RunRequest) => RouteTarget;
}

function isAgentRunner(v: unknown): v is AgentRunner {
  return v !== null && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'function';
}

export function defaultModelRoute(model: string): 'anthropic' | 'codex' | 'gemini' {
  const trimmed = model.trim();
  if (/^(?:claude-|anthropic\/)/i.test(trimmed)) return 'anthropic';
  if (/^(?:gemini-|gemma-|google\/)/i.test(trimmed)) return 'gemini';
  return 'codex';
}

export class RoutingRunner implements AgentRunner {
  #anthropic: AgentRunner | undefined;
  #codex: AgentRunner | undefined;
  #gemini: AgentRunner | undefined;
  readonly #anthropicOpts: AnthropicRunnerOptions | undefined;
  readonly #codexOpts: CodexRunnerOptions | undefined;
  readonly #geminiOpts: GeminiRunnerOptions | undefined;
  readonly #route: (model: string, req: RunRequest) => RouteTarget;
  readonly maxRequestTokens: number | undefined;

  constructor(opts: RoutingRunnerOptions = {}) {
    let maxReq: number | undefined;
    const recordMax = (v: number | undefined) => {
      if (v !== undefined) maxReq = maxReq === undefined ? v : Math.max(maxReq, v);
    };
    if (isAgentRunner(opts.anthropic)) {
      this.#anthropic = opts.anthropic;
      if (opts.anthropic instanceof AnthropicRunner) {
        recordMax(opts.anthropic.maxRequestTokens);
      }
    } else {
      this.#anthropicOpts = opts.anthropic;
      if (opts.anthropic?.maxTokens !== undefined) {
        recordMax(new AnthropicRunner(opts.anthropic).maxRequestTokens);
      }
    }
    if (isAgentRunner(opts.codex)) this.#codex = opts.codex;
    else this.#codexOpts = opts.codex;
    if (isAgentRunner(opts.gemini)) {
      this.#gemini = opts.gemini;
      if (opts.gemini instanceof GeminiRunner) {
        recordMax(opts.gemini.maxRequestTokens);
      }
    } else {
      this.#geminiOpts = opts.gemini;
      if (opts.gemini?.maxTokens !== undefined) {
        recordMax(new GeminiRunner(opts.gemini).maxRequestTokens);
      }
    }
    this.maxRequestTokens = maxReq;
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

  private getGemini(): AgentRunner {
    this.#gemini ??= new GeminiRunner(this.#geminiOpts);
    return this.#gemini;
  }

  resolveRunner(req: RunRequest): AgentRunner {
    const target = this.#route(req.model, req);
    if (target === 'anthropic') return this.getAnthropic();
    if (target === 'codex') return this.getCodex();
    if (target === 'gemini') return this.getGemini();
    return target;
  }

  run(req: RunRequest): Promise<RunResult> {
    return this.resolveRunner(req).run(req);
  }
}
