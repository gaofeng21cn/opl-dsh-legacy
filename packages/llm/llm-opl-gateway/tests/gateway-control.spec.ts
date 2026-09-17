/**
 * The control-plane client.
 *
 * The gateway is an independent service, so these cover the protocol this
 * plugin speaks to it — the only thing standing between a fresh machine and a
 * working account.
 */
import { describe, expect, it, vi } from 'vitest'
import { GatewayControlClient, GatewayControlError } from '../src/gateway-control.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** One client over a scripted transport, recording every request it made. */
function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(url), init: init ?? {} }
    calls.push(request)
    return handler(request.url, request.init)
  })
  return {
    control: new GatewayControlClient('https://gateway.test/api/v1', fetchImpl as unknown as typeof fetch),
    calls,
  }
}

describe('sign-in', () => {
  it('returns the token pair the gateway issued', async () => {
    const { control, calls } = client(() => jsonResponse({ code: 0, data: { access_token: 'access', refresh_token: 'refresh' } }))
    expect(await control.login('person@example.test', 'secret')).toEqual({ accessToken: 'access', refreshToken: 'refresh' })
    expect(calls[0]?.url).toBe('https://gateway.test/api/v1/auth/login')
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ email: 'person@example.test', password: 'secret' })
  })

  it('reports rejected credentials with copy the page can show', async () => {
    const { control, calls } = client(() => jsonResponse({ message: 'no' }, 401))
    await expect(control.login('person@example.test', 'wrong')).rejects.toMatchObject({
      code: 'invalid_credentials',
      message: 'The account email or password is incorrect',
    })
    // A refusal is an answer, not a transient fault: the write is not retried.
    expect(calls).toHaveLength(1)
  })

  it('refuses a session the gateway cannot persist', async () => {
    const { control } = client(() => jsonResponse({ code: 0, data: { access_token: 'access' } }))
    await expect(control.login('person@example.test', 'secret')).rejects.toMatchObject({ code: 'session_unavailable' })
  })

  it('names an interactive challenge instead of pretending to sign in', async () => {
    const { control } = client(() => jsonResponse({ code: 0, data: { requires_2fa: true } }))
    await expect(control.login('person@example.test', 'secret')).rejects.toMatchObject({ code: 'challenge_required' })
  })

  it('treats a success envelope carrying a refusal code as a refusal', async () => {
    const { control } = client(() => jsonResponse({ code: 40001, message: 'quota exhausted' }))
    await expect(control.login('person@example.test', 'secret')).rejects.toMatchObject({
      code: 'request_rejected',
      message: 'quota exhausted',
    })
  })
})

describe('session renewal', () => {
  it('returns the rotated pair', async () => {
    const { control, calls } = client(() => jsonResponse({ code: 0, data: { access_token: 'a2', refresh_token: 'r2' } }))
    expect(await control.refreshSession('r1')).toEqual({ accessToken: 'a2', refreshToken: 'r2' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ refresh_token: 'r1' })
  })

  it('reports a renewal it cannot confirm instead of reusing a dead token', async () => {
    const { control } = client(() => jsonResponse({ code: 0, data: { access_token: 'a2' } }))
    await expect(control.refreshSession('r1')).rejects.toMatchObject({ code: 'reauth_required' })
  })
})

describe('account reads', () => {
  it('reads the profile behind an access token', async () => {
    const { control, calls } = client(() => jsonResponse({
      code: 0,
      data: { user: { id: 7, username: 'Person', email: 'person@example.test', status: 'active', balance: 12.5, currency: 'USD' } },
    }))
    expect(await control.profile('access')).toMatchObject({
      userId: '7', displayName: 'Person', email: 'person@example.test', balanceAmount: 12.5, balanceCurrency: 'USD',
    })
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer access' })
  })

  it('reads usage totals', async () => {
    const { control } = client(() => jsonResponse({ code: 0, data: { today_tokens: 10, total_tokens: 99, today_actual_cost: 0.5 } }))
    expect(await control.usage('access')).toMatchObject({ todayTokens: 10, totalTokens: 99, todayCost: 0.5 })
  })

  it('lists groups and keys, skipping entries without a usable key', async () => {
    const groups = client(() => jsonResponse({ code: 0, data: { groups: [{ id: 3, name: 'Codex' }, { id: 9, name: 'AGI' }] } }))
    expect(await groups.control.groups('access')).toEqual([{ id: '3', label: 'Codex' }, { id: '9', label: 'AGI' }])
    const keys = client(() => jsonResponse({
      code: 0,
      data: { keys: [{ id: 1, name: 'OPL DSH', key: 'sk-1', status: 'active' }, { id: 2, name: 'x' }] },
    }))
    expect(await keys.control.keys('access')).toEqual([
      { id: '1', name: 'OPL DSH', key: 'sk-1', status: 'active', groupId: null, raw: { id: 1, name: 'OPL DSH', key: 'sk-1', status: 'active' } },
    ])
  })
})

describe('key lifecycle', () => {
  it('issues a key in the chosen group', async () => {
    const { control, calls } = client(() => jsonResponse({ code: 0, data: { id: 5, name: 'OPL DSH', key: 'sk-new' } }))
    expect(await control.createKey('access', 'OPL DSH', '3')).toMatchObject({ id: '5', key: 'sk-new' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: 'OPL DSH', group_id: 3 })
  })

  it('omits the group when none applies', async () => {
    const { control, calls } = client(() => jsonResponse({ code: 0, data: { id: 5, name: 'OPL DSH', key: 'sk-new' } }))
    await control.createKey('access', 'OPL DSH', null)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: 'OPL DSH' })
  })

  it('reports a created key the gateway never returned', async () => {
    const { control } = client(() => jsonResponse({ code: 0, data: { id: 5, name: 'OPL DSH' } }))
    await expect(control.createKey('access', 'OPL DSH', null)).rejects.toMatchObject({ code: 'key_unavailable' })
  })

  it('preserves the fields it does not own when changing a key status', async () => {
    const { control, calls } = client(() => jsonResponse({ code: 0, data: {} }))
    const key = {
      id: '5',
      name: 'OPL DSH',
      key: 'sk-1',
      status: 'active',
      groupId: '3',
      // Fields this client does not interpret must travel back unchanged: a
      // status change is a full replace, so dropping them would silently
      // rewrite the key's expiry and quota.
      raw: { id: 5, name: 'OPL DSH', key: 'sk-1', status: 'active', group_id: 3, expires_at: '2027-01-01', quota: 100 },
    }
    await control.setKeyStatus('access', key, 'disabled')
    expect(calls[0]?.url).toBe('https://gateway.test/api/v1/keys/5')
    expect(calls[0]?.init.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      id: 5, name: 'OPL DSH', key: 'sk-1', status: 'disabled', group_id: 3, expires_at: '2027-01-01', quota: 100,
    })
  })
})

describe('transport failures', () => {
  it('names unreachable hosts', async () => {
    const { control } = client(() => { throw new TypeError('fetch failed') })
    await expect(control.profile('access')).rejects.toBeInstanceOf(GatewayControlError)
    await expect(control.profile('access')).rejects.toMatchObject({ code: 'network_unreachable' })
  })

  it('retries read-only requests before giving up', async () => {
    let attempts = 0
    const { control } = client(() => {
      attempts += 1
      return attempts < 2 ? new Response('busy', { status: 503 }) : jsonResponse({ code: 0, data: { user: { username: 'Person' } } })
    })
    expect(await control.profile('access')).toMatchObject({ displayName: 'Person' })
    expect(attempts).toBe(2)
  })

  it('refuses an oversized response instead of buffering it', async () => {
    const { control } = client(() => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }))
    await expect(control.profile('access')).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('refuses a body that is not JSON', async () => {
    const { control } = client(() => new Response('<html></html>', { status: 200 }))
    await expect(control.profile('access')).rejects.toMatchObject({ code: 'response_invalid' })
  })

  it('reports the public settings it can read without a session', async () => {
    const { control, calls } = client(() => jsonResponse({ code: 0, data: { turnstile_enabled: true, totp_enabled: false } }))
    expect(await control.publicSettings()).toEqual({ turnstile: true, totp: false })
    expect(calls[0]?.init.headers).not.toMatchObject({ authorization: expect.anything() })
  })
})
