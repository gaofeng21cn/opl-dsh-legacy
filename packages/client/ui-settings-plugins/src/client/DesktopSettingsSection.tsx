/** Desktop-owned preferences presented inside the shared Web settings. */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopSettingsSection.module.css'

/** Preferences persisted by the desktop shell. */
export interface DesktopPreferences {
  notificationsEnabled: boolean
  closeBehavior: 'ask' | 'tray' | 'exit'
}

/** Environment choices reported by the desktop shell. */
export interface DesktopEnvironmentState {
  current: 'windows-native' | 'wsl2'
  currentDistro?: string
  selected: 'windows-native' | 'wsl2'
  selectedDistro?: string
  restartRequired: boolean
  distributions: readonly { name: string; isDefault: boolean; nodeVersion?: string; problem?: 'not-wsl2' | 'unreachable' | 'node-missing' | 'node-too-old' | 'host-missing' }[]
  unavailable?: 'not-windows' | 'not-installed' | 'no-usable-distribution'
}

/** Narrow renderer projection of the desktop preload operations used here. */
export interface DesktopSettingsBridge {
  preferences: {
    get(): Promise<DesktopPreferences>
    set(update: Partial<DesktopPreferences>): Promise<DesktopPreferences>
    subscribe(listener: (preferences: DesktopPreferences) => void): () => void
  }
  environment: {
    status(): Promise<DesktopEnvironmentState>
    select(selection: { environment: 'windows-native' | 'wsl2'; distro?: string }): Promise<DesktopEnvironmentState>
  }
}

/** Renderer bindings for the desktop settings page. */
export type DesktopSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.plugins'> & InjectFace<{ desktop: DesktopSettingsBridge }>

/**
 * Render shell preferences and the execution environment reported by Electron.
 * @param props - localized copy and the desktop preload bridge.
 * @returns the desktop settings page.
 */
export function DesktopSettingsSection({ t, desktop }: DesktopSettingsSectionProps) {
  const [preferences, setPreferences] = useState<DesktopPreferences>()
  const [environment, setEnvironment] = useState<DesktopEnvironmentState>()
  const [selected, setSelected] = useState<'windows-native' | 'wsl2'>('windows-native')
  const [distro, setDistro] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    const off = desktop.preferences.subscribe((value) => { if (active) setPreferences(value) })
    Promise.all([desktop.preferences.get(), desktop.environment.status()]).then(([prefs, env]) => {
      if (!active) return
      setPreferences(prefs)
      setEnvironment(env)
      setSelected(env.selected)
      setDistro(env.selectedDistro ?? env.distributions.find(item => item.problem === undefined)?.name ?? '')
    }).catch((_error: unknown) => { if (active) setError(true) })
    return () => { active = false; off() }
  }, [desktop])
  const savePreferences = async () => {
    if (preferences === undefined) return
    setBusy(true); setError(false)
    try { setPreferences(await desktop.preferences.set(preferences)) }
    catch (_error) { setError(true) }
    finally { setBusy(false) }
  }
  const saveEnvironment = async () => {
    setBusy(true); setError(false)
    try { setEnvironment(await desktop.environment.select({ environment: selected, ...(selected === 'wsl2' ? { distro } : {}) })) }
    catch (_error) { setError(true) }
    finally { setBusy(false) }
  }
  const usable = environment?.distributions.filter(item => item.problem === undefined) ?? []
  return <section className={css.section}>
    <h2>{t('desktopTitle')}</h2>
    <p>{t('desktopDescription')}</p>
    {error ? <p role="alert">{t('desktopFailed')}</p> : null}
    {preferences === undefined ? <p role="status">{t('desktopLoading')}</p> : <fieldset disabled={busy} className={css.group}>
      <legend>{t('desktopPreferences')}</legend>
      <label className={css.checkbox}><input type="checkbox" checked={preferences.notificationsEnabled}
        onChange={(event) => { setPreferences({ ...preferences, notificationsEnabled: event.target.checked }) }} />{t('desktopNotifications')}</label>
      <label htmlFor="desktop-close-behavior">{t('desktopCloseBehavior')}</label>
      <select id="desktop-close-behavior" value={preferences.closeBehavior} onChange={(event) => {
        const closeBehavior = event.target.value
        if (closeBehavior === 'ask' || closeBehavior === 'tray' || closeBehavior === 'exit') setPreferences({ ...preferences, closeBehavior })
      }}>
        <option value="ask">{t('desktopCloseAsk')}</option><option value="tray">{t('desktopCloseTray')}</option><option value="exit">{t('desktopCloseExit')}</option>
      </select>
      <button type="button" onClick={() => { void savePreferences() }}>{t(busy ? 'saving' : 'save')}</button>
    </fieldset>}
    {environment !== undefined && environment.unavailable !== 'not-windows' ? <fieldset disabled={busy} className={css.group}>
      <legend>{t('desktopEnvironment')}</legend>
      <p>{t('desktopEnvironmentHint')}</p>
      <label htmlFor="desktop-environment">{t('desktopEnvironment')}</label>
      <select id="desktop-environment" value={selected} onChange={(event) => {
        if (event.target.value === 'windows-native' || event.target.value === 'wsl2') setSelected(event.target.value)
      }}>
        <option value="windows-native">{t('desktopNative')}</option><option value="wsl2" disabled={usable.length === 0}>{t('desktopWsl')}</option>
      </select>
      {selected === 'wsl2' ? <><label htmlFor="desktop-distro">{t('desktopDistribution')}</label>
        <select id="desktop-distro" value={distro} onChange={(event) => { setDistro(event.target.value) }}>
          {usable.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select></> : null}
      {usable.length === 0 ? <p>{t('desktopWslUnavailable')}</p> : null}
      {environment.restartRequired ? <p role="status">{t('desktopRestart')}</p> : null}
      <button type="button" disabled={selected === 'wsl2' && !usable.some(item => item.name === distro)} onClick={() => { void saveEnvironment() }}>{t(busy ? 'saving' : 'save')}</button>
    </fieldset> : null}
  </section>
}
