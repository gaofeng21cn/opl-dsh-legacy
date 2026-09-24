/**
 * Which shell the agent's command tool runs through on a Windows Native host,
 * and the Git for Windows executable resolution that selection needs.
 *
 * Both shell executors declare the same selection fields in their profile
 * configuration. A host mounts exactly one executor, and saved configuration
 * remains readable under either selection and on every platform. A POSIX
 * host has one agent shell, so `agentShell` is inert there.
 *
 * A resolved Windows bash is always a Git for Windows installation: the Windows
 * Subsystem for Linux launcher is rejected by path, and Cygwin or a standalone
 * MSYS2 is rejected by installation layout, so a host that cannot offer Git Bash
 * fails loud instead of running a different POSIX environment.
 *
 * @module @deepseek-ai/dsh-shell/agent-shell
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SandboxUnavailableError, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/** Selectable Agent command shells on a Windows Native host. */
export const AGENT_SHELL_KINDS = ['powershell', 'git-bash'] as const

/** One selectable Agent command shell. */
export type AgentShellKind = typeof AGENT_SHELL_KINDS[number]

/**
 * The selection a host with no stored value uses: the shell every existing
 * Windows Native installation already runs.
 */
export const DEFAULT_AGENT_SHELL: AgentShellKind = 'powershell'

/** The shell dialect `ctx.shell` runs for the agent's commands. */
export type AgentShellDialect = 'pwsh' | 'bash'

/** The profile configuration fields both shell executors declare. */
export interface AgentShellSettings {
  /**
   * Shell the agent's command tool runs on a Windows Native host (default
   * `powershell`, the behavior every existing installation has). Inert on a
   * POSIX host, whose agent shell is always bash.
   */
  agentShell?: AgentShellKind
  /**
   * Explicit Git for Windows `bash.exe`. When omitted, the well-known Git for
   * Windows install locations and PATH entries are probed in order; the
   * Windows Subsystem for Linux launcher `System32\bash.exe` is never selected.
   */
  gitBashPath?: string
}

/**
 * Schemastery fields for {@link AgentShellSettings}, spread into each shell
 * executor's `Config` so one definition owns the shared section's two fields.
 */
export const AGENT_SHELL_SETTINGS_FIELDS = {
  agentShell: z.union(AGENT_SHELL_KINDS).default('powershell'),
  gitBashPath: z.string().required(false),
} as const

/** Maximum wait for one `bash --version` identity probe. */
const PROBE_TIMEOUT_MS = 10_000

/** Git for Windows' marker for its own installation root. */
const GIT_FOR_WINDOWS_MARKER = ['cmd', 'git.exe'] as const

/**
 * The Windows Subsystem for Linux launcher's `bash.exe`.
 *
 * `System32\bash.exe` starts a distribution rather than Git Bash: it would run
 * the agent's commands inside WSL, against another filesystem, so it is excluded
 * from every candidate list and rejected when it is configured by hand.
 * @param candidate - an absolute path.
 * @param env - the environment supplying `SystemRoot`; defaults to the process environment.
 * @returns true when the path names the WSL launcher.
 */
export function isWslBashLauncher(candidate: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const systemRoot = (env.SystemRoot ?? 'C:/Windows').replace(/[\\/]+$/u, '')
  return win32.resolve(candidate).toLowerCase() === win32.resolve(systemRoot, 'System32', 'bash.exe').toLowerCase()
}

/**
 * The Git for Windows installation root containing one executable.
 *
 * Git for Windows ships `cmd\git.exe` at its root; Cygwin and a standalone MSYS2
 * installation do not, which is what separates the three when only a `bash.exe`
 * path is known. The search ascends the executable's own path, so a renamed or
 * relocated installation is still identified by layout rather than by an
 * expected directory name.
 * @param executable - an absolute path to a candidate `bash.exe`.
 * @returns the installation root, or undefined when no ancestor carries the marker.
 */
export function gitForWindowsRoot(executable: string): string | undefined {
  let level = win32.dirname(win32.resolve(executable))
  while (true) {
    if (existsSync(win32.join(level, ...GIT_FOR_WINDOWS_MARKER))) return level
    const parent = win32.dirname(level)
    if (parent === level) return undefined
    level = parent
  }
}

/**
 * Well-known Git for Windows `bash.exe` locations plus PATH entries, in
 * resolution order. The WSL launcher is filtered out here so no caller can reach
 * it by probing, and a PATH entry that is not an absolute Windows path is
 * skipped because joining it could not name a real installation.
 * @param env - the environment to probe; defaults to the process environment.
 * @returns candidate Git Bash executable paths.
 */
export function candidateGitBashPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    win32.join(env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
    win32.join(env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ]
  const localAppData = env.LOCALAPPDATA
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))
  }
  // A user-added location lives on PATH; entries may carry surrounding quotes
  // from `setx`-style definitions.
  for (const entry of (env.PATH ?? env.Path ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0 || !win32.isAbsolute(trimmed)) continue
    candidates.push(win32.join(trimmed, 'bash.exe'))
  }
  return candidates.filter(candidate => !isWslBashLauncher(candidate, env))
}

/**
 * Whether a candidate can be spawned. lstat opens the entry itself instead of
 * following reparse points, matching the pwsh probe, so a real directory never
 * matches.
 * @param candidate - an absolute path.
 * @returns true when the path names a file or link.
 */
function candidateExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    // ENOENT (the candidate vanished between listing and probing) is the only
    // expected failure; any other error names an unspawnable path, so false is
    // the safe answer for it too.
    return false
  }
}

/**
 * Resolve the Git for Windows `bash.exe` this host would run.
 * @param configured - an explicit `gitBashPath` value, returned unchanged when non-empty.
 * @param env - the environment to probe; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @returns the configured or first existing Git Bash path, or undefined when
 *   this platform has no Git Bash to probe and none was configured.
 */
export function resolveGitBashPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform !== 'win32') return undefined
  for (const candidate of candidateGitBashPaths(env)) {
    if (candidateExists(candidate) && gitForWindowsRoot(candidate) !== undefined) return candidate
  }
  return undefined
}

/**
 * Prove one executable is a Git for Windows bash and report its version.
 *
 * Identity is checked in three independent steps, because no single one is
 * sufficient: an executable name resolves nothing (a bare `bash` would reach
 * whatever PATH holds, including the WSL launcher), a `GNU bash` banner alone
 * also matches Cygwin and MSYS2, and a directory name alone matches nothing at
 * all. The path must therefore be absolute, it must name a file, its own
 * `--version` must report GNU bash, and an ancestor must carry Git for Windows'
 * installation marker.
 * @param path - candidate executable to probe.
 * @param env - the environment supplying `SystemRoot` and the probe's own environment.
 * @returns the first `bash --version` line.
 * @throws when the path is not absolute, is the WSL launcher, is missing, cannot
 *   be executed, does not report GNU bash, or is not inside a Git for Windows
 *   installation.
 */
export function probeGitBash(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/iu.test(path)) {
    throw new Error(
      `shell: gitBashPath must be an absolute path to Git for Windows bash.exe, got ${JSON.stringify(path)}; `
      + 'a bare name resolves through PATH and could select the Windows Subsystem for Linux launcher',
    )
  }
  if (isWslBashLauncher(path, env)) {
    throw new Error(`${JSON.stringify(path)} is the Windows Subsystem for Linux launcher, not Git for Windows bash`)
  }
  if (!statIsFile(path)) {
    throw new Error(`${JSON.stringify(path)} is not a readable executable file`)
  }
  if (gitForWindowsRoot(path) === undefined) {
    throw new Error(
      `${JSON.stringify(path)} reports GNU bash but belongs to no Git for Windows installation `
      + `(no ancestor directory contains ${GIT_FOR_WINDOWS_MARKER.join('\\')}); Cygwin and a standalone MSYS2 `
      + 'installation are not Git for Windows, so point gitBashPath at Git for Windows or install it',
    )
  }
  const banner = versionBanner(path, env)
  const first = banner.split('\n', 1)[0]?.trim() ?? ''
  if (!/GNU bash/u.test(banner)) {
    throw new Error(`${JSON.stringify(path)} did not report GNU bash (first line: ${JSON.stringify(first)})`)
  }
  return first
}

/** Whether one path is a readable regular file. */
function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    // Absence, an unreadable parent, and a directory all mean "cannot run this".
    return false
  }
}

/** Run `bash --version`, turning every spawn failure into one actionable message. */
function versionBanner(path: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync(path, ['--version'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      env: Object.fromEntries(Object.entries(env).filter(([key]) =>
        !SENSITIVE_ENV_PATTERN.test(key) && !/^(?:DSH_|BASH_ENV$|ENV$|BASH_FUNC_)/iu.test(key))),
    })
  } catch (error) {
    // A missing, non-executable, or hanging executable all mean the same thing
    // to the caller: this path cannot run the agent's commands.
    throw new Error(`${JSON.stringify(path)} could not be run as Git for Windows bash: ${describeFailure(error)}`)
  }
}

/** One failure's message, without assuming the thrown value is an Error. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve and identify the Git Bash a `git-bash` selection will run.
 * @param settings - the shell selection fields from the active profile entry.
 * @param env - the environment to probe; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @returns the absolute Git Bash executable and its `--version` banner.
 * @throws when no Git Bash resolves, or the resolved one is not Git for Windows.
 */
export function resolveGitBash(
  settings: AgentShellSettings,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { readonly path: string; readonly version: string } {
  const path = resolveGitBashPath(settings.gitBashPath, env, platform)
  if (path === undefined) {
    throw new Error(
      'shell: agentShell "git-bash" needs Git for Windows, and no bash.exe was found in the well-known '
      + 'Git for Windows locations or on PATH; install Git for Windows or set gitBashPath',
    )
  }
  return { path, version: probeGitBash(path, env) }
}

/**
 * Reject a resolved section whose Agent shell selection this host cannot honor.
 *
 * A `git-bash` selection on Windows must resolve to a real Git for Windows
 * installation. The failure is reported where the selection is written, and
 * again where a command first resolves its executable, so the selection is never
 * silently replaced by PowerShell. On a POSIX host the field selects nothing and
 * is not judged.
 * @param settings - the shell selection fields from the active profile entry.
 * @param env - the environment to probe; defaults to the process environment.
 * @param platform - the platform to judge; defaults to the process platform.
 * @throws Error naming the selection and why it cannot run.
 */
export function assertAgentShellSettings(
  settings: AgentShellSettings,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || settings.agentShell !== 'git-bash') return
  resolveGitBash(settings, env, platform)
}

/**
 * Refuse Git Bash under the Windows restricted-token sandbox without probing:
 * the static refusal for consumers that own no capability probe. MSYS creates
 * per-user runtime objects — its shared-memory mapping and signal pipes — with
 * security descriptors that name the user SID alone, which the WRITE_RESTRICTED
 * token's write check never matches; adding the user SID to the restricting
 * list would also grant every ambient write the user holds.
 *
 * The agent Bash executor does NOT use this: it asks the Git Bash broker
 * (`./git-bash-broker.ts`), which runs the real backend against the real
 * executable and refuses only the dimensions that stay unproven. This function
 * remains the refusal for the persistent PTY terminal, whose shell has no such
 * probe.
 * @param mode - the already resolved per-call permission mode.
 * @param platform - execution platform, defaulting to the local process.
 */
export function assertGitBashConfinement(mode: SandboxMode, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32' || mode === 'danger-full-access') return
  throw new SandboxUnavailableError(mode,
    'Git Bash on Windows cannot initialize MSYS signal pipes under the restricted-token sandbox. '
    + 'Use PowerShell for read-only/workspace-write. Git Bash requires explicitly approved danger-full-access; '
    + 'this command was not started and permissions were not changed.')
}
