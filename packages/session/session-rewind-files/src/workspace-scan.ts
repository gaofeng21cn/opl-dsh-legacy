/**
 * Workspace walking and path discipline for the file-change journal.
 *
 * Every journaled path is a `/`-separated path relative to the session
 * workspace root, produced by walking that root with `lstat` and never
 * following a symbolic link. Containment is decided by construction: the walk
 * only descends from the root, so a journaled relative path cannot escape it,
 * and a restore re-resolves each relative path inside the root before writing.
 *
 * @module @deepseek-ai/dsh-session-rewind-files/workspace-scan
 */

import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FileBlobHash, type FileEntryKind } from './types.ts'
import { hashBlob } from './blob-store.ts'

/**
 * Directory names the walk never descends into: dependency trees, version-control
 * object stores, and language caches. Their content is owned by another tool and
 * ordinary project output is NOT excluded, so a build directory stays covered.
 * Skipping them is what keeps one checkpoint proportional to the project's own
 * sources rather than to its installed dependencies.
 *
 * A write into one of these paths is still refused whenever the journal sees it:
 * `ctx.fs` mutations are reported through the filesystem observation, and a path
 * the baseline never recorded makes its turn unrestorable. Only an opaque
 * subprocess write inside one of them is invisible, which is the documented
 * boundary of what this journal can prove.
 */
export const PROTECTED_DIRECTORY_NAMES: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.turbo',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'target',
]

/** One observed workspace entry. */
export interface ScannedEntry {
  /** Workspace-relative `/`-separated path. */
  readonly path: string
  readonly kind: FileEntryKind
  /** Content address of a regular file's bytes; absent for any other kind. */
  readonly blob?: FileBlobHash
  /** Byte size of the entry as observed. */
  readonly size?: number
  /** Permission bits. */
  readonly mode?: number
  /** Modification time, used only to detect a change to an entry whose bytes were not read. */
  readonly mtimeMs?: number
  /**
   * Whether the entry is a regular file whose bytes this walk read and
   * verified. A regular file over the walk's per-file limit is present but not
   * verifiable: the journal can report that it changed and refuse, but it cannot
   * put its content back.
   */
  readonly verifiable: boolean
}

/**
 * Read the size, mode, and modification time of an entry whose bytes the walk
 * does not read, so a later scan can still tell that it moved.
 * @param absolute - the entry's absolute path.
 * @returns the observable fields, or none when the entry vanished first.
 */
async function statsOf(absolute: string): Promise<{ size?: number; mode?: number; mtimeMs?: number }> {
  try {
    const stats = await lstat(absolute)
    return { size: stats.size, mode: stats.mode, mtimeMs: stats.mtimeMs }
  } catch {
    return {}
  }
}

/** Result of one bounded workspace walk. */
export interface ScanResult {
  /** Entries the walk recorded, keyed by relative path. */
  readonly entries: Map<string, ScannedEntry>
  /** Workspace-relative paths the walk saw but could not record. */
  readonly unrecorded: Set<string>
  /** Whether the walk stopped at a budget with entries still unvisited. */
  readonly truncated: boolean
  /** Total bytes read while hashing regular files. */
  readonly bytesRead: number
}

/** Budgets that bound one workspace walk. */
export interface ScanLimits {
  /** Largest regular file the walk reads and hashes; a larger file is unrecorded. */
  readonly maxFileBytes: number
  /** Largest number of entries the walk visits before truncating. */
  readonly maxEntries: number
  /** Largest total byte count the walk reads before truncating. */
  readonly maxTotalBytes: number
}

/**
 * Decide whether a directory name is protected from the walk.
 * @param name - the directory's basename.
 * @returns true when the walk must not descend into it.
 */
export function isProtectedDirectory(name: string): boolean {
  return PROTECTED_DIRECTORY_NAMES.includes(name)
}

/**
 * Canonicalize a session workspace root.
 * @param root - the session's configured cwd.
 * @returns the realpath of `root`.
 */
export async function canonicalWorkspaceRoot(root: string): Promise<string> {
  return realpath(resolve(root))
}

/**
 * Convert an absolute path into a workspace-relative `/`-separated path.
 * @param root - the canonical workspace root.
 * @param absolute - the absolute path to relativize.
 * @returns the relative path, or `undefined` when `absolute` lies outside `root`.
 */
export function relativeWorkspacePath(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

/**
 * Join a workspace-relative path onto the canonical root, refusing any path
 * that would escape it. The character rules reject the separators, drive
 * letters, and `..` segments that could leave the root on either platform
 * before any filesystem call is made.
 * @param root - the canonical workspace root.
 * @param path - the workspace-relative path.
 * @returns the absolute path inside `root`.
 * @throws Error when `path` is absolute, empty, or contains a `..` segment.
 */
export function resolveWorkspacePath(root: string, path: string): string {
  if (path.length === 0) throw new Error('journaled path must not be empty')
  if (path.startsWith('/') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error(`journaled path "${path}" must be workspace-relative`)
  }
  const segments = path.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`journaled path "${path}" contains an unusable segment`)
  }
  return join(root, ...segments)
}

/**
 * Walk one workspace root, recording regular files under `limits.maxFileBytes`
 * and reporting everything else it saw.
 *
 * The walk is depth-first with an explicit stack and never follows a symbolic
 * link, so it cannot leave the root, cannot cycle, and reports a symlink or a
 * special file as an entry whose kind is not `file`.
 * @param root - the canonical workspace root to walk.
 * @param limits - the walk's budgets.
 * @param store - receives each regular file's exact bytes for durable retention;
 *   omitted only by callers that need the observation without the content.
 * @returns the recorded entries, the unrecorded paths, and whether a budget truncated the walk.
 */
export async function scanWorkspace(
  root: string,
  limits: ScanLimits,
  store?: (bytes: Uint8Array) => Promise<void>,
): Promise<ScanResult> {
  const entries = new Map<string, ScannedEntry>()
  const unrecorded = new Set<string>()
  let truncated = false
  let visited = 0
  let bytesRead = 0

  const stack: string[] = ['']
  while (stack.length > 0) {
    const directory = stack.pop() as string
    let handle
    try {
      handle = await opendir(directory.length === 0 ? root : join(root, directory))
    } catch (error) {
      // A directory that vanished mid-walk is reported rather than fatal: the
      // scan is a baseline, and an unreadable directory is exactly the
      // "cannot prove this" case that must make its turn unrestorable.
      if (directory.length > 0) unrecorded.add(directory)
      else throw error
      continue
    }
    for await (const dirent of handle) {
      if (visited >= limits.maxEntries) {
        truncated = true
        break
      }
      visited += 1
      const path = directory.length === 0 ? dirent.name : `${directory}/${dirent.name}`
      if (dirent.isSymbolicLink()) {
        entries.set(path, { path, kind: 'symlink', verifiable: false, ...await statsOf(join(root, path)) })
        continue
      }
      if (dirent.isDirectory()) {
        entries.set(path, { path, kind: 'directory', verifiable: false })
        if (isProtectedDirectory(dirent.name)) {
          // A protected directory is recorded as present but never descended
          // into, so what it holds is unknown. That alone blocks nothing: only a
          // change the journal actually observes under it refuses a rewind.
          unrecorded.add(path)
          continue
        }
        stack.push(path)
        continue
      }
      if (!dirent.isFile()) {
        entries.set(path, { path, kind: 'other', verifiable: false, ...await statsOf(join(root, path)) })
        continue
      }
      const absolute = join(root, path)
      let stats
      try {
        stats = await lstat(absolute)
      } catch {
        // Absence here contradicts the directory listing, so the walk leaves the
        // path out entirely; its next observation reports whatever it became.
        unrecorded.add(path)
        continue
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        entries.set(path, { path, kind: 'other', size: stats.size, mode: stats.mode, mtimeMs: stats.mtimeMs, verifiable: false })
        continue
      }
      if (stats.size > limits.maxFileBytes) {
        // Present and sized, content unknown: the journal can prove this file
        // changed but cannot put its bytes back.
        entries.set(path, { path, kind: 'file', size: stats.size, mode: stats.mode, mtimeMs: stats.mtimeMs, verifiable: false })
        unrecorded.add(path)
        continue
      }
      if (bytesRead + stats.size > limits.maxTotalBytes) {
        entries.set(path, { path, kind: 'file', size: stats.size, mode: stats.mode, mtimeMs: stats.mtimeMs, verifiable: false })
        unrecorded.add(path)
        truncated = true
        continue
      }
      const bytes = await readFile(absolute)
      bytesRead += bytes.length
      await store?.(bytes)
      entries.set(path, {
        path,
        kind: 'file',
        blob: hashBlob(bytes),
        size: bytes.length,
        mode: stats.mode,
        verifiable: true,
      })
    }
    if (truncated) break
  }
  return { entries, unrecorded, truncated, bytesRead }
}
