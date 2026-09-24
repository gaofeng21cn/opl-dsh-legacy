import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OPL_GATEWAY_INFERENCE_BASE_URL,
  importOplGatewayKey,
  oplGatewayStateDirectories,
  oplGatewayStateDirectory,
  readBoundGatewayKey,
  readOplGatewayAccount,
  readOplGatewayBinding,
  resolveInferenceBaseURL,
} from '../src/opl-credentials.ts'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opl-gateway-'))
  roots.push(root)
  return root
}

function privateFile(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, { mode: 0o600 })
}

function writeState(root: string, binding: unknown): void {
  privateFile(join(root, 'account.json'), `${JSON.stringify({
    surface_kind: 'opl_gateway_account_state.v1',
    key_group_id: '22',
    available_groups: [{ group_id: '22', label: 'DeepSeek' }],
    status: 'connected',
    codex_binding: binding,
  }, undefined, 2)}\n`)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('gateway state location', () => {
  it('defaults below the home directory and honors the override', () => {
    expect(oplGatewayStateDirectory('/Users/example', {}, 'darwin'))
      .toBe('/Users/example/Library/Application Support/OPL/state/gateway')
    expect(oplGatewayStateDirectory('/Users/example', { OPL_GATEWAY_STATE_ROOT: '/custom/state' }, 'darwin'))
      .toBe('/custom/state')
    expect(oplGatewayStateDirectory('/Users/example', { OPL_GATEWAY_STATE_ROOT: '  ' }, 'darwin'))
      .toBe('/Users/example/Library/Application Support/OPL/state/gateway')
  })

  it('uses the Windows application-data roots instead of the macOS layout', () => {
    expect(oplGatewayStateDirectories('C:\\Users\\Example', {
      APPDATA: 'C:\\Users\\Example\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local',
    }, 'win32')).toEqual([
      'C:\\Users\\Example\\AppData\\Roaming\\OPL\\state\\gateway',
      'C:\\Users\\Example\\AppData\\Local\\OPL\\state\\gateway',
    ])
  })

  it('offers every Windows root once and ignores blank ones', () => {
    expect(oplGatewayStateDirectories('C:\\Users\\Example', { APPDATA: 'C:\\shared', LOCALAPPDATA: 'C:\\shared' }, 'win32'))
      .toEqual(['C:\\shared\\OPL\\state\\gateway'])
    expect(oplGatewayStateDirectories('C:\\Users\\Example', { APPDATA: '  ', LOCALAPPDATA: 'C:\\local' }, 'win32'))
      .toEqual(['C:\\local\\OPL\\state\\gateway'])
  })

  it('has no Windows candidate when no root is defined, and still answers with a path', () => {
    expect(oplGatewayStateDirectories('C:\\Users\\Example', {}, 'win32')).toEqual([])
    expect(oplGatewayStateDirectory('C:\\Users\\Example', {}, 'win32'))
      .toBe('C:\\Users\\Example\\OPL\\state\\gateway')
  })

  it('honors the override ahead of every platform layout', () => {
    expect(oplGatewayStateDirectories('/Users/example', { OPL_GATEWAY_STATE_ROOT: 'D:\\opl\\state' }, 'win32'))
      .toEqual(['D:\\opl\\state'])
    expect(oplGatewayStateDirectories('/Users/example', { OPL_GATEWAY_STATE_ROOT: 'D:\\opl\\state' }, 'darwin'))
      .toEqual(['D:\\opl\\state'])
  })
})

describe('binding discovery', () => {
  it('reads the bound client configuration and provider', () => {
    const root = scratch()
    writeState(root, { config_path: '/tmp/client/config.toml', provider_id: 'gflab' })
    expect(readOplGatewayBinding(root)).toEqual({ configPath: '/tmp/client/config.toml', providerId: 'gflab' })
  })

  it('reports no binding without a signed-in account', () => {
    const root = scratch()
    expect(readOplGatewayBinding(root)).toBeUndefined()
    writeState(root, undefined)
    expect(readOplGatewayBinding(root)).toBeUndefined()
    writeState(root, { config_path: '  ', provider_id: 'gflab' })
    expect(readOplGatewayBinding(root)).toBeUndefined()
    writeState(root, { config_path: '/tmp/config.toml' })
    expect(readOplGatewayBinding(root)).toBeUndefined()
  })

  it('does not follow a symbolic link into another owner', () => {
    const root = scratch()
    const real = join(scratch(), 'account.json')
    privateFile(real, '{}')
    try {
      symlinkSync(real, join(root, 'account.json'))
    } catch {
      // Windows denies a file symlink unless Developer Mode is on or the
      // process is elevated. A directory junction needs neither, and `lstat`
      // reports a junction as a symbolic link just the same, which is the
      // clause this case exists to protect. A junction keeps the guard covered
      // on those machines instead of skipping the case and leaving it dark.
      const foreignDirectory = join(scratch(), 'account.json')
      mkdirSync(foreignDirectory, { recursive: true })
      symlinkSync(foreignDirectory, join(root, 'account.json'), 'junction')
    }
    expect(readOplGatewayBinding(root)).toBeUndefined()
  })
})

describe('bound client key', () => {
  const document = `model_provider = "gflab"

[model_providers.gflab]
name = "gflab"
base_url = "https://gateway.example/v1"
experimental_bearer_token = "sk-account-key"
wire_api = "responses"

[model_providers.other]
experimental_bearer_token = "sk-other-key"
`

  it('extracts exactly the named provider section', () => {
    expect(readBoundGatewayKey(document, 'gflab'))
      .toEqual({ key: 'sk-account-key', baseURL: 'https://gateway.example/v1' })
    expect(readBoundGatewayKey(document, 'other'))
      .toEqual({ key: 'sk-other-key', baseURL: undefined })
  })

  it('reports nothing for an absent provider or a tokenless section', () => {
    expect(readBoundGatewayKey(document, 'missing')).toBeUndefined()
    expect(readBoundGatewayKey('[model_providers.gflab]\nname = "gflab"\n', 'gflab')).toBeUndefined()
  })
})

describe('credential import', () => {
  it('returns the account key and its recorded endpoint', () => {
    const root = scratch()
    const config = join(scratch(), 'config.toml')
    privateFile(config, '[model_providers.gflab]\nexperimental_bearer_token = "sk-account-key"\n')
    writeState(root, { config_path: config, provider_id: 'gflab' })
    expect(importOplGatewayKey({ stateDirectory: root }))
      .toEqual({ key: 'sk-account-key', baseURL: OPL_GATEWAY_INFERENCE_BASE_URL, providerId: 'gflab' })
  })

  it('honors an endpoint OPL deliberately bound to the key', () => {
    const root = scratch()
    const config = join(scratch(), 'config.toml')
    privateFile(config, '[model_providers.gflab]\nbase_url = "https://self-hosted.example/v1"\nexperimental_bearer_token = "sk-legacy"\n')
    writeState(root, { config_path: config, provider_id: 'gflab' })
    expect(importOplGatewayKey({ stateDirectory: root })?.baseURL).toBe('https://self-hosted.example/v1')
  })

  it('upgrades the gateway\u2019s old host name to the canonical one', () => {
    const root = scratch()
    const config = join(scratch(), 'config.toml')
    // A binding written before the service moved still names the old host.
    // Calling it would work, and would keep this machine pinned to a name OPL
    // itself has moved off.
    privateFile(config, '[model_providers.gflab]\nbase_url = "https://gflabtoken.cn/v1"\nexperimental_bearer_token = "sk-moved"\n')
    writeState(root, { config_path: config, provider_id: 'gflab' })
    expect(importOplGatewayKey({ stateDirectory: root })?.baseURL).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
  })

  it('rejects a provider the caller does not expect', () => {
    const root = scratch()
    const config = join(scratch(), 'config.toml')
    privateFile(config, '[model_providers.gflab]\nexperimental_bearer_token = "sk-account-key"\n')
    writeState(root, { config_path: config, provider_id: 'gflab' })
    expect(importOplGatewayKey({ stateDirectory: root, providerId: 'someone-else' })).toBeUndefined()
  })

  it('reports nothing when the bound client configuration is gone', () => {
    const root = scratch()
    writeState(root, { config_path: join(root, 'absent.toml'), provider_id: 'gflab' })
    expect(importOplGatewayKey({ stateDirectory: root })).toBeUndefined()
  })

  it('adopts the account from whichever Windows root OPL used', () => {
    // Windows can keep the state under either application-data root, so an
    // installation that used the second one must still be found.
    const empty = scratch()
    const populated = scratch()
    const config = join(scratch(), 'config.toml')
    privateFile(config, '[model_providers.gflab]\nexperimental_bearer_token = "sk-windows"\n')
    writeState(populated, { config_path: config, provider_id: 'gflab' })
    expect(importOplGatewayKey({ stateDirectory: [empty, populated] })?.key).toBe('sk-windows')
  })

  it('degrades to no credential when no candidate holds any OPL state', () => {
    // A machine with no OPL installation must fall back to the in-app sign-in
    // rather than failing, so an empty search is an ordinary answer.
    const candidates = [scratch(), scratch(), join(scratch(), 'absent')]
    expect(importOplGatewayKey({ stateDirectory: candidates })).toBeUndefined()
    expect(importOplGatewayKey({ stateDirectory: [] })).toBeUndefined()
  })
})

describe('recorded account', () => {
  function writeAccount(root: string, status: string, snapshot: Record<string, unknown>): void {
    privateFile(join(root, 'account.json'), `${JSON.stringify({
      surface_kind: 'opl_gateway_account_state.v1',
      key_group_id: '22',
      available_groups: [{ group_id: '22', label: 'DeepSeek' }],
      status,
      snapshot,
      observed_at: '2026-09-19T00:00:00.000Z',
      stale_after: '2026-09-19T01:00:00.000Z',
    }, undefined, 2)}\n`)
  }

  it('reads the account and its usage totals', () => {
    const root = scratch()
    writeAccount(root, 'connected', {
      display_name: 'Example',
      balance_amount: 12.5,
      balance_currency: 'CNY',
      today_tokens: 10,
      total_tokens: 2048,
    })
    expect(readOplGatewayAccount(root)).toMatchObject({
      status: 'connected',
      displayName: 'Example',
      balanceAmount: 12.5,
      balanceCurrency: 'CNY',
      todayTokens: 10,
      totalTokens: 2048,
    })
  })

  it('reports no account for an absent or unreadable state directory', () => {
    expect(readOplGatewayAccount(join(scratch(), 'absent'))).toBeUndefined()
    expect(readOplGatewayAccount([])).toBeUndefined()
  })

  it('follows the same candidate order the credential import uses', () => {
    const empty = scratch()
    const populated = scratch()
    writeAccount(populated, 'connected', { display_name: 'Second root' })
    expect(readOplGatewayAccount([empty, populated])?.displayName).toBe('Second root')
  })

  it('rejects a state file that records no status', () => {
    const root = scratch()
    privateFile(join(root, 'account.json'), '{"surface_kind":"opl_gateway_account_state.v1"}')
    expect(readOplGatewayAccount(root)).toBeUndefined()
  })
})

describe('endpoint resolution', () => {
  it('defaults to the canonical root', () => {
    expect(resolveInferenceBaseURL(undefined)).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
    expect(resolveInferenceBaseURL(null)).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
    expect(resolveInferenceBaseURL('   ')).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
  })

  it('recognizes a legacy host regardless of a trailing slash', () => {
    expect(resolveInferenceBaseURL('https://gflabtoken.cn/v1')).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
    expect(resolveInferenceBaseURL('https://gflabtoken.cn/v1/')).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
    expect(resolveInferenceBaseURL('  https://gflabtoken.cn/v1  ')).toBe(OPL_GATEWAY_INFERENCE_BASE_URL)
  })

  it('never rewrites a deployment that chose its own endpoint', () => {
    for (const custom of [
      'https://gateway.example.test/v1',
      'https://gflabtoken.cn.evil.example/v1',
      'https://gateway.medopl.com/v1',
    ]) {
      expect(resolveInferenceBaseURL(custom)).toBe(custom)
    }
  })
})
