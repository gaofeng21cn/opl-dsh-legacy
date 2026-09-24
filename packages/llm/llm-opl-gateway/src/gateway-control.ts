/**
 * The OPL Gateway control API.
 *
 * The gateway is an independent service: it authenticates accounts, issues
 * inference keys, and reports usage over its own HTTP API. OPL Framework is a
 * *client* of that API, not a prerequisite for it, so this plugin speaks the
 * protocol directly and works on a machine that has never installed OPL.
 *
 * Two hosts of one service: `/api/v1` manages accounts and keys, while `/v1`
 * serves model traffic. This module owns the control plane only; the adapter
 * carries inference.
 */

/** Account-facing control root. */
export const OPL_GATEWAY_CONTROL_BASE_URL = 'https://gateway.medopl.com/api/v1'

/** Largest control response this client will buffer. */
const MAX_RESPONSE_BYTES = 1024 * 1024

/** How long one control request may take before it is aborted. */
const REQUEST_TIMEOUT_MS = 15_000

/** Transient control failures retried for read-only requests. */
const READ_ATTEMPTS = 3

/** One failure reported by the control plane. */
export class GatewayControlError extends Error {
  constructor(
    /** Stable reason code callers branch on. */
    readonly code: string,
    message: string,
    /** HTTP status when the failure came from a response. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GatewayControlError'
  }
}

/** Credentials returned by one successful sign-in or refresh. */
export interface GatewaySession {
  readonly accessToken: string
  readonly refreshToken: string
}

/** The signed-in account as the gateway reports it. */
export interface GatewayProfile {
  readonly userId: string | null
  readonly displayName: string | null
  readonly email: string | null
  readonly status: string
  readonly balanceAmount: number | null
  readonly balanceCurrency: string
}

/** Token and cost totals for the account. */
export interface GatewayUsage {
  readonly todayTokens: number | null
  readonly totalTokens: number | null
  readonly todayCost: number | null
  readonly totalCost: number | null
  readonly currency: string
}

/** One key the account owns. */
export interface GatewayManagedKey {
  readonly id: string
  readonly name: string
  readonly key: string
  readonly status: string
  readonly groupId: string | null
  /**
   * The key exactly as the gateway returned it.
   *
   * A status change is a full replace, so every field this client does not
   * interpret (expiry, quota, allowlists) has to travel back unchanged. Without
   * the original body, disabling a key would silently drop them.
   */
  readonly raw: Readonly<Record<string, unknown>>
}

type FetchLike = typeof fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Peel the gateway's `{ code, message, data }` envelope. */
function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (value.data !== undefined) return value.data
  if (value.result !== undefined) return value.result
  return value
}

function record(value: unknown): Record<string, unknown> {
  const inner = unwrap(value)
  return isRecord(inner) ? inner : {}
}

/**
 * Read one list field, accepting either a bare array or a paged object.
 * @param value - parsed response body.
 * @param fields - object fields that may carry the list.
 * @returns the list, or an empty array.
 */
function list(value: unknown, fields: readonly string[]): unknown[] {
  const inner = unwrap(value)
  if (Array.isArray(inner)) return inner
  if (isRecord(inner)) {
    for (const field of fields) {
      if (Array.isArray(inner[field])) return inner[field] as unknown[]
    }
  }
  return []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return text(value)
}

function failureCode(status: number): string {
  if (status === 401) return 'invalid_credentials'
  if (status === 403) return 'account_disabled'
  if (status === 409) return 'gateway_conflict'
  if (status === 422) return 'request_rejected'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'gateway_unavailable'
  return 'request_failed'
}

/**
 * Name one rejection in terms the person operating the page can act on.
 * @param code - code derived from the status.
 * @param status - HTTP status the gateway returned.
 * @returns a sentence safe to show verbatim.
 */
function rejectionMessage(code: string, status: number): string {
  switch (code) {
    case 'invalid_credentials': return 'The account email or password is incorrect'
    case 'account_disabled': return 'This account is disabled'
    case 'rate_limited': return 'Too many attempts; try again in a moment'
    case 'gateway_unavailable': return 'OPL Gateway is temporarily unavailable'
    default: return `OPL Gateway refused the request (HTTP ${String(status)})`
  }
}

/** One control-plane client bound to a base URL and fetch implementation. */
export class GatewayControlClient {
  constructor(
    private readonly baseURL: string = OPL_GATEWAY_CONTROL_BASE_URL,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request(
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; accessToken?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const method = options.method ?? 'GET'
    const attempts = method === 'GET' ? READ_ATTEMPTS : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
      try {
        const response = await this.fetchImpl(`${this.baseURL}${path}`, {
          method,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            accept: 'application/json',
            ...options.body === undefined ? {} : { 'content-type': 'application/json' },
            ...options.accessToken === undefined ? {} : { authorization: `Bearer ${options.accessToken}` },
          },
          ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
        })
        if (!response.ok) {
          const code = failureCode(response.status)
          // A refusal is an answer, not a transient fault: name what the person
          // can act on, without echoing the gateway's own text (which can carry
          // account-specific detail).
          throw new GatewayControlError(code, rejectionMessage(code, response.status), response.status)
        }
        const raw = await response.text()
        if (raw.length > MAX_RESPONSE_BYTES) {
          throw new GatewayControlError('response_too_large', 'OPL Gateway returned an oversized response')
        }
        if (raw === '') return {}
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        }
        catch {
          throw new GatewayControlError('response_invalid', 'OPL Gateway returned an invalid response')
        }
        // The envelope carries its own success flag; a non-zero code is a
        // refusal even when the HTTP status was 200.
        if (isRecord(parsed) && parsed.code !== undefined) {
          const code = parsed.code
          const ok = code === 0 || code === 200 || code === '0' || code === '200' || code === 'success'
          if (!ok) {
            const message = text(parsed.message) ?? 'OPL Gateway refused the request'
            throw new GatewayControlError('request_rejected', message)
          }
        }
        return parsed
      }
      catch (error) {
        lastError = error
        if (error instanceof GatewayControlError
          && (error.status === undefined || (error.status < 500 && error.status !== 429))) {
          throw error
        }
        if (attempt + 1 >= attempts) break
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
      }
      finally {
        clearTimeout(timer)
      }
    }
    const aborted = lastError instanceof Error && lastError.name === 'AbortError'
    throw new GatewayControlError(
      aborted ? 'network_timeout' : 'network_unreachable',
      aborted ? 'OPL Gateway did not answer in time' : 'OPL Gateway could not be reached',
    )
  }

  /**
   * Whether the deployment requires an interactive challenge before login.
   * @returns whether sign-in presents a Turnstile challenge and whether the account needs an interactive verification step.
   */
  async publicSettings(): Promise<{ turnstile: boolean; totp: boolean }> {
    const value = record(await this.request('/settings/public'))
    return {
      turnstile: value.turnstile_enabled === true || value.turnstileEnabled === true,
      totp: value.totp_enabled === true || value.totpEnabled === true || value.require_totp === true,
    }
  }

  /**
   * Exchange an email and password for a session.
   * @param email - account email.
   * @param password - account password.
   * @returns the session tokens.
   */
  async login(email: string, password: string): Promise<GatewaySession> {
    const value = record(await this.request('/auth/login', { method: 'POST', body: { email, password } }))
    const accessToken = text(value.access_token ?? value.accessToken ?? value.token)
    const refreshToken = text(value.refresh_token ?? value.refreshToken)
    if (value.requires_2fa === true || text(value.temp_token ?? value.tempToken) !== null) {
      throw new GatewayControlError('challenge_required', 'This account needs an interactive verification step')
    }
    if (accessToken === null || refreshToken === null) {
      throw new GatewayControlError('session_unavailable', 'OPL Gateway did not return a usable session')
    }
    return { accessToken, refreshToken }
  }

  /**
   * Trade a refresh token for a fresh session.
   * @param refreshToken - token stored by the last successful sign-in.
   * @returns the rotated session.
   */
  async refreshSession(refreshToken: string): Promise<GatewaySession> {
    const value = record(await this.request('/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } }))
    const accessToken = text(value.access_token ?? value.accessToken ?? value.token)
    const nextRefreshToken = text(value.refresh_token ?? value.refreshToken)
    if (accessToken === null || nextRefreshToken === null) {
      throw new GatewayControlError('reauth_required', 'The stored session could not be renewed')
    }
    return { accessToken, refreshToken: nextRefreshToken }
  }

  /**
   * Read the account behind an access token.
   * @param accessToken - session token from {@link login} or {@link refreshSession}.
   * @returns the identity, status, and balance fields the account page presents.
   */
  async profile(accessToken: string): Promise<GatewayProfile> {
    const value = record(await this.request('/user/profile', { accessToken }))
    const user = isRecord(value.user) ? value.user : value
    return {
      userId: identifier(user.id ?? user.user_id ?? user.userId),
      displayName: text(user.username ?? user.name ?? user.display_name),
      email: text(user.email),
      status: text(user.status) ?? 'active',
      balanceAmount: numeric(user.balance ?? user.balance_amount ?? value.balance),
      balanceCurrency: text(user.currency ?? value.currency) ?? 'USD',
    }
  }

  /**
   * Read token and cost totals for the account.
   * @param accessToken - session token from {@link login} or {@link refreshSession}.
   * @returns today's and all-time token counts and costs, with their currency.
   */
  async usage(accessToken: string): Promise<GatewayUsage> {
    const value = record(await this.request('/usage/dashboard/stats', { accessToken }))
    return {
      todayTokens: numeric(value.today_tokens),
      totalTokens: numeric(value.total_tokens),
      todayCost: numeric(value.today_actual_cost),
      totalCost: numeric(value.total_actual_cost),
      currency: text(value.currency) ?? 'USD',
    }
  }

  /**
   * List the key groups this account may issue keys in.
   * @param accessToken - session token from {@link login} or {@link refreshSession}.
   * @returns the available groups as ids with display labels.
   */
  async groups(accessToken: string): Promise<Array<{ id: string; label: string }>> {
    const values = list(await this.request('/groups/available', { accessToken }), ['groups', 'items'])
    return values.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const id = identifier(entry.id ?? entry.group_id ?? entry.groupId)
      if (id === null) return []
      return [{ id, label: text(entry.name ?? entry.label) ?? id }]
    })
  }

  /**
   * List the keys this account owns.
   * @param accessToken - session token from {@link login} or {@link refreshSession}.
   * @param search - name substring the gateway matches; an empty string lists every key, up to the gateway's page size.
   * @returns the account's keys, each retaining the object the gateway returned.
   */
  async keys(accessToken: string, search = ''): Promise<GatewayManagedKey[]> {
    const value = await this.request(`/keys?search=${encodeURIComponent(search)}&page_size=100`, { accessToken })
    return list(value, ['keys', 'items']).flatMap((entry): GatewayManagedKey[] => {
      if (!isRecord(entry)) return []
      // The gateway answers either with the key object or with it nested under
      // `key`; only an object can be unwrapped, a bare string would read as none.
      const key = normalizeKey(isRecord(entry.key) ? entry.key : entry)
      return key === undefined ? [] : [key]
    })
  }

  /**
   * Create one inference key for this account.
   * @param accessToken - session token.
   * @param name - key name.
   * @param groupId - key group to issue in, when one was chosen.
   * @returns the created key.
   */
  async createKey(accessToken: string, name: string, groupId: string | null): Promise<GatewayManagedKey> {
    const body: Record<string, unknown> = { name }
    if (groupId !== null) {
      const parsed = Number(groupId)
      if (Number.isSafeInteger(parsed) && parsed > 0) body.group_id = parsed
    }
    const value = record(await this.request('/keys', { method: 'POST', accessToken, body }))
    const key = normalizeKey(isRecord(value.key) ? value.key : value)
    if (key === undefined) {
      throw new GatewayControlError('key_unavailable', 'OPL Gateway created a key without returning it')
    }
    return key
  }

  /**
   * Replace one key's status, preserving every field this client does not own.
   * @param accessToken - session token.
   * @param key - the key to change, as the gateway returned it.
   * @param status - new status.
   */
  async setKeyStatus(accessToken: string, key: GatewayManagedKey, status: string): Promise<void> {
    const preserved = key.raw
    const groupId = key.groupId === null ? null : Number(key.groupId)
    await this.request(`/keys/${encodeURIComponent(key.id)}`, {
      method: 'PUT',
      accessToken,
      body: {
        ...preserved,
        name: key.name,
        status,
        ...groupId !== null && Number.isSafeInteger(groupId) && groupId > 0 ? { group_id: groupId } : {},
      },
    })
  }
}

/** Normalize one key object, or nothing when it carries no usable key. */
function normalizeKey(value: Record<string, unknown> | undefined): GatewayManagedKey | undefined {
  if (value === undefined) return undefined
  const id = identifier(value.id ?? value.key_id ?? value.keyId)
  const name = text(value.name)
  const key = text(value.key ?? value.api_key ?? value.apiKey)
  if (id === null || name === null || key === null) return undefined
  return {
    id,
    name,
    key,
    status: text(value.status) ?? 'active',
    groupId: identifier(value.group_id ?? value.groupId),
    raw: value,
  }
}
