/**
 * Vocabulary of the workspace file-change journal: the content-addressed blob
 * identity, the per-path before/after states, the recorded change arms, the
 * `file/change` and `file/checkpoint` session-event payloads, the restore
 * receipts, and the stable failure reasons a rewind routes on.
 *
 * These types are shared by the host journal, the `session.rewind` consumer in
 * `@deepseek-ai/dsh-api-session-controller`, and the client contract, so the
 * reason vocabulary is declared once instead of restated per package.
 *
 * @module @deepseek-ai/dsh-session-rewind-files/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Opaque identity of one stored file blob: the lowercase hex SHA-256 of its exact bytes. */
export type FileBlobHash = Branded<'FileBlobHash'>

/**
 * Brand a raw hex digest as a {@link FileBlobHash}. For blob-store use only;
 * consumers receive hashes from journal events and never manufacture one.
 * @param hash - the lowercase hex SHA-256 digest.
 * @returns the same string, branded; no validation is performed.
 */
export function FileBlobHash(hash: string): FileBlobHash {
  return hash as FileBlobHash
}

/** What one journaled path held, as observed inside the session workspace. */
export type FileEntryKind = 'file' | 'directory' | 'symlink' | 'other'

/**
 * A path's state at one end of a recorded change.
 *
 * `recorded` carries the durable facts a restore needs: the kind, the exact
 * content hash of a regular file, its byte size, and its permission bits. A
 * path that is not a regular file — a directory, symlink, or device — is
 * recorded with no blob, and the journal refuses to rewind a turn whose
 * changes touch one, because recreating it is not something this journal can
 * prove.
 *
 * `absent` means the path did not exist at that end. It is a positive fact
 * observed by a workspace scan or by a guarded filesystem operation, never an
 * assumption.
 */
export type FileEntryState =
  | { readonly kind: 'absent' }
  | {
    readonly kind: 'recorded'
    readonly entry: FileEntryKind
    /** Exact content hash of the regular file's bytes; present exactly when {@link verifiable}. */
    readonly blob?: FileBlobHash
    /** Byte size of the entry, when the filesystem reported one. */
    readonly size?: number
    /** Permission bits of the regular file; absent for non-files. */
    readonly mode?: number
    /** Modification time, recorded only for an entry whose bytes were not read. */
    readonly mtimeMs?: number
    /**
     * Whether the journal read and hashed this entry's bytes. A regular file over
     * the per-file limit stays observable but not verifiable: its change can be
     * detected and refused, never restored.
     */
    readonly verifiable: boolean
  }

/** How one path changed between two observations. */
export type FileChangeKind = 'create' | 'modify' | 'delete' | 'rename'

/**
 * One path's recorded change.
 *
 * The before/after pair is complete: a `create` has `before: absent`, a
 * `delete` has `after: absent`, a `modify` has both recorded, and a `rename`
 * pairs one disappearing path with one appearing path under one
 * {@link FileRename}. A restore replays the pair in reverse, which is why the
 * after-state is recorded even though only the before-state is restored: the
 * after-state is what proves nothing else touched the path since.
 */
export interface FileChangeRecord {
  /** Path relative to the session workspace root, with `/` separators. */
  readonly path: string
  readonly kind: FileChangeKind
  readonly before: FileEntryState
  readonly after: FileEntryState
  /** Present exactly on a `rename`; the counterpart path of the pair. */
  readonly rename?: FileMove
}

/** One rename as the journal observed it: one path disappeared, another appeared. */
export interface FileMove {
  /** Workspace-relative path the entry left. */
  readonly from: string
  /** Workspace-relative path the entry arrived at. */
  readonly to: string
}

/**
 * Why a turn's file changes cannot be restored. Closed union; the client maps
 * each arm to localized copy and each arm has exactly one producer.
 */
export type FileRewindBlockReason =
  /** No journal plugin was loaded, so the turn's writes were never recorded. */
  | 'journal-absent'
  /** A write landed outside the session workspace and cannot be restored. */
  | 'outside-workspace'
  /** A changed path carried no recoverable content (oversized, or not a regular file). */
  | 'unrecoverable'
  /** The turn's checkpoint exceeded a scan or byte budget, so its baseline is incomplete. */
  | 'checkpoint-over-budget'
  /** A journaled path diverged after the turn ended; restoring it would discard that work. */
  | 'conflict'
  /** The blob for a journaled path is missing from the journal store. */
  | 'blob-missing'

/** One path a rewind put back to its pre-turn state. */
export interface FileRestoreAction {
  /** Workspace-relative path. */
  readonly path: string
  /** What the restore did: rewrite the recorded content, or remove a created path. */
  readonly action: 'restored' | 'deleted'
}

/** Outcome of restoring one turn's recorded file changes. */
export interface FileRestoreReceipt {
  /** Number of paths rewritten from a journaled blob. */
  readonly restored: number
  /** Number of paths deleted because the turn created them. */
  readonly deleted: number
  /** Per-path actions in replay order. */
  readonly actions: readonly FileRestoreAction[]
}

/** Payload of the log-only `file/checkpoint` event: one turn's capture baseline. */
export interface FileCheckpointEventData {
  /** Turn whose writes this baseline can restore. */
  readonly turn: number
  /** Invocation that opened the baseline. */
  readonly promptSeq: SessionSeq
  /** Absolute session workspace root the baseline is limited to. */
  readonly workspaceRoot: string
  /** Paths whose content the baseline recorded. */
  readonly coveredPaths: number
  /** Total bytes of recorded content, before content-addressed deduplication. */
  readonly coveredBytes: number
  /**
   * Paths observed inside the workspace whose content could not be recorded
   * (over the per-file limit, or not a regular file). A change to any of them
   * makes its turn unrestorable rather than silently approximate.
   */
  readonly unrecorded: readonly string[]
  /**
   * Whether the scan stopped at a budget with workspace entries still
   * unvisited. A truncated baseline cannot prove what a turn created or
   * deleted, so its turn is unrestorable.
   */
  readonly truncated: boolean
}

/** Payload of the log-only `file/change` event: one tool execution's recorded writes. */
export interface FileChangeEventData {
  /** Turn the changes belong to. */
  readonly turn: number
  /** Step the changes belong to; the loop-assigned step of the executing tool call. */
  readonly step: number
  /** Paths changed by this execution, in the order the journal recorded them. */
  readonly changes: readonly FileChangeRecord[]
  /**
   * Paths this execution touched outside the session workspace. Non-empty means
   * the effect is outside what a rewind can restore, so the turn is reported
   * unrestorable instead of partially restored.
   */
  readonly outsideWorkspace: readonly string[]
  /**
   * Paths this execution touched whose before- or after-state could not be
   * recorded. Non-empty has the same fail-closed effect as
   * {@link outsideWorkspace}.
   */
  readonly unrecorded: readonly string[]
}

/**
 * Stable failure reasons for `session/rewind-unavailable` when file restoration
 * refuses. Every arm names a condition the rewind cannot repair, so the command
 * can leave the workspace untouched and report it.
 */
export type SessionRewindFileReason =
  | 'file-journal-absent'
  | 'file-outside-workspace'
  | 'file-unrecoverable'
  | 'file-checkpoint-over-budget'
  | 'file-conflict'
  | 'file-blob-missing'
  | 'file-workspace-busy'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One turn's captured workspace baseline: the content a rewind can put
     * back. Log-only, appended before the first possibly-writing execution of
     * its turn, so a reader knows whether that turn is restorable without
     * scanning anything.
     */
    'file/checkpoint': FileCheckpointEventData
    /**
     * One tool execution's workspace writes, diffed against the journal's
     * baseline and its own earlier records. Log-only: neither the model-visible
     * surface nor any message projection reads it, and each record cites content
     * addresses instead of inline bytes.
     */
    'file/change': FileChangeEventData
  }
}
