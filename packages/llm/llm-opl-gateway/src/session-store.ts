/**
 * What this plugin remembers between restarts.
 *
 * Two different things with two different homes, because they have two
 * different sensitivity levels:
 *
 * - The **refresh token** is a credential, so it lives in the credentials
 *   seam as an opaque grant record — the same place the harness keeps every
 *   other sign-in, with the same permissions and the same lock.
 * - The **last observed account facts** are not secret (a balance and a token
 *   count), so they live in a small JSON file in the Harness home. Caching them
 *   is what lets the page show the account immediately after a restart instead
 *   of an empty panel while a request is in flight.
 *
 * The cache is only honoured while a session exists: an account summary with
 * nothing behind it to refresh would be a stale claim, not a convenience.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { GatewayAccountFacts } from './types.ts'

/** Credentials-seam record holding this plugin's refresh token. */
export const SESSION_RECORD: CredentialKey = credentialKey('llm-opl-gateway', 'session')

/** File in the Harness home holding the last observed account facts. */
export const FACTS_FILENAME = 'opl-gateway-account.json'

/** How long an observation stays current, matching the gateway's own window. */
export const FACTS_FRESH_MS = 15 * 60 * 1000

/** The stored session. */
interface StoredSession {
  readonly version: 1
  readonly refreshToken: string
}

/** The stored account facts. */
interface StoredFacts {
  readonly version: 1
  readonly observedAt: string
  readonly facts: GatewayAccountFacts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the stored refresh token.
 * @param credentials - the credentials seam.
 * @returns the token, or undefined when this plugin has no session.
 */
export async function readSession(credentials: CredentialProvider): Promise<string | undefined> {
  let record
  try {
    record = await credentials.readRecord(SESSION_RECORD)
  }
  catch {
    return undefined
  }
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload: unknown = record.payload
  if (!isRecord(payload)) return undefined
  const token = payload.refreshToken
  return typeof token === 'string' && token !== '' ? token : undefined
}

/**
 * Store the refresh token that renews this session.
 * @param credentials - the credentials seam.
 * @param refreshToken - token from the last successful sign-in or refresh.
 */
export async function writeSession(credentials: CredentialProvider, refreshToken: string): Promise<void> {
  const session: StoredSession = { version: 1, refreshToken }
  await credentials.modifyRecord(SESSION_RECORD, () => Promise.resolve({ kind: 'grant', payload: session }))
}

/**
 * Forget the stored session.
 * @param credentials - the credentials seam.
 */
export async function clearSession(credentials: CredentialProvider): Promise<void> {
  await credentials.deleteRecord(SESSION_RECORD)
}

function factsPath(home: string): string {
  return join(home, FACTS_FILENAME)
}

/**
 * Read the cached account facts.
 * @param home - Harness home directory.
 * @returns the cached observation, or undefined when none is usable.
 */
export function readFacts(home: string): { facts: GatewayAccountFacts; observedAt: string; stale: boolean } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(factsPath(home), 'utf8'))
  }
  catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined
  const observedAt = parsed.observedAt
  const facts = parsed.facts
  if (typeof observedAt !== 'string' || !isRecord(facts)) return undefined
  const observed = Date.parse(observedAt)
  return {
    facts: facts as unknown as GatewayAccountFacts,
    observedAt,
    stale: !Number.isFinite(observed) || Date.now() - observed > FACTS_FRESH_MS,
  }
}

/**
 * Cache the account facts just observed.
 * @param home - Harness home directory.
 * @param facts - facts to store.
 * @param observedAt - instant they were observed.
 */
export function writeFacts(home: string, facts: GatewayAccountFacts, observedAt: string): void {
  const path = factsPath(home)
  const stored: StoredFacts = { version: 1, observedAt, facts }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(stored, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Drop the cached account facts.
 * @param home - Harness home directory.
 */
export function clearFacts(home: string): void {
  rmSync(factsPath(home), { force: true })
}
