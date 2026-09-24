/**
 * Persisted Desktop execution-environment selection.
 *
 * The selection is a launch-time fact, so it lives beside the profile the
 * launch loads rather than in Harness settings the Host owns. Changing it
 * requires a restart: an environment determines the runtime, the filesystem,
 * and the sandbox a running Host was built with, none of which can be replaced
 * under a live session.
 *
 * A missing or unreadable file means "not chosen yet", which resolves to
 * Windows Native — the behavior every existing installation already has.
 *
 * @module dsh-desktop/execution-environment-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type ExecutionEnvironment,
  type ExecutionEnvironmentKind,
  resolveExecutionEnvironment,
} from './execution-environment.ts'

/** File name the selection is stored under inside the Desktop state directory. */
export const ENVIRONMENT_SELECTION_FILENAME = 'execution-environment.json'

/** The persisted selection, as written to disk. */
interface StoredSelection {
  readonly version: 1
  readonly environment: ExecutionEnvironmentKind
  readonly distro?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Read the persisted selection.
 *
 * An unreadable file is reported rather than silently ignored: a selection
 * that vanished would silently move a user's next launch back to Windows
 * Native, where their sessions in the distribution are invisible.
 * @param stateRoot - Desktop state directory owning the selection file.
 * @returns the selected environment, defaulting to Windows Native.
 * @throws when the stored file exists but cannot be parsed or validated.
 */
export function readStoredEnvironment(stateRoot: string): ExecutionEnvironment {
  const filename = join(stateRoot, ENVIRONMENT_SELECTION_FILENAME)
  if (!existsSync(filename)) return { kind: 'windows-native' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filename, 'utf8'))
  } catch (error) {
    throw new Error(`desktop: the execution environment file ${filename} is not readable JSON`, { cause: error })
  }
  if (!isRecord(parsed) || parsed.version !== 1
    || (parsed.environment !== 'windows-native' && parsed.environment !== 'wsl2')) {
    throw new Error(`desktop: the execution environment file ${filename} is not a supported selection`)
  }
  const distro = typeof parsed.distro === 'string' ? parsed.distro : undefined
  return resolveExecutionEnvironment(parsed.environment, distro)
}

/**
 * Persist one selection.
 *
 * The write goes through a rename so a crash mid-write cannot leave a partial
 * selection that the next launch refuses to read.
 * @param stateRoot - Desktop state directory owning the selection file.
 * @param environment - environment to persist.
 * @throws when the distribution name is unusable.
 */
export function writeStoredEnvironment(stateRoot: string, environment: ExecutionEnvironment): void {
  const stored: StoredSelection = environment.kind === 'wsl2'
    ? { version: 1, environment: 'wsl2', distro: environment.distro }
    : { version: 1, environment: 'windows-native' }
  // Validate before writing so an unusable name never reaches disk.
  resolveExecutionEnvironment(stored.environment, stored.distro)
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const filename = join(stateRoot, ENVIRONMENT_SELECTION_FILENAME)
  const temp = `${filename}.${String(process.pid)}.tmp`
  writeFileSync(temp, `${JSON.stringify(stored, undefined, 2)}\n`, { mode: 0o600, flag: 'w' })
  renameSync(temp, filename)
}

/**
 * Remove a persisted selection, returning to the historical default.
 * @param stateRoot - Desktop state directory owning the selection file.
 */
export function clearStoredEnvironment(stateRoot: string): void {
  const filename = join(stateRoot, ENVIRONMENT_SELECTION_FILENAME)
  try {
    unlinkSync(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** The directory one selection file lives in, given the Desktop state root. */
export function environmentSelectionPath(stateRoot: string): string {
  return join(stateRoot, ENVIRONMENT_SELECTION_FILENAME)
}

/** Ensure the selection directory exists without writing a selection. */
export function prepareEnvironmentSelection(stateRoot: string): void {
  mkdirSync(dirname(environmentSelectionPath(stateRoot)), { recursive: true, mode: 0o700 })
}
