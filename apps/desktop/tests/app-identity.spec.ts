import { describe, expect, it } from 'vitest'
import { DESKTOP_APP_ID_FIELD, parseDesktopAppId, resolveDesktopAppId } from '../src/app-identity.ts'

describe('desktop application identity', () => {
  it('reads the identity packaging injected into the manifest', () => {
    expect(parseDesktopAppId({ [DESKTOP_APP_ID_FIELD]: 'com.onepersonlab.dsh' })).toBe('com.onepersonlab.dsh')
    expect(parseDesktopAppId({ name: 'dsh-desktop' })).toBeUndefined()
    expect(parseDesktopAppId({ [DESKTOP_APP_ID_FIELD]: '' })).toBeUndefined()
    expect(parseDesktopAppId({ [DESKTOP_APP_ID_FIELD]: 'not an id' })).toBeUndefined()
    expect(parseDesktopAppId({ [DESKTOP_APP_ID_FIELD]: 'x'.repeat(129) })).toBeUndefined()
    expect(parseDesktopAppId(undefined)).toBeUndefined()
    expect(parseDesktopAppId('com.example.app')).toBeUndefined()
  })

  it('prefers an explicit launch override and refuses a malformed one', () => {
    expect(resolveDesktopAppId({
      packaged: true,
      environment: { DSH_DESKTOP_APP_ID: 'com.example.dev' },
      manifest: { [DESKTOP_APP_ID_FIELD]: 'com.example.packaged' },
    })).toBe('com.example.dev')
    expect(resolveDesktopAppId({
      packaged: true,
      environment: { DSH_DESKTOP_APP_ID: '../escape' },
      manifest: { [DESKTOP_APP_ID_FIELD]: 'com.example.packaged' },
    })).toBeUndefined()
  })

  it('publishes the packaged identity only for a packaged application', () => {
    expect(resolveDesktopAppId({
      packaged: true,
      environment: {},
      manifest: { [DESKTOP_APP_ID_FIELD]: 'com.example.packaged' },
    })).toBe('com.example.packaged')
    // An unpackaged run has no installer-written shortcut, so it must not claim
    // an identity the platform never registered.
    expect(resolveDesktopAppId({
      packaged: false,
      environment: {},
      manifest: { [DESKTOP_APP_ID_FIELD]: 'com.example.packaged' },
    })).toBeUndefined()
  })
})
