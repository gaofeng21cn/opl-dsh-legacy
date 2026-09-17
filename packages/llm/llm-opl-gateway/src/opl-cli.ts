/**
 * The OPL command line, as this plugin's authority for the gateway account.
 *
 * OPL Framework owns the account: signing in, reconciling the managed key,
 * rotating sessions, and binding that key to a client are its jobs, and it
 * exposes them through `opl connect gateway …`. This plugin deliberately does
 * NOT re-implement that protocol. A second implementation would drift — and
 * would mint a second key under the same account, so one operator would see
 * two keys and two sources of truth for the same balance.
 *
 * The read model below is the CLI's own public surface. Anything this module
 * cannot obtain from it (the inference key's value, which no read model
 * carries) comes from OPL's binding in `./opl-credentials.ts`.
 */

import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Environment override naming the OPL executable, as the OPL applications use. */
export const OPL_BINARY_ENV = 'OPL_APP_OPL_BIN'

/** How long one OPL command may run before it is abandoned. */
const COMMAND_TIMEOUT_MS = 45_000

/** Largest stdout this client will buffer. */
const MAX_OUTPUT_BYTES = 256 * 1024

/** One failure OPL reported, in the vocabulary its CLI uses. */
export class OplCliError extends Error {
  constructor(
    /** Reason code from OPL, or a transport code this module derived. */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OplCliError'
  }
}

/** The gateway account as OPL reports it. */
export interface OplGatewayStatus {
  readonly connected: boolean
  readonly connectionMode: string
  /** Why OPL considers the account unusable, when it does. */
  readonly problem: string | null
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
  readonly keyName: string | null
  readonly stale: boolean
  readonly observedAt: string | null
}

function candidateBinaries(env: NodeJS.ProcessEnv): string[] {
  const configured = env[OPL_BINARY_ENV]?.trim()
  const fromPath = (env.PATH ?? '').split(delimiter)
    .filter(part => part !== '')
    .map(part => join(part, 'opl'))
  // A Finder-launched application inherits a minimal PATH, so the two
  // conventional install locations are named explicitly.
  return [
    ...(configured === undefined || configured === '' ? [] : [configured]),
    ...fromPath,
    join(homedir(), '.local', 'bin', 'opl'),
    '/opt/homebrew/bin/opl',
    '/usr/local/bin/opl',
  ]
}

/**
 * Resolve the OPL executable.
 * @param env - environment carrying the override and PATH.
 * @returns the first runnable candidate, or undefined when none is installed.
 */
export function resolveOplBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return candidateBinaries(env).find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK)
      return true
    }
    catch {
      return false
    }
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

/** Run one OPL command and return its parsed JSON document. */
function runOpl(
  args: readonly string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env
  const binary = resolveOplBinary(env)
  if (binary === undefined) {
    return Promise.reject(new OplCliError('opl_not_installed', 'The OPL command line is not installed'))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let settled = false
    const finish = (error: Error | undefined, value?: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined && value !== undefined) resolve(value)
      else reject(error ?? new OplCliError('opl_failed', 'The OPL command failed'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new OplCliError('opl_timeout', 'The OPL command did not finish in time'))
    }, COMMAND_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM')
        finish(new OplCliError('opl_output_too_large', 'The OPL command produced too much output'))
      }
    })
    child.stderr.resume()
    child.once('error', (error: Error) => { finish(new OplCliError('opl_unavailable', error.message)) })
    child.once('close', () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      }
      catch {
        finish(new OplCliError('opl_response_invalid', 'The OPL command did not return JSON'))
        return
      }
      const value = record(parsed)
      const error = record(value.error)
      const reason = text(record(error.details).reason_code) ?? text(error.code)
      if (reason !== null) {
        // OPL's own message is operator-facing copy; pass it through rather
        // than inventing a second description of the same failure.
        finish(new OplCliError(reason, text(error.message) ?? 'The OPL command was refused'))
        return
      }
      finish(undefined, value)
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}

/**
 * Read the gateway account through OPL's public read model.
 * @param env - environment carrying the OPL override.
 * @returns the account as OPL sees it.
 */
export async function readGatewayStatus(env: NodeJS.ProcessEnv = process.env): Promise<OplGatewayStatus> {
  const value = record(record((await runOpl(['connect', 'gateway', 'status', '--json'], { env })).gateway_account))
  if (Object.keys(value).length === 0) {
    throw new OplCliError('opl_response_invalid', 'OPL reported no gateway account')
  }
  const account = record(value.account)
  const balance = record(account.balance)
  const usage = record(value.usage)
  const freshness = record(value.freshness)
  const status = text(value.status) ?? 'unknown'
  return {
    connected: status === 'connected',
    connectionMode: text(value.connection_mode) ?? 'none',
    problem: status === 'connected' ? null : status,
    displayName: text(account.display_name),
    email: text(account.email),
    accountStatus: text(account.status),
    balanceAmount: numeric(balance.amount),
    balanceCurrency: text(balance.currency) ?? 'USD',
    todayTokens: numeric(usage.today_tokens),
    totalTokens: numeric(usage.total_tokens),
    todayCost: numeric(usage.today_actual_cost),
    totalCost: numeric(usage.total_actual_cost),
    usageCurrency: text(usage.currency) ?? 'USD',
    keyName: text(record(value.managed_key).name),
    stale: freshness.stale === true,
    observedAt: text(freshness.observed_at),
  }
}

/**
 * Sign in through OPL, which owns the session, the managed key, and the
 * binding this machine's inference uses.
 * @param email - account email.
 * @param password - account password.
 * @param env - environment carrying the OPL override.
 */
export async function loginGateway(
  email: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runOpl(['connect', 'gateway', 'login', '--credentials-stdin', '--json'], {
    env,
    stdin: `${JSON.stringify({ email: email.trim(), password })}\n`,
  })
}

/**
 * Ask OPL to re-read the account from the gateway.
 * @param env - environment carrying the OPL override.
 */
export async function refreshGateway(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runOpl(['connect', 'gateway', 'refresh', '--json'], { env })
}
