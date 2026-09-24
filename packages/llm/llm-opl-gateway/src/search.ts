/**
 * OPL Gateway web search through the gateway's OpenAI-Responses route.
 *
 * The gateway serves native web search on `POST {baseURL}/responses` with the
 * `web_search` server tool: it answers with server-sent events carrying
 * `response.web_search_call.*` lifecycle events and `url_citation` annotations
 * (title plus URL) on the answer text. Its Anthropic-compatible `/messages`
 * route accepts the same request and silently ignores the tool, and the
 * non-streaming Responses form closes the connection, so the streaming form is
 * the only shape this provider sends.
 *
 * The wire format and the `fetch` client are provider-private and do not use
 * `ctx.llm`.
 * @module @one-person-lab/dsh-llm-opl-gateway/search
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type { OplGatewaySearchLlmRequest } from './search-types.ts'

/** Stable id this provider registers under in `ctx.web`. */
export const OPL_GATEWAY_SEARCH_PROVIDER_ID = 'opl-gateway'

/**
 * Default model that performs the search.
 *
 * Search is an OpenAI-family capability on this gateway: the account's DeepSeek
 * routes accept the request and ignore the tool. A deployment whose account
 * enables another search-capable model names it through `search.model`.
 */
export const OPL_GATEWAY_SEARCH_DEFAULT_MODEL = 'gpt-6-astra'

/** Default upper bound on generated tokens for the search turn. */
export const OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS = 1024

/** Default budget for one search, covering connection, search, and answer. */
export const OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS = 60_000

/** Default upper bound on server-side searches one request may run. */
export const OPL_GATEWAY_SEARCH_DEFAULT_MAX_SEARCHES = 3

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface OplGatewaySearchProviderOptions {
  /** Literal gateway key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string | undefined
  /** Resolve the current gateway key for one search operation. */
  resolveApiKey?: (() => Promise<string | undefined>) | undefined
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Inference root; `/responses` is appended. */
  baseURL: string
  /** Model that runs the auxiliary search turn. */
  model: string
  /** Upper bound on generated tokens for the search turn. */
  maxOutputTokens: number
  /** Budget for one search. */
  timeoutMs: number
  /** Upper bound on server-side searches one request may run. */
  maxSearches: number
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: OplGatewaySearchLlmRequest) => void
  /** Provider-reported usage; called even when a completed response has no sources. */
  recordUsage?: (usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }) => void
}

/** One `url_citation` annotation the gateway attached to answer text. */
export interface OplSearchCitation {
  readonly url: string
  readonly title?: string | undefined
  /** Character span inside the answer item's text, when the gateway reports one. */
  readonly startIndex?: number | undefined
  readonly endIndex?: number | undefined
}

/** Everything one streamed search response yielded. */
export interface OplSearchStream {
  readonly usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  /** Citations in arrival order, deduplicated by URL. */
  readonly citations: readonly OplSearchCitation[]
  /** Answer text per `output_index`, used to derive snippets for citations. */
  readonly itemText: ReadonlyMap<number, string>
  /** Output index of the item each citation was attached to. */
  readonly citationItems: readonly number[]
  /** Server-side searches the gateway reported completing. */
  readonly searches: number
  /** Failure the gateway reported mid-stream, when one arrived. */
  readonly failure?: string | undefined
}

/** Mutable accumulator one stream writes into. */
interface SearchAccumulator {
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }
  citations: OplSearchCitation[]
  citationItems: number[]
  readonly seen: Set<string>
  readonly itemText: Map<number, string>
  searches: number
  failure?: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function index(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Reduce one streaming Responses payload to the fields this provider consumes.
 * @param event - decoded SSE payload.
 * @param state - accumulator carried across the stream, updated in place.
 */
export function absorbSearchEvent(event: unknown, state: SearchAccumulator): void {
  if (!isRecord(event)) return
  const type = text(event.type)
  if (isRecord(event.response) && isRecord(event.response.usage)) {
    const usage = event.response.usage
    const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    const input = numeric(usage.input_tokens)
    const output = numeric(usage.output_tokens)
    const cached = numeric(isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined)
    state.usage = {
      ...(input === undefined ? {} : { inputTokens: input }),
      ...(output === undefined ? {} : { outputTokens: output }),
      ...(cached === undefined ? {} : { cachedTokens: cached }),
    }
  }
  if (type === 'response.web_search_call.completed') {
    state.searches += 1
    return
  }
  if (type === 'response.failed' || type === 'error') {
    const response = isRecord(event.response) ? event.response : event
    const error = isRecord(response.error) ? response.error : undefined
    state.failure = text(error?.message) ?? text(response.message)
      ?? 'the gateway reported a failed search response'
    return
  }
  if (type === 'response.output_text.done') {
    const outputIndex = index(event.output_index)
    const body = text(event.text)
    if (outputIndex !== undefined && body !== undefined) state.itemText.set(outputIndex, body)
    return
  }
  if (type !== 'response.output_text.annotation.added') return
  const annotation = isRecord(event.annotation) ? event.annotation : undefined
  if (annotation === undefined || text(annotation.type) !== 'url_citation') return
  const url = text(annotation.url)
  if (url === undefined || state.seen.has(url)) return
  state.seen.add(url)
  const title = text(annotation.title)
  const startIndex = index(annotation.start_index)
  const endIndex = index(annotation.end_index)
  state.citations.push({
    url,
    ...title === undefined ? {} : { title },
    ...startIndex === undefined ? {} : { startIndex },
    ...endIndex === undefined ? {} : { endIndex },
  })
  state.citationItems.push(index(event.output_index) ?? -1)
}

/** A fresh accumulator for one stream. */
function emptyAccumulator(): SearchAccumulator {
  return { citations: [], citationItems: [], seen: new Set(), itemText: new Map(), searches: 0 }
}

/**
 * Parse one SSE byte stream into the citations, item text, and search count.
 *
 * Only `data:` payloads are read; a payload split across chunk boundaries is
 * buffered until its line completes, and a malformed payload is skipped rather
 * than failing a search the gateway already answered.
 * @param body - the response body stream.
 * @param signal - cancellation for the surrounding search.
 * @returns the accumulated stream facts.
 */
export async function readSearchStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<OplSearchStream> {
  const state = emptyAccumulator()
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (payload === '' || payload === '[DONE]') continue
        let event: unknown
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        absorbSearchEvent(event, state)
      }
    }
  } finally {
    reader.releaseLock()
  }
  return {
    citations: state.citations,
    itemText: state.itemText,
    citationItems: state.citationItems,
    searches: state.searches,
    ...state.usage === undefined ? {} : { usage: state.usage },
    ...state.failure === undefined ? {} : { failure: state.failure },
  }
}

/**
 * Map one parsed stream to the seam's search result.
 *
 * A citation's snippet is the answer text the gateway attributed it to, when
 * that span is available; the seam treats snippets and titles as optional, so an
 * absent slice costs nothing instead of inventing text.
 * @param stream - parsed stream facts.
 * @returns the normalized result with sources deduplicated by URL.
 * @throws {@link WebError} when the gateway ran no search, cited nothing, or failed mid-stream.
 */
export function mapSearchStream(stream: OplSearchStream): WebSearchResult {
  if (stream.failure !== undefined) {
    throw new WebError(`OPL Gateway search failed: ${stream.failure}`, 'WEB_PROVIDER_ERROR')
  }
  if (stream.citations.length === 0) {
    throw new WebError(
      stream.searches === 0
        ? 'OPL Gateway ran no web search: the request may not have triggered native search on the configured model'
        : 'OPL Gateway searched but returned no url_citation annotations to cite',
      'WEB_PROVIDER_ERROR',
    )
  }
  const sources: WebSearchSource[] = stream.citations.map((citation, position) => {
    const body = stream.itemText.get(stream.citationItems[position] ?? -1)
    const snippet = body !== undefined
      && citation.startIndex !== undefined
      && citation.endIndex !== undefined
      && citation.endIndex > citation.startIndex
      ? body.slice(citation.startIndex, citation.endIndex)
      : ''
    return {
      url: citation.url,
      ...citation.title === undefined ? {} : { title: citation.title },
      ...snippet === '' ? {} : { snippet },
    }
  })
  return { sources, truncated: false }
}

/**
 * The OPL Gateway-backed search provider.
 *
 * Failures after dispatch name the endpoint and the configuration field that
 * moves it: search runs on a different model than the conversation, so an
 * operator who reads only the error must learn that from the error.
 */
export class OplGatewaySearchProvider implements WebSearchProvider {
  readonly id = OPL_GATEWAY_SEARCH_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted at
   * each operation's entry so one search never mixes two settings sections.
   */
  constructor(private readonly resolveOptions: () => OplGatewaySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && options.model.trim().length > 0
      && isPositiveInteger(options.maxOutputTokens)
      && isPositiveInteger(options.timeoutMs)
      && isPositiveInteger(options.maxSearches)
  }

  /**
   * Run one search through the gateway's streaming Responses route.
   * @param request - the caller's query and optional source bound.
   * @param signal - caller cancellation; a timeout budget is added on top.
   * @returns normalized sources; the seam applies `maxResults` truncation.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const endpoint = `${options.baseURL.replace(/\/+$/u, '')}/responses`
    const body: OplGatewaySearchLlmRequest['body'] = {
      model: options.model,
      input: `Perform a web search for the query: ${request.query}`,
      tools: [{ type: 'web_search' }],
      max_output_tokens: options.maxOutputTokens,
      stream: true,
    }
    options.recordRequest?.({ endpoint, body })
    throwIfSearchAborted(signal)
    const budget = AbortSignal.any([
      ...signal === undefined ? [] : [signal],
      AbortSignal.timeout(options.timeoutMs),
    ])
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: budget,
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      if (budget.aborted) throw searchTimeout(endpoint, options.timeoutMs)
      throw searchEndpointError(endpoint, `OPL Gateway search request failed: ${String(error)}`, error)
    }
    if (!response.ok) {
      const detail = await this.errorDetail(response, signal)
      throw searchEndpointError(endpoint, `OPL Gateway search error: HTTP ${String(response.status)}${detail}`)
    }
    if (response.body === null) {
      throw searchEndpointError(endpoint, 'OPL Gateway search returned no response body')
    }
    try {
      const parsed = await readSearchStream(response.body, budget)
      if (parsed.usage) options.recordUsage?.(parsed.usage)
      return mapSearchStream(parsed)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      if (budget.aborted) throw searchTimeout(endpoint, options.timeoutMs)
      const message = error instanceof WebError
        ? error.message
        : `OPL Gateway search response was unusable: ${String(error)}`
      throw searchEndpointError(endpoint, message, error)
    }
  }

  /** Read the gateway's own error text, tolerating a missing or non-JSON body. */
  private async errorDetail(response: Response, signal?: AbortSignal): Promise<string> {
    try {
      const parsed: unknown = await response.json()
      if (!isRecord(parsed)) return ''
      const error = isRecord(parsed.error) ? parsed.error : undefined
      const message = text(error?.message) ?? text(parsed.message)
      return message === undefined ? '' : `: ${message}`
    } catch (error: unknown) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      // The status is already in the message; a non-JSON error body only costs
      // the richer provider text.
      return ''
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved key.
   */
  private async apiKey(options: OplGatewaySearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      throw new WebError(
        `OPL Gateway search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'OPL_GATEWAY_DEEPSEEK_API_KEY'
    throw new WebError(
      `OPL Gateway search has no API key for "${ref}"; sign in to OPL Gateway in this app, or store it`
      + ' through the credentials service',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Add endpoint recovery instructions to failures that occur after dispatch begins. */
function searchEndpointError(endpoint: string, message: string, cause?: unknown): WebError {
  return new WebError(
    `${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. `
    + 'Search runs on the OPL Gateway Responses route with the model named by llm-opl-gateway.search.model,'
    + ' which is separate from the conversation model. An operator who did not intend that endpoint or model'
    + ' changes them in the llm-opl-gateway plugin configuration.',
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/** Name a search that exceeded its budget, distinct from the caller's cancellation. */
function searchTimeout(endpoint: string, timeoutMs: number): WebError {
  return searchEndpointError(endpoint, `OPL Gateway search did not finish within ${String(timeoutMs)}ms`)
}

/**
 * Race a same-process asynchronous step against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('OPL Gateway search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for gateway request limits that can be sent to the Responses API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
