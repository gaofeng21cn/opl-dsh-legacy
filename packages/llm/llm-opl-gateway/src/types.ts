/**
 * Wire-safe account vocabulary for the OPL Gateway surface.
 *
 * This module is a public type subpath on purpose: every type that crosses the
 * Remote boundary must be importable by consumers without pulling this
 * package's Cordis Context augmentation into their compilation.
 *
 * @module @one-person-lab/dsh-llm-opl-gateway/types
 */

/** One model this route advertises to the picker. */
export interface GatewayAccountModel {
  /** Gateway-owned model id sent on the wire. */
  readonly id: string
  /** Display name the picker shows. */
  readonly name: string
}

/**
 * What the account page should present.
 *
 * `connected` covers both sources: a session this process opened, and the
 * binding OPL already recorded on this machine. The page never asks for a
 * password to show facts it can already read.
 */
export type GatewayAccountPhase = 'signed-out' | 'connected' | 'unavailable'

/** The signed-in account as the page renders it. */
export interface GatewayAccountFacts {
  readonly displayName: string | null
  readonly email: string | null
  readonly status: string
  readonly balanceAmount: number | null
  readonly balanceCurrency: string
  readonly todayTokens: number | null
  readonly totalTokens: number | null
  readonly todayCost: number | null
  readonly totalCost: number | null
  readonly usageCurrency: string
  /** Name of the inference key this route uses, when one is known. */
  readonly keyName: string | null
  /** When the facts were observed, for the freshness line. */
  readonly observedAt?: string | null
  /** Whether the observation is past its freshness window. */
  readonly stale?: boolean
}

/** One status answer, secret-free. */
export interface GatewayAccountStatus {
  readonly phase: GatewayAccountPhase
  /** Endpoint inference uses for this account. */
  readonly endpoint: string
  /** Whether the credential reference the adapter resolves currently resolves. */
  readonly keyReady: boolean
  /** Models this route serves, so the account page can name what it provides. */
  readonly models: readonly GatewayAccountModel[]
  /**
   * Where the account facts came from: this process's own session, or the
   * binding OPL recorded. Absent when neither has one.
   */
  readonly source?: 'session' | 'opl'
  readonly account?: GatewayAccountFacts
  /** Why the last operation failed, when one did. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** What one sign-in attempt returns. */
export interface GatewaySignInResult {
  readonly status: GatewayAccountStatus
  /** Whether this attempt minted a new inference key rather than reusing one. */
  readonly createdKey: boolean
}

/** Search settings stored on this machine, independent of conversation models. */
export interface OplSearchPreferences {
  mode: 'cloud' | 'local'
  model: string
}
/** Reported usage only; absent provider usage is counted separately. */
export interface OplSearchTotals {
  calls: number
  succeeded: number
  failed: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  unknownUsage: number
}
/** One locally persisted search accounting bucket. */
export interface OplSearchBucket extends OplSearchTotals {
  mode: 'cloud' | 'local'
  model: string
  sessionId: string | null
}
/** Settings and per-model/per-session statistics, with no query text. */
export interface OplSearchStatus {
  preferences: OplSearchPreferences
  totals: OplSearchTotals
  buckets: OplSearchBucket[]
}
/** A real test response, never inferred from model discovery. */
export interface OplSearchTestResult {
  sources: { url: string; title?: string }[]
  durationMs: number
}
