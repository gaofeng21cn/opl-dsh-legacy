/**
 * WSL2 discovery, selection, and lifecycle.
 *
 * `wsl.exe` is used only for three jobs: listing installed distributions,
 * probing that one can run a Linux Node, and starting the long-lived DSH Host
 * inside it. A tool call is never wrapped in its own `wsl.exe` invocation —
 * that would pay process-start cost per call, lose the Linux process tree, and
 * place the sandbox outside the Host that owns it.
 *
 * Discovery reads the Windows registry first because `wsl.exe -l` is a
 * console program whose output is localized and whose exit status is
 * unavailable on hosts where the WSL service is present but not yet started.
 * The registry listing is authoritative for *installed* distributions, and
 * `wsl.exe` remains authoritative for *running* one.
 *
 * @module dsh-desktop/wsl
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { assertDistroName, translatePath } from './execution-environment.ts'

/** One installed WSL2 distribution. */
export interface WslDistribution {
  readonly name: string
  /** WSL version reported by the distribution's registry entry. */
  readonly version: number
  /** Whether this is the default distribution when none is named. */
  readonly isDefault: boolean
}

/** A probe result for one distribution. */
export interface WslProbeResult {
  readonly name: string
  /** Linux Node.js version reported inside the distribution, when present. */
  readonly nodeVersion?: string
  /** Why the distribution cannot host the DSH Host, when it cannot. */
  readonly problem?: WslProblem
}

/** A reason one distribution cannot host the DSH Host. */
export type WslProblem =
  | 'not-wsl2'
  | 'unreachable'
  | 'node-missing'
  | 'node-too-old'
  | 'host-missing'

/** Minimum Linux Node.js major version the bundled runtime supports. */
export const WSL_MINIMUM_NODE_MAJOR = 22

/** Injectable process and registry operations, so discovery is testable off Windows. */
export interface WslInternals {
  /** Run one command and resolve with its stdout, or undefined on failure. */
  readonly run?: (command: string, args: readonly string[]) => Promise<string | undefined>
  /** Read installed distributions from the platform's own registry. */
  readonly listInstalled?: () => Promise<readonly WslDistribution[]>
  /** Host platform; discovery is a no-op off Windows. */
  readonly platform?: NodeJS.Platform
  /** Probe deadline for one distribution, in milliseconds. */
  readonly timeoutMs?: number
}

/** Default deadline for one `wsl.exe` probe. */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000

/** Run one command, resolving with trimmed stdout or undefined on any failure. */
function runCommand(command: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) { resolve(undefined); return }
      resolve(stdout.trim() === '' ? undefined : stdout.trim())
    })
  })
}

/**
 * Read every installed WSL2 distribution from the Windows registry.
 *
 * The registry is the durable record of what is installed, and it is readable
 * without starting the WSL service. Distribution names are read as Unicode, so
 * a name containing non-ASCII characters is preserved exactly.
 *
 * The default distribution is named by the key's `DefaultDistribution` value,
 * which holds the GUID of the matching subkey. The per-distribution `Flags`
 * value is not that marker: it reads 15 for every distribution that has one,
 * so testing its low bit reports every distribution as the default.
 * @returns installed distributions, in registry order.
 */
async function listInstalledFromRegistry(): Promise<readonly WslDistribution[]> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$root = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss"',
    'if (-not (Test-Path $root)) { "[]"; exit 0 }',
    '$default = (Get-ItemProperty $root -Name DefaultDistribution -ErrorAction SilentlyContinue).DefaultDistribution',
    '$items = Get-ChildItem $root | ForEach-Object {',
    '  $p = Get-ItemProperty $_.PSPath',
    '  if ($p.DistributionName) {',
    '    [pscustomobject]@{ name = $p.DistributionName; version = [int]$p.Version; isDefault = ($_.PSChildName -eq $default) }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($items) -Compress',
  ].join('; ')
  // The registry read runs through PowerShell rather than `wsl.exe`: it works
  // with the WSL service stopped and its output is structured rather than
  // localized console text.
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: DEFAULT_PROBE_TIMEOUT_MS,
    }, (error, output) => { resolve(error === null ? output : undefined) })
  })
  if (stdout === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // An unreadable or empty registry view is reported as "none installed",
    // which the settings surface presents as an unavailable environment.
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry): WslDistribution[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name === '') return []
    return [{
      name: record.name,
      version: typeof record.version === 'number' ? record.version : 0,
      isDefault: record.isDefault === 1 || record.isDefault === true,
    }]
  })
}

/**
 * List installed WSL2 distributions.
 *
 * Off Windows, or when the registry cannot be read, the result is empty: an
 * absent WSL is a state the settings surface reports, not an error.
 * @param internals - injectable registry reader and platform.
 * @returns installed distributions.
 */
export async function listWslDistributions(internals: WslInternals = {}): Promise<readonly WslDistribution[]> {
  if ((internals.platform ?? process.platform) !== 'win32') return []
  return (internals.listInstalled ?? listInstalledFromRegistry)()
}

/**
 * Probe whether one distribution can host the DSH Host.
 *
 * The probe runs `wsl.exe -d <distro> -- sh -lc 'node --version'`, which is a
 * one-shot discovery call rather than a per-tool wrapper: it answers whether a
 * usable Linux Node exists before any Host is started.
 * @param name - installed distribution name.
 * @param internals - injectable command runner, platform, and deadline.
 * @returns the probe result, including the concrete problem when unusable.
 */
export async function probeWslDistribution(name: string, internals: WslInternals = {}): Promise<WslProbeResult> {
  if ((internals.platform ?? process.platform) !== 'win32') return { name, problem: 'unreachable' }
  const run = internals.run ?? ((command, args) => runCommand(command, args, internals.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS))
  const output = await run('wsl.exe', [
    '--distribution', name, '--exec', 'sh', '-lc', 'node --version',
  ])
  if (output === undefined) return { name, problem: 'unreachable' }
  const match = /v(\d+)\./u.exec(output)
  if (match === null) return { name, problem: 'node-missing' }
  const major = Number(match[1])
  if (!Number.isSafeInteger(major) || major < WSL_MINIMUM_NODE_MAJOR) {
    return { name, nodeVersion: output, problem: 'node-too-old' }
  }
  return { name, nodeVersion: output }
}

/**
 * Resolve which distribution a launch must use.
 *
 * The persisted selection wins when it is still installed; otherwise the
 * registry default is used. A selection naming a distribution that is no
 * longer installed is reported rather than silently replaced, because the
 * environment the user chose is a different filesystem and runtime.
 * @param distributions - currently installed distributions.
 * @param selected - persisted selection, when there is one.
 * @returns the distribution to use.
 * @throws when nothing is installed, or the selected distribution is gone.
 */
export function selectWslDistribution(
  distributions: readonly WslDistribution[],
  selected: string | undefined,
): WslDistribution {
  if (distributions.length === 0) throw new Error('desktop: no WSL2 distribution is installed')
  if (selected !== undefined && selected !== '') {
    const match = distributions.find(entry => entry.name === selected)
    if (match === undefined) {
      throw new Error(`desktop: the selected WSL2 distribution ${JSON.stringify(selected)} is not installed`)
    }
    if (match.version !== 2) throw new Error(`desktop: WSL distribution ${JSON.stringify(match.name)} is not WSL2`)
    return match
  }
  const fallback = distributions.find(entry => entry.isDefault) ?? distributions[0]
  /* v8 ignore next -- an empty list returned above, so the first entry exists. */
  if (fallback === undefined) throw new Error('desktop: no WSL2 distribution is installed')
  if (fallback.version !== 2) {
    const wsl2 = distributions.find(entry => entry.version === 2)
    if (wsl2 === undefined) throw new Error('desktop: no installed WSL distribution reports version 2')
    return wsl2
  }
  return fallback
}

/**
 * The `wsl.exe` argv that starts one long-lived Host inside a distribution.
 *
 * The Host starts once per launch and serves every tool call over its own
 * connection, so the distribution entrypoint is the Linux Node executable
 * running the installed Host entry — never a per-call command. Given paths are
 * Linux paths checked with Linux rules, because they run inside the
 * distribution rather than on this host.
 * @param node - absolute Linux path of the Node.js executable.
 * @param hostEntry - absolute Linux path of the Host entry inside the distribution.
 * @param hostArgs - arguments the Host entry expects.
 * @param distro - target distribution name.
 * @returns the complete argv for `wsl.exe`, beginning with the executable.
 * @throws when an entry or the distribution name is unusable.
 */
export function wslHostInvocation(
  node: string,
  hostEntry: string,
  hostArgs: readonly string[],
  distro: string,
): readonly string[] {
  for (const [label, value] of [['Node.js executable', node], ['Host entry', hostEntry]] as const) {
    if (value === '' || value.startsWith('-') || !posix.isAbsolute(value)) {
      throw new Error(`desktop: ${JSON.stringify(value)} is not a usable Linux ${label} path`)
    }
  }
  return ['wsl.exe', '--distribution', assertDistroName(distro), '--exec', node, hostEntry, ...hostArgs]
}

/**
 * Build the environment the Windows-side launcher hands to `wsl.exe`.
 *
 * The Linux Host owns its Harness home inside the distribution, so the launcher
 * forwards no Windows path and no Windows credential into it. `WSLENV` is set
 * explicitly rather than inherited: an ambient Windows value would forward
 * whatever it names — including this process's `DSH_HOME` — into the Host, and
 * the Host would then read a Windows home it cannot use.
 *
 * `DSH_DESKTOP_WSL_HOME` is the one supported override, and it is a Linux path
 * by definition because only the distribution can resolve it.
 * @param base - launcher environment to extend.
 * @param wslHome - optional absolute Linux Harness home for the Host.
 * @returns the environment for the `wsl.exe` launcher child.
 * @throws when a configured home is not an absolute Linux path.
 */
export function wslLauncherEnvironment(
  base: NodeJS.ProcessEnv,
  wslHome?: string,
): NodeJS.ProcessEnv {
  const home = wslHome?.trim()
  if (home === undefined || home === '') return { ...base, WSLENV: '' }
  if (!posix.isAbsolute(home)) {
    throw new Error(`desktop: ${WSL_HOME_ENV} must be an absolute Linux path, got ${JSON.stringify(home)}`)
  }
  return { ...base, WSLENV: WSL_HOME_ENV, [WSL_HOME_ENV]: home }
}

/** Environment variable naming an explicit Linux Harness home for the WSL Host. */
export const WSL_HOME_ENV = 'DSH_DESKTOP_WSL_HOME'

/** Directory this product owns inside a distribution when nothing overrides it. */
export const WSL_DEFAULT_HOME_DIR = '.dsh-opl'

/** Payload-relative path of the Linux Node.js executable. */
export const WSL_PAYLOAD_NODE = ['runtime', 'node', 'node'] as const

/** Payload-relative path of the private Desktop Host entry. */
export const WSL_PAYLOAD_HOST_ENTRY = [
  'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js',
] as const

/** Payload-relative path of the installed dsh package tree. */
export const WSL_PAYLOAD_DSH_ROOT = ['dsh'] as const

/** One fully resolved WSL Host launch. */
export interface WslLaunchPlan {
  /** Absolute Linux path of the Node.js executable that starts the Host. */
  readonly node: string
  /** Absolute Linux path of the Host entry the Node executable runs. */
  readonly hostEntry: string
  /** Absolute Linux path of the dsh package tree the Host resolves against. */
  readonly runtimeDir: string
  /** Absolute Linux path of the jointly visible binding file the Host publishes. */
  readonly bindingFile: string
  /** Complete `wsl.exe` argv, beginning with the executable. */
  readonly invocation: readonly string[]
}

/**
 * Resolve one WSL Host launch from the Windows-side facts.
 *
 * Every path the Linux process reads or writes is converted here, because the
 * two sides name the same files differently: the packaged payload, the Desktop
 * profile, and the binding file all live on a Windows drive, which the
 * distribution reaches only through `/mnt/<drive>`. The binding file is
 * deliberately placed on that shared drive rather than inside the distribution,
 * so both the Linux writer and the Windows reader can see it.
 *
 * The Harness home and the profile are NOT part of the plan: the Host derives
 * them inside the distribution, where they are fast and where a Windows-staged
 * profile (whose native modules are Windows binaries) could never be loaded.
 *
 * @param input - target distribution, packaged payload root, and binding path.
 * @returns the Linux paths and the argv that starts the Host.
 * @throws when a supplied path cannot be expressed inside the distribution.
 */
export function resolveWslLaunchPlan(input: {
  readonly environment: { readonly kind: 'wsl2'; readonly distro: string }
  /** Payload root as this host names it; translated when it is a Windows path. */
  readonly payloadRoot: string
  /** Binding file as this host names it; translated when it is a Windows path. */
  readonly bindingFile: string
}): WslLaunchPlan {
  const { environment } = input
  const root = translatePath(input.payloadRoot, environment)
  const bindingFile = translatePath(input.bindingFile, environment)
  const requireLinux = (value: string, label: string): string => {
    if (!posix.isAbsolute(value)) {
      throw new Error(
        `dsh desktop: ${label} ${JSON.stringify(value)} has no path inside WSL distribution `
        + `${JSON.stringify(environment.distro)}; it must be on a mounted Windows drive`,
      )
    }
    return value
  }
  const node = requireLinux(posix.join(root, ...WSL_PAYLOAD_NODE), 'the packaged Linux Node.js executable')
  const hostEntry = requireLinux(posix.join(root, ...WSL_PAYLOAD_HOST_ENTRY), 'the packaged Linux Host entry')
  const runtimeDir = requireLinux(posix.join(root, ...WSL_PAYLOAD_DSH_ROOT), 'the packaged Linux dsh tree')
  return {
    node,
    hostEntry,
    runtimeDir,
    bindingFile: requireLinux(bindingFile, 'the transport binding file'),
    invocation: wslHostInvocation(node, hostEntry, [runtimeDir, WSL_HOST_ARGUMENT, bindingFile], environment.distro),
  }
}

/** Argument selecting the loopback transport entry in the packaged Host. */
export const WSL_HOST_ARGUMENT = '--serve-wsl'

/** Subdirectory of the packaged resources that carries the Linux payload. */
export const WSL_PAYLOAD_DIR = 'wsl'

/**
 * Return the packaged Linux payload root as this host names it.
 * @param resourcesPath - Electron's `process.resourcesPath`.
 * @returns the payload root, in the host's own path syntax.
 */
export function wslPayloadRoot(resourcesPath: string): string {
  return join(resourcesPath, WSL_PAYLOAD_DIR)
}

/**
 * Require the packaged Linux payload one WSL2 launch depends on.
 *
 * The distribution runs the Linux Node executable out of this tree, so a build
 * that ships the WSL2 choice without the tree would fail only after the user
 * restarted into it. Checking here turns that into an immediate, named failure
 * and keeps the settings surface from advertising an environment the package
 * cannot provide.
 * @param payloadRoot - payload root in the host's path syntax.
 * @returns the checked payload root.
 * @throws when the Linux Node executable or Host entry is absent.
 */
export function assertWslPayloadPresent(payloadRoot: string): string {
  const required = [
    join(payloadRoot, ...WSL_PAYLOAD_NODE),
    join(payloadRoot, ...WSL_PAYLOAD_HOST_ENTRY),
  ]
  for (const path of required) {
    if (!existsSync(path)) {
      throw new Error(
        'dsh desktop: this application does not carry the Linux runtime WSL2 needs '
        + `(missing ${JSON.stringify(path)}); reinstall it, or select Windows Native`,
      )
    }
  }
  return payloadRoot
}
