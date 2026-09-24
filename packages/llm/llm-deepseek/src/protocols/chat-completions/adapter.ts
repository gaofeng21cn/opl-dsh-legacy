/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-deepseek/adapter
 */

import { attributionHeaders, contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmTransportStage,
  PreparedAdapterCall,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {
  DeepSeekLlmApiJson,
} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { serializeRequest, serializeRequestWithImages } from './serialize.ts'
import { deepSeekImageRequestPricing, resolveRequestImageTarget } from '../../common/request-pricing.ts'
import { catalogModelInfo, modelInfo } from '../../common/model-info.ts'
import { attemptAnomaly, controlMarkerFamilies, describeAttemptAnomaly, WireObserver } from '../../common/protocol-anomaly.ts'
import type { AttemptFacts } from '../../common/protocol-anomaly.ts'
import type { DeepSeekAdapterOptions, DeepSeekCatalogModel, DeepSeekConnectionOptions } from '../../common/types.ts'
import type { DeepSeekFileStore } from '../../common/file-store.ts'
import { FileResolutionFailure, RequestFiles } from '../../common/request-files.ts'
import { prepareRequestExtensions } from '../../common/request-extensions.ts'
import { parseSse, DONE } from './sse.ts'
import { translate } from './translate.ts'
import { ReasoningTrace } from './reasoning-trace.ts'
import type { WireError, WireRequest } from './types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

function collectImageRefs(
  content: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of content) {
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

async function prepareRequestImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  model: DeepSeekCatalogModel,
  signal: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const projected = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal),
  ))
  return new Map(orderedRefs.map((ref, index) => (
    [ref.attachmentId, projected[index] as RequestImageAttachment]
  )))
}



/**
 * Describe a transport failure without carrying anything sensitive.
 *
 * `fetch` rejects with a wrapper (`TypeError: fetch failed`) whose `cause` holds
 * the platform error; without unwrapping it every network fault, DNS failure,
 * and TLS refusal reads as one identical `TRANSPORT` line. Only the error
 * `name` and the errno-style `code` are copied, because those are a fixed
 * vocabulary: the message can embed the endpoint, a header, or a credential.
 * @param error - the value `fetch` rejected with.
 * @param stage - which request phase the caller observed the failure in.
 * @returns the diagnostic fields to attach to the `TRANSPORT` failure.
 */
export function transportDiagnostics(
  error: unknown,
  stage: LlmTransportStage,
): { transportStage: LlmTransportStage; causeName?: string; causeCode?: string } {
  // Undici nests the platform error one level down; a native abort or a direct
  // throw has no cause at all.
  const cause = error instanceof Error && error.cause !== undefined && error.cause !== null
    ? error.cause
    : error
  const causeName = cause instanceof Error && cause.name.length > 0 ? cause.name : undefined
  const rawCode = typeof cause === 'object' && cause !== null
    ? (cause as { code?: unknown }).code
    : undefined
  const causeCode = typeof rawCode === 'string' && rawCode.length > 0
    ? rawCode
    : typeof rawCode === 'number' && Number.isFinite(rawCode) ? String(rawCode) : undefined
  return {
    transportStage: stage,
    ...causeName === undefined ? {} : { causeName },
    ...causeCode === undefined ? {} : { causeCode },
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class ChatCompletionsAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly config: DeepSeekAdapterOptions & { resolveFiles: () => DeepSeekFileStore }) {
    super()
    this.files = config.resolveFiles()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override imageRequestPricing(_provider: string, model: string): ReturnType<LlmAdapter['imageRequestPricing']> {
    // The same access resolution the serializer uses, so priced handle and
    // placeholder text matches what the request actually sends.
    const attachments = this.config.resolveAttachments?.()
    const resolveAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => (
        this.config.resolveImageAccess?.(attachments, ref)
      )
    return deepSeekImageRequestPricing(this.config.options(), model, resolveAccess)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => catalogModelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(this.config.options(), provider, model))
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: modelInfo(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: DeepSeekConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      const model = connection.models.find(entry => entry.id === options.model)
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `DeepSeek model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          'DeepSeek image conversion requires the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      attachments,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `DeepSeek API stream from ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error, ...transportDiagnostics(error, 'response-body') },
      )
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const trace = ReasoningTrace.open()
    try {
      for await (const chunk of this.requestObserved(options, signal, connection, apiKey, userId, attachments, onActivity, trace)) {
        trace?.safely(() => { trace.chunk(chunk) })
        yield chunk
      }
    } finally {
      trace?.safely(() => { trace.close() })
    }
  }

  private async * requestObserved(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
    trace: ReasoningTrace | undefined,
  ): AsyncIterable<StreamChunk> {
    // One observer per attempt, and none at all when no sink is configured:
    // with no consumer, tapping the raw payloads would cost a second parse of
    // every chunk to build a report nobody reads.
    const wire = this.config.onProtocolAnomaly === undefined ? undefined : new WireObserver()
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }

    const fileConnection = { baseURL: connection.baseURL, apiKey, protocol: connection.protocol }
    const model = connection.models.find(entry => entry.id === options.model)
    const resolveImageAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => this.config.resolveImageAccess?.(attachments, ref)
    const imageAccessOptions = resolveImageAccess === undefined ? {} : { resolveImageAccess }
    const requestOptions = options
    const requestImages = attachments === undefined || model === undefined
      ? new Map<AttachmentId, RequestImageAttachment>()
      : await prepareRequestImages(requestOptions, attachments, model, signal)
    let representation: 'file' | 'base64' = 'file'
    const requestFiles = new RequestFiles(
      this.files, fileConnection, connection.filePolicy, connection.filesApiTimeoutMs, signal, onActivity,
    )
    while (true) {
      requestFiles.beginAttempt()
      let body: WireRequest
      if (attachments === undefined) {
        body = serializeRequest(requestOptions, connection.defaults)
      } else if (representation === 'base64') {
        body = await serializeRequestWithImages(requestOptions, {
          representation: { kind: 'base64' },
          requestImages,
          ...imageAccessOptions,
          maxRequestImageBytes: connection.maxInlineRequestImageBytes,
          maxImagesPerRequest: connection.maxImagesPerRequest,
          byteQuantum: connection.inlineImageOffloadByteQuantum,
          countQuantum: connection.imageOffloadCountQuantum,
        }, connection.defaults)
      } else {
        try {
          body = await serializeRequestWithImages(requestOptions, {
            representation: {
              kind: 'file',
              resolveFileId: (version, _block, location) => requestFiles.resolve(version, location),
            },
            requestImages,
            ...imageAccessOptions,
            maxRequestImageBytes: connection.maxRequestFilesBytes,
            maxImagesPerRequest: connection.maxImagesPerRequest,
            byteQuantum: connection.imageOffloadByteQuantum,
            countQuantum: connection.imageOffloadCountQuantum,
          }, connection.defaults)
        } catch (error: unknown) {
          if (!(error instanceof FileResolutionFailure)) throw error
          representation = 'base64'
          continue
        }
      }
      const extensions = await prepareRequestExtensions(body as unknown as Readonly<Record<string, DeepSeekLlmApiJson>>, {
        signal,
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        ...options.purpose === undefined ? {} : { purpose: options.purpose },
      }, this.config.prepareExtensions)
      trace?.safely(() => { trace.request(requestOptions, JSON.parse(extensions.payload) as WireRequest) })

      // TODO(http): adopt the Cordis HTTP service when shared transport configuration
      // outweighs its additional runtime dependencies.
      let response: Response
      try {
        response = await fetch(`${connection.baseURL}/chat/completions`, {
          method: 'POST',
          headers,
          body: extensions.payload,
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(
          `DeepSeek API request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error, ...transportDiagnostics(error, 'request') },
        )
      }

      trace?.safely(() => { trace.response(response.status, requestId(response.headers)) })
      if (!response.ok) {
        let message = `DeepSeek API error (HTTP ${response.status})`
        let providerError: WireError['error']
        const rawResponse = await response.text()
        try {
          const parsed = JSON.parse(rawResponse) as WireError
          providerError = parsed.error
          if (providerError?.message) message = providerError.message
        } catch {
          // The HTTP status remains authoritative when a gateway returns malformed JSON.
        }
        const detail = [providerError?.code, providerError?.type, providerError?.message]
          .filter((field): field is string => typeof field === 'string')
          .join(' ')
        if (await requestFiles.retry(detail)) continue
        message = requestFiles.errorMessage(response.status, message, detail)
        const delay = providerRetryAfterMs(response.headers.get('retry-after'))
        const id = requestId(response.headers)
        throw new LlmError(message, httpErrorCode(response.status, providerError), {
          cause: new Error(rawResponse.length > 0 ? rawResponse : `DeepSeek HTTP ${response.status}`),
          status: response.status,
          ...delay === undefined ? {} : { providerRetryAfterMs: delay },
          ...id === undefined ? {} : { requestId: id },
        })
      }
      await extensions.accept()
      if (!response.body) {
        throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
      }

      yield* this.observeAttempt(
        translate(this.observeWire(parseSse(response.body, onActivity), wire, trace)),
        options,
        requestId(response.headers),
        wire,
      )
      return
    }
  }

  /**
   * Tap raw SSE payloads into the wire observer without altering the stream.
   *
   * This runs before `translate`, so the observer sees the endpoint's own
   * fields rather than the blocks they become. Removing the tap would leave the
   * diagnostic able only to describe the translation, which cannot show whether
   * a control marker arrived in `delta.content`, in a reasoning field, or not
   * at all.
   * @param payloads - raw SSE data payloads.
   * @param wire - the observer to feed.
   * @returns the same payloads, unchanged and un-delayed.
   */
  private async * observeWire(
    payloads: AsyncIterable<string>,
    wire: WireObserver | undefined,
    trace: ReasoningTrace | undefined,
  ): AsyncIterable<string> {
    if (wire === undefined && trace === undefined) {
      yield* payloads
      return
    }
    for await (const payload of payloads) {
      trace?.safely(() => { trace.payload(payload) })
      if (payload === DONE) wire?.markComplete()
      else wire?.observe(payload)
      yield payload
    }
  }

  /**
   * Forward one attempt's chunks while collecting the produced-block facts.
   *
   * Evidence comes from each settled `block-end`, whose block is the exact text
   * or reasoning the attempt committed, so a marker split across deltas is still
   * recognized. Reporting happens once, after the translation settles, and only
   * for an attempt the two-sided comparison finds anomalous. Matched text is
   * never retained.
   * @param chunks - the translated chunk stream for one attempt.
   * @param options - the request, for the route identity the report names.
   * @param id - provider request id from the response headers, when present.
   * @param wire - the raw-wire observer for this attempt, absent when no sink is configured.
   * @returns the same chunks, unchanged and un-delayed.
   */
  private async * observeAttempt(
    chunks: AsyncIterable<StreamChunk>,
    options: GenerateOptions,
    id: ReturnType<typeof ProviderRequestId> | undefined,
    wire: WireObserver | undefined,
  ): AsyncIterable<StreamChunk> {
    if (wire === undefined) {
      yield* chunks
      return
    }
    let textChars = 0
    let reasoningChars = 0
    let structuredToolCalls = 0
    let finishReason = 'none'
    const textMarkers = new Set<string>()
    const reasoningMarkers = new Set<string>()
    try {
      for await (const chunk of chunks) {
        if (chunk.type === 'block-end') {
          if (chunk.block.type === 'tool-call') structuredToolCalls += 1
          else if (chunk.block.type === 'text') {
            textChars += chunk.block.text.length
            for (const family of controlMarkerFamilies(chunk.block.text)) textMarkers.add(family)
          } else if (chunk.block.type === 'reasoning') {
            reasoningChars += chunk.block.text.length
            for (const family of controlMarkerFamilies(chunk.block.text)) reasoningMarkers.add(family)
          }
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason.kind
        }
        yield chunk
      }
    } finally {
      this.reportProtocolAnomaly(options, id, {
        wire: wire.facts(),
        blocks: {
          textChars,
          reasoningChars,
          textMarkers: [...textMarkers],
          reasoningMarkers: [...reasoningMarkers],
          structuredToolCalls,
          finishReason,
        },
      })
    }
  }

  /**
   * Hand one attempt's comparison to the configured sink.
   *
   * A diagnostic must never change the attempt's outcome: a failing sink cannot
   * fail a model request that already succeeded, and it cannot mask the error
   * that failed one, which is why every sink or classification fault is
   * swallowed here rather than propagating out of the caller's `finally`.
   * @param options - the request, for the route identity the report names.
   * @param id - provider request id from the response headers, when present.
   * @param facts - the raw and produced facts for this attempt.
   */
  private reportProtocolAnomaly(
    options: GenerateOptions,
    id: ReturnType<typeof ProviderRequestId> | undefined,
    facts: AttemptFacts,
  ): void {
    const report = this.config.onProtocolAnomaly
    if (report === undefined) return
    try {
      const anomaly = attemptAnomaly({ ...facts, ...id === undefined ? {} : { requestId: String(id) } })
      if (anomaly === undefined) return
      report({
        provider: options.provider,
        model: options.model,
        report: describeAttemptAnomaly('chat-completions', anomaly),
      })
    } catch (_sinkOrClassificationFailure) {
      // A diagnostic is observational: it neither fails nor rescues an attempt,
      // so its own fault stops here instead of reaching the caller.
    }
  }
}
