/**
 * Resolve the Harness home this Desktop product owns, on every platform.
 *
 * The OPL distribution keeps its sessions, settings, and credentials in a home
 * of its own rather than the default `~/.dsh`, so an npm-installed `dsh` and
 * this application never fight over one directory.
 *
 * macOS receives that home from the bundle: the packaging step writes
 * `LSEnvironment.DSH_HOME` into `Info.plist` with the portable `~/.dsh-opl`,
 * which the launcher expands for the signed-in user. Windows has no equivalent
 * launch-environment mechanism, so the home is resolved here instead and handed
 * to the child processes through the ordinary environment.
 *
 * The two environment overrides are honored first, so an operator can point a
 * build or a debugging session anywhere. Otherwise the default is per platform:
 * a POSIX-style home directory on macOS and Linux, and Electron's own user-data
 * directory on Windows, where a hidden dot-directory under the user profile is
 * neither conventional nor expected.
 *
 * Every answer is derived from the *named* platform's rules and that platform's
 * home directory, never from the machine the code happens to run on. Otherwise
 * the same input would resolve differently in a cross-platform test run, and a
 * diagnostic printed on one platform could not be trusted on another.
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'

/** Environment variable that overrides the Harness home this product owns. */
export const OPL_DSH_HOME_ENV = 'DSH_OPL_HOME'

/** Portable suffix this product owns when the platform has a POSIX-style home. */
export const OPL_DSH_HOME_DIR_NAME = '.dsh-opl'

/** Directory below Electron's user-data directory that holds a Windows Harness home. */
export const WINDOWS_DSH_HOME_DIR_NAME = 'dsh-home'

/** Facts the home resolution depends on, injected so it stays testable off Windows. */
export interface DesktopDshHomeInput {
  /** Platform whose directory conventions apply. */
  readonly platform: NodeJS.Platform
  /** Environment carrying the optional overrides. */
  readonly env: NodeJS.ProcessEnv
  /** Electron's `app.getPath('userData')`, used as the Windows default root. */
  readonly userDataPath: string
  /** Operating-system home, overridable only so tests need no real profile. */
  readonly homeDirectory?: string
}

/** Path rules of the named platform, so an answer does not depend on the build host. */
function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed !== '') return trimmed
  }
  return undefined
}

/**
 * Expand the supported tilde prefixes against the home of the named platform.
 *
 * The shared `expandHomePath` helper is deliberately not used here: it expands
 * against the build host's home with the build host's separators, so asking it
 * for a `win32` answer on a POSIX machine would produce a POSIX home. This
 * function takes the caller's path API and home directory instead, which is
 * what makes the result reproducible on every host.
 * @param path - configured override that may begin with `~`, `~/`, or `~\`.
 * @param api - path rules of the named platform.
 * @param homeDirectory - that platform's absolute home directory.
 * @returns the override with any supported tilde prefix replaced.
 */
function expandPlatformHome(path: string, api: typeof posix, homeDirectory: string): string {
  if (path === '~') return homeDirectory
  if (path.startsWith('~/') || path.startsWith('~\\')) return api.join(homeDirectory, path.slice(2))
  return path
}

/**
 * Resolve the Harness home this application must use.
 *
 * Precedence, highest first: `$DSH_OPL_HOME`, `$DSH_HOME`, then the platform
 * default. An override is expanded against the named platform's home and
 * normalized with the named platform's rules, so a drive-lettered Windows
 * override is understood on a POSIX build host and vice versa.
 * @param input - platform, environment, user-data directory, and home override.
 * @returns the normalized absolute Harness home path.
 */
export function resolveDesktopDshHome(input: DesktopDshHomeInput): string {
  const api = pathApi(input.platform)
  const homeDirectory = api.resolve(input.homeDirectory ?? homedir())
  const configured = firstNonEmpty(input.env[OPL_DSH_HOME_ENV], input.env[DSH_HOME_ENV])
  if (configured !== undefined) return api.resolve(expandPlatformHome(configured, api, homeDirectory))
  return input.platform === 'win32'
    ? api.resolve(api.join(input.userDataPath, WINDOWS_DSH_HOME_DIR_NAME))
    : api.resolve(api.join(homeDirectory, OPL_DSH_HOME_DIR_NAME))
}

/**
 * Describe a Harness home for logs and diagnostics without leaking the account
 * name it usually contains.
 *
 * The prefix test folds case on Windows, where two spellings of one profile
 * directory are the same directory: without that, a home recorded by a child
 * process with different capitalization would print in full instead of being
 * shortened, which is exactly the case the display exists to avoid.
 * @param home - resolved absolute Harness home.
 * @param input - the same input that produced `home`.
 * @returns `~/.dsh-opl`-style text when the home sits below the user profile,
 *   otherwise the literal path.
 */
export function desktopDshHomeDisplay(home: string, input: DesktopDshHomeInput): string {
  const api = pathApi(input.platform)
  const homeDirectory = api.resolve(input.homeDirectory ?? homedir())
  const prefix = homeDirectory + api.sep
  const comparable = input.platform === 'win32' ? home.toLowerCase() : home
  const comparablePrefix = input.platform === 'win32' ? prefix.toLowerCase() : prefix
  if (!comparable.startsWith(comparablePrefix)) return home
  return `~${api.sep}${home.slice(prefix.length)}`
}
