/**
 * What this plugin contributes to a composition.
 *
 * Two facts matter and they pull in opposite directions: the route must be
 * live (so the composer can pick its model and first-run readiness is
 * satisfied), and it must NOT appear in the Models page's configurable
 * directory (because that page renders an editable profile card, and this
 * route has no profile to edit — its surface is the account page).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as OplGateway from '../src/index.ts'
import { OplGatewayAccountService, gatewayKeyName } from '../src/account-service.ts'
import { GatewayControlClient, GatewayControlError } from '../src/gateway-control.ts'
import type { GatewayManagedKey } from '../src/gateway-control.ts'

let home = ''
let stateRoot = ''
const previousStateRoot = process.env.OPL_GATEWAY_STATE_ROOT
const previousDshHome = process.env.DSH_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-opl-mount-'))
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-opl-state-'))
  // Hermetic: the plugin reads OPL's own state directory unless told otherwise,
  // and a unit test must not depend on the developer's gateway account.
  process.env.OPL_GATEWAY_STATE_ROOT = stateRoot
  // The account service writes its cache beside the Harness home; point that at
  // the scratch directory so a test never touches the developer's own state.
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousStateRoot === undefined) delete process.env.OPL_GATEWAY_STATE_ROOT
  else process.env.OPL_GATEWAY_STATE_ROOT = previousStateRoot
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(home, { recursive: true, force: true })
  await rm(stateRoot, { recursive: true, force: true })
})

/** A context with the seams the account service needs, and no mounted plugin. */
async function seams(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  return ctx
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
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
      models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }],
    })
  })
})

/**
 * The account flow against a scripted gateway.
 *
 * This is the case that matters for a machine with nothing else installed: the
 * plugin must take an operator from "no account" to "working key" on its own,
 * because the gateway is a service rather than a local program.
 */
describe('account flow without any local OPL installation', () => {
  /** A scripted gateway recording what the plugin asked it to do. */
  function gateway(options: { existingKeys?: GatewayManagedKey[]; withKey?: boolean } = {}) {
    const calls: string[] = []
    const keys: GatewayManagedKey[] = options.existingKeys ?? []
    const control = {
      login: async (email: string, password: string) => {
        calls.push(`login:${email}`)
        // A real instance, because the service branches on the type: a stub
        // error would exercise the "unexpected" path instead of the refusal.
        if (password !== 'right') throw new GatewayControlError('invalid_credentials', 'The account email or password is incorrect', 401)
        return { accessToken: 'access', refreshToken: 'refresh-1' }
      },
      refreshSession: async (token: string) => {
        calls.push(`refresh:${token}`)
        return { accessToken: 'access-2', refreshToken: 'refresh-2' }
      },
      profile: async () => {
        calls.push('profile')
        return { userId: '7', displayName: 'Person', email: 'person@example.test', status: 'active', balanceAmount: 12.5, balanceCurrency: 'USD' }
      },
      usage: async () => ({ todayTokens: 1024, totalTokens: 4096, todayCost: 0.25, totalCost: 3, currency: 'USD' }),
      groups: async () => [{ id: '3', label: 'Codex' }, { id: '22', label: 'DeepSeek' }],
      keys: async () => {
        calls.push('keys')
        return keys
      },
      createKey: async (_token: string, name: string, groupId: string | null) => {
        calls.push(`createKey:${name}:${String(groupId)}`)
        const created: GatewayManagedKey = {
          id: '5', name, key: 'sk-issued', status: 'active', groupId, raw: { id: 5, name, status: 'active' },
        }
        if (options.withKey !== false) keys.push(created)
        return created
      },
      setKeyStatus: async (_token: string, key: GatewayManagedKey, status: string) => {
        calls.push(`setKeyStatus:${key.id}:${status}`)
      },
    } as unknown as GatewayControlClient
    return { control, calls, keys }
  }

  async function service(control: GatewayControlClient, home: string) {
    // A bare context: the plugin itself is covered above, and mounting it would
    // register the very service this harness constructs by hand.
    const ctx = await seams()
    const credentials = ctx.get('credentials')
    expect(credentials).toBeDefined()
    return {
      account: new OplGatewayAccountService(ctx, {
        credentialRef: () => (ctx.get('llm'), 'OPL_GATEWAY_DEEPSEEK_API_KEY' as never),
        endpoint: () => 'https://gateway.example/v1',
        models: () => [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }],
        stateDirectory: () => home,
        control,
      }),
      credentials: credentials!,
    }
  }

  it('takes a fresh machine from no account to a working key', async () => {
    const { control, calls } = gateway()
    const { account, credentials } = await service(control, stateRoot)

    expect(await account.status()).toMatchObject({ phase: 'signed-out', keyReady: false })

    const result = await account.signIn('person@example.test', 'right')
    expect(result.createdKey).toBe(true)
    // The key the gateway issued becomes the one the adapter resolves, and the
    // session is kept so a restart does not need another sign-in.
    expect((await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never))?.value).toBe('sk-issued')
    expect(calls).toContain('createKey:OPL DSH · ' + (await import('node:os')).hostname() + ' · DeepSeek:22')
    expect(await account.status()).toMatchObject({
      phase: 'connected',
      source: 'session',
      keyReady: true,
      account: { email: 'person@example.test', balanceAmount: 12.5, todayTokens: 1024 },
    })
  })

  it('reuses the key a previous sign-in left behind instead of minting another', async () => {
    const name = gatewayKeyName()
    const existing: GatewayManagedKey = {
      id: '9', name, key: 'sk-existing', status: 'active', groupId: '22', raw: { id: 9, name, status: 'active' },
    }
    const { control, calls } = gateway({ existingKeys: [existing] })
    const { account, credentials } = await service(control, stateRoot)

    expect((await account.signIn('person@example.test', 'right')).createdKey).toBe(false)
    expect((await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never))?.value).toBe('sk-existing')
    expect(calls.some(call => call.startsWith('createKey'))).toBe(false)
  })

  it('reports bad credentials without leaving a session behind', async () => {
    const { control } = gateway()
    const { account, credentials } = await service(control, stateRoot)

    await expect(account.signIn('person@example.test', 'wrong')).rejects.toMatchObject({
      code: 'opl-gateway/credentials',
    })
    expect(await account.status()).toMatchObject({ phase: 'unavailable' })
    expect((await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never))).toBeUndefined()
  })

  it('releases the key on sign-out and forgets the session', async () => {
    const { control, calls } = gateway()
    const { account, credentials } = await service(control, stateRoot)
    await account.signIn('person@example.test', 'right')

    expect(await account.signOut()).toMatchObject({ phase: 'signed-out', keyReady: false })
    // The key was issued to this client, so ending the session disables it
    // rather than leaving a live credential nobody holds.
    expect(calls).toContain('setKeyStatus:5:disabled')
    expect(await credentials.resolve('OPL_GATEWAY_DEEPSEEK_API_KEY' as never)).toBeUndefined()
  })

  it('renews a stored session on refresh without another sign-in', async () => {
    const { control, calls } = gateway()
    const { account } = await service(control, stateRoot)
    await account.signIn('person@example.test', 'right')

    // A second context over the same home and credential file is the restart
    // case: the session must come back from storage, not from memory.
    const restartedCtx = await seams()
    const restarted = new OplGatewayAccountService(restartedCtx, {
      credentialRef: () => 'OPL_GATEWAY_DEEPSEEK_API_KEY' as never,
      endpoint: () => 'https://gateway.example/v1',
      models: () => [],
      stateDirectory: () => stateRoot,
      control,
    })
    expect(await restarted.refresh()).toMatchObject({ phase: 'connected', account: { email: 'person@example.test' } })
    expect(calls).toContain('refresh:refresh-1')
  })
})
