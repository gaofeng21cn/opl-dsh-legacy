/**
 * OPL Gateway Settings page: the deployment's account surface.
 *
 * The page owns no facts of its own. It reads one status from the Host's
 * account service, starts one sign-in (email and password, submitted once and
 * never echoed back), and can sign out; everything it renders — balance,
 * usage, endpoint, key readiness — arrives in that status.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GatewayAccountStatus, GatewaySignInResult } from '@one-person-lab/dsh-llm-opl-gateway/types'
import css from './OplGatewaySection.module.css'

/** Registration-side face the section drives. */
export interface OplGatewaySectionInjected {
  /** Read the current account status. */
  status: () => Promise<GatewayAccountStatus>
  /** Sign in and make the account's key this machine's inference credential. */
  signIn: (email: string, password: string) => Promise<GatewaySignInResult>
  /** Ask OPL to re-read the account from the gateway. */
  refresh: () => Promise<GatewayAccountStatus>
  /** End this machine's session and release the key it holds. */
  signOut: () => Promise<GatewayAccountStatus>
}

/** Full props assembled by the Settings slot renderer. */
export type OplGatewaySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.oplGateway'>
  & InjectFace<OplGatewaySectionInjected>

/** The page's locale seat, threaded into the formatters so every label stays dictionary-owned. */
type Translate = OplGatewaySectionProps['t']

/** Render a currency amount with its own currency and grouping, or a dash. */
function money(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return '—'
  return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
}

/** Render a token count, or a dash when unknown. */
function tokens(amount: number | null | undefined): string {
  return amount === null || amount === undefined ? '—' : amount.toLocaleString()
}

/**
 * Describe how old an observation is.
 *
 * The age is the fact a reader needs — "is this current?" — and an absolute
 * clock time makes them compute it. The exact instant stays available as the
 * element's title for anyone who needs it.
 * @param observedAt - ISO timestamp OPL recorded.
 * @param t - the page's locale seat, so the age reads in the active language.
 * @param now - current time in ms, injectable for tests.
 * @returns a short age label, or the original text if unparsable.
 */
export function observedAge(observedAt: string, t: Translate, now: number = Date.now()): string {
  const parsed = new Date(observedAt)
  if (Number.isNaN(parsed.getTime())) return observedAt
  const minutes = Math.max(0, Math.round((now - parsed.getTime()) / 60_000))
  if (minutes < 1) return t('age.now')
  if (minutes < 60) return t('age.ago', { t: t('age.minutes', { n: minutes }) })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('age.ago', { t: t('age.hours', { n: hours }) })
  return t('age.ago', { t: t('age.days', { n: Math.round(hours / 24) }) })
}

/**
 * Exact local timestamp, used as the age element's tooltip.
 * @param observedAt - ISO timestamp OPL recorded.
 * @returns a local, minute-precision label, or the original text if unparsable.
 */
export function observedLabel(observedAt: string): string {
  const parsed = new Date(observedAt)
  if (Number.isNaN(parsed.getTime())) return observedAt
  return parsed.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * One labelled fact.
 * @param props.label - localized field name.
 * @param props.value - rendered value.
 * @param props.wide - span the full grid row, for values that are copied verbatim.
 */
function Fact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? css.wide : undefined}>
      <span className={css.factLabel}>{label}</span>
      <span className={css.factValue}>{value}</span>
    </div>
  )
}

/** The OPL Gateway account page. */
export function OplGatewaySection(props: OplGatewaySectionProps) {
  const { t, status: readStatus, signIn, refresh, signOut } = props
  const [state, setState] = useState<GatewayAccountStatus | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'idle' | 'loading' | 'signing-in' | 'signing-out'>('loading')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (reload = false): Promise<void> => {
    setBusy('loading')
    try {
      // A plain open reads what OPL already recorded; the refresh button asks
      // OPL to go and re-read it from the gateway.
      setState(reload ? await refresh() : await readStatus())
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy('idle')
    }
  }, [readStatus, refresh])

  useEffect(() => { void load() }, [load])

  const submit = useCallback(async (): Promise<void> => {
    setBusy('signing-in')
    setNotice(null)
    setError(null)
    try {
      const result = await signIn(email, password)
      setState(result.status)
      setNotice(result.createdKey ? t('createdKey') : t('reusedKey'))
      // The password has done its work; keeping it in renderer state would
      // leave a live credential in a component nobody is looking at.
      setPassword('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy('idle')
    }
  }, [email, password, signIn, t])

  const leave = useCallback(async (): Promise<void> => {
    setBusy('signing-out')
    setNotice(null)
    setError(null)
    try {
      setState(await signOut())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy('idle')
    }
  }, [signOut])

  const account = state?.account
  const phase = state?.phase ?? 'signed-out'

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('intro')}</p>
      {state === undefined || state.models.length === 0
        ? null
        : (
          <p className={css.muted}>
            {t('provides', { names: state.models.map(model => model.name).join(', ') })}
          </p>
        )}
      {error === null ? null : <p className={`${css.notice} ${css.error}`} role="alert">{t('failure', { message: error })}</p>}
      {notice === null ? null : <p className={css.notice} role="status">{notice}</p>}

      {state === undefined
        ? <p className={css.muted}>{busy === 'loading' ? t('loading') : t('signedOut')}</p>
        : (
          <div className={css.card}>
            <div className={css.header}>
              <div className={css.identity}>
                <span className={css.name}>{t('title')}</span>
                <span className={css.muted}>
                  {phase === 'connected' ? t('connected') : phase === 'unavailable' ? t('unavailable') : t('signedOut')}
                  {account?.email === undefined || account.email === null ? null : ` · ${account.email}`}
                </span>
              </div>
              {phase === 'connected'
                ? (
                  <div className={css.actions}>
                    <Button variant='outline' disabled={busy !== 'idle'} onClick={() => { void load(true) }}>
                      {busy === 'loading' ? t('refreshing') : t('refresh')}
                    </Button>
                    {/* Only a session this client holds can be ended here. An
                        account merely read from OPL's record is signed out in
                        the OPL application, and offering the button would be a
                        no-op that reads as a broken control. */}
                    {state.source !== 'session'
                      ? null
                      : (
                        <Button variant='outline' disabled={busy !== 'idle'} onClick={() => { void leave() }}>
                          {busy === 'signing-out' ? t('signingIn') : t('signOut')}
                        </Button>
                      )}
                  </div>
                )
                : null}
            </div>

            {phase === 'connected' && account !== undefined
              ? (
                <dl className={css.facts}>
                  {account.displayName === null ? null : <Fact label={t('accountStatus')} value={account.status} />}
                  <Fact label={t('balance')} value={money(account.balanceAmount, account.balanceCurrency)} />
                  <Fact label={t('todayTokens')} value={tokens(account.todayTokens)} />
                  <Fact label={t('totalTokens')} value={tokens(account.totalTokens)} />
                  <Fact label={t('todayCost')} value={money(account.todayCost, account.usageCurrency)} />
                  <Fact label={t('totalCost')} value={money(account.totalCost, account.usageCurrency)} />
                  {account.keyName === null ? null : <Fact label={t('keyName')} value={account.keyName} wide />}
                  <Fact label={t('endpoint')} value={state.endpoint} wide />
                </dl>
              )
              : null}

            {phase === 'connected'
              ? (
                <div>
                  <p className={css.muted}>{state.keyReady ? t('keyReady') : t('keyMissing')}</p>
                  <p className={css.muted}>{state.codexKeyReady ? t('codexReady') : t('codexMissing')}</p>
                  <p className={css.muted}>{t('failoverHint')}</p>
                  {state.activeChannel === undefined ? null : <p className={css.muted}>{t('activeChannel', { channel: state.activeChannel === 'deepseek' ? 'DeepSeek / Messages' : 'Codex / OpenAI' })}</p>}
                  {state.channelError === undefined ? null : <p className={css.muted}>{t('codexMissing')}</p>}
                  {state.source !== 'opl'
                    ? null
                    : <p className={css.muted}>{t('connectedViaOpl')}</p>}
                  {state.source !== 'opl' || account?.observedAt === undefined || account.observedAt === null
                    ? null
                    : (
                      <p className={css.muted} title={observedLabel(account.observedAt)}>
                        {t('observedAt', { time: observedAge(account.observedAt, t) })}
                        {account.stale === true ? ` · ${t('observedStale')}` : ''}
                      </p>
                    )}
                </div>
              )
              : (
                <form
                  className={css.form}
                  onSubmit={(event) => { event.preventDefault(); void submit() }}
                >
                  <p className={css.muted}>{state.keyReady ? t('keyAlreadyConfigured') : t('notSignedInHint')}</p>
                  <label className={css.field}>
                    <span className={css.label}>{t('email')}</span>
                    <input
                      className={css.input}
                      type='email'
                      autoComplete='username'
                      placeholder={t('emailPlaceholder')}
                      value={email}
                      onChange={(event) => { setEmail(event.target.value) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.label}>{t('password')}</span>
                    <input
                      className={css.input}
                      type='password'
                      autoComplete='current-password'
                      placeholder={t('passwordPlaceholder')}
                      value={password}
                      onChange={(event) => { setPassword(event.target.value) }}
                    />
                  </label>
                  <div className={css.actions}>
                    <Button
                      type='submit'
                      disabled={busy !== 'idle' || email.trim() === '' || password === ''}
                    >
                      {busy === 'signing-in' ? t('signingIn') : t('signIn')}
                    </Button>
                  </div>
                </form>
              )}
          </div>
        )}
    </div>
  )
}
