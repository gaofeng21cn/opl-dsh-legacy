/**
 * OPL Gateway account surface: the one Remote service the account page reads.
 *
 * OPL Framework owns this account — the session, the managed key, the binding
 * this machine's inference uses — and publishes it through
 * `opl connect gateway …`. This service is therefore a *view* of OPL plus one
 * safe action: signing in when this machine has no account yet. It never
 * disconnects, rotates, or replaces OPL's key, because those change the OPL
 * application too, and that decision belongs where the account lives.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { GatewayAccountFacts, GatewayAccountModel, GatewayAccountStatus, GatewaySignInResult } from './types.ts'
import { OplCliError, loginGateway, readGatewayStatus, refreshGateway } from './opl-cli.ts'
import type { OplGatewayStatus } from './opl-cli.ts'
import { adoptOplGatewayKey } from './adoption.ts'
import { importOplGatewayKey, oplGatewayStateDirectory, readOplGatewayAccount } from './opl-credentials.ts'
import type { OplGatewayAccount } from './opl-credentials.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The gateway refused the supplied credentials. */
    'opl-gateway/credentials': {}
    /** The account needs a step this page cannot take; OPL owns it. */
    'opl-gateway/attention': {}
    /** OPL or its gateway could not be reached. */
    'opl-gateway/unavailable': {}
    /** This deployment cannot store the key the account issued. */
    'opl-gateway/store': {}
  }
}

/** Cordis service key and Remote namespace of this surface. */
export const OPL_GATEWAY_ACCOUNT_SERVICE = 'oplGatewayAccount'

/** Map one OPL failure reason onto the vocabulary this surface declares. */
function remoteCode(reason: string): keyof import('@deepseek-ai/dsh-typert-protocol').RemoteErrorDetailsMap {
  switch (reason) {
    case 'invalid_credentials': return 'opl-gateway/credentials'
    case 'group_selection_required':
    case 'mfa_or_challenge_required':
    case 'account_switch_requires_disconnect':
    case 'account_disabled': return 'opl-gateway/attention'
    case 'opl_not_installed': return 'opl-gateway/attention'
    default: return 'opl-gateway/unavailable'
  }
}

/** Restate any failure in the code and message the page shows. */
function describe(error: unknown): { code: string; message: string } {
  if (error instanceof OplCliError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'unexpected', message: error.message }
  return { code: 'unexpected', message: 'The OPL Gateway request failed' }
}

/** One account whose status the page reads and whose sign-in the page starts. */
export class OplGatewayAccountService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly options: {
      /** Credential reference the adapter resolves. */
      readonly credentialRef: () => CredentialRef
      /** Inference endpoint reported to the page. */
      readonly endpoint: () => string
      /** Models this route advertises. */
      readonly models: () => readonly GatewayAccountModel[]
      /** OPL state directory used when the command line is unavailable. */
      readonly stateDirectory?: () => string
      /** Environment carrying the OPL binary override. */
      readonly environment?: () => NodeJS.ProcessEnv
    },
  ) {
    // The Typert analyzer reads the service key from this call site, so it must
    // be the literal that also names the Remote namespace.
    super(ctx, 'oplGatewayAccount')
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.environment?.() ?? process.env
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
   * OPL's account record read straight from its state directory.
   *
   * Used only when the command line cannot answer — a deployment without the
   * OPL binary still gets account facts, and a test does not have to spawn a
   * process to observe one.
   */
  private localAccount(): OplGatewayAccount | undefined {
    try {
      return readOplGatewayAccount(this.options.stateDirectory?.() ?? oplGatewayStateDirectory())
    }
    catch {
      return undefined
    }
  }

  /** Account facts for a connected account, from either source. */
  private factsFromOpl(status: OplGatewayStatus): GatewayAccountFacts {
    return {
      displayName: status.displayName,
      email: status.email,
      status: status.accountStatus ?? (status.connected ? 'active' : status.problem ?? 'unknown'),
      balanceAmount: status.balanceAmount,
      balanceCurrency: status.balanceCurrency,
      todayTokens: status.todayTokens,
      totalTokens: status.totalTokens,
      todayCost: status.todayCost,
      totalCost: status.totalCost,
      usageCurrency: status.usageCurrency,
      keyName: status.keyName,
      observedAt: status.observedAt,
      stale: status.stale,
    }
  }

  /** Account facts from OPL's local record, for the no-CLI fallback. */
  private factsFromLocal(account: OplGatewayAccount): GatewayAccountFacts {
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

  /** Current account status: what the account page renders. */
  @Remote
  async status(): Promise<GatewayAccountStatus> {
    const base = {
      endpoint: this.options.endpoint(),
      keyReady: await this.keyReady(),
      models: this.options.models(),
    }
    try {
      const opl = await readGatewayStatus(this.env())
      if (opl.connectionMode === 'none') return { ...base, phase: 'signed-out' }
      if (!opl.connected) {
        return {
          ...base,
          phase: 'unavailable',
          source: 'opl',
          account: this.factsFromOpl(opl),
          error: {
            code: opl.problem ?? 'attention_needed',
            message: this.attentionMessage(opl.problem),
          },
        }
      }
      return { ...base, phase: 'connected', source: 'opl', account: this.factsFromOpl(opl) }
    }
    catch (error) {
      const failure = describe(error)
      const local = this.localAccount()
      if (local === undefined || local.status === 'disconnected') {
        // No account anywhere. A missing OPL install is worth saying out loud,
        // because the sign-in form below cannot work without it.
        return failure.code === 'opl_not_installed'
          ? { ...base, phase: 'signed-out', error: failure }
          : { ...base, phase: 'signed-out' }
      }
      return {
        ...base,
        phase: local.status === 'connected' ? 'connected' : 'unavailable',
        source: 'opl',
        account: this.factsFromLocal(local),
        ...local.status === 'connected'
          ? {}
          : { error: { code: local.status, message: this.attentionMessage(local.status) } },
      }
    }
  }

  /** What the operator has to do, in terms of where they have to do it. */
  private attentionMessage(problem: string | null): string {
    switch (problem) {
      case 'setup_required':
      case 'group_selection_required':
        return 'Choose a key group for this account in the OPL application'
      case 'reauth_required':
        return 'Sign in to OPL Gateway again in the OPL application'
      case 'managed_key_missing':
      case 'managed_key_conflict':
      case 'managed_key_identity_drift':
        return 'OPL needs to repair the managed key; open the OPL application'
      case 'account_disabled':
        return 'This gateway account is disabled'
      default:
        return 'OPL reports that this account needs attention'
    }
  }

  /**
   * Sign in through OPL, then make its key this machine's inference credential.
   * @param email - account email.
   * @param password - account password.
   * @returns the resulting status and whether a key was adopted for the first time.
   */
  @Remote
  async signIn(email: string, password: string): Promise<GatewaySignInResult> {
    if (email.trim() === '' || password === '') {
      throw new RemoteError('gateway/bad-request', 'An email address and password are required', {})
    }
    const credentials = this.credentials()
    try {
      // OPL performs the whole sign-in: session, managed key, and the binding
      // this machine's inference reads. Nothing here duplicates that protocol.
      await loginGateway(email, password, this.env())
    }
    catch (error) {
      const failure = describe(error)
      throw new RemoteError(remoteCode(failure.code), failure.message, {})
    }
    if (credentials !== undefined) {
      const outcome = await adoptOplGatewayKey({
        credentials,
        home: this.homeDirectory(),
        ref: this.options.credentialRef(),
        stateDirectory: this.options.stateDirectory?.() ?? oplGatewayStateDirectory(),
      })
      if (outcome === 'unavailable') {
        throw new RemoteError('opl-gateway/store', 'This deployment cannot store the gateway key', {})
      }
      return { status: await this.status(), createdKey: outcome === 'adopted' }
    }
    return { status: await this.status(), createdKey: false }
  }

  /** Ask OPL to re-read the account from the gateway. */
  @Remote
  async refresh(): Promise<GatewayAccountStatus> {
    try {
      await refreshGateway(this.env())
    }
    catch {
      // The status read below is what the page shows. A failed refresh must not
      // replace readable account facts with an error: the account may be fine
      // and only the network down, and OPL's own freshness line says so.
    }
    return this.status()
  }

  /**
   * The Harness home the adoption record is written to.
   *
   * Deliberately never OPL's state directory: this file records what *this*
   * Harness adopted, and writing it beside OPL's own state would be one
   * product editing another's.
   */
  private homeDirectory(): string {
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
}
