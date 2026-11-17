import Anthropic from '@anthropic-ai/sdk';
import { AnthropicRunner, type AnthropicRunnerOptions } from './runner.js';
import type { RunRequest, RunResult } from './types.js';

export interface GatewayRunnerOptions extends Omit<AnthropicRunnerOptions, 'client'> {
  /** Vercel AI Gateway key. Defaults only to AI_GATEWAY_API_KEY; blank keys are rejected. */
  apiKey?: string;
}

/** Anthropic Messages protocol via Vercel AI Gateway, with explicit provider/model routing. */
export class GatewayRunner extends AnthropicRunner {
  #gatewayClient: Anthropic | undefined;
  readonly #apiKey: string;

  constructor(opts: GatewayRunnerOptions = {}) {
    super({ ...opts, client: undefined, structuredMode: opts.structuredMode ?? 'submit-tool' });
    this.#apiKey = (opts.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? '').trim();
  }

  /** Keep construction lazy so MCP can start without credentials and dry runs need none. */
  override get client(): Anthropic {
    if (!this.#apiKey) {
      throw new Error(
        'AI_GATEWAY_API_KEY is missing or blank. Set it or pass apiKey to GatewayRunner; use --dry-run for offline runs.',
      );
    }
    this.#gatewayClient ??= new Anthropic({
      apiKey: this.#apiKey,
      authToken: null,
      baseURL: 'https://ai-gateway.vercel.sh',
      // Do not inherit ANTHROPIC_LOG: request logging can expose Gateway credentials.
      logLevel: 'off',
    });
    return this.#gatewayClient;
  }

  override async run(req: RunRequest): Promise<RunResult> {
    if (!req.signal.aborted && !/^[^/\s]+\/[^/\s]+$/.test(req.model)) {
      throw new Error(
        'Gateway requires an explicit provider/model ID. Set --model, run({ model }), or agent opts.model ' +
          '(for example openai/gpt-5.4); the default direct Claude model is not a Gateway ID.',
      );
    }
    // A remote error may echo credentials; keep them out of logs and persisted error diagnostics.
    const redact = (text: string) => (this.#apiKey ? text.replaceAll(this.#apiKey, '[REDACTED]') : text);
    const result = await super.run({ ...req, log: (message) => req.log(redact(message)) });
    if (result.error !== undefined) result.error = redact(result.error);
    return result;
  }
}
