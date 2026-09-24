/**
 * OPL Gateway Settings page, browser half.
 *
 * The page is the account surface for the `llm-opl-gateway` adapter family:
 * signing in here is what makes that route's credential resolve, so the card
 * and the adapter are two halves of one feature rather than a settings form
 * and an unrelated integration.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `ctx.remote` Context merge plus the account namespace
// this page calls. The wire vocabulary comes from the Host package's public
// type subpath, never from its implementation module.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@one-person-lab/dsh-llm-opl-gateway/remote'
import { OplGatewaySection, type OplGatewaySectionInjected } from './OplGatewaySection.tsx'
import { en, zh, type OplGatewayLocaleKey } from './locales.ts'
import { SearchSection, type SearchSectionInjected } from './SearchSection.tsx'

export type { OplGatewaySectionInjected, OplGatewaySectionProps } from './OplGatewaySection.tsx'
export type { OplGatewayLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OPL Gateway page copy. */
    'settings.oplGateway': OplGatewayLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.oplGateway'

/** Services this plugin needs: the slot ledger, dictionaries, and the account Remote. */
export const inject = ['slots', 'locale', 'remote', 'remote.oplGatewayAccount', 'remote.oplSearch']

/** Contribute the OPL Gateway page to Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-opl-gateway: dictionaries')

  const t = ctx.locale.bind(NS)
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    // The code is a support handle, not copy: the page shows the sentence.
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const injected = (): OplGatewaySectionInjected => ({
    status: async () => unwrap(await ctx.remote.oplGatewayAccount.status()),
    signIn: async (email, password) => unwrap(await ctx.remote.oplGatewayAccount.signIn(email, password)),
    refresh: async () => unwrap(await ctx.remote.oplGatewayAccount.refresh()),
    signOut: async () => unwrap(await ctx.remote.oplGatewayAccount.signOut()),
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'opl-gateway',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, OplGatewaySection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'opl-search', order: 31, label: () => t('search.nav'), locale: NS,
    inject: (): SearchSectionInjected => ({
      searchStatus: async () => unwrap(await ctx.remote.oplSearch.status()),
      searchConfigure: async preferences => unwrap(await ctx.remote.oplSearch.configure(preferences)),
      searchModels: async () => unwrap(await ctx.remote.oplSearch.models()),
      searchTest: async (preferences, query) => unwrap(await ctx.remote.oplSearch.test(preferences, query)),
    }),
  }, SearchSection))
}
