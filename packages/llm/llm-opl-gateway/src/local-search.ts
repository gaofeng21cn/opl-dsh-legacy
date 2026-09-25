/** Keyless local retrieval through Bing's public RSS search response. */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'

function xmlText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? ''
  }).trim()
}

/** Parse result records, refusing verification pages and empty responses.
 * @param xml - Search engine RSS response.
 * @param maxResults - Maximum returned sources.
 * @returns bounded source records and truncation status.
 */
export function parseLocalSearch(xml: string, maxResults = 10): WebSearchResult {
  if (!/<rss[\s>]/i.test(xml)) throw new WebError('Local search returned no RSS results; the search engine may require verification.', 'WEB_PROVIDER_ERROR')
  const sources: { url: string; title: string; snippet: string }[] = []
  const seen = new Set<string>()
  for (const item of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const field = (name: string) => xmlText(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(item[1] ?? '')?.[1] ?? '')
    const url = field('link')
    if (!URL.canParse(url) || !['https:', 'http:'].includes(new URL(url).protocol) || seen.has(url)) continue
    seen.add(url)
    sources.push({ url, title: field('title'), snippet: field('description').slice(0, 2000) })
  }
  if (sources.length === 0) throw new WebError('Local search returned no sources. Try another query or cloud search.', 'WEB_PROVIDER_ERROR')
  return { sources: sources.slice(0, maxResults), truncated: sources.length > maxResults }
}

/** Reuse the HTTP fetch provider's proxy, cancellation, size, and address policy.
 * @param request - Search query and result budget.
 * @param fetchPage - Policy-checked HTTP fetch operation.
 * @returns parsed search sources.
 */
export async function localSearch(
  request: WebSearchRequest,
  fetchPage: (url: string) => Promise<WebFetchResult>,
): Promise<WebSearchResult> {
  const url = new URL('https://www.bing.com/search')
  url.searchParams.set('q', request.query)
  url.searchParams.set('format', 'rss')
  let response: WebFetchResult
  try { response = await fetchPage(url.href) } catch (error) {
    // Bing regional redirects still use a fresh, policy-checked public fetch.
    if (!(error instanceof WebError) || error.code !== 'WEB_REDIRECT_BLOCKED') throw error
    url.hostname = 'cn.bing.com'
    response = await fetchPage(url.href)
  }
  if (response.statusCode !== 200 || response.truncated) throw new WebError('Local search failed: HTTP ' + response.statusCode, 'WEB_PROVIDER_ERROR')
  return parseLocalSearch(response.body.content, request.maxResults)
}
