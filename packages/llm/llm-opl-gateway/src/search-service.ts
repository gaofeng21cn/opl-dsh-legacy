/** Search selection, real capability tests, and local usage accounting. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchResult, WebFetchResult } from '@deepseek-ai/dsh-web'
import { z } from 'zod'
import { OplGatewaySearchProvider } from './search.ts'
import type { OplGatewaySearchProviderOptions } from './search.ts'
import type { OplSearchPreferences, OplSearchStatus, OplSearchTotals, OplSearchTestResult } from './types.ts'
import { localSearch } from './local-search.ts'

const preferencesSchema = z.object({ mode: z.enum(['cloud', 'local']), model: z.string().trim().min(1).max(160) })
const totalsSchema = z.object({
  calls: z.number().nonnegative(), succeeded: z.number().nonnegative(), failed: z.number().nonnegative(),
  durationMs: z.number().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative(), unknownUsage: z.number().nonnegative(),
})
const stateSchema = z.object({
  preferences: preferencesSchema,
  totals: totalsSchema,
  buckets: z.array(totalsSchema.extend({
    mode: z.enum(['cloud', 'local']), model: z.string(), sessionId: z.string().nullable(),
  })).max(2000),
})
const empty = (): OplSearchTotals => ({
  calls: 0, succeeded: 0, failed: 0, durationMs: 0,
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, unknownUsage: 0,
})

/** Host-owned search settings and statistics exposed through generated Remote methods. */
export class OplSearchService extends TypertRemoteService {
  private state: OplSearchStatus
  private readonly pending = new Set<AbortController>()
  private readonly operations = new Set<Promise<unknown>>()
  constructor(ctx: Context, private readonly options: {
    path: string
    cloud: () => OplGatewaySearchProviderOptions
    fetchPage: (url: string, signal: AbortSignal) => Promise<WebFetchResult>
    sessionId: () => string | null
  }) {
    super(ctx, 'oplSearch', { namespace: 'oplSearch' })
    this.state = { preferences: { mode: 'cloud', model: options.cloud().model }, totals: empty(), buckets: [] }
    try { this.state = stateSchema.parse(JSON.parse(readFileSync(options.path, 'utf8'))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read OPL search settings/statistics', { cause: error })
    }
    ctx.effect(() => async () => {
      for (const controller of this.pending) controller.abort()
      await Promise.allSettled([...this.operations])
    }, 'opl-search: cancel active requests')
  }

  private persist(): void {
    mkdirSync(dirname(this.options.path), { recursive: true })
    const temp = this.options.path + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.options.path)
  }

  /** Read settings and accounting without making a model request.
   * @returns a detached settings and usage snapshot.
   */
  @Remote
  status(): OplSearchStatus { return structuredClone(this.state) }

  /** Persist the selection for subsequent calls, leaving in-flight calls unchanged.
   * @param preferences - Search mode and model for future calls.
   * @returns the committed settings and usage snapshot.
   */
  @Remote
  configure(preferences: OplSearchPreferences): OplSearchStatus {
    const parsed = preferencesSchema.parse(preferences)
    const previous = this.state.preferences
    this.state.preferences = parsed
    try { this.persist() } catch (error) { this.state.preferences = previous; throw error }
    return this.status()
  }

  /** Fetch the account's advertised models; discovery is not search verification.
   * @param signal - Cancellation for discovery.
   * @returns advertised model identifiers.
   */
  @Remote
  async models(signal: AbortSignal): Promise<string[]> {
    const options = this.options.cloud()
    const key = options.apiKey ?? await options.resolveApiKey?.()
    if (!key) throw new WebError('Sign in to OPL Gateway to load models.', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    const response = await fetch(options.baseURL.replace(/\/+$/, '') + '/models', { headers: { authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
    if (!response.ok) throw new Error('Model discovery failed: HTTP ' + response.status)
    const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json())
    return [...new Set(parsed.data.map(row => row.id))].sort()
  }

  /** Test the proposed configuration without saving it; this performs a real search.
   * @param preferences - Proposed backend selection.
   * @param query - Search query.
   * @param signal - Cancellation for the test.
   * @returns verified sources and elapsed time.
   */
  @Remote
  async test(preferences: OplSearchPreferences, query: string, signal: AbortSignal): Promise<OplSearchTestResult> {
    const start = Date.now()
    const result = await this.execute({ query, maxResults: 5 }, signal, preferencesSchema.parse(preferences), null)
    return {
      sources: result.sources.map(source => ({
        url: source.url,
        ...(source.title ? { title: source.title } : {}),
      })),
      durationMs: Date.now() - start,
    }
  }

  /** Execute the selected backend; never silently substitute a different mode or model.
   * @param request - Search query and result budget.
   * @param signal - Optional caller cancellation.
   * @returns search sources from the selected backend.
   */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return this.execute(request, signal, { ...this.state.preferences }, this.options.sessionId())
  }

  private execute(
    request: WebSearchRequest,
    signal: AbortSignal | undefined,
    preferences: OplSearchPreferences,
    sessionId: string | null,
  ): Promise<WebSearchResult> {
    const operation = this.executeTracked(request, signal, preferences, sessionId)
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }

  private async executeTracked(
    request: WebSearchRequest,
    signal: AbortSignal | undefined,
    preferences: OplSearchPreferences,
    sessionId: string | null,
  ): Promise<WebSearchResult> {
    if (!request.query.trim() || request.query.length > 10000) throw new Error('Search query must contain 1–10000 characters.')
    const controller = new AbortController()
    this.pending.add(controller)
    const budget = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(120000)])
    const started = Date.now()
    let succeeded = false
    let usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number } | undefined
    try {
      const result = preferences.mode === 'local'
        ? await localSearch(request, url => this.options.fetchPage(url, budget))
        : await new OplGatewaySearchProvider(() => ({
          ...this.options.cloud(),
          model: preferences.model,
          recordUsage: (value) => { usage = value },
        })).search(request, budget)
      if (result.sources.length === 0) throw new Error('Search returned no sources.')
      succeeded = true
      return result
    } finally {
      this.pending.delete(controller)
      const delta: OplSearchTotals = {
        calls: 1,
        succeeded: succeeded ? 1 : 0,
        failed: succeeded ? 0 : 1,
        durationMs: Date.now() - started,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedTokens: usage?.cachedTokens ?? 0,
        unknownUsage: preferences.mode === 'cloud'
          && (usage?.inputTokens === undefined || usage.outputTokens === undefined) ? 1 : 0,
      }
      const model = preferences.mode === 'local' ? 'bing' : preferences.model
      let bucket = this.state.buckets.find(row => row.mode === preferences.mode && row.model === model && row.sessionId === sessionId)
      if (!bucket) {
        bucket = { ...empty(), mode: preferences.mode, model, sessionId }
        this.state.buckets.push(bucket)
        if (this.state.buckets.length > 2000) this.state.buckets.shift()
      }
      for (const key of Object.keys(delta) as (keyof OplSearchTotals)[]) { this.state.totals[key] += delta[key]; bucket[key] += delta[key] }
      this.persist()
    }
  }
}
