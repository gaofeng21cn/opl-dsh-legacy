/**
 * Download and checksum-verify one upstream Node.js archive.
 *
 * Both packaged runtimes come from this module: the Windows runtime the shell
 * installs for Windows Native, and the Linux runtime a Windows package carries
 * for its WSL2 execution environment. Sharing it keeps the pinned version, the
 * published checksum, and the shared download cache in one place.
 *
 * @module desktop/node-archive
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

/** Node.js version both packaged runtimes are built from. */
export const NODE_VERSION = '24.17.0'

/** Platforms for which Node.js publishes an archive. */
export type NodeArchivePlatform = 'darwin' | 'linux' | 'win'

/** Architectures for which Node.js publishes an archive. */
export type NodeArchiveArch = 'arm64' | 'x64'

/** One verified, downloaded Node.js archive. */
export interface VerifiedNodeArchive {
  /** Absolute path of the verified archive. */
  readonly archive: string
  /** Archive container, which decides how it is extracted. */
  readonly extension: 'zip' | 'tar.gz'
  /** Root directory the archive extracts to. */
  readonly folder: string
}

/** Write one URL to a file with owner-only permissions. */
async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`desktop runtime: ${url} returned HTTP ${String(response.status)}`)
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 })
}

/**
 * Download and verify the Node.js archive for one platform and architecture.
 *
 * The archive is cached by file name, which carries the version, platform, and
 * architecture, so one cache serves every release target. The published
 * `SHASUMS256.txt` entry is required: an archive that is absent from it is
 * rejected rather than trusted.
 * @param input - target platform and architecture plus the shared download cache.
 * @returns the verified archive path and how to extract it.
 * @throws when the download fails, the archive is unpublished, or its digest differs.
 */
export async function fetchVerifiedNodeArchive(input: {
  readonly platform: NodeArchivePlatform
  readonly arch: NodeArchiveArch
  readonly downloads: string
}): Promise<VerifiedNodeArchive> {
  const extension = input.platform === 'win' ? 'zip' : 'tar.gz'
  const folder = `node-v${NODE_VERSION}-${input.platform}-${input.arch}`
  const archiveName = `${folder}.${extension}`
  const releaseRoot = `https://nodejs.org/download/release/v${NODE_VERSION}`
  mkdirSync(input.downloads, { recursive: true })
  const archive = join(input.downloads, archiveName)
  const sums = join(input.downloads, `node-v${NODE_VERSION}-SHASUMS256.txt`)
  if (!existsSync(archive)) await download(`${releaseRoot}/${archiveName}`, archive)
  if (!existsSync(sums)) await download(`${releaseRoot}/SHASUMS256.txt`, sums)
  const line = (await readFile(sums, 'utf8')).split(/\r?\n/u)
    .find(candidate => candidate.endsWith(`  ${archiveName}`))
  if (line === undefined) {
    throw new Error(`desktop runtime: ${archiveName} is absent from Node.js SHASUMS256.txt`)
  }
  const expected = line.split(/\s+/u)[0]
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  if (actual !== expected) throw new Error(`desktop runtime: checksum mismatch for ${archiveName}`)
  return { archive, extension, folder }
}
