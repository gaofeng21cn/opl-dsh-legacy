/**
 * The workspace file-change journal: it records what each tool execution wrote
 * inside a session workspace so `session.rewind` can put those files back.
 *
 * ## Why the baseline precedes the write
 *
 * Writes split into two kinds at the harness boundary. Every Harness-authored
 * text mutation goes through `ctx.fs.writeText`/`editText` (the `write`, `edit`,
 * and `str_replace_editor` tools), so the filesystem seam sees it. A command run
 * through `ctx.shell` — the `bash`, `pwsh`, `run_code`, and terminal tools — is
 * an opaque process that can create, modify, delete, or rename any workspace
 * file without calling back into the harness: nothing observes those writes, and
 * no operating system snapshot is available here.
 *
 * The journal therefore captures a bounded content baseline of the workspace
 * BEFORE the first execution that could write, then diffs the workspace after
 * each later execution. That baseline is what makes an opaque process's writes
 * recoverable: the diff finds what moved, and the baseline still holds the bytes
 * those paths had before. A turn whose baseline is incomplete — over a budget,
 * or holding a path this journal cannot restore — is recorded as unrestorable
 * rather than approximated.
 *
 * ## What this deliberately does not do
 *
 * It never infers a change from modification times, never treats "this looks
 * like it changed this turn" as permission to remove a file, and never reaches
 * outside the session workspace. A path it cannot prove is left untouched and
 * its turn is refused.
 *
 * @module @deepseek-ai/dsh-session-rewind-files/journal
 */

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { } from './types.ts'
import { FileBlobStore, hashBlob } from './blob-store.ts'
import { journalFactsOf } from './projection.ts'
import type { FileJournalState, JournalCheckpoint } from './projection.ts'
import {
  canonicalWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspacePath,
  scanWorkspace,
} from './workspace-scan.ts'
import type { ScanLimits, ScanResult, ScannedEntry } from './workspace-scan.ts'
import type {
  FileChangeRecord,
  FileEntryState,
  FileRestoreAction,
  FileRestoreReceipt,
  FileRewindBlockReason,
  SessionRewindFileReason,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileJournal: FileJournal
  }
}

/**
 * Reasons that refuse every restore of their turn. Once one is recorded, a later
 * change of circumstances does not clear it, and a narrower later reason does
 * not displace the first, more specific one.
 */
const HARD_BLOCKS: ReadonlySet<FileRewindBlockReason> = new Set<FileRewindBlockReason>([
  'journal-absent',
  'checkpoint-over-budget',
  'unrecoverable',
  'outside-workspace',
  'blob-missing',
])

/** Default cap on one recorded file's size. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/** Default cap on entries one baseline walk visits. */
export const DEFAULT_MAX_ENTRIES = 50_000

/** Default cap on total bytes one baseline reads. */
export const DEFAULT_MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024

/** Journal configuration; every deployment-varying bound is a validated field. */
export interface FileJournalConfig {
  /**
   * Largest regular file the baseline records. A larger file is listed as
   * unrecorded, which makes any turn that changes it unrestorable instead of
   * partially restored. Defaults to 2 MiB.
   */
  maxFileBytes?: number
  /** Largest number of workspace entries one scan visits before truncating. Defaults to 50000. */
  maxEntries?: number
  /** Largest total byte count one baseline reads. Defaults to 64 MiB. */
  maxCheckpointBytes?: number
  /** Override the content-addressed blob root; defaults to `$DSH_HOME/rewind-files`. */
  blobRoot?: string
}

/** Validated journal configuration. */
export interface ResolvedConfig {
  readonly maxFileBytes: number
  readonly maxEntries: number
  readonly maxCheckpointBytes: number
  readonly blobRoot: string | undefined
}

/** One session's journal state for the turn currently being recorded. */
interface TurnJournal {
  /** Turn being recorded. */
  readonly turn: number
  /** Whether the baseline exists yet. */
  checkpointed: boolean
  /** Whether the baseline or a later record makes this turn unrestorable. */
  blocked: FileRewindBlockReason | undefined
  /** Workspace-relative path responsible for {@link blocked}, when one is. */
  blockedPath: string | undefined
  /** Paths the baseline recorded, with the state each held when captured. */
  known: Map<string, FileEntryState>
  /** Paths the baseline could not record. */
  readonly unrecorded: Set<string>
  /** Absolute paths this turn touched outside the workspace. */
  readonly outsideWorkspace: Set<string>
  /**
   * Targets whose write intent was announced but whose `fs/observed` emission
   * has not arrived yet. Keyed by process path so the confirmation can find the
   * entry again after the mutation.
   */
  readonly intendedWrites: Map<string, FsTarget>
  /** Merge chain serializing baseline capture and rescans for this turn. */
  tail: Promise<unknown>
  /**
   * Record a reason this turn cannot be restored, keeping the first hard block.
   * @param reason - the reason the latest observation proves.
   * @param path - the workspace-relative path responsible, when one is.
   */
  block(reason: FileRewindBlockReason, path?: string): void
}

/** Outcome of a restore attempt. */
export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly receipt: FileRestoreReceipt }
  | { readonly kind: 'blocked'; readonly reason: SessionRewindFileReason; readonly path?: string }

/** One path's collapsed plan: the turn's first before-state and last after-state. */
interface PlannedPath {
  readonly path: string
  readonly before: FileEntryState
  readonly after: FileEntryState
}

/**
 * The `ctx.fileJournal` service: per-turn workspace baselines, per-execution
 * change records, and the restore a rewind runs.
 *
 * One instance serves every session. Live state is keyed by session identity and
 * rebuilt from the log after a restart, so replay produces the same records
 * without relying on anything held only in memory.
 */
export class FileJournal extends Service {
  /** Validated configuration. */
  readonly config: ResolvedConfig
  private readonly blobs: FileBlobStore
  private readonly turns = new WeakMap<Session, TurnJournal>()

  /**
   * @param ctx - context carrying `ctx.fs`.
   * @param config - journal bounds and the deployment's extra writing tools.
   */
  constructor(ctx: Context, config: FileJournalConfig = {}) {
    super(ctx, 'fileJournal')
    this.config = resolveConfig(config)
    this.blobs = new FileBlobStore(this.config.blobRoot)
  }

  /**
   * The content-addressed store holding this journal's recorded bytes.
   * @returns the blob store.
   */
  get store(): FileBlobStore {
    return this.blobs
  }

  /**
   * Capture the addressed turn's workspace baseline when it has none.
   *
   * Call this before dispatching a possibly-writing tool, so the baseline holds
   * the content those writes are about to replace.
   * @param session - the session whose workspace is journaled.
   * @param turn - the turn the baseline belongs to.
   * @param promptSeq - the user prompt that opened `turn`.
   * @returns resolution after the baseline exists, or immediately when one does.
   */
  async ensureCheckpoint(session: Session, turn: number, promptSeq: SessionSeq): Promise<void> {
    const state = this.turnState(session, turn)
    if (state.checkpointed) return
    await this.serialize(state, async () => {
      if (state.checkpointed) return
      const root = session.header.cwd
      if (root === undefined) {
        // Without a workspace there is no containment boundary to journal
        // against, so every record for this turn would be unprovable.
        state.checkpointed = true
        state.block('journal-absent')
        return
      }
      const canonical = await canonicalWorkspaceRoot(root)
      const scan = await scanWorkspace(canonical, this.scanLimits(), bytes => this.blobs.put(bytes).then(() => undefined))
      state.known = new Map([...scan.entries].map(([path, entry]) => [path, stateOfScanned(entry)]))
      for (const path of scan.unrecorded) state.unrecorded.add(path)
      // An unrecorded path blocks only once this turn is observed changing it.
      // Pre-existing dependency trees and build output would otherwise make
      // every turn in an ordinary repository unrestorable.
      if (scan.truncated) state.block('checkpoint-over-budget')
      state.checkpointed = true
      session.append('file/checkpoint', {
        turn,
        promptSeq,
        workspaceRoot: canonical,
        coveredPaths: scan.entries.size,
        coveredBytes: scan.bytesRead,
        unrecorded: [...scan.unrecorded].sort(),
        truncated: scan.truncated,
      })
    })
  }

  /**
   * Diff the session workspace against the journal's known state and append one
   * `file/change` event for what moved.
   *
   * A no-op unless the turn already has a baseline: an execution the journal did
   * not plan for must not claim coverage it never captured.
   * @param session - the session whose workspace is journaled.
   * @param turn - the turn the execution belongs to.
   * @param step - the step the execution belongs to.
   * @returns resolution after any change event is appended.
   */
  async recordToolExecution(session: Session, turn: number, step: number): Promise<void> {
    const state = this.turns.get(session)
    if (state === undefined || state.turn !== turn || !state.checkpointed) return
    await this.serialize(state, async () => {
      const checkpoint = checkpointOfTurn(journalFactsOf(this.ctx.sessionProjections.stateOf(session, 'fileJournal')), turn)
      if (checkpoint === undefined) return
      const scan = await scanWorkspace(checkpoint.workspaceRoot, this.scanLimits())
      const diff = diffAgainstKnown(state, scan)
      if (diff.unrecorded.length > 0) {
        for (const path of diff.unrecorded) state.unrecorded.add(path)
        state.block('unrecoverable', diff.unrecorded[0])
      }
      // A durable record is written whenever anything moved, including an
      // observation with no restorable change: the refusal must survive replay,
      // and an empty event is what carries it.
      if (diff.changes.length === 0
        && state.outsideWorkspace.size === 0
        && state.unrecorded.size === 0
        && diff.unrecorded.length === 0) return
      session.append('file/change', {
        turn,
        step,
        changes: diff.changes,
        outsideWorkspace: [...state.outsideWorkspace].sort(),
        unrecorded: [...diff.unrecorded].sort(),
      })
    })
  }

  /**
   * Record a filesystem write that a rewind cannot undo.
   *
   * Two signals compose here. The intent waterfalls fire before every
   * `ctx.fs` mutation, which is the only point where an out-of-workspace target
   * is knowable; the `fs/observed` emission confirms the mutation landed. A path
   * inside the workspace is left to the differential rescan, which holds its
   * prior content. A confirmed path outside the workspace is unreachable for
   * every later scan, so it refuses the turn: a rewind must not report success
   * while a write it cannot see remains in place.
   * @param session - the session that owns the write.
   * @param target - the resolved filesystem target that was written.
   * @param phase - `'intent'` before the mutation, `'observed'` after it landed.
   */
  noteFilesystemWrite(session: Session, target: FsTarget, phase: 'intent' | 'observed'): void {
    const facts = journalFactsOf(this.ctx.sessionProjections.stateOf(session, 'fileJournal'))
    const workspaceRoot = facts.checkpoints.at(-1)?.workspaceRoot ?? session.header.cwd
    // Without a recorded baseline there is no rewind to protect, and no turn to
    // attach the fact to.
    if (workspaceRoot === undefined || facts.checkpoints.length === 0) return
    const state = this.turnState(session, facts.turn)
    const absolute = this.ctx.fs.processPath(target)
    if (phase === 'intent') {
      state.intendedWrites.set(absolute, target)
      return
    }
    const intended = state.intendedWrites.get(absolute)
    state.intendedWrites.delete(absolute)
    if (intended === undefined) return
    const relative = relativeWorkspacePath(workspaceRoot, absolute)
    if (relative === undefined) {
      state.outsideWorkspace.add(absolute)
      state.block('outside-workspace')
      return
    }
    if (relative.length === 0 || state.known.has(relative)) return
    // Inside the workspace but absent from the baseline: a path the walk does
    // not record (a dependency store, or a subtree a budget truncated). Its
    // prior content is unknowable, so the turn refuses instead of leaving the
    // write behind.
    state.unrecorded.add(relative)
    state.block('unrecoverable', relative)
  }

  /**
   * Plan and perform the restore of one ended turn's recorded file changes.
   *
   * The complete plan is verified before anything is written: every recorded
   * path must currently hold the state the journal recorded AFTER the turn's
   * last change to it. A path that moved since — an edit by the user or by a
   * later turn — refuses the whole rewind, so nothing is half-restored.
   * @param session - the session whose turn is being rewound.
   * @param turn - the ended turn to restore.
   * @returns the restore receipt, or the reason the turn cannot be restored.
   */
  async restoreTurn(session: Session, turn: number): Promise<RestoreOutcome> {
    const facts = journalFactsOf(this.ctx.sessionProjections.stateOf(session, 'fileJournal'))
    const checkpoint = checkpointOfTurn(facts, turn)
    if (checkpoint === undefined) {
      // A turn that dispatched no tool cannot have written anything through one,
      // so it has nothing to put back. A turn that did dispatch one and still
      // has no baseline is the case this journal must refuse: it cannot tell
      // what that tool wrote.
      return facts.toolCallTurns.includes(turn)
        ? { kind: 'blocked', reason: 'file-journal-absent' }
        : { kind: 'restored', receipt: { restored: 0, deleted: 0, actions: [] } }
    }
    const recorded = changesOfTurn(facts, turn)
    const state = this.turns.get(session)
    const live = state?.turn === turn ? state.blocked : undefined
    const blocked = live ?? recorded.block
    if (blocked !== undefined) {
      const path = live === undefined ? undefined : state?.blockedPath
      return { kind: 'blocked', reason: reasonOf(blocked), ...path === undefined ? {} : { path } }
    }
    if (recorded.changes.length === 0) {
      return { kind: 'restored', receipt: { restored: 0, deleted: 0, actions: [] } }
    }
    return this.applyPlan(checkpoint.workspaceRoot, collapseChanges(recorded.changes))
  }

  /**
   * Mark one turn unrestorable after a record attempt failed.
   *
   * The in-memory diff is the only place the missing record is visible; without
   * this mark a rewind would restore the changes it did record and leave the
   * failed execution's writes behind.
   * @param session - the session whose turn failed to record.
   * @param turn - the turn that failed.
   */
  noteRecordingFailure(session: Session, turn: number): void {
    this.turnState(session, turn).block('unrecoverable')
  }

  /**
   * Drop a session's in-memory turn state. The recorded events stay in the log,
   * so replaying the session reconstructs the same journal state.
   * @param session - the session whose state is dropped.
   */
  forget(session: Session): void {
    this.turns.delete(session)
  }

  /** Limits passed to every workspace scan. */
  private scanLimits(): ScanLimits {
    return {
      maxFileBytes: this.config.maxFileBytes,
      maxEntries: this.config.maxEntries,
      maxTotalBytes: this.config.maxCheckpointBytes,
    }
  }

  /** Current state for one session turn, replacing it when the turn advanced. */
  private turnState(session: Session, turn: number): TurnJournal {
    const existing = this.turns.get(session)
    if (existing !== undefined && existing.turn === turn) return existing
    const created: TurnJournal = {
      turn,
      checkpointed: false,
      blocked: undefined,
      blockedPath: undefined,
      known: new Map(),
      unrecorded: new Set(),
      outsideWorkspace: new Set(),
      intendedWrites: new Map(),
      tail: Promise.resolve(),
      block(reason: FileRewindBlockReason, path?: string): void {
        if (created.blocked !== undefined && HARD_BLOCKS.has(created.blocked)) return
        created.blocked = reason
        created.blockedPath = path
      },
    }
    this.turns.set(session, created)
    return created
  }

  /** Run `op` after every previously queued operation on this turn's state. */
  private async serialize<T>(state: TurnJournal, op: () => Promise<T>): Promise<T> {
    const run = state.tail.then(op, op)
    state.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Verify the whole plan, then perform it. */
  private async applyPlan(root: string, entries: readonly PlannedPath[]): Promise<RestoreOutcome> {
    const loaded = new Map<string, Uint8Array>()
    for (const entry of entries) {
      const current = await readEntryState(resolveWorkspacePath(root, entry.path))
      if (!sameState(current, entry.after)) {
        return { kind: 'blocked', reason: 'file-conflict', path: entry.path }
      }
      if (entry.before.kind === 'recorded' && entry.before.blob !== undefined) {
        const bytes = await this.blobs.read(entry.before.blob)
        if (bytes === undefined) return { kind: 'blocked', reason: 'file-blob-missing', path: entry.path }
        loaded.set(entry.path, bytes)
      }
    }
    const actions: FileRestoreAction[] = []
    // Deepest first, so a directory the turn created is emptied before it goes.
    const removals = entries
      .filter(entry => entry.before.kind === 'absent')
      .sort((left, right) => right.path.length - left.path.length)
    for (const entry of removals) {
      await rm(resolveWorkspacePath(root, entry.path), { recursive: true, force: true })
      actions.push({ path: entry.path, action: 'deleted' })
    }
    for (const entry of entries) {
      if (entry.before.kind !== 'recorded') continue
      const bytes = loaded.get(entry.path)
      if (bytes === undefined) continue
      await writeAtomically(resolveWorkspacePath(root, entry.path), bytes, entry.before.mode)
      actions.push({ path: entry.path, action: 'restored' })
    }
    return {
      kind: 'restored',
      receipt: {
        restored: actions.filter(action => action.action === 'restored').length,
        deleted: actions.filter(action => action.action === 'deleted').length,
        actions,
      },
    }
  }
}

/**
 * Fold one turn's reconstructed records into the facts a restore needs.
 *
 * The facts come from the `fileJournal` projection, which folds the same
 * `file/checkpoint` and `file/change` events a live journal appended; a process
 * that never saw the turn reads identical facts after replay.
 * @param facts - the session's reconstructed journal state.
 * @param turn - the turn to fold.
 * @returns the turn's changes in log order and the first block its records prove.
 */
export function changesOfTurn(facts: FileJournalState, turn: number): {
  changes: FileChangeRecord[]
  block: FileRewindBlockReason | undefined
} {
  const changes: FileChangeRecord[] = []
  let block: FileRewindBlockReason | undefined
  for (const batch of facts.batches) {
    if (batch.turn !== turn) continue
    changes.push(...batch.changes)
    if (batch.outsideWorkspace.length > 0 && block === undefined) block = 'outside-workspace'
    else if (batch.unrecorded.length > 0 && block === undefined) block = 'unrecoverable'
  }
  const checkpoint = checkpointOfTurn(facts, turn)
  if (checkpoint !== undefined && checkpoint.truncated) return { changes, block: 'checkpoint-over-budget' }
  return { changes, block }
}

/**
 * Collapse one turn's change records into one plan entry per path.
 *
 * Only the endpoints matter to a restore: the state a path held before the
 * turn's first change to it, and the state its last change left behind. The
 * intermediate transitions stay in the log as evidence but do not change the
 * inverse.
 * @param changes - the turn's change records in log order.
 * @returns one plan entry per changed path, in first-change order.
 */
export function collapseChanges(changes: readonly FileChangeRecord[]): PlannedPath[] {
  const byPath = new Map<string, PlannedPath>()
  for (const change of changes) {
    const existing = byPath.get(change.path)
    byPath.set(change.path, {
      path: change.path,
      before: existing?.before ?? change.before,
      after: change.after,
    })
  }
  return [...byPath.values()]
}

/**
 * The last baseline recorded for one turn.
 * @param facts - the session's reconstructed journal state.
 * @param turn - the turn to look up.
 * @returns that turn's newest checkpoint, or undefined when it has none.
 */
function checkpointOfTurn(facts: FileJournalState, turn: number): JournalCheckpoint | undefined {
  let found: JournalCheckpoint | undefined
  for (const checkpoint of facts.checkpoints) {
    if (checkpoint.turn === turn) found = checkpoint
  }
  return found
}

/**
 * Diff one scan against the journal's known state, updating that state.
 *
 * A change the journal can restore becomes a {@link FileChangeRecord}; a change
 * it can only observe — an entry whose bytes were never read, or one behind a
 * protected directory — is reported as unrecorded instead, which makes its turn
 * unrestorable rather than partially restored.
 * @param state - the turn's live baseline and known states.
 * @param scan - the workspace observation to fold in.
 * @returns the restorable changes and the paths only a refusal can cover.
 */
function diffAgainstKnown(state: TurnJournal, scan: ScanResult): {
  changes: FileChangeRecord[]
  unrecorded: string[]
} {
  const changes: FileChangeRecord[] = []
  const unrecorded: string[] = []
  for (const [path, entry] of scan.entries) {
    const before = state.known.get(path) ?? { kind: 'absent' as const }
    const after = stateOfScanned(entry)
    if (sameState(before, after)) continue
    const restorable = isVerifiable(after) && (before.kind === 'absent' || isVerifiable(before))
    if (restorable) {
      changes.push({ path, kind: before.kind === 'absent' ? 'create' : 'modify', before, after })
    } else {
      unrecorded.push(path)
    }
    state.known.set(path, after)
  }
  for (const [path, before] of state.known) {
    if (scan.entries.has(path) || before.kind === 'absent') continue
    if (isVerifiable(before)) {
      changes.push({ path, kind: 'delete', before, after: { kind: 'absent' } })
    } else {
      // The path is gone and its bytes were never read, so nothing can put it
      // back; reporting the loss keeps its turn honest.
      unrecorded.push(path)
    }
    state.known.set(path, { kind: 'absent' })
  }
  return { changes, unrecorded }
}

/**
 * Whether a state carries verified content. Only a recorded regular file does;
 * an absent path and a non-file entry have no bytes to compare or restore.
 * @param state - the state to test.
 * @returns true when the state has a content address to verify against.
 */
function isVerifiable(state: FileEntryState): boolean {
  return state.kind === 'recorded' && state.verifiable
}

/** Convert one scanned entry into its journaled state. */
function stateOfScanned(entry: ScannedEntry): FileEntryState {
  return {
    kind: 'recorded',
    entry: entry.kind,
    ...entry.blob === undefined ? {} : { blob: entry.blob },
    ...entry.mode === undefined ? {} : { mode: entry.mode },
    ...entry.size === undefined ? {} : { size: entry.size },
    ...entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs },
    verifiable: entry.verifiable,
  }
}

/**
 * Whether two recorded states describe the same path content.
 *
 * A verifiable entry compares by content address, which is exact. An entry
 * whose bytes were never read compares by the facts the walk could observe. A
 * directory compares by kind alone: its modification time moves whenever a child
 * does, so comparing it would report a change for every file a turn legitimately
 * created inside one.
 * @param left - one end of a comparison.
 * @param right - the other end.
 * @returns true when both ends describe the same state.
 */
function sameState(left: FileEntryState, right: FileEntryState): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'absent' || right.kind === 'absent') return true
  if (left.entry !== right.entry) return false
  if (isVerifiable(left) || isVerifiable(right)) return left.blob === right.blob
  if (left.entry === 'directory') return true
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

/**
 * Read one path's current journaled state without following a final symbolic
 * link. A path a restore can rewrite is always a regular file whose bytes this
 * reads, so the state it returns for one is verifiable.
 * @param absolute - the absolute path to inspect.
 * @returns the path's state, or absence when it does not exist.
 */
async function readEntryState(absolute: string): Promise<FileEntryState> {
  let stats
  try {
    stats = await lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (stats.isSymbolicLink()) return { kind: 'recorded', entry: 'symlink', mode: stats.mode, verifiable: false }
  if (stats.isDirectory()) return { kind: 'recorded', entry: 'directory', mode: stats.mode, verifiable: false }
  if (!stats.isFile()) {
    return { kind: 'recorded', entry: 'other', mode: stats.mode, size: stats.size, verifiable: false }
  }
  const bytes = await readFile(absolute)
  return {
    kind: 'recorded',
    entry: 'file',
    blob: hashBlob(bytes),
    size: bytes.length,
    mode: stats.mode,
    verifiable: true,
  }
}

/**
 * Publish bytes at a path through a same-directory temporary file and a rename,
 * so a reader never observes a partial restore and a failure leaves the original
 * file rather than a truncated one.
 *
 * The recorded `rwx` bits are applied to the staging file before the rename, so
 * a restored file keeps its mode instead of taking the temporary file's. A host
 * without POSIX permission bits ignores them, which leaves Windows as it was.
 * @param absolute - the absolute destination path inside the workspace.
 * @param bytes - the recorded content to publish.
 * @param mode - the mode the baseline recorded, or undefined when the record
 *   carries none; only its low permission bits are reapplied.
 */
async function writeAtomically(absolute: string, bytes: Uint8Array, mode: number | undefined): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true })
  const staging = `${absolute}.dsh-rewind-${String(process.pid)}-${Date.now().toString(36)}`
  await writeFile(staging, bytes)
  try {
    // Explicit chmod rather than writeFile's `mode`, which the umask masks.
    if (mode !== undefined) await chmod(staging, mode & 0o777)
    await rename(staging, absolute)
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Map an internal block to the stable reason a rewind reports.
 * @param block - the internal condition that refuses a restore.
 * @returns the wire reason a client switches on.
 */
export function reasonOf(block: FileRewindBlockReason): SessionRewindFileReason {
  switch (block) {
    case 'journal-absent': return 'file-journal-absent'
    case 'outside-workspace': return 'file-outside-workspace'
    case 'unrecoverable': return 'file-unrecoverable'
    case 'checkpoint-over-budget': return 'file-checkpoint-over-budget'
    case 'conflict': return 'file-conflict'
    case 'blob-missing': return 'file-blob-missing'
    default: return assertNeverBlock(block)
  }
}

/** Exhaustiveness guard for the closed block union. */
function assertNeverBlock(block: never): never {
  throw new Error(`unhandled rewind-file block reason ${String(block)}`)
}

/** Validate configuration into its resolved form. */
function resolveConfig(config: FileJournalConfig): ResolvedConfig {
  const positive = (value: number, name: string): number => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`session-rewind-files: ${name} must be a positive safe integer`)
    }
    return value
  }
  return {
    maxFileBytes: positive(config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 'maxFileBytes'),
    maxEntries: positive(config.maxEntries ?? DEFAULT_MAX_ENTRIES, 'maxEntries'),
    maxCheckpointBytes: positive(config.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES, 'maxCheckpointBytes'),
    blobRoot: config.blobRoot ?? undefined,
  }
}
