/** Desktop-only settings contribution; a remote Host never writes Codex files. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { CodexSkillBridge } from '../types.ts'
import { CodexSection } from './CodexSection.tsx'
import { en, zh, type CodexLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Codex coordination settings copy. */
    'settings.codex': CodexLocaleKey
  }
}

/** Services required for the settings contribution. */
export const inject = ['slots', 'locale']

/** Register only when the local shell supports skill installation. */
export function apply(ctx: Context): void {
  const desktop = (globalThis as typeof globalThis & { dshDesktop?: { protocolVersion: number; codex?: CodexSkillBridge } }).dshDesktop
  const codex = desktop?.protocolVersion === 1 ? desktop.codex : undefined
  if (!codex || typeof codex.status !== 'function' || typeof codex.install !== 'function') return
  ctx.effect(() => ctx.locale.register('settings.codex', { zh, en }), 'ui-settings-codex: dictionaries')
  const t = ctx.locale.bind('settings.codex')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'codex', order: 32,
    label: () => t('nav'), locale: 'settings.codex',
    inject: () => ({ status: () => codex.status(), install: (options: { autoStart: boolean }) => codex.install(options) }),
  }, CodexSection))
}
