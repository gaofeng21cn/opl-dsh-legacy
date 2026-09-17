import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OPL_GATEWAY_INFERENCE_BASE_URL,
  importOplGatewayKey,
  oplGatewayStateDirectory,
  readBoundGatewayKey,
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
    status: 'connected',
    codex_binding: binding,
  }, undefined, 2)}\n`)
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('gateway state location', () => {
  it('defaults below the home directory and honors the override', () => {
    expect(oplGatewayStateDirectory('/Users/example', {}))
      .toBe('/Users/example/Library/Application Support/OPL/state/gateway')
    expect(oplGatewayStateDirectory('/Users/example', { OPL_GATEWAY_STATE_ROOT: '/custom/state' }))
      .toBe('/custom/state')
    expect(oplGatewayStateDirectory('/Users/example', { OPL_GATEWAY_STATE_ROOT: '  ' }))
      .toBe('/Users/example/Library/Application Support/OPL/state/gateway')
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
    symlinkSync(real, join(root, 'account.json'))
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
