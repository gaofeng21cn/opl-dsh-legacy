import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodexSkillBridge, CodexSkillStatus } from '../types.ts'
import css from './CodexSection.module.css'

type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings.codex'> & InjectFace<CodexSkillBridge>

/** User-triggered installation with visible conflict and completion states. */
export function CodexSection({ t, status, install }: Props) {
  const [value, setValue] = useState<CodexSkillStatus>()
  const [autoStart, setAutoStart] = useState(true)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let disposed = false
    void status().then((next) => {
      if (!disposed) { setValue(next); setAutoStart(next.autoStart) }
    }).catch(() => { if (!disposed) setFailed(true) }).finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true }
  }, [status])
  const run = async (save: boolean) => {
    setBusy(true); setFailed(false); setSaved(false)
    try {
      const next = await (save ? install({ autoStart }) : status())
      setValue(next); setAutoStart(next.autoStart); setSaved(save && next.state === 'current')
    } catch { setFailed(true) } finally { setBusy(false) }
  }
  const canInstall = value && ['missing', 'current', 'update'].includes(value.state)
  return <section className={css.section}>
    <p>{t('intro')}</p>
    <div className={css.card}>
      <p role='status'>{value ? t(value.state) : t('loading')}</p>
      {value && <div><strong>{t('directory')}</strong><code className={css.path}>{value.directory}</code></div>}
      <label className={css.toggle}>
        <input type='checkbox' checked={autoStart} disabled={busy || !canInstall} onChange={(event) => { setAutoStart(event.target.checked); setSaved(false) }} />
        {t('autoStart')}
      </label>
      <p className={css.hint}>{t('autoStartHint')}</p>
      <div className={css.actions}>
        <Button disabled={busy || !canInstall} onClick={() => { void run(true) }}>{t(busy ? 'busy' : value?.state === 'missing' ? 'install' : 'save')}</Button>
        <Button variant='outline' disabled={busy} onClick={() => { void run(false) }}>{t('refresh')}</Button>
      </div>
      {saved && <p role='status'>{t('saved')}</p>}
      {failed && <p role='alert'>{t('failure')}</p>}
    </div>
    <p className={css.hint}>{t('limits')}</p>
  </section>
}
