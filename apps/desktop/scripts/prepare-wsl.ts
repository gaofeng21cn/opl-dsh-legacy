/**
 * Materialize the Linux payload a Windows package carries for its WSL2
 * execution environment.
 *
 * The payload is a complete Linux runtime, not a wrapper: a Linux Node.js
 * executable plus a dsh production tree whose native modules were installed by
 * a Linux package manager. Installing it on Windows and copying the result
 * would ship Windows `.node` binaries that the distribution cannot load, so the
 * production install runs inside a WSL2 distribution and only its output is
 * copied back into the release.
 *
 * The install happens inside the distribution's own filesystem rather than on
 * the shared Windows drive: a full dependency closure installed over the
 * Linux/Windows boundary is dramatically slower, and nothing about the result
 * depends on where it was built. Only the finished tree is copied out.
 *
 * A Windows package therefore requires WSL2 at packaging time. When no usable
 * distribution is present the preparation fails loudly instead of producing a
 * package that offers a WSL2 environment it cannot serve.
 *
 * @module desktop/prepare-wsl
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { extract } from 'tar'
import { join, posix } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  desktopCoreBuildKey,
  desktopCorePackageOverrides,
  readDesktopCorePackageSet,
} from '../src/core-package-set.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { fetchVerifiedNodeArchive, NODE_VERSION } from './node-archive.ts'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const WSL_ROOT = BUILD_PATHS.wsl
const DOWNLOAD_ROOT = BUILD_PATHS.downloads
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet

/** Linux architecture a Windows x64 package carries. */
const LINUX_ARCH = 'x64'

/** File recording which runtime the Linux payload carries. */
export const WSL_RUNTIME_FILE = 'wsl-runtime.json'

/** Build-time environment variable selecting the distribution to build in. */
const WSL_BUILD_DISTRO_ENV = 'DSH_DESKTOP_WSL_BUILD_DISTRO'

/**
 * Directories every supported distribution keeps its system programs in.
 *
 * The distribution's own `PATH` is not available: `wsl.exe --exec` starts the
 * command without a login shell, so the environment is whatever interop builds
 * rather than the one a user's shell would have.
 */
const DISTRO_SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/**
 * Run one command inside the build distribution.
 *
 * `execFileSync` reports only the exit status, while the useful diagnosis is on
 * the child's stderr, so that stream is captured and appended to the failure.
 * @param distro - distribution to run in.
 * @param argv - command and arguments to execute.
 * @param options - optional working directory inside the distribution.
 * @returns the command's trimmed stdout.
 * @throws when the command exits nonzero, carrying its stderr.
 */
function wsl(distro: string, argv: readonly string[], options: { cwd?: string } = {}): string {
  try {
    return execFileSync('wsl.exe', [
      '--distribution', distro,
      ...(options.cwd === undefined ? [] : ['--cd', options.cwd]),
      '--exec', ...argv,
    ], { encoding: 'utf8', windowsHide: true, timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? `: ${stderr.trim()}` : ''
    throw new Error(`desktop wsl: ${argv.join(' ')} failed in ${distro}${detail}`, { cause: error })
  }
}

/**
 * Run one pnpm command inside the distribution with the Linux Node on `PATH`.
 *
 * pnpm runs each dependency's lifecycle scripts through `sh`, and those scripts
 * invoke `node` by name. The directory holding the interpreter is the only place
 * that Node is guaranteed to exist, so it is placed on `PATH` explicitly;
 * without it a native dependency fails with `sh: 1: node: not found`.
 * @param distro - distribution the command runs in.
 * @param linuxNode - absolute Linux path of the Node.js executable to run.
 * @param argv - pnpm entry point and its arguments, after the executable.
 * @param cwd - absolute Linux working directory for the command.
 */
function pnpmInDistro(distro: string, linuxNode: string, argv: readonly string[], cwd: string): void {
  wsl(distro, [
    '/usr/bin/env',
    `PATH=${posix.dirname(linuxNode)}:${DISTRO_SYSTEM_PATH}`,
    linuxNode,
    ...argv,
  ], { cwd })
}

/**
 * Convert one Windows drive path to the path the distribution reaches it by.
 * @param windowsPath - absolute drive path, such as `C:\build\wsl`.
 * @returns the `/mnt/<drive>/…` path.
 * @throws when the path is not a drive path, and so has no mount inside WSL.
 */
function linuxPath(windowsPath: string): string {
  const normalized = windowsPath.replaceAll('\\', '/')
  if (!/^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`desktop wsl: ${JSON.stringify(windowsPath)} is not a Windows drive path WSL can mount`)
  }
  return `/mnt/${normalized.slice(0, 1).toLowerCase()}${normalized.slice(2)}`
}

/** Names of the installed distributions, or an empty list when WSL is absent. */
function installedDistros(): string[] {
  try {
    return execFileSync('wsl.exe', ['--list', '--quiet'], { encoding: 'utf8', windowsHide: true })
      .replaceAll('\u0000', '')
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line !== '')
  } catch {
    // WSL is absent or its service is unavailable; the caller reports it.
    return []
  }
}

/**
 * Choose the distribution the Linux payload is built in.
 *
 * An explicit `DSH_DESKTOP_WSL_BUILD_DISTRO` names it; otherwise the first
 * installed distribution that runs a Linux Node is used.
 * @returns the distribution name and its absolute Linux Node.js path.
 * @throws when no distribution can build the payload.
 */
function resolveBuildDistro(): { distro: string; node: string } {
  const requested = process.env[WSL_BUILD_DISTRO_ENV]?.trim()
  const candidates = requested === undefined || requested === '' ? installedDistros() : [requested]
  if (candidates.length === 0) {
    throw new Error(
      'desktop wsl: no WSL2 distribution is available to build the Linux payload; '
      + `install one, or set ${WSL_BUILD_DISTRO_ENV}`,
    )
  }
  for (const distro of candidates) {
    try {
      const node = wsl(distro, ['sh', '-lc', 'command -v node'])
      if (node.startsWith('/')) return { distro, node }
    } catch {
      continue
    }
  }
  throw new Error(
    `desktop wsl: none of ${candidates.join(', ')} provides a Linux Node.js to run the production install`,
  )
}

/** Download and place the Linux Node.js executable the payload carries. */
async function prepareLinuxNode(): Promise<void> {
  const { archive, folder } = await fetchVerifiedNodeArchive({
    platform: 'linux',
    arch: LINUX_ARCH,
    downloads: DOWNLOAD_ROOT,
  })
  const extraction = join(BUILD_PATHS.root, 'wsl-node-extract')
  rmSync(extraction, { recursive: true, force: true })
  mkdirSync(extraction, { recursive: true })
  await extract({ cwd: extraction, file: archive })
  const destinationRoot = join(WSL_ROOT, 'runtime', 'node')
  rmSync(destinationRoot, { recursive: true, force: true })
  mkdirSync(destinationRoot, { recursive: true })
  const destination = join(destinationRoot, 'node')
  cpSync(join(extraction, folder, 'bin', 'node'), destination)
  await chmod(destination, 0o755)
  rmSync(extraction, { recursive: true, force: true })
}

/**
 * Run the production install inside the distribution and copy the tree out.
 *
 * The lockfile is generated in the same distribution: a lockfile written on
 * Windows records only Windows optional dependencies, so installing from it on
 * Linux would silently omit the Linux builds of every native package.
 * @param distro - distribution that runs the install.
 * @param linuxNode - absolute Linux path of the Node.js executable to install with.
 * @param pnpmEntry - absolute Linux path of the bundled pnpm entry.
 * @param releaseVersion - exact release version the package set was built for.
 */
function prepareLinuxDshTree(distro: string, linuxNode: string, pnpmEntry: string, releaseVersion: string): void {
  // A distribution-native build directory: the dependency closure is written
  // and read many times, and the shared drive would make that the slowest step.
  const buildRoot = wsl(distro, ['sh', '-lc', 'mktemp -d -t dsh-wsl-build-XXXXXX'])
  const store = `${buildRoot}/store`
  try {
    // The package set and its manifests are read-only inputs produced by the
    // Windows-side preparation, so copying them in keeps one source of truth.
    // The tarball directory keeps its own name: every `file:` override is
    // relative to it, so renaming it here would break dependency resolution.
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_PATHS.root, 'wsl-package-set.json'))
    wsl(distro, ['cp', linuxPath(join(BUILD_PATHS.root, 'wsl-package-set.json')), `${buildRoot}/${DESKTOP_PACKAGE_SET_FILE}`])
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_PATHS.root, 'wsl-packages'), { recursive: true })
    wsl(distro, ['cp', '-r', linuxPath(join(BUILD_PATHS.root, 'wsl-packages')), `${buildRoot}/${DESKTOP_PACKAGES_DIR}`])
    rmSync(join(BUILD_PATHS.root, 'wsl-packages'), { recursive: true, force: true })
    rmSync(join(BUILD_PATHS.root, 'wsl-package-set.json'), { force: true })

    const packageSet = readDesktopCorePackageSet(PACKAGE_SET_ROOT, releaseVersion)
    const overrides = desktopCorePackageOverrides(packageSet)
    const overrideLines = Object.entries(overrides)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`)
      .join('\n')
    writeFileSync(join(BUILD_PATHS.root, 'wsl-workspace.yaml'), [
      'packages:', '  - .', '',
      'overrides:', overrideLines, '',
      'nodeLinker: hoisted', 'autoInstallPeers: false', 'strictDepBuilds: true', '',
      'allowBuilds:', '  node-pty: true', '  koffi: true', '  fs-ext: true',
      `  ${JSON.stringify(desktopCoreBuildKey(overrides))}: true`,
      '  \'@google/genai\': false', '  protobufjs: false', '  node-addon-require-builtin: false', '',
    ].join('\n'))
    writeFileSync(join(BUILD_PATHS.root, 'wsl-project.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime',
      private: true,
      version: releaseVersion,
      type: 'module',
      dependencies: overrides,
    }, undefined, 2)}\n`)
    wsl(distro, ['cp', linuxPath(join(BUILD_PATHS.root, 'wsl-workspace.yaml')), `${buildRoot}/pnpm-workspace.yaml`])
    wsl(distro, ['cp', linuxPath(join(BUILD_PATHS.root, 'wsl-project.json')), `${buildRoot}/package.json`])
    rmSync(join(BUILD_PATHS.root, 'wsl-workspace.yaml'), { force: true })
    rmSync(join(BUILD_PATHS.root, 'wsl-project.json'), { force: true })

    const pnpmArgs = [
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${store}`,
      '--config.enable-global-virtual-store=false',
    ]
    // The lockfile is generated here, on Linux, for the same reason the install
    // is: it must record the Linux optional dependencies.
    pnpmInDistro(distro, linuxNode, [pnpmEntry, ...pnpmArgs, 'install', '--lockfile-only'], buildRoot)
    pnpmInDistro(distro, linuxNode, [
      pnpmEntry, ...pnpmArgs, 'install', '--prod', '--frozen-lockfile', '--trust-lockfile',
    ], buildRoot)

    // Only the finished tree crosses back, through the shared drive.
    const staged = join(BUILD_PATHS.root, 'wsl-dsh-staged')
    rmSync(staged, { recursive: true, force: true })
    mkdirSync(staged, { recursive: true })
    wsl(distro, ['cp', '-r', `${buildRoot}/node_modules`, linuxPath(staged)])
    // The runtime file policy drops native binaries belonging to another
    // platform, so it must judge the payload's runtime rather than this build
    // host's: this tree is installed for Linux even when packaging runs on
    // Windows, and naming the host here would strip the Linux addons.
    const target = { platform: 'linux' as NodeJS.Platform, arch: LINUX_ARCH as 'x64' }
    const modules = join(staged, 'node_modules')
    const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
    const officeEngine = selectOfficeEngine(officeManifest, target)
    const destination = join(WSL_ROOT, 'dsh')
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(join(destination, 'node_modules'), { recursive: true })
    cpSync(modules, join(destination, 'node_modules'), {
      recursive: true, dereference: true,
      filter: source => desktopRuntimeFileExclusion(
        source.slice(modules.length + 1).replaceAll('\\', '/'), target, officeEngine,
      ) === undefined,
    })
    rmSync(staged, { recursive: true, force: true })
    writeFileSync(join(destination, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime',
      private: true,
      version: releaseVersion,
      type: 'module',
      dependencies: overrides,
    }, undefined, 2)}\n`)
  } finally {
    try {
      wsl(distro, ['rm', '-rf', buildRoot])
    } catch {
      // A leftover build directory in the distribution is not a release failure.
    }
  }
}

/**
 * Require the files that make the payload loadable inside a distribution.
 * @param releaseVersion - exact release version the payload was built for.
 * @throws when the Linux Node executable or the private Host entry is absent.
 */
function verifyPreparedPayload(releaseVersion: string): void {
  const node = join(WSL_ROOT, 'runtime', 'node', 'node')
  if (!existsSync(node)) {
    throw new Error(`desktop wsl: the prepared payload has no Linux Node.js executable at ${node}`)
  }
  for (const file of DESKTOP_HOST_RUNTIME_FILES) {
    const path = join(WSL_ROOT, 'dsh', 'node_modules', DESKTOP_HOST_PACKAGE, file)
    if (!existsSync(path)) throw new Error(`desktop wsl: the prepared payload is missing ${path}`)
  }
  writeFileSync(join(WSL_ROOT, WSL_RUNTIME_FILE), `${JSON.stringify({
    schemaVersion: 1,
    node: NODE_VERSION,
    platform: 'linux',
    arch: LINUX_ARCH,
    releaseVersion,
    hostPackage: DESKTOP_HOST_PACKAGE,
  }, undefined, 2)}\n`)
}

/** Read the release version the Windows-side preparation recorded. */
function releaseVersion(): string {
  const manifest = JSON.parse(readFileSync(join(BUILD_PATHS.dsh, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') {
    throw new Error('desktop wsl: the packaged dsh tree records no version; run the dsh preparation first')
  }
  return manifest.version
}

/**
 * Build the Linux payload for the current Windows target.
 * @returns the payload root that was written.
 * @throws when no distribution can build it, or the result is incomplete.
 */
export async function prepareWslPayload(): Promise<string> {
  const { distro, node } = resolveBuildDistro()
  const pnpmEntry = join(BUILD_PATHS.runtime, 'pnpm', 'bin', 'pnpm.mjs')
  if (!existsSync(pnpmEntry)) {
    throw new Error(`desktop wsl: the bundled pnpm entry is missing at ${pnpmEntry}; run the runtime preparation first`)
  }
  rmSync(WSL_ROOT, { recursive: true, force: true })
  mkdirSync(WSL_ROOT, { recursive: true })
  await prepareLinuxNode()
  prepareLinuxDshTree(distro, node, linuxPath(pnpmEntry), releaseVersion())
  verifyPreparedPayload(releaseVersion())
  return WSL_ROOT
}

await prepareWslPayload()
