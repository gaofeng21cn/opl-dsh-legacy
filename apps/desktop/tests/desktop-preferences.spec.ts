import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_PREFERENCES_FILENAME,
  DEFAULT_DESKTOP_PREFERENCES,
  applyDesktopPreferencesUpdate,
  readDesktopPreferences,
  writeDesktopPreferences,
} from '../src/desktop-preferences.ts'

const roots: string[] = []

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-preferences-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop preferences', () => {
  it('answers the compatible defaults when nothing was ever stored', () => {
    expect(readDesktopPreferences(temporary())).toEqual(DEFAULT_DESKTOP_PREFERENCES)
    expect(DEFAULT_DESKTOP_PREFERENCES).toEqual({ notificationsEnabled: true, closeBehavior: 'ask' })
  })

  it('round-trips a stored choice through one atomic write', () => {
    const root = temporary()
    writeDesktopPreferences(root, { notificationsEnabled: false, closeBehavior: 'tray' })
    expect(readDesktopPreferences(root)).toEqual({ notificationsEnabled: false, closeBehavior: 'tray' })
    expect(JSON.parse(readFileSync(join(root, DESKTOP_PREFERENCES_FILENAME), 'utf8')))
      .toEqual({ version: 1, notificationsEnabled: false, closeBehavior: 'tray' })
  })

  it('falls back to the defaults for unreadable or unsupported documents', () => {
    const root = temporary()
    const filename = join(root, DESKTOP_PREFERENCES_FILENAME)
    writeFileSync(filename, 'not json')
    expect(readDesktopPreferences(root)).toEqual(DEFAULT_DESKTOP_PREFERENCES)

    for (const document of [
      { version: 2, notificationsEnabled: false, closeBehavior: 'tray' },
      { version: 1, notificationsEnabled: 'yes', closeBehavior: 'tray' },
      { version: 1, notificationsEnabled: false, closeBehavior: 'hide' },
      { version: 1, notificationsEnabled: false },
      [],
    ]) {
      writeFileSync(filename, JSON.stringify(document))
      expect(readDesktopPreferences(root)).toEqual(DEFAULT_DESKTOP_PREFERENCES)
    }
  })

  it('applies a partial update and keeps the fields it does not name', () => {
    const current = { notificationsEnabled: true, closeBehavior: 'ask' } as const
    expect(applyDesktopPreferencesUpdate(current, { closeBehavior: 'exit' }))
      .toEqual({ notificationsEnabled: true, closeBehavior: 'exit' })
    expect(applyDesktopPreferencesUpdate(current, { notificationsEnabled: false }))
      .toEqual({ notificationsEnabled: false, closeBehavior: 'ask' })
    expect(applyDesktopPreferencesUpdate({ notificationsEnabled: false, closeBehavior: 'exit' }, {}))
      .toEqual({ notificationsEnabled: false, closeBehavior: 'exit' })
  })

  it('rejects a change that is not one of the stored values', () => {
    const current = { notificationsEnabled: true, closeBehavior: 'ask' } as const
    expect(() => applyDesktopPreferencesUpdate(current, { closeBehavior: 'hide' }))
      .toThrow('unknown close behavior')
    expect(() => applyDesktopPreferencesUpdate(current, { notificationsEnabled: 'yes' }))
      .toThrow('notificationsEnabled must be a boolean')
    expect(() => applyDesktopPreferencesUpdate(current, { closeBehavior: 7 }))
      .toThrow('closeBehavior must be a string')
  })

  it('restores the prompt after a remembered answer', () => {
    const root = temporary()
    writeDesktopPreferences(root, { notificationsEnabled: true, closeBehavior: 'exit' })
    writeDesktopPreferences(root, applyDesktopPreferencesUpdate(readDesktopPreferences(root), { closeBehavior: 'ask' }))
    expect(readDesktopPreferences(root).closeBehavior).toBe('ask')
  })
})
