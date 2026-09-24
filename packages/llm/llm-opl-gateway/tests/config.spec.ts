import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_API_KEY_REF, DEFAULT_MODELS, toAdapterConfig } from '../src/config.ts'

describe('gateway catalog', () => {
  it('advertises the one gateway model under its deployment name', () => {
    expect(DEFAULT_MODELS).toHaveLength(1)
    expect(DEFAULT_MODELS[0]).toMatchObject({
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek-V4.1-Flash',
      systemPromptUpdate: 'in-history',
    })
  })
})

describe('gateway settings section', () => {
  it('starts on the gateway protocol, catalog, and credential reference', () => {
    const resolved = Config({})
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_REF)
    expect(resolved.models).toEqual(DEFAULT_MODELS)
    // No endpoint is stored, so the account binding can supply the one this
    // key was issued against.
    expect(resolved.baseURL).toBeUndefined()
  })

  it('lets the account binding choose the endpoint until one is configured', () => {
    expect(toAdapterConfig({})).toMatchObject({ baseURL: 'https://gateway.medopl.com/v1' })
    expect(toAdapterConfig({}, 'https://bound.example/v1')).toMatchObject({ baseURL: 'https://bound.example/v1' })
    expect(toAdapterConfig({ baseURL: ' https://typed.example/v1 ' }, 'https://bound.example/v1'))
      .toMatchObject({ baseURL: 'https://typed.example/v1' })
  })

  it('carries only the fields the DeepSeek adapter accepts', () => {
    const adapter = toAdapterConfig({ apiKeyEnv: ' CUSTOM_REF ', baseURL: ' https://example.test/v1 ' })
    expect(adapter).toMatchObject({
      apiKeyEnv: 'CUSTOM_REF',
      baseURL: 'https://example.test/v1',
    })
    // Unset settings must not shadow the adapter's own defaults.
    expect(adapter).not.toHaveProperty('models')
    expect(adapter).not.toHaveProperty('thinking')
    expect(adapter).not.toHaveProperty('retryPolicy')
  })

  it('drops blank overrides instead of forwarding them', () => {
    const adapter = toAdapterConfig({ apiKeyEnv: '   ', baseURL: '' }, 'https://bound.example/v1')
    expect(adapter).not.toHaveProperty('apiKeyEnv')
    expect(adapter).toMatchObject({ baseURL: 'https://bound.example/v1' })
  })
})
