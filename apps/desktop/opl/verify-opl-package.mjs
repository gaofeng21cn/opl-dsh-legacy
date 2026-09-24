/** Release guard for the packed OPL DSH application, its disk image, and its Windows packages. */

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Portable default the app expands for the signed-in user. */
export const DEFAULT_DSH_HOME = '~/.dsh-opl'

/**
 * Home a Windows installation resolves at runtime.
 *
 * Windows has no `LSEnvironment`, so the packaged application derives its home
 * from Electron's user-data directory instead of reading it out of the bundle.
 * `src/dsh-home.ts` owns that resolution; this constant is the label the build
 * receipt records for it.
 */
export const WINDOWS_DSH_HOME = 'user-data'

/** Downstream packages whose absence empties the OPL Gateway settings page. */
const GATEWAY_PACKAGES = [
  '@one-person-lab/dsh-llm-opl-gateway',
  '@one-person-lab/dsh-client-ui-settings-opl-gateway',
]

/** Entry file each gateway package must carry inside the archive. */
const GATEWAY_ENTRIES = {
  '@one-person-lab/dsh-llm-opl-gateway': 'lib/index.js',
  '@one-person-lab/dsh-client-ui-settings-opl-gateway': 'lib/client.js',
}

/** Profile rows the bundled Web patch must contribute for that page to exist. */
const BUNDLE_PATCH_ROWS = ['ui-settings-opl-gateway', 'llm-opl-gateway']

/** Bytes before the asar header JSON. */
const ASAR_PREFIX_BYTES = 16

/**
 * Absolute prefixes that only exist on the machine that produced a macOS release.
 *
 * A bundle that carries one ships the packager's account name to every user.
 * `/Users/` is checked everywhere; `/Applications/` is additionally checked on
 * the Windows side, where such a path could never resolve.
 */
const MACOS_HOME_PATH_PREFIX = '/Users/'

/** Prefixes a Windows package must not carry either. */
const WINDOWS_FORBIDDEN_PATH_PREFIXES = ['/Users/', '/Applications/']

/** Bundled files that must never name the packager's own machine. */
const MACHINE_INDEPENDENT_ENTRIES = ['lib/main.js']

/** Executables electron-builder can emit for the Windows target. */
const WINDOWS_EXECUTABLE_PATTERN = /^opl-dsh-.+-win-x64(?:-(?<kind>setup|portable))?\.exe$/u

/** Smallest believable Windows executable; a truncated download is far below this. */
const MINIMUM_EXECUTABLE_BYTES = 1024

/** MS-DOS stub signature every PE image starts with. */
const DOS_MAGIC = 'MZ'

/** PE signature found at the offset the DOS header records. */
const PE_SIGNATURE = 'PE\u0000\u0000'

/** Offset of the `e_lfanew` field inside the DOS header. */
const PE_HEADER_OFFSET_POSITION = 0x3c

// --- Linux payload a Windows package carries for its WSL2 environment ---

/** Directory inside a Windows package's resources that carries the Linux payload. */
export const WSL_PAYLOAD_DIR = 'wsl'

/** Manifest the payload preparation writes beside the runtime it describes. */
const WSL_RUNTIME_FILE = 'wsl-runtime.json'

/** Payload-relative path of the Linux Node.js executable. */
const WSL_NODE_ENTRY = ['runtime', 'node', 'node']

/** Payload-relative path of the private Desktop Host entry. */
const WSL_HOST_ENTRY = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js']

/** Payload-relative path of the private Desktop Host manifest. */
const WSL_HOST_MANIFEST = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json']

/** Private Desktop Host package name the payload must carry. */
const WSL_HOST_PACKAGE = '@deepseek-ai/dsh-desktop-host'

/**
 * Payload-relative path of the PTY addon the terminal backend loads.
 *
 * `node-pty` resolves its addon from `prebuilds/<platform>-<arch>`, so the
 * Linux tree is only loadable while it keeps its own platform's prebuild.
 */
const WSL_PTY_ADDON = ['dsh', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node']

/** First four bytes of every ELF image. */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

/** `EI_CLASS` value for a 64-bit ELF image. */
const ELF_CLASS_64 = 2

/** `EI_DATA` value for a little-endian ELF image. */
const ELF_DATA_LSB = 1

/** `e_machine` value for x86-64. */
const EM_X86_64 = 62

/** Offset of the `e_machine` field inside an ELF header. */
const ELF_MACHINE_OFFSET = 18

/**
 * Verify the Linux payload a Windows package carries for WSL2.
 *
 * The payload is what the distribution actually executes, so its two loadable
 * artifacts are checked directly rather than inferred from the manifest: a
 * Linux ELF Node.js executable and the private Host entry. A package that
 * offered the WSL2 environment without them would fail only after the user
 * restarted into it.
 * @param {string} payloadRoot - `resources/wsl` directory of one packed application.
 * @returns {{ node: string, version: string }} Verified payload facts for the build receipt.
 */
export function verifyOplWslPayload(payloadRoot) {
  const manifestPath = join(payloadRoot, WSL_RUNTIME_FILE)
  if (!existsSync(manifestPath)) {
    throw new Error(
      `OPL package verification: the Windows package carries no WSL2 Linux payload `
      + `(missing ${manifestPath}); run the WSL preparation before packaging`,
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'linux' || typeof manifest.node !== 'string') {
    throw new Error(`OPL package verification: ${manifestPath} is not a supported payload manifest`)
  }

  const nodePath = join(payloadRoot, ...WSL_NODE_ENTRY)
  if (!existsSync(nodePath)) {
    throw new Error(`OPL package verification: the WSL2 payload has no Linux Node.js executable at ${nodePath}`)
  }
  const descriptor = openSync(nodePath, 'r')
  try {
    const header = Buffer.alloc(ELF_MACHINE_OFFSET + 2)
    readSync(descriptor, header, 0, header.length, 0)
    if (!header.subarray(0, 4).equals(ELF_MAGIC)) {
      throw new Error(`OPL package verification: ${nodePath} is not a Linux executable`)
    }
    if (header[4] !== ELF_CLASS_64 || header[5] !== ELF_DATA_LSB
      || header.readUInt16LE(ELF_MACHINE_OFFSET) !== EM_X86_64) {
      throw new Error(`OPL package verification: ${nodePath} is not a Linux x64 executable`)
    }
  } finally {
    closeSync(descriptor)
  }

  const hostManifestPath = join(payloadRoot, ...WSL_HOST_MANIFEST)
  if (!existsSync(hostManifestPath)) {
    throw new Error(`OPL package verification: the WSL2 payload has no ${WSL_HOST_PACKAGE} package`)
  }
  if (JSON.parse(readFileSync(hostManifestPath, 'utf8')).name !== WSL_HOST_PACKAGE) {
    throw new Error(`OPL package verification: the WSL2 payload mislabels ${WSL_HOST_PACKAGE}`)
  }
  const hostEntry = join(payloadRoot, ...WSL_HOST_ENTRY)
  if (!existsSync(hostEntry)) {
    throw new Error(`OPL package verification: the WSL2 payload has no Host entry at ${hostEntry}`)
  }
  // A payload whose native addons were filtered for the packaging host instead
  // of the distribution still starts, then fails on the first terminal it opens.
  const ptyAddon = join(payloadRoot, ...WSL_PTY_ADDON)
  if (!existsSync(ptyAddon)) {
    throw new Error(
      `OPL package verification: the WSL2 payload has no Linux PTY addon at ${ptyAddon}; `
      + 'its native modules must be copied for the distribution\'s platform, not the packaging host\'s',
    )
  }
  return { node: WSL_NODE_ENTRY.join('/'), version: manifest.node }
}

/**
 * Read one entry from an asar archive without extracting it.
 * @param {string} archivePath - Path to `app.asar`.
 * @param {string} entryPath - Slash-separated path inside the archive.
 * @returns {string} Entry contents as UTF-8 text.
 */
function readArchiveEntry(archivePath, entryPath) {
  const descriptor = openSync(archivePath, 'r')
  try {
    const prefix = Buffer.alloc(ASAR_PREFIX_BYTES)
    readSync(descriptor, prefix, 0, ASAR_PREFIX_BYTES, 0)
    const headerSize = prefix.readUInt32LE(4)
    const headerJsonBytes = prefix.readUInt32LE(12)
    const headerJson = Buffer.alloc(headerJsonBytes)
    readSync(descriptor, headerJson, 0, headerJsonBytes, ASAR_PREFIX_BYTES)
    let entries
    try {
      entries = JSON.parse(headerJson.toString('utf8')).files
    } catch {
      // A truncated or foreign file has no asar header; say so instead of
      // leaking a JSON parser error out of a packaging guard.
      throw new Error(`OPL package verification: ${archivePath} is not a readable application archive`)
    }
    let entry
    for (const part of entryPath.split('/')) {
      entry = entries?.[part]
      if (entry === undefined) throw new Error(`OPL package verification: app.asar has no ${entryPath}`)
      entries = entry.files
    }
    if (entry.unpacked === true) return readFileSync(`${archivePath}.unpacked/${entryPath}`, 'utf8')
    if (entry.size === undefined) throw new Error(`OPL package verification: app.asar entry is a directory: ${entryPath}`)
    const contents = Buffer.alloc(entry.size)
    readSync(descriptor, contents, 0, entry.size, 8 + headerSize + Number(entry.offset))
    return contents.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Verify the OPL Gateway plugin halves carried by one packed application archive.
 *
 * These are the checks that hold on every platform: the archive ships both
 * gateway packages with their entry files, the desktop runtime links them, the
 * bundled Web patch contributes both settings rows, and no bundled file names
 * the packager's own machine.
 * @param {string} archivePath - Path to `app.asar`.
 * @param {readonly string[]} forbiddenPrefixes - Absolute prefixes a bundled file must not contain.
 * @returns {string[]} The gateway packages the archive proved.
 */
function verifyGatewayContent(archivePath, forbiddenPrefixes) {
  for (const name of GATEWAY_PACKAGES) {
    const packageRoot = `dsh/node_modules/${name}`
    const manifest = JSON.parse(readArchiveEntry(archivePath, `${packageRoot}/package.json`))
    if (manifest.name !== name) throw new Error(`OPL package verification: app.asar mislabels ${name}`)
    readArchiveEntry(archivePath, `${packageRoot}/${GATEWAY_ENTRIES[name]}`)
  }
  const runtime = JSON.parse(readArchiveEntry(archivePath, 'dsh/desktop-runtime.json'))
  const shared = new Set((runtime.sharedPackages ?? []).map(entry => entry.name))
  for (const name of GATEWAY_PACKAGES) {
    if (!shared.has(name)) throw new Error(`OPL package verification: desktop runtime omits ${name}`)
  }
  const patch = readArchiveEntry(archivePath, 'dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
  for (const row of BUNDLE_PATCH_ROWS) {
    if (!new RegExp(`^\\s*- id: ${row}$`, 'mu').test(patch)) {
      throw new Error(`OPL package verification: bundled Web patch has no ${row} row`)
    }
  }
  for (const entry of MACHINE_INDEPENDENT_ENTRIES) {
    const text = readArchiveEntry(archivePath, entry)
    for (const prefix of forbiddenPrefixes) {
      if (text.includes(prefix)) {
        throw new Error(`OPL package verification: ${entry} carries the build machine's absolute path ${prefix}`)
      }
    }
  }
  return [...GATEWAY_PACKAGES]
}

/**
 * Verify the immutable runtime the Desktop shell launches from.
 * @param {string} runtimeDir - `runtime` directory of one packed application.
 */
function verifyBundledRuntime(runtimeDir) {
  if (!existsSync(join(runtimeDir, 'versions.json'))) {
    throw new Error(`OPL package verification: the packed application has no bundled runtime in ${runtimeDir}`)
  }
  if (!existsSync(join(runtimeDir, 'pnpm'))) {
    throw new Error(`OPL package verification: the bundled runtime carries no package manager in ${runtimeDir}`)
  }
}

/**
 * Verify the launch configuration and bundled gateway plugin of one packed application.
 * @param {string} appPath - Path to `OPL DSH.app`.
 * @param {{ expectedDshHome?: string }} [options] - Packaging-time expected home override.
 * @returns {{ dshHome: string, packages: string[] }} Verified facts for the build receipt.
 */
export function verifyOplAppBundle(appPath, options = {}) {
  const expectedDshHome = options.expectedDshHome ?? DEFAULT_DSH_HOME
  const infoPath = join(appPath, 'Contents', 'Info.plist')
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', infoPath], { encoding: 'utf8' }))
  const dshHome = info?.LSEnvironment?.DSH_HOME
  if (dshHome !== expectedDshHome) {
    throw new Error(`OPL package verification: DSH_HOME is ${JSON.stringify(dshHome)}; expected ${JSON.stringify(expectedDshHome)}`)
  }
  if (readFileSync(infoPath, 'utf8').includes('/Users/')) {
    throw new Error('OPL package verification: Info.plist carries an absolute user path')
  }

  const packages = verifyGatewayContent(
    join(appPath, 'Contents', 'Resources', 'app.asar'),
    [MACOS_HOME_PATH_PREFIX],
  )
  const runtimeDir = join(appPath, 'Contents', 'Resources', 'runtime')
  verifyBundledRuntime(runtimeDir)
  if (!existsSync(join(appPath, 'Contents', 'MacOS', 'OPL DSH'))) {
    throw new Error('OPL package verification: the application has no Electron Node-mode executable')
  }
  return { dshHome, packages }
}

/**
 * Verify the application directory electron-builder produced for Windows.
 *
 * The unpacked tree is the last point where the packaged contents can be
 * inspected before they are compressed into an installer, so this applies the
 * same gateway checks the macOS bundle receives and adds the Windows-specific
 * facts: the launcher exists, the runtime the shell spawns is present under its
 * Windows layout, and the Linux payload the WSL2 execution environment runs is
 * complete.
 * @param {string} appOutDir - `win-unpacked` directory electron-builder populated.
 * @param {{ productFilename?: string }} [options] - Launcher base name override.
 * @returns {{ home: string, executable: string, packages: string[], wslNode: string }} Verified facts for the build receipt.
 */
export function verifyOplWindowsApplication(appOutDir, options = {}) {
  const resources = join(appOutDir, 'resources')
  const archivePath = join(resources, 'app.asar')
  if (!existsSync(archivePath)) {
    throw new Error(`OPL package verification: ${archivePath} is missing; the application archive was not packed`)
  }
  const packages = verifyGatewayContent(archivePath, WINDOWS_FORBIDDEN_PATH_PREFIXES)

  const executable = `${options.productFilename ?? 'OPL DSH'}.exe`
  const executablePath = join(appOutDir, executable)
  if (!existsSync(executablePath)) {
    throw new Error(`OPL package verification: ${executablePath} is missing; the application cannot be launched`)
  }

  const runtimeDir = join(resources, 'runtime')
  verifyBundledRuntime(runtimeDir)
  if (!existsSync(join(runtimeDir, 'bin', 'node.cmd'))) {
    throw new Error(`OPL package verification: the bundled runtime has no Node-mode launcher in ${runtimeDir}`)
  }

  const wsl = verifyOplWslPayload(join(resources, WSL_PAYLOAD_DIR))
  return { home: WINDOWS_DSH_HOME, executable, packages, wslNode: wsl.node }
}

/**
 * Assert one file is a Windows executable whose name keeps its release identity.
 * @param {string} file - Path to one `.exe` electron-builder emitted.
 * @returns {{ kind: string, bytes: number }} The artifact kind and its size.
 */
export function verifyOplWindowsInstaller(file) {
  const name = basename(file)
  const match = WINDOWS_EXECUTABLE_PATTERN.exec(name)
  if (match === null) {
    throw new Error(`OPL package verification: ${name} does not name its version and the win-x64 target`)
  }
  const bytes = statSync(file).size
  if (bytes < MINIMUM_EXECUTABLE_BYTES) {
    throw new Error(`OPL package verification: ${name} is only ${String(bytes)} bytes; the artifact is truncated`)
  }
  const descriptor = openSync(file, 'r')
  try {
    const dosHeader = Buffer.alloc(PE_HEADER_OFFSET_POSITION + 4)
    readSync(descriptor, dosHeader, 0, dosHeader.length, 0)
    if (dosHeader.toString('latin1', 0, 2) !== DOS_MAGIC) {
      throw new Error(`OPL package verification: ${name} is not a Windows executable`)
    }
    const signatureOffset = dosHeader.readUInt32LE(PE_HEADER_OFFSET_POSITION)
    const signature = Buffer.alloc(4)
    readSync(descriptor, signature, 0, 4, signatureOffset)
    if (signature.toString('latin1') !== PE_SIGNATURE) {
      throw new Error(`OPL package verification: ${name} has no PE header`)
    }
  } finally {
    closeSync(descriptor)
  }
  return { kind: match.groups?.kind ?? 'executable', bytes }
}

/**
 * Verify the application carried by one disk image.
 * @param {string} imagePath - Path to the `.dmg`.
 * @param {{ expectedDshHome?: string }} [options] - Packaging-time expected home override.
 * @returns {{ dshHome: string, packages: string[] }} Verified facts for the build receipt.
 */
export function verifyOplDiskImage(imagePath, options = {}) {
  const mountPoint = mkdtempSync(join(tmpdir(), 'opl-dsh-verify-'))
  try {
    execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, imagePath], { stdio: 'pipe' })
  } catch (error) {
    rmSync(mountPoint, { recursive: true, force: true })
    throw error
  }
  try {
    return verifyOplAppBundle(join(mountPoint, 'OPL DSH.app'), options)
  } finally {
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' })
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = process.argv[2]
  if (target === undefined) {
    process.stderr.write('usage: node apps/desktop/opl/verify-opl-package.mjs <OPL DSH.app|opl-dsh-*.dmg|win-unpacked|opl-dsh-*.exe>\n')
    process.exitCode = 1
  } else if (target.endsWith('.dmg')) {
    const verified = verifyOplDiskImage(target)
    process.stdout.write(`OPL package verification: ${target} keeps DSH_HOME=${verified.dshHome} and bundles ${verified.packages.join(', ')}\n`)
  } else if (target.endsWith('.exe')) {
    const verified = verifyOplWindowsInstaller(target)
    process.stdout.write(`OPL package verification: ${target} is a ${verified.kind} executable of ${String(verified.bytes)} bytes\n`)
  } else if (existsSync(join(target, 'resources'))) {
    const verified = verifyOplWindowsApplication(target)
    process.stdout.write(`OPL package verification: ${target} resolves home=${verified.home} and bundles ${verified.packages.join(', ')}\n`)
  } else {
    const verified = verifyOplAppBundle(target)
    process.stdout.write(`OPL package verification: ${target} keeps DSH_HOME=${verified.dshHome} and bundles ${verified.packages.join(', ')}\n`)
  }
}
