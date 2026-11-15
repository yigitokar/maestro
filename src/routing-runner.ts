// Mixed-model runner: routes each agent() call to AnthropicRunner or CodexRunner based on req.model
// (or a caller-supplied route function), so one workflow script can pair e.g. GPT/Codex finders with a
// Claude Opus judge under one shared journal, scheduler, budget and worktree isolation pool.

import { CodexRunner, type CodexRunnerOptions } from './codex-runner.js';
import { AnthropicRunner, type AnthropicRunnerOptions } from './runner.js';
import type { AgentRunner, RunRequest, RunResult } from './types.js';

export type RouteTarget = 'anthropic' | 'codex' | AgentRunner;

export interface RoutingRunnerOptions {
  /** Pre-built runner or options for `AnthropicRunner` (built lazily on first `anthropic` route). */
  anthropic?: AgentRunner | AnthropicRunnerOptions;
  /** Pre-built runner or options for `CodexRunner` (built lazily on first `codex` route). */
  codex?: AgentRunner | CodexRunnerOptions;
  /** Custom model router. Default: `claude-*` (and `anthropic/*`) → `'anthropic'`, everything else → `'codex'`. */
  route?: (model: string, req: RunRequest) => RouteTarget;
}

function isAgentRunner(v: unknown): v is AgentRunner {
  return v !== null && typeof v === 'object' && typeof (v as { run?: unknown }).run === 'function';
}

export function defaultModelRoute(model: string): 'anthropic' | 'codex' {
  return /^(?:claude-|anthropic\/)/i.test(model.trim()) ? 'anthropic' : 'codex';
}

export class RoutingRunner implements AgentRunner {
  #anthropic: AgentRunner | undefined;
  #codex: AgentRunner | undefined;
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
    return target;
  }

  run(req: RunRequest): Promise<RunResult> {
    return this.resolveRunner(req).run(req);
  }
}
