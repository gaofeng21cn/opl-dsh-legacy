/**
 * Git Bash restricted-execution broker: the launch decision and parameter
 * guard one agent Bash command passes through before `ctx.sandbox` confines it
 * on Windows.
 *
 * The Windows backend confines by spawning the caller's argv under a
 * WRITE_RESTRICTED token whose restricting list carries the logon SID,
 * EVERYONE, and the mode's write capabilities. Git for Windows is an MSYS
 * runtime: it initializes per-user named kernel objects whose security
 * descriptors name the user SID and no restricting SID, so the token's second
 * access check denies initialization before any command runs. Adding the user
 * SID to the restricting list would let those objects open and would equally
 * grant every ambient write ACE the user holds, so "Git Bash runs confined on
 * this host" is a PROBED capability ({@link GitBashProbeReport}) rather than an
 * assumption: the consumer runs the real backend against the real executable
 * and refuses — never silently downgrades to an unconfined launch — while any
 * dimension stays unproven.
 *
 * Around that decision the broker bounds the launch parameters it owns: the
 * working directory must sit inside the mode's granted roots after MSYS and
 * Windows spellings, `..` traversal, drive switches, UNC prefixes, and
 * reparse-point (junction/symlink) resolution are unified into one comparison
 * key, and the inherited environment is pinned to the boundary (HOME inside the
 * workspace; out-of-bound startup-file variables tombstoned).
 *
 * Reads are NOT bounded here. The Windows backend restricts write access only,
 * and the launch cwd is not a read boundary.
 * @module @deepseek-ai/dsh-shell/git-bash-broker
 */

import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedSandboxMode, SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * Dimensions a host must prove before Git Bash may run under a confined mode:
 * the MSYS runtime must initialize under the restricted token, and the mode's
 * write boundary must hold — a write inside the granted roots behaves as the
 * mode says and a write outside every granted root is denied to that process
 * tree. Both are observed, not inferred — a present runner proves neither.
 */
export const GIT_BASH_PROBE_DIMENSIONS = ['msys-runtime-startup', 'write-denial-outside-roots'] as const

/** One probed dimension of Git Bash confinement. */
export type GitBashProbeDimension = typeof GIT_BASH_PROBE_DIMENSIONS[number]

/** What one host proved by running the real backend against the real Git Bash. */
export interface GitBashProbeReport {
  /** The dimensions observed holding; a confined launch requires every dimension. */
  readonly proven: readonly GitBashProbeDimension[]
  /** Observable evidence for a dimension that did not hold (runner or runtime diagnostic). */
  readonly evidence?: string | undefined
}

/** Inputs of the Git Bash confined-launch decision. */
export interface GitBashDecisionRequest {
  /** The resolved per-call mode. */
  readonly mode: SandboxMode
  /** Execution platform; the broker is inert off win32, where bash confines through the platform backend. */
  readonly platform: NodeJS.Platform
  /** This host's probe report; absent means "not probed", which is not proven. */
  readonly probe?: GitBashProbeReport | undefined
}

/** The broker's launch decision for one Bash call. */
export type GitBashDecision =
  | { readonly kind: 'direct' }
  | { readonly kind: 'confined' }
  | { readonly kind: 'refused'; readonly missing: readonly GitBashProbeDimension[]; readonly detail: string }

/**
 * Decide how one Bash call may start: directly (no Git Bash boundary involved),
 * confined (every probed dimension holds), or refused with the unproven
 * dimensions and an actionable fallback.
 *
 * `danger-full-access` is direct by definition, and a POSIX host is direct
 * because its bash is confined by the platform backend rather than by this
 * broker.
 * @param request - the resolved mode, the platform, and this host's probe report.
 * @returns the decision; `refused` carries the missing dimensions and the detail text.
 */
export function decideGitBashConfinement(request: GitBashDecisionRequest): GitBashDecision {
  if (request.platform !== 'win32' || request.mode === 'danger-full-access') return { kind: 'direct' }
  const proven = request.probe?.proven ?? []
  const missing = GIT_BASH_PROBE_DIMENSIONS.filter(dimension => !proven.includes(dimension))
  if (missing.length === 0) return { kind: 'confined' }
  return { kind: 'refused', missing, detail: refusalDetail(request.mode, missing, request.probe?.evidence) }
}

/** The refusal detail: what stayed unproven, what ran instead of the command, and the approved fallback. */
function refusalDetail(mode: ConfinedSandboxMode, missing: readonly GitBashProbeDimension[], evidence?: string): string {
  return `Git Bash on Windows cannot run confined under ${mode}: the capability probe did not prove `
    + `${missing.join(', ')}${evidence === undefined ? '' : ` (${evidence})`}. `
    + 'Use PowerShell for read-only/workspace-write. Git Bash requires explicitly approved danger-full-access; '
    + 'this command was not started and permissions were not changed.'
}

/** MSYS mount targets the broker places a Git Bash path under. */
export interface GitBashMounts {
  /** Git for Windows installation root — the MSYS `/` mount; absent when the executable's root is unknown. */
  readonly installationRoot?: string | undefined
  /** Windows directory the MSYS `/tmp` mount resolves to; defaults to the process temp directory. */
  readonly tempRoot?: string | undefined
}

/** The MSYS `/tmp` mount point (Git for Windows mounts it on the user's temp directory). */
const MSYS_TEMP_MOUNT = '/tmp'

/**
 * Absolute path prefixes that name ANOTHER environment's drive mounts, not Git
 * Bash's: the Windows Subsystem for Linux spells a drive `/mnt/c` and Cygwin
 * spells it `/cygdrive/c`, while Git for Windows mounts it as `/c`. The broker
 * never translates them to a drive: Git Bash itself resolves them under the
 * MSYS root (where they exist only if the user's fstab mounted them), so
 * translating one would admit a launch directory the command never uses.
 */
const FOREIGN_DRIVE_MOUNT = /^\/(?:mnt|cygdrive)(?:\/|$)/iu

/** An absolute Windows drive path (`C:\…` or `C:/…`). */
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/iu

/** An absolute Windows UNC path (`\\server\share`), including the `\\?\UNC\` device spelling. */
const WINDOWS_UNC_PATH = /^[\\/]{2}[^\\/]/u

/** A Windows device-namespace path (`\\.\…`), which names a device rather than a directory. */
const WINDOWS_DEVICE_PATH = /^[\\/]{2}\./u

/** Remove the `\\?\` / `\\?\UNC\` device prefix, which spells the same file as its plain form. */
function stripDevicePrefix(path: string): string {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/iu.test(path)) return `\\\\${path.slice(8)}`
  if (/^[\\/]{2}\?[\\/]/u.test(path)) return path.slice(4)
  return path
}

/** Drop trailing separators, keeping a bare drive root (`C:\`) intact. */
function trimTrailingSeparators(path: string): string {
  return path.length > 3 ? path.replace(/[\\/]+$/u, '') : path
}

/**
 * The comparison key for one absolute Windows path: device prefix removed,
 * separators and case folded, `..` resolved, trailing separators dropped.
 * Windows path comparison is case-insensitive, so two spellings of one
 * directory must never straddle a boundary check.
 * @param path - an absolute Windows path (either separator).
 * @returns the case-folded comparison key.
 */
export function windowsPathKey(path: string): string {
  return trimTrailingSeparators(stripDevicePrefix(win32.resolve(path))).toLowerCase()
}

/**
 * Whether one comparison key is the root itself or sits below it.
 * @param rootKey - the boundary's comparison key from {@link windowsPathKey}.
 * @param candidateKey - the candidate's comparison key from {@link windowsPathKey}.
 * @returns true when the candidate is inside the boundary.
 */
export function isWithinWindowsPathKey(rootKey: string, candidateKey: string): boolean {
  if (candidateKey === rootKey) return true
  const prefix = rootKey.endsWith('\\') ? rootKey : `${rootKey}\\`
  return candidateKey.startsWith(prefix)
}

/**
 * Translate an absolute Windows path into the MSYS spelling Git Bash resolves
 * to the same file (`C:\a\b` → `/c/a/b`, `\\server\share\a` → `//server/share/a`).
 * @param path - an absolute Windows path.
 * @returns the MSYS spelling with forward slashes.
 */
export function windowsPathToMsys(path: string): string {
  const resolved = trimTrailingSeparators(stripDevicePrefix(win32.resolve(path)))
  const unc = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)((?:[\\/].*)?)$/u.exec(resolved)
  if (unc !== null) return `//${unc[1]}/${unc[2]}${(unc[3] ?? '').replace(/\\/gu, '/')}`
  const drive = /^([a-z]):((?:[\\/].*)?)$/iu.exec(resolved)
  if (drive === null) return resolved.replace(/\\/gu, '/')
  const rest = (drive[2] ?? '').replace(/\\/gu, '/')
  return `/${(drive[1] ?? '').toLowerCase()}${rest === '/' ? '' : rest}`
}

/**
 * Translate an absolute MSYS path into its Windows spelling. Only the mounts
 * Git for Windows defines are translated: `/c/…` maps to the drive, `/tmp/…`
 * to the temp mount, `//server/share/…` to the UNC path, and every other
 * absolute path to the Git for Windows installation root that backs `/`. The
 * last rule is conservative — `/dev`, `/proc`, and `/bin` are placed under the
 * installation root rather than matched against the workspace — and the
 * foreign drive mounts `/mnt/…` and `/cygdrive/…` are refused outright because
 * no Git Bash mount defines them.
 * @param path - an absolute MSYS path.
 * @param mounts - the installation root and the temp mount target.
 * @returns the absolute Windows path, or undefined when the input is relative,
 *   names a foreign drive mount, or is `/`-rooted with no known installation root.
 */
export function msysPathToWindows(path: string, mounts: GitBashMounts = {}): string | undefined {
  if (!path.startsWith('/')) return undefined
  if (FOREIGN_DRIVE_MOUNT.test(path)) return undefined
  const unc = /^\/\/([^/]+)\/([^/]+)((?:\/.*)?)$/u.exec(path)
  if (unc !== null) {
    return win32.resolve(`\\\\${unc[1]}\\${unc[2]}${(unc[3] ?? '').replace(/\//gu, '\\')}`)
  }
  const drive = /^\/([a-z])(?=\/|$)(.*)$/iu.exec(path)
  if (drive !== null) {
    const rest = (drive[2] ?? '').replace(/\//gu, '\\')
    return win32.resolve(`${(drive[1] ?? '').toUpperCase()}:\\${rest.startsWith('\\') ? rest.slice(1) : rest}`)
  }
  if (path === MSYS_TEMP_MOUNT || path.startsWith(`${MSYS_TEMP_MOUNT}/`)) {
    const tempRoot = mounts.tempRoot ?? tmpdir()
    return win32.resolve(`${trimTrailingSeparators(win32.resolve(tempRoot))}${path.slice(MSYS_TEMP_MOUNT.length).replace(/\//gu, '\\')}`)
  }
  const root = mounts.installationRoot
  if (root === undefined) return undefined
  return win32.resolve(`${trimTrailingSeparators(win32.resolve(root))}${path.replace(/\//gu, '\\')}`)
}

/**
 * The absolute Windows spelling of a directory named in either world, which is
 * the one spelling the broker compares and the one Node's spawn accepts.
 * @param path - a Windows absolute path or an absolute MSYS path.
 * @param mounts - the installation root and temp mount target for MSYS paths.
 * @returns the absolute Windows path, or undefined when the input is relative,
 *   drive-relative (`C:dir`), or in the device namespace (`\\.\…`) — none of
 *   which names a directory the broker can place inside a boundary.
 */
export function brokerAbsolutePath(path: string, mounts: GitBashMounts = {}): string | undefined {
  const trimmed = path.trim()
  if (trimmed.length === 0 || WINDOWS_DEVICE_PATH.test(trimmed)) return undefined
  if (WINDOWS_DRIVE_PATH.test(trimmed) || WINDOWS_UNC_PATH.test(trimmed)) {
    const resolved = trimTrailingSeparators(win32.resolve(stripDevicePrefix(trimmed)))
    // One spelling per drive: Windows path comparison is case-insensitive, so
    // the drive letter is upper-cased to keep diagnostics and comparisons stable.
    return /^[a-z]:/iu.test(resolved) ? `${resolved.slice(0, 1).toUpperCase()}${resolved.slice(1)}` : resolved
  }
  return msysPathToWindows(trimmed, mounts)
}

/**
 * Environment names a confined Git Bash launch must not inherit: the startup
 * files bash sources before the agent's command runs and the search path that
 * relocates a descendant's `cd`. Each is tombstoned (an explicit `undefined`
 * removes the ambient entry at the subprocess seam) rather than reassigned,
 * because there is no in-boundary file to point them at.
 */
const GIT_BASH_TOMBSTONES = ['BASH_ENV', 'ENV', 'CDPATH'] as const

/** Inputs of the Git Bash launch-parameter guard. */
export interface GitBashLaunchGuardRequest {
  /** Execution platform; off win32 the guard constrains nothing. */
  readonly platform: NodeJS.Platform
  /** The confined mode being launched. */
  readonly mode: ConfinedSandboxMode
  /** The policy's workspace boundary, in either world's spelling. */
  readonly workspaceRoot: string
  /** The resolved launch directory, in either world's spelling. */
  readonly workdir: string
  /** Git for Windows installation root ({@link gitForWindowsRoot}), for MSYS placement. */
  readonly installationRoot?: string | undefined
  /** The MSYS `/tmp` mount target; defaults to the process temp directory. */
  readonly tempRoot?: string | undefined
  /**
   * Additional granted roots from the mode's own vocabulary (the sandbox
   * seam's `writableRoots`: the platform temp areas under `workspace-write`).
   */
  readonly grantedRoots?: readonly string[] | undefined
  /** Filesystem canonicalizer resolving reparse points; defaults to the sandbox seam's realpath contract. */
  readonly canonicalize?: ((path: string) => string) | undefined
}

/**
 * The guard's verdict: the normalized launch directory plus the environment
 * overlay that keeps inherited defaults inside the boundary, or the reason the
 * launch is refused.
 */
export type GitBashLaunchGuard =
  | {
    readonly ok: true
    /** The launch directory in its Windows spelling (an MSYS-spelled cwd is placed here). */
    readonly workdir: string
    /** Environment entries to layer onto the launch, `undefined` marking a tombstone. */
    readonly env: Readonly<Record<string, string | undefined>>
  }
  | { readonly ok: false; readonly detail: string }

/**
 * Bound one confined Git Bash launch: the working directory must resolve inside
 * the mode's granted roots (after MSYS/Windows unification and reparse-point
 * resolution), and HOME is pinned to the workspace so a tool resolving `~`
 * writes inside the boundary instead of the user profile.
 *
 * Admission is a launch-parameter check, not a write promise: the roots are the
 * policy's own `writableRoots` vocabulary (the workspace plus the platform temp
 * areas), while the enforcing backend may grant a narrower set — the Windows
 * ACL runner grants the workspace and one per-session private temp directory.
 *
 * Temp variables are deliberately NOT pinned here: under `workspace-write` the
 * ACL runner already repoints TMP/TEMP at its granted private temp directory,
 * and pinning them to the workspace would move temp writes out of that granted
 * area into the workspace tree.
 * @param request - the mode, boundary, launch directory, mounts, and canonicalizer.
 * @returns the normalized launch parameters, or the refusal detail.
 */
export function guardGitBashLaunch(request: GitBashLaunchGuardRequest): GitBashLaunchGuard {
  if (request.platform !== 'win32') {
    return { ok: true, workdir: request.workdir, env: {} }
  }
  const mounts: GitBashMounts = {
    ...request.installationRoot === undefined ? {} : { installationRoot: request.installationRoot },
    ...request.tempRoot === undefined ? {} : { tempRoot: request.tempRoot },
  }
  const canonicalize = request.canonicalize ?? canonicalPath
  const workspace = placeInsideBoundary(request.workspaceRoot, mounts, canonicalize)
  if (workspace === undefined) {
    return { ok: false, detail: unplaceableDetail('workspace root', request.workspaceRoot) }
  }
  const roots = request.mode === 'workspace-write'
    ? [workspace, ...(request.grantedRoots ?? []).map(root => placeInsideBoundary(root, mounts, canonicalize)).filter(isPlaced)]
    : [workspace]
  const workdir = placeInsideBoundary(request.workdir, mounts, canonicalize)
  if (workdir === undefined) {
    return { ok: false, detail: unplaceableDetail('workdir', request.workdir) }
  }
  const key = windowsPathKey(workdir)
  if (!roots.some(root => isWithinWindowsPathKey(windowsPathKey(root), key))) {
    return {
      ok: false,
      detail: `Git Bash ${request.mode} launch refused: workdir ${JSON.stringify(request.workdir)} resolves outside `
        + `the granted roots (${roots.map(root => JSON.stringify(root)).join(', ')}); this command was not started.`,
    }
  }
  return {
    ok: true,
    workdir,
    env: {
      HOME: windowsPathToMsys(workspace),
      ...Object.fromEntries(GIT_BASH_TOMBSTONES.map(name => [name, undefined])),
    },
  }
}

/** Whether one optional placement resolved. */
function isPlaced(path: string | undefined): path is string {
  return path !== undefined
}

/** Place one path and canonicalize it, or undefined when the broker cannot place it. */
function placeInsideBoundary(
  path: string,
  mounts: GitBashMounts,
  canonicalize: (path: string) => string,
): string | undefined {
  const placed = brokerAbsolutePath(path, mounts)
  return placed === undefined ? undefined : canonicalize(placed)
}

/** The refusal detail for a path the broker cannot place inside any boundary. */
function unplaceableDetail(label: string, path: string): string {
  const foreign = FOREIGN_DRIVE_MOUNT.test(path.trim())
    ? ' — a Windows Subsystem for Linux `/mnt/<drive>` or Cygwin `/cygdrive/<drive>` spelling, which Git Bash does not '
      + 'mount (Git for Windows mounts a drive as `/c`, `/d`, and so on)'
    : ''
  return `Git Bash confined launch refused: ${label} ${JSON.stringify(path)} is not an absolute Windows or MSYS `
    + `path the broker can place${foreign} (relative, drive-relative, device-namespace, and unmounted MSYS paths name `
    + 'no workspace location); this command was not started.'
}
