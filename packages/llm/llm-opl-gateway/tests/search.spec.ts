/** OPL Gateway search provider: streaming Responses parsing, citation mapping, and failure honesty. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  OplGatewaySearchProvider,
  OPL_GATEWAY_SEARCH_PROVIDER_ID,
  mapSearchStream,
  readSearchStream,
} from '../src/search.ts'
import type { OplGatewaySearchProviderOptions } from '../src/search.ts'

const KEY = 'opl-search-key'

/** The options one provider operation reads, with the endpoint pinned to a test host. */
function options(overrides: Partial<OplGatewaySearchProviderOptions> = {}): OplGatewaySearchProviderOptions {
  return {
    apiKey: KEY,
    apiKeyEnv: credentialRef('OPL_GATEWAY_DEEPSEEK_API_KEY'),
    baseURL: 'https://gateway.test/v1',
    model: 'gpt-6-astra',
    maxOutputTokens: 1024,
    timeoutMs: 30_000,
    maxSearches: 3,
    ...overrides,
  }
}

/** One SSE frame as the gateway writes it. */
function frame(event: unknown): string {
  return `event: ${(event as { type?: string }).type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`
}

/** A 200 event-stream body carrying the given frames, delivered as given chunks. */
function streamResponse(chunks: readonly string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

/** Answer text plus its two citations, as the gateway reports them. */
const ANSWER = 'DeepSeek Harness is a plugin-based agent harness.'
function citedFrames(): string[] {
  return [
    frame({ type: 'response.created' }),
    frame({ type: 'response.web_search_call.in_progress', item_id: 'ws_1', output_index: 1 }),
    frame({ type: 'response.web_search_call.completed', item_id: 'ws_1', output_index: 1 }),
    frame({ type: 'response.output_text.done', output_index: 2, content_index: 0, text: ANSWER }),
    frame({
      type: 'response.output_text.annotation.added',
      output_index: 2,
      content_index: 0,
      annotation: { type: 'url_citation', start_index: 0, end_index: 17, title: 'Harness home', url: 'https://a.test/harness' },
    }),
    frame({
      type: 'response.output_text.annotation.added',
      output_index: 2,
      content_index: 0,
      annotation: { type: 'url_citation', start_index: 17, end_index: 37, title: 'Premier', url: 'https://b.test/premier' },
    }),
    frame({ type: 'response.completed' }),
  ]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readSearchStream', () => {
  it('collects citations, answer text, and the search count from the event stream', async () => {
    const parsed = await readSearchStream(streamResponse([citedFrames().join('')]).body!)
    expect(parsed.searches).toBe(1)
    expect(parsed.citations.map(citation => citation.url))
      .toEqual(['https://a.test/harness', 'https://b.test/premier'])
    expect(parsed.itemText.get(2)).toBe(ANSWER)
  })

  it('reassembles a frame split across chunk boundaries', async () => {
    const whole = citedFrames().join('')
    const split = [whole.slice(0, 40), whole.slice(40, 90), whole.slice(90)]
    const parsed = await readSearchStream(streamResponse(split).body!)
    expect(parsed.citations).toHaveLength(2)
    expect(parsed.searches).toBe(1)
  })

  it('skips a malformed frame instead of failing an answered search', async () => {
    const parsed = await readSearchStream(streamResponse([
      'event: response.created\ndata: {not json\n\n',
      ...citedFrames(),
    ]).body!)
    expect(parsed.citations).toHaveLength(2)
  })
})

describe('mapSearchStream', () => {
  it('maps citations to sources with the attributed text as the snippet', async () => {
    const result = mapSearchStream(await readSearchStream(streamResponse([citedFrames().join('')]).body!))
    expect(result.truncated).toBe(false)
    expect(result.sources).toEqual([
      { url: 'https://a.test/harness', title: 'Harness home', snippet: 'DeepSeek Harness ' },
      { url: 'https://b.test/premier', title: 'Premier', snippet: 'is a plugin-based ag' },
    ])
  })

  it('reports a search that ran without citeable annotations rather than inventing sources', async () => {
    const parsed = await readSearchStream(streamResponse([
      frame({ type: 'response.web_search_call.completed' }),
      frame({ type: 'response.output_text.done', output_index: 1, text: 'See https://a.test' }),
      frame({ type: 'response.completed' }),
    ]).body!)
    expect(() => mapSearchStream(parsed)).toThrow(WebError)
    expect(() => mapSearchStream(parsed)).toThrow(/searched but returned no url_citation/)
  })

  it('reports a request that triggered no server-side search at all', async () => {
    const parsed = await readSearchStream(streamResponse([
      frame({ type: 'response.output_text.done', output_index: 1, text: 'no search here' }),
      frame({ type: 'response.completed' }),
    ]).body!)
    expect(() => mapSearchStream(parsed)).toThrow(/ran no web search/)
  })

  it('surfaces a mid-stream failure the gateway reported', async () => {
    const parsed = await readSearchStream(streamResponse([
      frame({ type: 'response.failed', response: { error: { message: 'upstream unavailable' } } }),
    ]).body!)
    expect(parsed.failure).toBe('upstream unavailable')
    expect(() => mapSearchStream(parsed)).toThrow(/upstream unavailable/)
  })
})

describe('OplGatewaySearchProvider', () => {
  it('posts the streaming Responses request to the configured gateway', async () => {
    const fetchMock = vi.fn(async () => streamResponse([citedFrames().join('')]))
    vi.stubGlobal('fetch', fetchMock)
    const recorded: unknown[] = []
    const provider = new OplGatewaySearchProvider(() => options({ recordRequest: request => recorded.push(request) }))

    const result = await provider.search({ query: 'what is DeepSeek Harness', maxResults: 5 })

    expect(provider.id).toBe(OPL_GATEWAY_SEARCH_PROVIDER_ID)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gateway.test/v1/responses')
    expect(init.method).toBe('POST')
    // A redirect must never carry the credential to another origin.
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream')
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-6-astra',
      input: 'Perform a web search for the query: what is DeepSeek Harness',
      tools: [{ type: 'web_search' }],
      max_output_tokens: 1024,
      stream: true,
    })
    // The logged record is secret-free and identical to what was sent.
    expect(recorded).toEqual([{
      endpoint: 'https://gateway.test/v1/responses',
      body: {
        model: 'gpt-6-astra',
        input: 'Perform a web search for the query: what is DeepSeek Harness',
        tools: [{ type: 'web_search' }],
        max_output_tokens: 1024,
        stream: true,
      },
    }])
    expect(JSON.stringify(recorded)).not.toContain(KEY)
    expect(result.sources.map(source => source.url))
      .toEqual(['https://a.test/harness', 'https://b.test/premier'])
  })

  it('never resolves a gateway search against the official DeepSeek endpoint', async () => {
    const fetchMock = vi.fn(async () => streamResponse([citedFrames().join('')]))
    vi.stubGlobal('fetch', fetchMock)
    await new OplGatewaySearchProvider(() => options()).search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).not.toContain('api.deepseek.com')
  })

  it('resolves the key per operation and prefers a literal key', async () => {
    const fetchMock = vi.fn(async () => streamResponse([citedFrames().join('')]))
    vi.stubGlobal('fetch', fetchMock)
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    await new OplGatewaySearchProvider(() => options({ apiKey: undefined, resolveApiKey })).search({ query: 'q' })
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization'))
      .toBe('Bearer resolved-key')

    const literal = vi.fn(async () => 'resolved-key')
    await new OplGatewaySearchProvider(() => options({ resolveApiKey: literal })).search({ query: 'q' })
    expect(literal).not.toHaveBeenCalled()
  })

  it('fails with a missing-credential code when the account holds no key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OplGatewaySearchProvider(() => options({
      apiKey: undefined,
      resolveApiKey: async () => undefined,
    }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/OPL_GATEWAY_DEEPSEEK_API_KEY/)
    // A missing credential is decided before dispatch, so no key can leak.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the endpoint and the provider message on an HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'model not enabled', type: 'invalid_request_error' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )))
    const provider = new OplGatewaySearchProvider(() => options())
    await expect(provider.search({ query: 'q' })).rejects.toThrow(
      /HTTP 400: model not enabled[\s\S]*https:\/\/gateway\.test\/v1\/responses/,
    )
  })

  it('reports caller cancellation as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }))
    const provider = new OplGatewaySearchProvider(() => options())
    await expect(provider.search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('is unavailable without a resolver, a parseable endpoint, or usable limits', () => {
    const provider = (overrides: Partial<OplGatewaySearchProviderOptions>): OplGatewaySearchProvider =>
      new OplGatewaySearchProvider(() => options(overrides))
    expect(provider({}).available()).toBe(true)
    expect(provider({ apiKey: undefined }).available()).toBe(false)
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
    expect(provider({ model: '  ' }).available()).toBe(false)
    expect(provider({ timeoutMs: 0 }).available()).toBe(false)
  })
})
