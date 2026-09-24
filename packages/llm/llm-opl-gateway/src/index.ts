/**
 * Register the OPL Gateway as one provider route.
 *
 * The route speaks the gateway's native Messages protocol
 * through the DeepSeek adapter, advertises the gateway's `deepseek-v4.1-flash` as
 * `DeepSeek-V4.1-Flash`, and authenticates with the key OPL provisioned for
 * this account. A deployment that mounts the plugin therefore reaches the
 * model with no model, endpoint, protocol, or key entered by hand; the Models
 * page still writes a key into the credentials seam, and that stored key wins.
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import { adoptOplGatewayKey } from './adoption.ts'
import { OplGatewayAccountService } from './account-service.ts'
import { Config, toAdapterConfig } from './config.ts'
import { OPL_GATEWAY_INFERENCE_BASE_URL, importOplGatewayKey, oplGatewayStateDirectories } from './opl-credentials.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_SEARCHES,
  OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
  OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
} from './search.ts'
import type { OplGatewaySearchProviderOptions } from './search.ts'
import { OplSearchService } from './search-service.ts'
export { OplSearchService } from './search-service.ts'

export const name = 'llm-opl-gateway'
export const inject = ['llm']

export { Config, DEFAULT_API_KEY_REF, DEFAULT_MODELS } from './config.ts'
export type { Config as OplGatewayConfig } from './config.ts'
export { OplGatewaySearchProvider } from './search.ts'
export type { OplGatewaySearchProviderOptions, OplSearchCitation, OplSearchStream } from './search.ts'
export type { OplGatewaySearchLlmRequest } from './search-types.ts'
export {
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_SEARCHES,
  OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
  OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
  OPL_GATEWAY_SEARCH_PROVIDER_ID,
} from './search.ts'
export { ADOPTION_RECORD_FILENAME, adoptOplGatewayKey, keyFingerprint, readAdoptedFingerprint, writeAdoptedFingerprint } from './adoption.ts'
export type { AdoptionOutcome } from './adoption.ts'
export {
  OPL_GATEWAY_ACCOUNT_SERVICE,
  OplGatewayAccountService,
} from './account-service.ts'
export type { GatewayAccountFacts, GatewayAccountPhase, GatewayAccountStatus, GatewaySignInResult } from './types.ts'
export {
  GatewayControlClient,
  GatewayControlError,
  OPL_GATEWAY_CONTROL_BASE_URL,
} from './gateway-control.ts'
export type { GatewayManagedKey, GatewayProfile, GatewaySession, GatewayUsage } from './gateway-control.ts'
export {
  FACTS_FILENAME,
  FACTS_FRESH_MS,
  SESSION_RECORD,
  clearFacts,
  clearSession,
  readFacts,
  readSession,
  writeFacts,
  writeSession,
} from './session-store.ts'
export {
  OPL_GATEWAY_INFERENCE_BASE_URL,
  OPL_GATEWAY_LEGACY_INFERENCE_BASE_URLS,
  importOplGatewayKey,
  readOplGatewayAccount,
  oplGatewayStateDirectories,
  oplGatewayStateDirectory,
  readBoundGatewayKey,
  resolveInferenceBaseURL,
  readOplGatewayBinding,
} from './opl-credentials.ts'
export type { OplGatewayAccount, OplGatewayKey } from './opl-credentials.ts'

const PROVIDER = 'opl-gateway'
const DISPLAY_NAME = 'OPL Gateway'

/**
 * The DeepSeek adapter names its route "DeepSeek" because that is the only
 * service it shipped for. This route reaches the same model through a
 * different account and endpoint, so the selector must not present the two as
 * one provider.
 */
class OplGatewayAdapter extends DeepSeekAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: DISPLAY_NAME }
  }
}

export function apply(ctx: Context, config: Config): void {
  const current = (): Config => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedDeepSeekOptions | undefined

  /**
   * The endpoint the OPL account binding records for this key. Requests can
   * fail against the canonical root while that one answers — a gateway may
   * serve a chain some runtimes reject — so the account's own record wins over
   * the built-in fallback until a settings section names an endpoint.
   */
  function boundBaseURL(): string {
    try {
      return importOplGatewayKey()?.baseURL ?? OPL_GATEWAY_INFERENCE_BASE_URL
    }
    catch {
      return OPL_GATEWAY_INFERENCE_BASE_URL
    }
  }

  const options = (): ResolvedDeepSeekOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(toAdapterConfig(raw, boundBaseURL()), launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-opl-gateway: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()


  /**
   * Resolve one request's bearer token. The connection facts arrive from the
   * same snapshot that chose the endpoint, so a key can never be paired with
   * an endpoint from another generation.
   */
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    const stored = credentials === undefined
      ? launchEnvironmentOf(ctx).get(ref)?.value
      : (await credentials.resolve(ref))?.value
    if (stored !== undefined && stored.length > 0) {
      return assertUsableApiKey(stored, 'llm-opl-gateway', ref)
    }
    // The OPL application keeps this account's gateway key beside the binding
    // it wrote for its own client; reuse it instead of asking the operator to
    // copy a key between two products that already share an account.
    let imported
    try {
      imported = importOplGatewayKey()
    } catch (error) {
      ctx.logger.warn('llm-opl-gateway: could not read the OPL Gateway binding')
      ctx.logger.warn(error)
      imported = undefined
    }
    if (imported !== undefined) {
      return assertUsableApiKey(imported.key, 'llm-opl-gateway', `OPL Gateway (${imported.providerId})`)
    }
    throw new LlmError(
      `llm-opl-gateway: no credential for provider route "${PROVIDER}"; sign in to OPL Gateway in the`
      + ` OPL application, or store ${ref} through the credentials service (the web Models page writes it)`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new OplGatewayAdapter({
    options,
    resolveApiKey,
    resolveUserId,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-opl-gateway: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    onProtocolAnomaly: ({ provider, model, report }) => {
      // Control syntax that arrived as visible text is never executed; this
      // record is what makes the next occurrence diagnosable without raw SSE.
      ctx.logger.warn(`llm-opl-gateway: control-marker anomaly on route "${provider}/${model}"; ${report}`)
    },
    prepareExtensions: (request) => {
      const extensions = ctx.get('deepseekLlmApiExtensions')
      return extensions?.prepare(request)
        ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
    },
  })
  // Deliberately NOT registered as a configurable provider. This route is an
  // account, not an API-key profile: the operator signs in on the OPL Gateway
  // settings page, and its endpoint, protocol, and catalog are the plugin's
  // own facts rather than fields to fill in. Declaring it configurable would
  // add a Models-page row whose only content is "edit settings.yaml", which
  // reads as a broken twin of the official DeepSeek card. An undeclared live
  // route still reaches the model picker and still counts as a usable provider
  // for first-run readiness, so the surfaces that matter keep working.
  ctx.llm.registerAdapter([PROVIDER], adapter)

  /**
   * Adoption runs once the credentials seam exists, which the loader may order
   * after this plugin. Until then the callback is a no-op, and requests are
   * unaffected because the resolver reads OPL's binding directly.
   */
  let adoptAccountKey = (): void => {}
  let account: OplGatewayAccountService | undefined
  ctx.inject(['credentials'], (credentialsCtx) => {
    const credentials = credentialsCtx.get('credentials')
    if (credentials === undefined) return
    // The Remote surface exists only where a credential store does: signing in
    // without one could not make the route usable.
    account ??= new OplGatewayAccountService(credentialsCtx, {
      credentialRef: () => options().apiKeyEnv,
      endpoint: () => options().baseURL,
      models: () => options().models.map(model => ({ id: model.id, name: model.name ?? model.id })),
      stateDirectory: () => oplGatewayStateDirectories(),
    })
    adoptAccountKey = (): void => {
      // Let the Models page show this route as ready for an operator who
      // signed in to OPL and never typed a key here.
      void adoptOplGatewayKey({ credentials, home: dshHomePath(), ref: options().apiKeyEnv }).then((outcome) => {
        if (outcome === 'unavailable') {
          ctx.logger.warn('llm-opl-gateway: could not adopt the OPL Gateway key into this Harness home')
        }
      }).catch((error: unknown) => {
        ctx.logger.warn('llm-opl-gateway: OPL Gateway key adoption failed')
        ctx.logger.warn(error)
      })
    }
    adoptAccountKey()
  })

  // Non-volatile Config is remounted by the Loader when its profile patch changes.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

  /**
   * The gateway key, resolved the way the adapter resolves it: the credentials
   * seam for the search reference first, then the token OPL recorded for its own
   * client. One sign-in therefore serves both the conversation and the search.
   * @param ref - reference to resolve.
   * @returns the key, or undefined when this machine holds none.
   */
  const resolveSearchApiKey = async (ref: CredentialRef): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    const stored = credentials === undefined
      ? launchEnvironmentOf(ctx).get(ref)?.value
      : (await credentials.resolve(ref))?.value
    if (stored !== undefined && stored.length > 0) return stored
    try {
      return undefined
    } catch (error) {
      ctx.logger.warn('llm-opl-gateway: could not read the OPL Gateway binding for search')
      ctx.logger.warn(error)
      return undefined
    }
  }

  /** Search options for the NEXT operation, projected from the current section. */
  const searchOptions = (): OplGatewaySearchProviderOptions => {
    const route = options()
    const search = current().search
    const apiKeyEnv = credentialRef(search?.apiKeyEnv ?? 'OPL_GATEWAY_SEARCH_API_KEY')
    return {
      resolveApiKey: () => resolveSearchApiKey(apiKeyEnv),
      apiKeyEnv,
      baseURL: search?.baseURL ?? route.baseURL,
      model: search?.model ?? OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
      maxOutputTokens: search?.maxOutputTokens ?? OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
      timeoutMs: search?.timeoutMs ?? OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
      maxSearches: search?.maxSearches ?? OPL_GATEWAY_SEARCH_DEFAULT_MAX_SEARCHES,
    }
  }

  // Web search is a second capability of the same account: the responses route
  // names its own model and the same key. Registered only where a web seam
  // exists, so a composition without one still mounts the conversation route.
  ctx.inject(['web'], (webCtx) => {
    const web = webCtx.get('web')
    if (web === undefined) return
    const service = new OplSearchService(webCtx, {
      path: dshHomePath('opl-search.json'),
      cloud: searchOptions,
      fetchPage: (url, signal) => web.fetch({ url }, signal),
      sessionId: () => webCtx.get('agents')?.currentInitiator()?.session.id ?? null,
    })
    webCtx.effect(
      () => web.registerSearchProvider({ id: 'opl-gateway', available: () => true, search: (request, signal) => service.search(request, signal) }),
      'llm-opl-gateway: OPL Gateway web search provider',
    )
  })
}
