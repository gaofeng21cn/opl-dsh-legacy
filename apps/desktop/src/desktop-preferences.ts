/**
 * Persisted Desktop shell preferences: whether task events may raise system
 * notifications, and what closing the primary window does.
 *
 * Both facts describe this installation's own shell rather than a Host
 * profile, so they live in the Desktop state directory beside the execution
 * environment selection. A missing, unreadable, or unknown-version file
 * resolves to {@link DEFAULT_DESKTOP_PREFERENCES} — notifications on, and a
 * prompt on the next close — which is what an installation that never chose
 * already does, so an upgrade changes no behavior.
 *
 * @module dsh-desktop/desktop-preferences
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What closing the primary window does. */
export type DesktopCloseBehavior = 'ask' | 'tray' | 'exit'

/** Desktop shell preferences owned by this installation. */
export interface DesktopPreferences {
  /** Whether task completion, failure, and interactive pauses raise a system notification. */
  readonly notificationsEnabled: boolean
  /** Remembered answer to the close prompt; `ask` prompts on every close. */
  readonly closeBehavior: DesktopCloseBehavior
}

/** File name the preferences are stored under inside the Desktop state directory. */
export const DESKTOP_PREFERENCES_FILENAME = 'desktop-preferences.json'

/** Behavior of an installation that has never made a choice. */
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  notificationsEnabled: true,
  closeBehavior: 'ask',
}

/** Every close behavior this shell accepts, in prompt order. */
export const DESKTOP_CLOSE_BEHAVIORS: readonly DesktopCloseBehavior[] = ['ask', 'tray', 'exit']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Read the persisted preferences.
 *
 * A stored value that cannot be used costs one remembered choice, not a
 * launch: the defaults are the behavior of an installation that never chose,
 * and the next explicit change rewrites the file.
 * @param stateRoot - Desktop state directory owning the preferences file.
 * @returns the stored preferences, or {@link DEFAULT_DESKTOP_PREFERENCES}.
 */
export function readDesktopPreferences(stateRoot: string): DesktopPreferences {
  const filename = join(stateRoot, DESKTOP_PREFERENCES_FILENAME)
  if (!existsSync(filename)) return DEFAULT_DESKTOP_PREFERENCES
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filename, 'utf8'))
  } catch {
    // Unreadable JSON is treated exactly like an absent file.
    return DEFAULT_DESKTOP_PREFERENCES
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.notificationsEnabled !== 'boolean') {
    return DEFAULT_DESKTOP_PREFERENCES
  }
  const closeBehavior = DESKTOP_CLOSE_BEHAVIORS.find(behavior => behavior === parsed.closeBehavior)
  if (closeBehavior === undefined) return DEFAULT_DESKTOP_PREFERENCES
  return { notificationsEnabled: parsed.notificationsEnabled, closeBehavior }
}

/**
 * Persist one complete preference set.
 *
 * The write goes through a rename so a crash mid-write cannot leave a partial
 * document the next launch refuses to read.
 * @param stateRoot - Desktop state directory owning the preferences file.
 * @param preferences - complete preference set to persist.
 */
export function writeDesktopPreferences(stateRoot: string, preferences: DesktopPreferences): void {
  const stored = {
    version: 1,
    notificationsEnabled: preferences.notificationsEnabled,
    closeBehavior: preferences.closeBehavior,
  }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const filename = join(stateRoot, DESKTOP_PREFERENCES_FILENAME)
  const temp = `${filename}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(stored, undefined, 2)}\n`, { mode: 0o600, flag: 'w' })
  renameSync(temp, filename)
}

/**
 * Apply one partial preference change.
 * @param current - preferences in effect now.
 * @param update - fields to replace; absent fields keep their current value.
 * @returns the complete preference set after the change.
 */
export function applyDesktopPreferencesUpdate(
  current: DesktopPreferences,
  update: { readonly notificationsEnabled?: unknown; readonly closeBehavior?: unknown },
): DesktopPreferences {
  const notificationsEnabled = update.notificationsEnabled === undefined
    ? current.notificationsEnabled
    : update.notificationsEnabled
  if (typeof notificationsEnabled !== 'boolean') {
    throw new Error('dsh desktop: notificationsEnabled must be a boolean')
  }
  const requestedBehavior = update.closeBehavior
  if (requestedBehavior !== undefined && typeof requestedBehavior !== 'string') {
    throw new Error('dsh desktop: closeBehavior must be a string')
  }
  const closeBehavior = requestedBehavior === undefined
    ? current.closeBehavior
    : DESKTOP_CLOSE_BEHAVIORS.find(behavior => behavior === requestedBehavior)
  if (closeBehavior === undefined) {
    throw new Error(`dsh desktop: unknown close behavior ${JSON.stringify(update.closeBehavior)}`)
  }
  return { notificationsEnabled, closeBehavior }
}
