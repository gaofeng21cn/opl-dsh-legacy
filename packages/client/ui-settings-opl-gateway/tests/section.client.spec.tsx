// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayAccountStatus } from '@one-person-lab/dsh-llm-opl-gateway/types'
import { OplGatewaySection } from '../src/client/OplGatewaySection.tsx'
import type { OplGatewaySectionProps } from '../src/client/OplGatewaySection.tsx'
import { en, type OplGatewayLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: OplGatewayLocaleKey, params?: Record<string, string | number>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    en[key],
  )

const MODELS = [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }]

const SIGNED_OUT: GatewayAccountStatus = {
  phase: 'signed-out',
  endpoint: 'https://gateway.example/v1',
  keyReady: false,
  models: MODELS,
}

const SIGNED_IN: GatewayAccountStatus = {
  phase: 'connected',
  endpoint: 'https://gateway.example/v1',
  keyReady: true,
  models: MODELS,
  source: 'session',
  account: {
    displayName: 'Person',
    email: 'person@example.test',
    status: 'active',
    balanceAmount: 12.5,
    balanceCurrency: 'USD',
    todayTokens: 1024,
    totalTokens: 4096,
    todayCost: 0.25,
    totalCost: 3,
    usageCurrency: 'USD',
    keyName: 'DSH · machine',
  },
}

/** The section with one injected face, defaulting to a signed-out account. */
function props(overrides: Partial<OplGatewaySectionProps> & { initial?: GatewayAccountStatus } = {}) {
  const initial = overrides.initial ?? SIGNED_OUT
  const status = vi.fn(async () => initial)
  const signIn = vi.fn(async () => ({ status: SIGNED_IN, createdKey: true }))
  const refresh = vi.fn(async () => initial)
  const signOut = vi.fn(async () => SIGNED_OUT)
  const component = {
    t,
    status: overrides.status ?? status,
    signIn: overrides.signIn ?? signIn,
    refresh: overrides.refresh ?? refresh,
    signOut: overrides.signOut ?? signOut,
  } as unknown as OplGatewaySectionProps
  return { status, signIn, refresh, signOut, component }
}

describe('signed out', () => {
  it('says a key is already configured when one resolves', async () => {
    const harness = props({ initial: { ...SIGNED_OUT, keyReady: true } })
    render(<OplGatewaySection {...harness.component} />)

    expect(await screen.findByText(en.keyAlreadyConfigured)).toBeTruthy()
  })

  it('asks for the account and keeps sign-in disabled until both fields are given', async () => {
    const harness = props()
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    const submit = screen.getByRole('button', { name: en.signIn })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(en.email), { target: { value: 'person@example.test' } })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(document.querySelector('input[type=password]') as HTMLInputElement, { target: { value: 'secret' } })
    expect((submit as HTMLButtonElement).disabled).toBe(false)
  })

  it('signs in once and reports the key it obtained', async () => {
    const harness = props()
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    fireEvent.change(screen.getByLabelText(en.email), { target: { value: 'person@example.test' } })
    fireEvent.change(document.querySelector('input[type=password]') as HTMLInputElement, { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))

    await waitFor(() => { expect(harness.signIn).toHaveBeenCalledWith('person@example.test', 'secret') })
    expect(await screen.findByText(en.createdKey)).toBeTruthy()
    // The form, and with it the password field, is gone: the successful answer
    // replaces the credential entry rather than leaving it mounted.
    expect(document.querySelector('input[type=password]')).toBeNull()
  })

  it('shows the gateway\u2019s own sentence when a sign-in fails', async () => {
    const signIn = vi.fn(async () => { throw new Error('The account email or password is incorrect') })
    const harness = props({ signIn: signIn as unknown as OplGatewaySectionProps['signIn'] })
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    fireEvent.change(screen.getByLabelText(en.email), { target: { value: 'person@example.test' } })
    fireEvent.change(document.querySelector('input[type=password]') as HTMLInputElement, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: en.signIn }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      en.failure.replace('{message}', 'The account email or password is incorrect'),
    )
  })
})

describe('signed in', () => {
  it('renders the account facts and the inference endpoint', async () => {
    const harness = props({ initial: SIGNED_IN })
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    expect(await screen.findByText(text => text.includes('person@example.test'))).toBeTruthy()
    expect(screen.getByText('12.50 USD')).toBeTruthy()
    expect(screen.getByText('1,024')).toBeTruthy()
    expect(screen.getByText('DSH · machine')).toBeTruthy()
    expect(screen.getByText(SIGNED_IN.endpoint)).toBeTruthy()
    expect(screen.getByText(en.keyReady)).toBeTruthy()
  })

  it('says when the account came from OPL instead of asking for a password', async () => {
    const harness = props({
      initial: {
        ...SIGNED_IN,
        source: 'opl',
        account: { ...SIGNED_IN.account!, observedAt: '2026-09-08T03:08:36.365Z', stale: true },
      },
    })
    render(<OplGatewaySection {...harness.component} />)

    expect(await screen.findByText(en.connectedViaOpl)).toBeTruthy()
    expect(screen.getByText(text => text.includes(en.observedStale))).toBeTruthy()
    // No credential entry: the account is already usable as it stands.
    expect(document.querySelector('input[type=password]')).toBeNull()
  })

  it('offers sign-out only for a session this client holds', async () => {
    const harness = props({ initial: SIGNED_IN })
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    expect(await screen.findByRole('button', { name: en.refresh })).toBeTruthy()
    expect(await screen.findByRole('button', { name: en.signOut })).toBeTruthy()
  })

  it('ends the session through the injected face', async () => {
    const harness = props({ initial: SIGNED_IN })
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    await waitFor(() => { expect(harness.signOut).toHaveBeenCalled() })
    expect(await screen.findByRole('button', { name: en.signIn })).toBeTruthy()
  })

  it('hides sign-out for an account merely read from OPL', async () => {
    const harness = props({ initial: { ...SIGNED_IN, source: 'opl' } })
    render(<OplGatewaySection {...harness.component} />)
    await waitFor(() => { expect(harness.status).toHaveBeenCalled() })

    expect(await screen.findByRole('button', { name: en.refresh })).toBeTruthy()
    // Signing out here would end a session this client never opened.
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
  })

})

describe('page purpose', () => {
  it('names the models this page provides so it is not mistaken for a provider form', async () => {
    const harness = props()
    render(<OplGatewaySection {...harness.component} />)

    expect(await screen.findByText(en.provides.replace('{names}', 'DeepSeek-V4.1-Flash'))).toBeTruthy()
  })
})
