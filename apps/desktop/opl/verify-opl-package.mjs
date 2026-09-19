/** Release guard for the packed OPL DSH application and its disk image. */

import { execFileSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Portable default the app expands for the signed-in user. */
export const DEFAULT_DSH_HOME = '~/.dsh-opl'

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
    let entries = JSON.parse(headerJson.toString('utf8')).files
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

  const archivePath = join(appPath, 'Contents', 'Resources', 'app.asar')
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
  if (readArchiveEntry(archivePath, 'lib/main.js').includes('/Users/')) {
    throw new Error('OPL package verification: desktop main bundle carries an absolute user path')
  }
  return { dshHome, packages: [...GATEWAY_PACKAGES] }
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
    process.stderr.write('usage: node apps/desktop/opl/verify-opl-package.mjs <OPL DSH.app|opl-dsh-*.dmg>\n')
    process.exitCode = 1
  } else {
    const verified = target.endsWith('.dmg') ? verifyOplDiskImage(target) : verifyOplAppBundle(target)
    process.stdout.write(`OPL package verification: ${target} keeps DSH_HOME=${verified.dshHome} and bundles ${verified.packages.join(', ')}\n`)
  }
}
