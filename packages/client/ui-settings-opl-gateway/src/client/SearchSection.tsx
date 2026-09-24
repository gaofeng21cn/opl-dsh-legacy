/** Search mode, model capability test, and usage readback. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { OplSearchPreferences, OplSearchStatus, OplSearchTestResult } from '@one-person-lab/dsh-llm-opl-gateway/types'
import css from './OplGatewaySection.module.css'

export interface SearchSectionInjected {
  searchStatus: () => Promise<OplSearchStatus>
  searchConfigure: (preferences: OplSearchPreferences) => Promise<OplSearchStatus>
  searchModels: () => Promise<string[]>
  searchTest: (preferences: OplSearchPreferences, query: string) => Promise<OplSearchTestResult>
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings.oplGateway'> & InjectFace<SearchSectionInjected>

export function SearchSection({ t, searchStatus, searchConfigure, searchModels, searchTest }: Props) {
  const [status, setStatus] = useState<OplSearchStatus>()
  const [preferences, setPreferences] = useState<OplSearchPreferences>({ mode: 'cloud', model: 'gpt-5.6-sol' })
  const [models, setModels] = useState<string[]>([])
  const [query, setQuery] = useState('DeepSeek Harness GitHub')
  const [result, setResult] = useState<OplSearchTestResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let disposed = false
    void searchStatus()
      .then((value) => { if (!disposed) { setStatus(value); setPreferences(value.preferences) } })
      .catch((e) => { if (!disposed) setError(String(e)) })
    return () => { disposed = true }
  }, [searchStatus])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setSaved(false)
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const change = (value: OplSearchPreferences) => { setPreferences(value); setSaved(false); setResult(undefined) }
  return <div className={css.section}>
    <p className={css.intro}>{t('search.intro')}</p>
    <div className={css.card}>
      <label className={css.field}><span>{t('search.mode')}</span>
        <select className={css.input} disabled={busy || !status} value={preferences.mode} onChange={e => change({ ...preferences, mode: e.target.value as 'local' | 'cloud' })}>
          <option value='cloud'>{t('search.cloud')}</option><option value='local'>{t('search.local')}</option>
        </select>
      </label>
      <p className={css.muted}>{preferences.mode === 'local' ? t('search.localHint') : t('search.cloudHint')}</p>
      {preferences.mode === 'cloud' && <>
        <label className={css.field}><span>{t('search.model')}</span>
          <select
            className={css.input}
            disabled={busy || !status}
            value={preferences.model}
            onChange={e => change({ ...preferences, model: e.target.value })}
          >
            {[...new Set([preferences.model, 'gpt-5.6-sol', ...models])].map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
        <Button variant='outline' disabled={busy} onClick={() => { void run(async () => setModels(await searchModels())) }}>{t('search.loadModels')}</Button>
        <p className={css.muted}>{t('search.modelHint')}</p>
      </>}
      <label className={css.field}><span>{t('search.query')}</span><input className={css.input} value={query} disabled={busy} onChange={(e) => { setQuery(e.target.value); setResult(undefined) }} /></label>
      <div className={css.actions}>
        <Button disabled={busy || !status || !preferences.model.trim()} onClick={() => { void run(async () => { setStatus(await searchConfigure(preferences)); setSaved(true) }) }}>{t('search.save')}</Button>
        <Button variant='outline' disabled={busy || !status || !query.trim() || !preferences.model.trim()} onClick={() => { void run(async () => { setResult(undefined); try { setResult(await searchTest(preferences, query)) } finally { setStatus(await searchStatus()) } }) }}>{busy ? t('search.busy') : t('search.test')}</Button>
      </div>
      {saved && <p role='status'>{t('search.saved')}</p>}
      {error && <p role='alert' className={css.error}>{error}</p>}
      {result && <div><p role='status'>{t('search.passed', { n: result.sources.length, ms: result.durationMs })}</p><ul>{result.sources.map(source => <li key={source.url}><a href={source.url} target='_blank' rel='noreferrer'>{source.title || source.url}</a></li>)}</ul></div>}
    </div>
    <div className={css.card}>
      <span className={css.name}>{t('search.stats')}</span>
      <p className={css.muted}>{t('search.statsHint')}</p>
      <Button variant='outline' disabled={busy} onClick={() => { void run(async () => setStatus(await searchStatus())) }}>{t('search.refresh')}</Button>
      {status && <>
        <p>{t('search.counts', { all: status.totals.calls, ok: status.totals.succeeded, failed: status.totals.failed })}</p>
        <p>{t('search.tokens', { input: status.totals.inputTokens, output: status.totals.outputTokens, cached: status.totals.cachedTokens, unknown: status.totals.unknownUsage })}</p>
        <p>{t('search.time', { ms: status.totals.durationMs })}</p>
        <div className={css.statistics}><table><thead><tr><th>{t('search.model')}</th><th>{t('search.session')}</th><th>{t('search.calls')}</th><th>{t('search.inputOutput')}</th></tr></thead>
          <tbody>{status.buckets.slice(-50).reverse().map((row, index) => <tr key={index}><td>{row.mode === 'local' ? t('search.local') : row.model}</td><td>{row.sessionId ?? t('search.outside')}</td><td>{row.calls} / {row.failed}</td><td>{row.inputTokens} / {row.outputTokens}{row.unknownUsage ? ' + ?' : ''}</td></tr>)}</tbody></table></div>
      </>}
    </div>
  </div>
}
