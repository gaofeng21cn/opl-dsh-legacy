/**
 * OPL Gateway account surface: the one Remote service the account page reads.
 *
 * The gateway is an independent service, so this surface stands on its own: a
 * machine with no OPL installation can sign in, receive an inference key, and
 * see the account. Nothing here shells out to a command line.
 *
 * OPL is still consulted, but only as a *convenience*: if this machine already
 * signed in through the OPL application, its recorded account and binding are
 * read so the operator needs no second sign-in. That read is a plain file read
 * (see `./opl-credentials.ts`) and never a requirement.
 */

import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CODEX_API_KEY_REF } from './config.ts'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { GatewayAccountFacts, GatewayAccountModel, GatewayAccountStatus, GatewaySignInResult } from './types.ts'
import {
  GatewayControlClient,
  GatewayControlError,
  type GatewayManagedKey,
  type GatewayProfile,
  type GatewayUsage,
} from './gateway-control.ts'
import { keyFingerprint, readAdoptedFingerprint, writeAdoptedFingerprint } from './adoption.ts'
import { importOplGatewayKey, oplGatewayStateDirectories, readOplGatewayAccount } from './opl-credentials.ts'
import type { OplGatewayAccount } from './opl-credentials.ts'
import { clearFacts, clearSession, readFacts, readSession, writeFacts, writeSession } from './session-store.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The gateway refused the supplied credentials. */
    'opl-gateway/credentials': {}
    /** The account needs a step this page cannot take. */
    'opl-gateway/attention': {}
    /** The gateway could not be reached. */
    'opl-gateway/unavailable': {}
    /** This deployment cannot store the key the account issued. */
    'opl-gateway/store': {}
  }
}

/** Cordis service key and Remote namespace of this surface. */
export const OPL_GATEWAY_ACCOUNT_SERVICE = 'oplGatewayAccount'

/** OPL account statuses that mean the recorded account is usable as it stands. */
const CONNECTED_OPL_STATUSES = new Set(['connected', 'setup_required'])

/** Map one control failure reason onto the vocabulary this surface declares. */
function remoteCode(reason: string): keyof import('@deepseek-ai/dsh-typert-protocol').RemoteErrorDetailsMap {
  switch (reason) {
    case 'invalid_credentials': return 'opl-gateway/credentials'
    case 'account_disabled':
    case 'challenge_required':
    case 'group_selection_required': return 'opl-gateway/attention'
    default: return 'opl-gateway/unavailable'
  }
}

/** Restate any failure in the code and message the page shows. */
function describe(error: unknown): { code: string; message: string } {
  if (error instanceof GatewayControlError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'unexpected', message: error.message }
  return { code: 'unexpected', message: 'The OPL Gateway request failed' }
}

/**
 * The name this client's key carries on the gateway.
 *
 * Named after the machine so an operator reading the gateway's key list can
 * tell which client holds which key — the same convention the OPL application
 * uses for its own managed key.
 * @param group - Gateway group whose independent key is named.
 * @returns the canonical key name.
 */
export function gatewayKeyName(group: 'DeepSeek' | 'Codex' = 'DeepSeek'): string {
  return `OPL DSH · ${hostname()} · ${group}`
}

/** Resolve the explicit DeepSeek group before issuing an inference key. */
function preferredGroup(groups: readonly { id: string; label: string }[], name: 'DeepSeek' | 'Codex'): string {
  const matches = groups.filter(group => group.label.trim().toLowerCase() === name.toLowerCase())
  if (matches.length !== 1) {
    throw new GatewayControlError('group_selection_required', `This account needs one available ${name} key group`)
  }
  const match = matches[0]
  if (match === undefined) throw new GatewayControlError('group_selection_required', `This account needs one available ${name} key group`)
  return match.id
}

/** One account whose status the page reads and whose sign-in the page starts. */
export class OplGatewayAccountService extends TypertRemoteService {
  private session: { accessToken: string; refreshToken: string } | undefined
  private facts: GatewayAccountFacts | undefined
  private source: 'session' | 'opl' | undefined
  private failure: { code: string; message: string } | undefined
  private key: GatewayManagedKey | undefined
  private codexKey: GatewayManagedKey | undefined
  private channelFailure: string | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private defaultControl: GatewayControlClient | undefined

  constructor(
    ctx: Context,
    private readonly options: {
      /** Credential reference the adapter resolves. */
      readonly credentialRef: () => CredentialRef
      /** Inference endpoint reported to the page. */
      readonly endpoint: () => string
      /** Models this route advertises. */
      readonly models: () => readonly GatewayAccountModel[]
      /** OPL state directory consulted as a convenience, never a requirement. */
      readonly stateDirectory?: () => string | readonly string[]
      /** Control transport override, for tests. */
      readonly control?: GatewayControlClient
      /** Last successful channel, for the account page. */
      readonly activeChannel?: () => 'deepseek' | 'codex' | undefined
    },
  ) {
    // The Typert analyzer reads the service key from this call site, so it must
    // be the literal that also names the Remote namespace.
    super(ctx, 'oplGatewayAccount')
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(action)
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private control(): GatewayControlClient {
    this.defaultControl ??= new GatewayControlClient()
    return this.options.control ?? this.defaultControl
  }

  private credentials(): CredentialProvider | undefined {
    return this.ctx.get('credentials')
  }

  /**
   * Whether the adapter can authenticate right now. A key stored by the page,
   * adopted from OPL, or resolved from the environment all count.
   * @returns whether the reference resolves.
   */
  private async keyReady(): Promise<boolean> {
    const credentials = this.credentials()
    if (credentials === undefined) return false
    const hit = await credentials.resolve(this.options.credentialRef())
    if (hit !== undefined && hit.value.length > 0) return true
    // Adoption covers the common case, but a deployment whose credential store
    // refused the write still authenticates through OPL's own binding, and the
    // page must not claim a working route has no key.
    return this.importedKey() !== undefined
  }

  private importedKey(): ReturnType<typeof importOplGatewayKey> {
    try {
      return importOplGatewayKey()
    }
    catch {
      return undefined
    }
  }

  /**
   * The Harness home this plugin's own files live in.
   *
   * Deliberately never OPL's state directory: what this plugin observed and
   * adopted belongs to this Harness, and writing it beside OPL's own state
   * would be one product editing another's.
   */
  private home(): string {
    try {
      const paths = this.ctx.get('dshHomePath')
      if (typeof paths === 'function') return paths()
    }
    catch {
      // Fall through to the documented default below.
    }
    const configured = process.env.DSH_HOME?.trim()
    return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
  }

  /** OPL's recorded account, read straight from its state directory. */
  private oplAccount(): OplGatewayAccount | undefined {
    try {
      return readOplGatewayAccount(this.options.stateDirectory?.() ?? oplGatewayStateDirectories())
    }
    catch {
      return undefined
    }
  }

  /** Facts assembled from one control-plane read. */
  private factsFrom(
    profile: GatewayProfile,
    usage: GatewayUsage | undefined,
    keyName: string | null,
  ): GatewayAccountFacts {
    return {
      displayName: profile.displayName,
      email: profile.email,
      status: profile.status,
      balanceAmount: profile.balanceAmount,
      balanceCurrency: profile.balanceCurrency,
      todayTokens: usage?.todayTokens ?? null,
      totalTokens: usage?.totalTokens ?? null,
      todayCost: usage?.todayCost ?? null,
      totalCost: usage?.totalCost ?? null,
      usageCurrency: usage?.currency ?? profile.balanceCurrency,
      keyName,
    }
  }

  /** Account facts for an account OPL recorded. */
  private factsFromOpl(account: OplGatewayAccount): GatewayAccountFacts {
    return {
      displayName: account.displayName,
      email: account.email,
      status: account.accountStatus ?? account.status,
      balanceAmount: account.balanceAmount,
      balanceCurrency: account.balanceCurrency,
      todayTokens: account.todayTokens,
      totalTokens: account.totalTokens,
      todayCost: account.todayCost,
      totalCost: account.totalCost,
      usageCurrency: account.usageCurrency,
      keyName: account.keyName,
      observedAt: account.observedAt,
      stale: account.stale,
    }
  }

  /**
   * Current account status: what the account page renders.
   * @returns the phase, endpoint, credential state, served models, and account facts the page presents.
   */
  @Remote
  async status(): Promise<GatewayAccountStatus> {
    const codexCredential = await this.credentials()?.resolve(credentialRef(CODEX_API_KEY_REF))
    const base = {
      endpoint: this.options.endpoint(),
      keyReady: await this.keyReady(),
      models: this.options.models(),
      codexKeyReady: codexCredential !== undefined && codexCredential.value.length > 0,
      activeChannel: this.options.activeChannel?.(),
      channelError: this.channelFailure,
    }
    if (this.facts !== undefined) {
      return { ...base, phase: 'connected', source: this.source ?? 'session', account: this.facts }
    }
    // Nothing in memory: show what this Harness already recorded, without
    // touching the network, so a restart paints the account rather than an
    // empty panel. The cache is honoured only while a session exists, because
    // an account summary with nothing behind it to refresh is a stale claim.
    const credentials = this.credentials()
    if (credentials !== undefined && await readSession(credentials) !== undefined) {
      const cached = readFacts(this.home())
      if (cached !== undefined) {
        return {
          ...base,
          phase: 'connected',
          source: 'session',
          account: { ...cached.facts, observedAt: cached.observedAt, stale: cached.stale },
        }
      }
    }
    // OPL is a convenience source: a machine that signed in through the OPL
    // application needs no second sign-in here.
    const opl = this.oplAccount()
    if (opl !== undefined) {
      const attention = !CONNECTED_OPL_STATUSES.has(opl.status) || !base.keyReady
      return {
        ...base,
        phase: attention ? 'unavailable' : 'connected',
        source: 'opl',
        account: this.factsFromOpl(opl),
        ...attention ? { error: { code: base.keyReady ? opl.status : 'group_selection_required', message: this.attentionMessage(base.keyReady ? opl.status : 'group_selection_required') } } : {},
      }
    }
    if (this.failure !== undefined) return { ...base, phase: 'unavailable', error: this.failure }
    return { ...base, phase: 'signed-out' }
  }

  /** What the operator has to do next, in terms they can act on. */
  private attentionMessage(problem: string | null): string {
    switch (problem) {
      case 'setup_required':
      case 'group_selection_required':
        return 'Choose a key group for this account, then sign in again'
      case 'reauth_required':
        return 'Sign in again to renew this account'
      case 'managed_key_missing':
      case 'managed_key_conflict':
      case 'managed_key_identity_drift':
        return 'The account key needs repair; sign in again'
      case 'account_disabled':
        return 'This gateway account is disabled'
      default:
        return 'This account needs attention'
    }
  }

  /**
   * Sign in to the gateway and make its key this machine's credential.
   * @param email - account email.
   * @param password - account password.
   * @returns the resulting status and whether this attempt minted the key.
   */
  @Remote
  async signIn(email: string, password: string): Promise<GatewaySignInResult> {
    return this.serialize(() => this.signInOnce(email, password))
  }

  private async signInOnce(email: string, password: string): Promise<GatewaySignInResult> {
    if (email.trim() === '' || password === '') {
      throw new RemoteError('gateway/bad-request', 'An email address and password are required', {})
    }
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new RemoteError('opl-gateway/store', 'This deployment has no credential store', {})
    }
    try {
      this.failure = undefined
      const session = await this.control().login(email.trim(), password)
      this.session = session
      const accessToken = session.accessToken
      const [profile, usage, groups] = await Promise.all([
        this.control().profile(accessToken),
        this.control().usage(accessToken).catch(() => undefined),
        this.control().groups(accessToken),
      ])
      const { key, created } = await this.ensureKey(accessToken, groups, 'DeepSeek')
      await credentials.set(this.options.credentialRef(), key.key)
      await writeSession(credentials, session.refreshToken)
      // Recording the adoption lets a later sign-out know this key is ours to
      // remove, and leaves a key the operator typed on the Models page alone.
      writeAdoptedFingerprint(this.home(), keyFingerprint(key.key))
      this.key = key
      await this.ensureCodexKey(accessToken, groups, credentials, true)
      this.facts = this.factsFrom(profile, usage, key.name)
      this.source = 'session'
      writeFacts(this.home(), this.facts, new Date().toISOString())
      return { status: await this.status(), createdKey: created }
    }
    catch (error) {
      const failure = describe(error)
      this.failure = failure
      this.session = undefined
      throw new RemoteError(remoteCode(failure.code), failure.message, {})
    }
  }

  /**
   * Reuse this account's key when it already exists, and mint one otherwise.
   *
   * Reuse matters: a sign-in that failed partway, or a reinstall, must not
   * leave the account accumulating keys nobody holds.
   * @param accessToken - session token.
   * @param groups - key groups the account may issue in.
   * @returns the key to use and whether this call created it.
   */
  private async ensureKey(
    accessToken: string,
    groups: readonly { id: string; label: string }[],
    group: 'DeepSeek' | 'Codex',
  ): Promise<{ key: GatewayManagedKey; created: boolean }> {
    const name = gatewayKeyName(group)
    const groupId = preferredGroup(groups, group)
    const existing = await this.control().keys(accessToken, name)
    const match = existing.find(entry => entry.name === name && entry.groupId === groupId && entry.status === 'active')
    if (match !== undefined) return { key: match, created: false }
    return { key: await this.control().createKey(accessToken, name, groupId), created: true }
  }

  private async ensureCodexKey(
    accessToken: string, groups: readonly { id: string; label: string }[],
    credentials: CredentialProvider, replacingAccount = false,
  ): Promise<void> {
    try {
      const { key } = await this.ensureKey(accessToken, groups, 'Codex')
      await credentials.set(credentialRef(CODEX_API_KEY_REF), key.key)
      writeAdoptedFingerprint(this.home(), keyFingerprint(key.key), 'codex')
      this.codexKey = key
      this.channelFailure = undefined
    } catch (error) {
      const ref = credentialRef(CODEX_API_KEY_REF)
      const stored = await credentials.resolve(ref)
      if ((replacingAccount || error instanceof GatewayControlError && error.code === 'group_selection_required')
        && stored !== undefined && keyFingerprint(stored.value) === readAdoptedFingerprint(this.home(), 'codex')) await credentials.unset(ref)
      this.codexKey = undefined
      this.channelFailure = 'Codex compatibility channel is unavailable; refresh the account to retry provisioning.'
    }
  }

  /**
   * Re-read the account from the gateway.
   * @returns the refreshed status, or the current status when this machine holds no session.
   */
  @Remote
  async refresh(): Promise<GatewayAccountStatus> {
    return this.serialize(() => this.refreshOnce())
  }

  private async refreshOnce(): Promise<GatewayAccountStatus> {
    if (this.session === undefined) {
      const credentials = this.credentials()
      if (credentials === undefined) return this.status()
      const stored = await readSession(credentials)
      if (stored === undefined) return this.status()
      try {
        const renewed = await this.control().refreshSession(stored)
        // A refresh rotates the token, so the new one is persisted before
        // anything else can fail.
        await writeSession(credentials, renewed.refreshToken)
        this.session = renewed
      }
      catch (error) {
        // A refused renewal ends the session: keeping it would leave the page
        // showing a cached account behind a credential that no longer works.
        await clearSession(credentials).catch(() => undefined)
        clearFacts(this.home())
        this.failure = describe(error)
        this.session = undefined
        return this.status()
      }
    }
    try {
      const accessToken = this.session.accessToken
      const [profile, usage, groups] = await Promise.all([
        this.control().profile(accessToken),
        this.control().usage(accessToken).catch(() => undefined),
        this.control().groups(accessToken),
      ])
      const credentials = this.credentials()
      if (credentials !== undefined) {
        const { key } = await this.ensureKey(accessToken, groups, 'DeepSeek')
        await credentials.set(this.options.credentialRef(), key.key)
        writeAdoptedFingerprint(this.home(), keyFingerprint(key.key))
        this.key = key
        await this.ensureCodexKey(accessToken, groups, credentials)
      }
      this.facts = this.factsFrom(profile, usage, this.facts?.keyName ?? this.key?.name ?? null)
      this.source = 'session'
      this.failure = undefined
      writeFacts(this.home(), this.facts, new Date().toISOString())
    }
    catch (error) {
      // The cached facts stay: the account may be fine and only the network
      // down, and the freshness line already says how old the numbers are.
      this.failure = describe(error)
    }
    return this.status()
  }

  /**
   * End this machine's session and release the key it holds.
   *
   * The gateway-side key is disabled rather than left active: it was issued to
   * this client, and a credential nobody holds is a loose end. A key the
   * operator typed on the Models page is theirs and is left alone.
   * @returns the signed-out status after this machine's session and key are released.
   */
  @Remote
  async signOut(): Promise<GatewayAccountStatus> {
    return this.serialize(() => this.signOutOnce())
  }

  private async signOutOnce(): Promise<GatewayAccountStatus> {
    const credentials = this.credentials()
    const ref = this.options.credentialRef()
    if (credentials !== undefined) {
      const stored = await credentials.resolve(ref)
      const fingerprint = stored === undefined ? undefined : keyFingerprint(stored.value)
      if (fingerprint !== undefined && fingerprint === readAdoptedFingerprint(this.home())) {
        await credentials.unset(ref).catch(() => undefined)
      }
    }
    if (credentials !== undefined) {
      const ref = credentialRef(CODEX_API_KEY_REF)
      const stored = await credentials.resolve(ref)
      if (stored !== undefined && keyFingerprint(stored.value) === readAdoptedFingerprint(this.home(), 'codex')) {
        await credentials.unset(ref)
      }
    }
    if (this.session !== undefined && this.codexKey !== undefined) {
      await this.control().setKeyStatus(this.session.accessToken, this.codexKey, 'disabled').catch(() => undefined)
    }
    if (this.session !== undefined && this.key !== undefined) {
      // Best effort: the local session ends either way, and an unreachable
      // gateway must not trap the operator in a signed-in state.
      await this.control().setKeyStatus(this.session.accessToken, this.key, 'disabled').catch(() => undefined)
    }
    if (credentials !== undefined) await clearSession(credentials).catch(() => undefined)
    clearFacts(this.home())
    this.session = undefined
    this.facts = undefined
    this.source = undefined
    this.key = undefined
    this.codexKey = undefined
    this.channelFailure = undefined
    this.failure = undefined
    return this.status()
  }
}
