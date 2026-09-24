/**
 * Read the credential OPL already provisioned for its own gateway binding.
 *
 * The OPL application owns every file under its state directory; this module
 * only reads them. It never rotates OPL's session or writes OPL state, so an
 * OPL sign-out, key rotation, or state migration cannot be caused here.
 */

import { readFileSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'

/** Canonical OPL Gateway inference root. */
export const OPL_GATEWAY_INFERENCE_BASE_URL = 'https://gateway.medopl.com/v1'

/**
 * Endpoints the gateway served before the canonical one.
 *
 * The old host is the same service, so an account bound to it is not broken —
 * but a client that keeps calling the legacy name keeps depending on a name
 * OPL itself has moved off. These are recognized and upgraded rather than
 * simply accepted; see {@link resolveInferenceBaseURL}.
 */
export const OPL_GATEWAY_LEGACY_INFERENCE_BASE_URLS = ['https://gflabtoken.cn/v1'] as const

/**
 * Resolve the endpoint this deployment should actually call.
 *
 * A binding records whatever host was current when OPL wrote it, so an
 * untouched machine can still name the legacy host. Calling it would work and
 * would also be wrong: it pins this client to a name the service has moved
 * away from. A legacy record is therefore upgraded to the canonical root,
 * while any other URL — a self-hosted or regional deployment — is honored
 * exactly as written, because that one is a deliberate choice.
 * @param bound - endpoint recorded by the binding, when it records one.
 * @returns the endpoint to use.
 */
export function resolveInferenceBaseURL(bound: string | null | undefined): string {
  const trimmed = bound?.trim()
  if (trimmed === undefined || trimmed === '') return OPL_GATEWAY_INFERENCE_BASE_URL
  const normalized = trimmed.replace(/\/+$/u, '')
  const legacy = OPL_GATEWAY_LEGACY_INFERENCE_BASE_URLS.some(candidate => candidate === normalized)
  return legacy ? OPL_GATEWAY_INFERENCE_BASE_URL : trimmed
}

/** Environment override naming the OPL Gateway state directory. */
export const OPL_GATEWAY_STATE_ROOT_ENV = 'OPL_GATEWAY_STATE_ROOT'

/** State-directory suffix below the user's home on macOS. */
const STATE_DIRECTORY_SUFFIX = ['Library', 'Application Support', 'OPL', 'state', 'gateway'] as const

/** State-directory suffix below a Windows roaming or local application-data root. */
const WINDOWS_STATE_DIRECTORY_SUFFIX = ['OPL', 'state', 'gateway'] as const

/**
 * Windows application-data roots the OPL app may have used, most specific first.
 *
 * Roaming leads because that is where a Windows application keeps per-account
 * state, with Local as the fallback for a deployment that stored it per machine.
 * Both may be absent, in which case there is simply nothing to reuse.
 * @param env - environment carrying the Windows application-data roots.
 * @returns distinct absolute roots, or an empty list.
 */
function windowsStateRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.APPDATA, env.LOCALAPPDATA]
    .map(root => root?.trim())
    .filter((root): root is string => root !== undefined && root !== '')
  return [...new Set(roots)]
}

/**
 * Resolve every OPL Gateway state directory this platform could use.
 *
 * The OPL application owns this directory and this module only reads it, so an
 * absent one is an ordinary answer rather than an error: a machine with no OPL
 * installation installs nothing here, which is exactly the case the in-app
 * sign-in exists for.
 *
 * The candidates are built with the named platform's own separators rather than
 * the host's, so a caller asking about macOS gets a macOS-shaped answer even
 * when it runs on Windows, and vice versa.
 * @param home - user's home directory.
 * @param env - environment carrying the optional override and Windows roots.
 * @param platform - platform whose layout applies.
 * @returns absolute state directories to try, most specific first.
 */
export function oplGatewayStateDirectories(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const configured = env[OPL_GATEWAY_STATE_ROOT_ENV]?.trim()
  if (configured !== undefined && configured !== '') return [configured]
  if (platform === 'win32') {
    return windowsStateRoots(env).map(root => win32.join(root, ...WINDOWS_STATE_DIRECTORY_SUFFIX))
  }
  return [posix.join(home, ...STATE_DIRECTORY_SUFFIX)]
}

/**
 * Resolve the OPL Gateway state directory.
 *
 * Kept as the single-path form of {@link oplGatewayStateDirectories} for callers
 * that only need the platform's primary location.
 * @param home - user's home directory.
 * @param env - environment carrying the optional override.
 * @param platform - platform whose layout applies.
 * @returns absolute state directory path.
 */
export function oplGatewayStateDirectory(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const candidates = oplGatewayStateDirectories(home, env, platform)
  if (candidates[0] !== undefined) return candidates[0]
  return platform === 'win32'
    ? win32.join(home, ...WINDOWS_STATE_DIRECTORY_SUFFIX)
    : posix.join(home, ...STATE_DIRECTORY_SUFFIX)
}

/** One gateway credential OPL bound to a client configuration. */
export interface OplGatewayKey {
  /** Bearer token OPL provisioned for this account. */
  readonly key: string
  /** Inference root recorded beside the token. */
  readonly baseURL: string
  /** Provider id OPL used inside the bound configuration. */
  readonly providerId: string
}

/**
 * The account facts OPL already recorded for its own gateway binding.
 *
 * Read-only on purpose. OPL owns this file and refreshes it on its own
 * schedule; a second product that re-fetched the same facts would double the
 * traffic and could disagree with the values OPL shows its own pages.
 */
export interface OplGatewayAccount {
  /** Gateway account status as OPL last observed it. */
  readonly status: string
  readonly displayName: string | null
  readonly email: string | null
  readonly accountStatus: string | null
  readonly balanceAmount: number | null
  readonly balanceCurrency: string
  readonly todayTokens: number | null
  readonly totalTokens: number | null
  readonly todayCost: number | null
  readonly totalCost: number | null
  readonly usageCurrency: string
  /** Name of the key OPL manages for this account. */
  readonly keyName: string | null
  readonly keyStatus: string | null
  /** When OPL last refreshed these facts. */
  readonly observedAt: string | null
  /** Whether the observation is past OPL's own freshness window. */
  readonly stale: boolean
  /** Why OPL's last refresh failed, when one did. */
  readonly lastErrorCode: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function privateFileText(path: string): string | undefined {
  try {
    const stats = lstatSync(path)
    // OPL refuses symbolic links and foreign ownership for this state; a
    // reader must not accept what the owner rejects.
    if (stats.isSymbolicLink() || !stats.isFile()) return undefined
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Read the client binding OPL recorded for its managed gateway key.
 * @param stateDirectory - OPL Gateway state directory.
 * @returns the bound configuration path and provider id, or undefined.
 */
export function readOplGatewayBinding(stateDirectory: string): { configPath: string; providerId: string } | undefined {
  const text = privateFileText(join(stateDirectory, 'account.json'))
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const binding = parsed.codex_binding
  if (!isRecord(binding)) return undefined
  const configPath = binding.config_path
  const providerId = binding.provider_id
  if (typeof configPath !== 'string' || configPath.trim() === '') return undefined
  if (typeof providerId !== 'string' || providerId.trim() === '') return undefined
  return { configPath: configPath.trim(), providerId: providerId.trim() }
}

function accountText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function accountNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/**
 * Read the account facts OPL recorded for its own gateway binding.
 *
 * Accepts several candidate directories so the account page reads the same
 * location the key import does: on Windows either application-data root may be
 * the one OPL chose, and a page that looked at only one of them would report
 * "not signed in" while requests still worked.
 * @param stateDirectory - OPL Gateway state directory, or candidates to try in order.
 * @returns the recorded account, or undefined when OPL has none.
 */
export function readOplGatewayAccount(stateDirectory: string | readonly string[]): OplGatewayAccount | undefined {
  const candidates = typeof stateDirectory === 'string' ? [stateDirectory] : stateDirectory
  for (const candidate of candidates) {
    const account = readOplGatewayAccountAt(candidate)
    if (account !== undefined) return account
  }
  return undefined
}

/**
 * Read the account OPL recorded in exactly one directory.
 * @param stateDirectory - OPL Gateway state directory.
 * @returns the recorded account, or undefined when this directory holds none.
 */
function readOplGatewayAccountAt(stateDirectory: string): OplGatewayAccount | undefined {
  const text = privateFileText(join(stateDirectory, 'account.json'))
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const status = accountText(parsed.status)
  if (status === null) return undefined
  const snapshot = isRecord(parsed.snapshot) ? parsed.snapshot : {}
  const observedAt = accountText(parsed.observed_at)
  const staleAfter = accountText(parsed.stale_after)
  // OPL records when the observation stops being trustworthy; comparing
  // against it keeps this page from presenting a stale balance as current.
  const stale = staleAfter !== null && Number.isFinite(Date.parse(staleAfter))
    ? Date.parse(staleAfter) <= Date.now()
    : false
  return {
    status,
    displayName: accountText(snapshot.display_name),
    email: accountText(snapshot.email),
    accountStatus: accountText(snapshot.account_status),
    balanceAmount: accountNumber(snapshot.balance_amount),
    balanceCurrency: accountText(snapshot.balance_currency) ?? 'USD',
    todayTokens: accountNumber(snapshot.today_tokens),
    totalTokens: accountNumber(snapshot.total_tokens),
    todayCost: accountNumber(snapshot.today_actual_cost),
    totalCost: accountNumber(snapshot.total_actual_cost),
    usageCurrency: accountText(snapshot.currency) ?? accountText(snapshot.cost_currency) ?? 'USD',
    keyName: accountText(parsed.canonical_key_name),
    keyStatus: accountText(parsed.key_status),
    observedAt,
    stale,
    lastErrorCode: accountText(parsed.last_error_code),
  }
}

/** One value inside a TOML section. */
function sectionValue(section: readonly string[], name: string): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*(?:#.*)?$`, 'u')
  for (const line of section) {
    const match = pattern.exec(line)
    if (match !== null) {
      const value = (match[1] ?? match[2] ?? '').trim()
      return value === '' ? undefined : value
    }
  }
  return undefined
}

/**
 * Extract one provider's bearer token from a client configuration.
 * @param text - TOML document text.
 * @param providerId - provider id whose section holds the token.
 * @returns the token and its recorded endpoint, or undefined.
 */
export function readBoundGatewayKey(
  text: string,
  providerId: string,
): { key: string; baseURL: string | undefined } | undefined {
  const headerPattern = new RegExp(`^\\s*\\[\\s*model_providers\\s*\\.\\s*(?:"${escapeRegExp(providerId)}"|'${escapeRegExp(providerId)}'|${escapeRegExp(providerId)})\\s*\\]\\s*$`, 'u')
  const lines = text.split(/\r?\n/u)
  let section: string[] | undefined
  for (const line of lines) {
    const other = /^\s*\[/u.test(line)
    if (headerPattern.test(line)) {
      section = []
      continue
    }
    if (section === undefined) continue
    if (other) break
    section.push(line)
  }
  if (section === undefined) return undefined
  const key = sectionValue(section, 'experimental_bearer_token')
  if (key === undefined) return undefined
  return { key, baseURL: sectionValue(section, 'base_url') }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Import the gateway key OPL provisioned for this account.
 *
 * An explicit `stateDirectory` names one location, or several to try in order.
 * Otherwise every candidate this platform could have used is tried, so a
 * Windows installation finds state under whichever application-data root OPL
 * chose, and a machine with no OPL installation simply yields `undefined`
 * rather than failing to start.
 * @param options - state directory candidates and expected provider id overrides.
 * @returns the imported credential, or undefined when OPL has none to offer.
 */
export function importOplGatewayKey(
  options: { stateDirectory?: string | readonly string[]; providerId?: string } = {},
): OplGatewayKey | undefined {
  const requested = options.stateDirectory
  const candidates = requested === undefined
    ? oplGatewayStateDirectories()
    : typeof requested === 'string' ? [requested] : requested
  for (const stateDirectory of candidates) {
    // General Codex/AGI bindings are not credentials for this native DeepSeek route.
    const accountText = privateFileText(join(stateDirectory, 'account.json'))
    if (accountText === undefined) continue
    let account: unknown
    try { account = JSON.parse(accountText) } catch { continue }
    if (!isRecord(account) || !Array.isArray(account.available_groups)) continue
    const group = account.available_groups.find((entry: unknown) => isRecord(entry)
      && String(entry.group_id) === String(account.key_group_id)
      && typeof entry.label === 'string' && entry.label.trim().toLowerCase() === 'deepseek')
    if (group === undefined) continue
    const binding = readOplGatewayBinding(stateDirectory)
    if (binding === undefined) continue
    if (options.providerId !== undefined && options.providerId !== binding.providerId) continue
    const text = privateFileText(binding.configPath)
    if (text === undefined) continue
    const bound = readBoundGatewayKey(text, binding.providerId)
    if (bound === undefined) continue
    return {
      key: bound.key,
      baseURL: resolveInferenceBaseURL(bound.baseURL),
      providerId: binding.providerId,
    }
  }
  return undefined
}
