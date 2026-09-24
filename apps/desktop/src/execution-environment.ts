/**
 * The execution environment a Desktop launch targets, and the path rules that
 * belong to it.
 *
 * Windows Native runs the bundled Windows Node.js; WSL2 runs a Linux Node
 * inside one installed distribution. The two environments have different path
 * syntax, different runtime state, and different filesystem performance
 * characteristics, so the choice is a launch-time fact — not a per-call switch.
 *
 * This module owns the vocabulary and the pure path translation. It performs
 * no probing and starts no process, so every rule here is testable without WSL
 * installed; {@link ./wsl.ts} owns discovery and lifecycle.
 *
 * @module dsh-desktop/execution-environment
 */

import { posix, win32 } from 'node:path'

/** Which execution environment a launch targets. */
export type ExecutionEnvironmentKind = 'windows-native' | 'wsl2'

/** Environment variable naming the selected environment, honored at launch. */
export const DESKTOP_ENVIRONMENT_ENV = 'DSH_DESKTOP_ENVIRONMENT'

/** Environment variable naming the selected WSL2 distribution. */
export const DESKTOP_WSL_DISTRO_ENV = 'DSH_DESKTOP_WSL_DISTRO'

/** The default environment: the current Windows Native behavior. */
export const DEFAULT_EXECUTION_ENVIRONMENT: ExecutionEnvironmentKind = 'windows-native'

/** One resolved execution environment. */
export type ExecutionEnvironment =
  | { readonly kind: 'windows-native' }
  | { readonly kind: 'wsl2'; readonly distro: string }

/** How one caller-supplied path is spelled. */
export type PathKind =
  /** A drive-letter Windows path, such as `C:\work`. */
  | 'windows-drive'
  /** A `\\wsl$`/`\\wsl.localhost` UNC path naming a distribution. */
  | 'wsl-unc'
  /** A `\\server\share` UNC path that is not a WSL distribution. */
  | 'unc'
  /** An absolute POSIX path, such as `/mnt/c/work` or `/home/me/work`. */
  | 'posix'
  /** A relative path or a bare name. */
  | 'relative'

/** Distribution name required by `\\wsl$` UNC paths. */
const WSL_UNC_HOSTS = ['wsl$', 'wsl.localhost'] as const

/**
 * Only these characters may appear in a distribution name passed to `wsl.exe`.
 *
 * The name reaches a process command line, so it is validated rather than
 * escaped: `wsl.exe` treats an option-looking argument as its own, and a name
 * containing a quote or separator could not be a real distribution anyway.
 */
const DISTRO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

const DRIVE_PATH_PATTERN = /^([A-Za-z]):[\\/]/u

/**
 * Validate one distribution name.
 * @param name - candidate distribution name.
 * @returns the name when it is usable.
 * @throws when the name is empty or contains characters `wsl.exe` would read as syntax.
 */
export function assertDistroName(name: string): string {
  if (!DISTRO_NAME_PATTERN.test(name)) {
    throw new Error(`desktop: ${JSON.stringify(name)} is not a usable WSL distribution name`)
  }
  return name
}

/**
 * Read the persisted environment selection.
 *
 * An unset or empty value selects the default. A `wsl2` selection without a
 * usable distribution name fails loud rather than silently falling back to
 * Windows Native: a launch that ran on the wrong environment would use the
 * wrong filesystem and the wrong runtime state.
 * @param value - persisted environment kind, as stored in settings.
 * @param distro - persisted distribution name.
 * @returns the resolved environment.
 * @throws when the kind is unknown or a WSL2 selection names no distribution.
 */
export function resolveExecutionEnvironment(
  value: string | undefined,
  distro: string | undefined,
): ExecutionEnvironment {
  if (value === undefined || value === '' || value === 'windows-native') {
    if (distro !== undefined && distro !== '') assertDistroName(distro)
    return { kind: 'windows-native' }
  }
  if (value !== 'wsl2') throw new Error(`desktop: unknown execution environment ${JSON.stringify(value)}`)
  if (distro === undefined || distro === '') {
    throw new Error('desktop: the wsl2 execution environment requires a distribution name')
  }
  return { kind: 'wsl2', distro: assertDistroName(distro) }
}

/**
 * Read the environment selection from a process environment.
 * @param env - environment carrying the optional overrides.
 * @returns the resolved environment.
 * @throws when the overrides are unusable.
 */
export function executionEnvironmentFromEnv(env: NodeJS.ProcessEnv): ExecutionEnvironment {
  return resolveExecutionEnvironment(env[DESKTOP_ENVIRONMENT_ENV], env[DESKTOP_WSL_DISTRO_ENV])
}

/**
 * Whether the process environment carries an explicit environment override.
 *
 * This distinguishes a deliberate operator choice (a debugging or scripted
 * launch) from the absence of one, which must fall through to the persisted
 * selection instead of defaulting to Windows Native.
 * @param env - environment carrying the optional overrides.
 * @returns true when either override names a non-empty value.
 */
export function hasEnvironmentOverride(env: NodeJS.ProcessEnv): boolean {
  for (const name of [DESKTOP_ENVIRONMENT_ENV, DESKTOP_WSL_DISTRO_ENV]) {
    const value = env[name]
    if (value !== undefined && value.trim() !== '') return true
  }
  return false
}

/**
 * Choose the environment one launch runs in.
 *
 * An explicit process-environment override wins because it is a deliberate
 * per-launch choice. Otherwise the persisted selection decides, and it is
 * returned unchanged even when it names WSL2: a launch that cannot honor it
 * must fail loudly rather than silently run on Windows Native, where the
 * user's sessions and plugins are not.
 * @param env - process environment that may carry an override.
 * @param stored - persisted selection for the next launch.
 * @returns the environment this launch runs in.
 * @throws when an override is present but unusable.
 */
export function resolveRunningEnvironment(
  env: NodeJS.ProcessEnv,
  stored: ExecutionEnvironment,
): ExecutionEnvironment {
  return hasEnvironmentOverride(env) ? executionEnvironmentFromEnv(env) : stored
}

/** A stable identifier for one environment, used to separate runtime state. */
export function executionEnvironmentId(environment: ExecutionEnvironment): string {
  return environment.kind === 'wsl2' ? `wsl2:${environment.distro}` : 'windows-native'
}

/**
 * Classify how one path is spelled.
 * @param path - caller-supplied path.
 * @returns its spelling category.
 */
export function pathKind(path: string): PathKind {
  if (path === '') return 'relative'
  if (DRIVE_PATH_PATTERN.test(path)) return 'windows-drive'
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    const rest = path.slice(2)
    const separator = rest.search(/[\\/]/u)
    const host = (separator === -1 ? rest : rest.slice(0, separator)).toLowerCase()
    return WSL_UNC_HOSTS.some(candidate => candidate.toLowerCase() === host) ? 'wsl-unc' : 'unc'
  }
  if (path.startsWith('/')) return 'posix'
  return 'relative'
}

/**
 * Read the distribution named by a `\\wsl$` UNC path.
 *
 * The form is `\\<host>\<distro>\<posix path>`: `wsl$` and `wsl.localhost` are
 * the host components that mark the share as a WSL distribution, and the
 * distribution name follows them.
 * @param path - UNC path beginning with `\\wsl$` or `\\wsl.localhost`.
 * @returns the distribution name and the POSIX path inside it, or undefined
 *   when the path is not a usable WSL UNC path.
 */
export function parseWslUncPath(path: string): { readonly distro: string; readonly posixPath: string } | undefined {
  if (pathKind(path) !== 'wsl-unc') return undefined
  const components = path.slice(2).split(/[\\/]+/u)
  const distro = components[1]
  if (distro === undefined || !DISTRO_NAME_PATTERN.test(distro)) return undefined
  const tail = components.slice(2).filter(component => component !== '')
  return { distro, posixPath: tail.length === 0 ? '/' : `/${tail.join('/')}` }
}

/**
 * Translate a Windows drive path to its WSL2 mount path.
 * @param path - absolute Windows drive path.
 * @returns the `/mnt/<drive>/…` path, or undefined when the input is not a drive path.
 */
export function windowsPathToWsl(path: string): string | undefined {
  const match = DRIVE_PATH_PATTERN.exec(path)
  if (match === null) return undefined
  const drive = (match[1] as string).toLowerCase()
  const tail = path.slice(match[0].length).replaceAll('\\', '/')
  return `/mnt/${drive}/${tail}`
}

/**
 * Translate a `/mnt/<drive>` path back to its Windows drive path.
 * @param path - absolute POSIX path.
 * @returns the Windows path, or undefined when the input is not a drive mount.
 */
export function wslPathToWindows(path: string): string | undefined {
  const match = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(path)
  if (match === null) return undefined
  const drive = (match[1] as string).toUpperCase()
  const tail = match[2] ?? ''
  return tail === '' ? `${drive}:\\` : `${drive}:\\${tail.replaceAll('/', '\\')}`
}

/**
 * The Windows UNC path that reaches one path inside a distribution.
 *
 * `\\wsl$\<distro>` is used rather than `\\wsl.localhost`: the former resolves
 * on every supported Windows build, while the latter is the newer alias.
 * @param distro - distribution name.
 * @param posixPath - absolute POSIX path inside that distribution.
 * @returns the UNC path.
 * @throws when the distribution name is unusable.
 */
export function wslUncPath(distro: string, posixPath: string): string {
  assertDistroName(distro)
  const normalized = posix.normalize(posixPath).replaceAll('/', '\\')
  return `\\\\wsl$\\${distro}${normalized === '\\' ? '' : normalized}`
}

/**
 * Translate one path into the syntax of a target environment.
 *
 * Translation is total for the forms a user can choose: a path already in the
 * target's syntax is normalized and returned, and each cross-environment form
 * converts when it names a location that environment can reach. A path that
 * cannot be expressed (a `\\server\share` UNC path from inside WSL2, or a
 * relative path) is returned unchanged and reported by {@link describePathReach}.
 *
 * @param path - caller-supplied path.
 * @param environment - environment the path must be expressed in.
 * @returns the path in that environment's syntax.
 * @throws when a WSL UNC path names a different distribution than the selected one.
 */
export function translatePath(path: string, environment: ExecutionEnvironment): string {
  const kind = pathKind(path)
  if (environment.kind === 'windows-native') {
    // A POSIX path is only reachable from Windows through a distribution, and
    // which distribution is not knowable here, so it is returned unchanged.
    if (kind === 'posix') return wslPathToWindows(path) ?? path
    if (kind === 'wsl-unc') {
      const parsed = parseWslUncPath(path)
      return parsed === undefined ? path : win32.normalize(`\\\\wsl$\\${parsed.distro}${parsed.posixPath.replaceAll('/', '\\')}`)
    }
    return kind === 'relative' ? path : win32.normalize(path)
  }
  switch (kind) {
    case 'windows-drive':
      return windowsPathToWsl(path) ?? path
    case 'wsl-unc': {
      const parsed = parseWslUncPath(path)
      if (parsed === undefined) return path
      if (parsed.distro !== environment.distro) {
        throw new Error(
          `desktop: ${JSON.stringify(path)} names WSL distribution ${JSON.stringify(parsed.distro)}, `
          + `but the selected environment is ${JSON.stringify(environment.distro)}`,
        )
      }
      return posix.normalize(parsed.posixPath)
    }
    case 'posix':
      return posix.normalize(path)
    default:
      return path
  }
}

/**
 * Whether one path is reachable from one environment, and why not when it is not.
 *
 * This is the fact a settings surface needs: a workspace under `/mnt/c` is
 * usable from WSL2 but pays the 9p filesystem cost, and a `\\server\share` UNC
 * path cannot be opened from inside a distribution at all.
 * @param path - caller-supplied path.
 * @param environment - environment that must reach it.
 * @returns reachability plus a human-readable reason when it is limited.
 */
export function describePathReach(
  path: string,
  environment: ExecutionEnvironment,
): { readonly reachable: boolean; readonly reason: 'native' | 'drive-mount' | 'unc-unreachable' | 'cross-distro' | 'relative' } {
  const kind = pathKind(path)
  if (kind === 'relative') return { reachable: false, reason: 'relative' }
  if (environment.kind === 'windows-native') {
    return { reachable: kind !== 'posix' || pathKind(wslPathToWindows(path) ?? '') === 'windows-drive', reason: 'native' }
  }
  if (kind === 'unc') return { reachable: false, reason: 'unc-unreachable' }
  if (kind === 'wsl-unc') {
    const parsed = parseWslUncPath(path)
    if (parsed !== undefined && parsed.distro !== environment.distro) return { reachable: false, reason: 'cross-distro' }
  }
  if (kind === 'windows-drive' || (kind === 'posix' && /^\/mnt\/[A-Za-z](\/|$)/u.test(path))) {
    return { reachable: true, reason: 'drive-mount' }
  }
  return { reachable: true, reason: 'native' }
}

/**
 * The user-visible caution for one path in one environment.
 *
 * A `/mnt/<drive>` path crosses the WSL2 9p boundary on every file operation,
 * which is materially slower than a path inside the distribution's own
 * filesystem. The path is allowed — the user may have no alternative — but the
 * cost is stated rather than discovered.
 * @param path - caller-supplied path.
 * @param environment - environment that will use it.
 * @returns the caution identifier, or undefined when there is nothing to say.
 */
export function pathPerformanceNotice(
  path: string,
  environment: ExecutionEnvironment,
): 'windows-drive-mount' | undefined {
  if (environment.kind !== 'wsl2') return undefined
  const kind = pathKind(path)
  if (kind === 'windows-drive') return 'windows-drive-mount'
  if (kind === 'posix' && /^\/mnt\/[A-Za-z](\/|$)/u.test(path)) return 'windows-drive-mount'
  return undefined
}

/**
 * Runtime-state directory suffixes that must never be shared between two
 * environments.
 *
 * Windows Native and a WSL2 distribution use different Node builds, native
 * modules, paths, and process semantics, so one database written by both would
 * be corrupted rather than merely stale. Each environment therefore owns its
 * own state root below the shared Harness home.
 */
export const ENVIRONMENT_STATE_ISOLATION = [
  'sessions',
  'cache',
  'desktop',
  'profiles',
] as const

/**
 * The per-environment state root below one Harness home.
 *
 * Windows Native keeps the historical shared layout so existing installations
 * are untouched; WSL2 is appended as a sibling keyed by a name derived from the
 * distribution, which keeps two distributions on one machine apart as well.
 * @param dshHome - shared Harness home path, in the target environment's syntax.
 * @param environment - environment that will use the root.
 * @returns the state root path.
 * @throws when the distribution name is unusable.
 */
export function environmentStateRoot(dshHome: string, environment: ExecutionEnvironment): string {
  if (environment.kind === 'windows-native') return dshHome
  const api = pathKind(dshHome) === 'posix' ? posix : win32
  return api.join(dshHome, 'environments', environmentStateName(environment))
}

/**
 * The directory name one environment owns below `environments/`.
 * @param environment - environment to name.
 * @returns a filesystem-safe directory name.
 * @throws when the distribution name is unusable.
 */
export function environmentStateName(environment: ExecutionEnvironment): string {
  if (environment.kind === 'windows-native') return 'windows-native'
  // Distribution names are already restricted to filesystem-safe characters,
  // so the name is used verbatim rather than hashed: an operator must be able
  // to see which directory belongs to which distribution.
  return `wsl2-${assertDistroName(environment.distro)}`
}

/**
 * Whether two environments may share one runtime-state database.
 * @param left - first environment.
 * @param right - second environment.
 * @returns true only when both are the same environment.
 */
export function shareState(left: ExecutionEnvironment, right: ExecutionEnvironment): boolean {
  return executionEnvironmentId(left) === executionEnvironmentId(right)
}
