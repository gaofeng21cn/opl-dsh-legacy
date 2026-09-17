/**
 * What this plugin contributes to a composition.
 *
 * Two facts matter and they pull in opposite directions: the route must be
 * live (so the composer can pick its model and first-run readiness is
 * satisfied), and it must NOT appear in the Models page's configurable
 * directory (because that page renders an editable profile card, and this
 * route has no profile to edit — its surface is the account page).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as OplGateway from '../src/index.ts'

let home = ''
let stateRoot = ''
const previousStateRoot = process.env.OPL_GATEWAY_STATE_ROOT

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-opl-mount-'))
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-opl-state-'))
  // Hermetic: the plugin reads OPL's own state directory unless told otherwise,
  // and a unit test must not depend on the developer's gateway account.
  process.env.OPL_GATEWAY_STATE_ROOT = stateRoot
})

afterEach(async () => {
  if (previousStateRoot === undefined) delete process.env.OPL_GATEWAY_STATE_ROOT
  else process.env.OPL_GATEWAY_STATE_ROOT = previousStateRoot
  await rm(home, { recursive: true, force: true })
  await rm(stateRoot, { recursive: true, force: true })
})

async function mount(): Promise<Context> {
  await writeFile(join(home, 'settings.yaml'), '')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(OplGateway, {})
  return ctx
}

describe('OPL Gateway composition', () => {
  it('registers the route so its model is selectable', async () => {
    const ctx = await mount()
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'opl-gateway', name: 'OPL Gateway' })
  })

  it('stays out of the Models page directory', async () => {
    const ctx = await mount()
    // An entry here would render a provider row whose only action is "edit
    // settings.yaml", the uneditable twin of the official DeepSeek card.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .not.toContain('opl-gateway')
  })

  it('provides the account surface the settings page drives', async () => {
    const ctx = await mount()
    const account = ctx.get('oplGatewayAccount')
    expect(account).toBeDefined()
    expect(await account?.status()).toMatchObject({
      phase: 'signed-out',
      keyReady: false,
      models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }],
    })
  })
})
