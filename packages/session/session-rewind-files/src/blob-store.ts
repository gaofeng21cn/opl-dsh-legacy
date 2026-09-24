/**
 * Content-addressed store for journaled file bytes, rooted below
 * `$DSH_HOME/rewind-files`.
 *
 * A blob is named by the lowercase hex SHA-256 of its exact bytes, so equal
 * content across turns, paths, and sessions is stored once and a restore can
 * prove it recovered the recorded content by re-hashing what it read. Writes
 * publish through a temporary file and a rename, so a crash leaves either the
 * complete blob or no blob, never a partial one under a valid name.
 *
 * @module @deepseek-ai/dsh-session-rewind-files/blob-store
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { FileBlobHash } from './types.ts'

/** Directory below the harness home that holds every journaled blob and its staging files. */
export const REWIND_FILES_HOME_DIR = 'rewind-files'

/** Subdirectory holding published, content-addressed blobs. */
const BLOB_DIR = 'blobs'

/** Subdirectory holding in-flight temporary files; safe to clear when no harness runs. */
export const STAGING_DIR = 'tmp'

/**
 * Hash bytes with the store's naming function.
 * @param bytes - the exact content to name.
 * @returns the lowercase hex SHA-256 digest, branded as a {@link FileBlobHash}.
 */
export function hashBlob(bytes: Uint8Array): FileBlobHash {
  return FileBlobHash(createHash('sha256').update(bytes).digest('hex'))
}

/** Durable content-addressed blob store backed by the harness home. */
export class FileBlobStore {
  /** Absolute directory holding published blobs. */
  readonly blobDir: string
  /** Absolute directory holding in-flight temporary files. */
  readonly stagingDir: string
  private counter = 0

  /**
   * @param root - explicit store root; defaults to `$DSH_HOME/rewind-files`.
   */
  constructor(root: string = dshHomePath(REWIND_FILES_HOME_DIR)) {
    this.blobDir = join(root, BLOB_DIR)
    this.stagingDir = join(root, STAGING_DIR)
  }

  /**
   * Publish bytes and return their content address. Republishing existing
   * content is a no-op, so a retried capture never duplicates storage.
   * @param bytes - the exact content to store.
   * @returns the content address of `bytes`.
   */
  async put(bytes: Uint8Array): Promise<FileBlobHash> {
    const hash = hashBlob(bytes)
    const destination = this.pathOf(hash)
    // Content addressing makes an existing blob authoritative: the same name
    // can only hold the same bytes, so the write is skipped entirely.
    if (await this.exists(hash)) return hash
    const staging = join(this.stagingDir, `${hash}.${String(process.pid)}.${String(this.counter++)}`)
    await mkdir(this.stagingDir, { recursive: true })
    await mkdir(this.blobDir, { recursive: true })
    await writeFile(staging, bytes)
    try {
      // A concurrent publisher of the same content racing this rename is
      // harmless: both names hold identical bytes.
      await rename(staging, destination)
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined)
      // A lost race against an identical publisher still leaves the blob present.
      if (!await this.exists(hash)) throw error
    }
    return hash
  }

  /**
   * Read one blob, verifying that its bytes still hash to its name.
   * @param hash - the content address to read.
   * @returns the stored bytes, or `undefined` when the blob is absent.
   * @throws Error when the stored bytes no longer match their address.
   */
  async read(hash: FileBlobHash): Promise<Uint8Array | undefined> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.pathOf(hash))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (hashBlob(bytes) !== hash) {
      throw new Error(`rewind file blob ${hash} does not match its content address`)
    }
    return bytes
  }

  /**
   * Whether a blob is published.
   * @param hash - the content address to probe.
   * @returns true when a blob with that address exists.
   */
  async exists(hash: FileBlobHash): Promise<boolean> {
    try {
      const handle = await open(this.pathOf(hash), 'r')
      await handle.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Absolute path of one blob.
   * @param hash - the content address.
   * @returns the absolute path the blob is published at.
   */
  pathOf(hash: FileBlobHash): string {
    return join(this.blobDir, hash)
  }
}

/**
 * Resolve the parent directory of a path, for callers that must create it
 * before publishing a restore.
 * @param path - an absolute file path.
 * @returns the absolute parent directory.
 */
export function parentOf(path: string): string {
  return dirname(path)
}
