import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OplSearchService } from '../src/search-service.ts'
import { localSearch, parseLocalSearch } from '../src/local-search.ts'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { readSearchStream } from '../src/search.ts'

const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const rss = '<rss><channel><item><title>A &amp; B</title><link>https://example.org/a</link><description>Source snippet</description></item></channel></rss>'

describe('local search', () => {
  it('retries Bing regional redirects through the same checked fetch provider', async () => {
    const fetchPage = vi.fn(async (url: string): Promise<WebFetchResult> => {
      if (new URL(url).hostname === 'www.bing.com') throw new WebError('regional redirect', 'WEB_REDIRECT_BLOCKED')
      return { url, statusCode: 200, body: { kind: 'text', content: rss }, truncated: false }
    })
    expect((await localSearch({ query: 'test' }, fetchPage)).sources).toHaveLength(1)
    expect(new URL(fetchPage.mock.calls[1]![0]).hostname).toBe('cn.bing.com')
  })
  it('extracts real sources and refuses non-result pages and unsafe URLs', () => {
    expect(parseLocalSearch(rss).sources[0]).toEqual({ title: 'A & B', url: 'https://example.org/a', snippet: 'Source snippet' })
    expect(() => parseLocalSearch('<html>Verify you are human</html>')).toThrow('no RSS')
    expect(() => parseLocalSearch(rss.replace('https://example.org/a', 'javascript:alert(1)'))).toThrow('no sources')
  })
})

describe('search settings and accounting', () => {
  it('switches without credentials, preserves settings/statistics on restart, and records failure without query text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opl-search-')); roots.push(root)
    const path = join(root, 'search.json')
    const fetchPage = vi.fn(async () => ({ url: 'https://www.bing.com/search', statusCode: 200, body: { kind: 'text' as const, content: rss }, truncated: false }))
    const options = { path, cloud: () => ({ model: 'gpt-5.6-sol', baseURL: 'https://gateway.test/v1', timeoutMs: 1000, maxOutputTokens: 1024, maxSearches: 3 }), fetchPage, sessionId: () => 'session-test' }
    const ctx = new Context()
    const service = new OplSearchService(ctx, options)
    service.configure({ mode: 'local', model: 'gpt-5.6-sol' })
    await service.search({ query: 'private query must not be persisted' })
    expect(fetchPage.mock.calls).toHaveLength(1)
    service.configure({ mode: 'cloud', model: 'another-model' })
    await expect(service.search({ query: 'second private query' })).rejects.toThrow('no API key')
    const restored = new OplSearchService(new Context(), options)
    expect(restored.status()).toMatchObject({ preferences: { mode: 'cloud', model: 'another-model' }, totals: { calls: 2, succeeded: 1, failed: 1, unknownUsage: 1 } })
    expect(readFileSync(path, 'utf8')).not.toContain('private query')
    await ctx.fiber.dispose()
  })
  it('collects reported cached and total tokens without fabricating absent usage', async () => {
    const wire = 'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } } } }) + '\n'
    const parsed = await readSearchStream(new Response(wire).body!)
    expect(parsed.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 60 })
    expect((await readSearchStream(new Response('data: {}\n').body!)).usage).toBeUndefined()
  })
})
