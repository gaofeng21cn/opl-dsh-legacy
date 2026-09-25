/** OPL request routing across the official Messages and OpenAI adapters. */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Selectable route that always uses the Codex-group OpenAI channel. */
export const OPENAI_PROVIDER = 'opl-gateway-openai'

const FAILOVER_CODES = new Set(['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'HTTP_404', 'HTTP_405', 'MISSING_CREDENTIAL'])

/** Advertise only capabilities shared by both transports. */
function commonModel(model: LlmResolvedModelInfo): LlmResolvedModelInfo {
  const { systemPromptUpdate: _update, ...common } = model
  return common
}

/**
 * Default to Messages; fail over once only before any chunk escapes to DSH.
 * An explicit OpenAI route bypasses Messages. Each prepared call freezes both
 * adapters' connection settings, and cancellation never triggers failover.
 */
export class DualChannelAdapter extends LlmAdapter {
  constructor(
    private readonly primary: LlmAdapter,
    private readonly compatibility: LlmAdapter,
    private readonly onChannel: (channel: 'deepseek' | 'codex') => void,
    private readonly onFallback: (code: string) => void,
  ) { super() }

  override providerInfo(provider: string) {
    return { id: provider, name: provider === OPENAI_PROVIDER ? 'OPL Gateway · OpenAI' : 'OPL Gateway' }
  }

  override providerRetryPolicy(provider: string) { return this.primary.providerRetryPolicy(provider) }

  override async listModels(provider: string) {
    return (await this.primary.listModels(provider)).map(commonModel)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return commonModel(await this.primary.resolveModel(provider, model, signal))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const primary = await this.primary.prepareCall(provider, model, signal)
    const compatibility = await this.compatibility.prepareCall(OPENAI_PROVIDER, model, signal)
    return {
      model: commonModel(primary.model),
      stream: options => this.dispatch(options, primary, compatibility),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = await this.prepareCall(options.provider, options.model, options.signal)
    yield* call.stream(options)
  }

  private async *dispatch(
    options: GenerateOptions, primary: PreparedAdapterCall, compatibility: PreparedAdapterCall,
  ): AsyncIterable<StreamChunk> {
    if (options.provider !== OPENAI_PROVIDER) {
      let emitted = false
      try {
        for await (const chunk of primary.stream(options)) {
          if (!emitted && chunk.type === 'finish' && chunk.reason.kind === 'error') {
            throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code)
          }
          emitted = true
          this.onChannel('deepseek')
          yield chunk
        }
        return
      } catch (error) {
        if (emitted || options.signal?.aborted || !(error instanceof LlmError) || !FAILOVER_CODES.has(error.code)) throw error
        this.onFallback(error.code)
      }
    }
    options.signal?.throwIfAborted()
    for await (const chunk of compatibility.stream({ ...options, provider: OPENAI_PROVIDER })) {
      this.onChannel('codex')
      yield chunk
    }
  }
}
