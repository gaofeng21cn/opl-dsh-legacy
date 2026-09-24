/**
 * Plugin entry for the workspace file-change journal: it activates the
 * `ctx.fileJournal` service by capturing a workspace baseline before a
 * possibly-writing tool runs and a change record after it, and it registers the
 * `fileJournal` projection so a restarted process reconstructs the same facts
 * from the log.
 *
 * This wrapper is the only interception point carrying both the caller's agent
 * identity and the full duration of an execution, which is what an opaque
 * process needs: a command started through `ctx.shell` can write any workspace
 * path, and only "diff the workspace after the execution returns" observes it.
 * The filesystem seam needs no separate hook because the same baseline covers
 * `write`, `edit`, and `str_replace_editor`.
 *
 * @module @deepseek-ai/dsh-session-rewind-files
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import { DEFAULT_MAX_CHECKPOINT_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_FILE_BYTES, FileJournal } from './journal.ts'
import type { FileJournalConfig } from './journal.ts'
import { fileJournalProjectionDefinition, journalFactsOf } from './projection.ts'

export { FileJournal, changesOfTurn, collapseChanges, reasonOf } from './journal.ts'
export { DEFAULT_MAX_CHECKPOINT_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_FILE_BYTES } from './journal.ts'
export type { FileJournalConfig, ResolvedConfig, RestoreOutcome } from './journal.ts'
export { FileBlobStore, hashBlob } from './blob-store.ts'
export { fileJournalProjectionDefinition, journalFactsOf } from './projection.ts'
export type { FileJournalState, JournalChangeBatch, JournalCheckpoint } from './projection.ts'
export {
  PROTECTED_DIRECTORY_NAMES,
  canonicalWorkspaceRoot,
  relativeWorkspacePath,
  resolveWorkspacePath,
  scanWorkspace,
} from './workspace-scan.ts'
export type { ScanLimits, ScanResult, ScannedEntry } from './workspace-scan.ts'
export { FileBlobHash } from './types.ts'
export type {
  FileChangeEventData,
  FileChangeKind,
  FileChangeRecord,
  FileCheckpointEventData,
  FileEntryKind,
  FileEntryState,
  FileMove,
  FileRestoreAction,
  FileRestoreReceipt,
  FileRewindBlockReason,
  SessionRewindFileReason,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-rewind-files'

/** Services this plugin reads: the tool pipeline, the projection registry, and the filesystem. */
export const inject = ['tools', 'sessionProjections', 'fs']

/**
 * Loader-validated plugin configuration. The bounds are resolved fields on the
 * schema rather than constants in code, so a deployment whose workspace is
 * larger than the defaults raises them from `cordis.yml` instead of editing the
 * plugin; the journal re-validates whatever it receives.
 */
export const Config: z<FileJournalConfig> = z.object({
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  maxEntries: z.number().default(DEFAULT_MAX_ENTRIES),
  maxCheckpointBytes: z.number().default(DEFAULT_MAX_CHECKPOINT_BYTES),
  blobRoot: z.string(),
})

/** Payload of the `agent/disposed` event, narrowed to the session this plugin keys on. */
interface AgentDisposedPayload {
  readonly agent: { session: Parameters<FileJournal['forget']>[0] }
}

/**
 * Register the recorder: the journal projection, the baseline-before /
 * record-after tool wrapper, the out-of-workspace observation, and disposal
 * cleanup.
 * @param ctx - context carrying the tool pipeline, projection registry, and filesystem.
 * @param config - journal bounds and the deployment's extra writing tools.
 */
export function apply(ctx: Context, config: FileJournalConfig = {}): void {
  const journal = new FileJournal(ctx, config)
  ctx.sessionProjections.register(fileJournalProjectionDefinition)

  ctx.on('tools/execute', async (exec, next) => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const session = agent.session
    const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (boundary === undefined || boundary.openTurnStartSeq === null) return next()
    const turn = boundary.lastTurn
    // Every dispatch opens the turn's baseline, whatever the tool is called:
    // a deployment tool this plugin has never heard of must still be covered,
    // and the baseline is what makes its writes recoverable.
    await journal.ensureCheckpoint(session, turn, boundary.openTurnStartSeq)
    try {
      return await next()
    } finally {
      // The record must observe the execution's final workspace state whatever
      // the tool returned, and while its turn is still the current one.
      try {
        await journal.recordToolExecution(session, turn, lastStepOf(ctx, session, turn))
      } catch (error) {
        // A failed record leaves this turn's diff incomplete, so its rewind must
        // refuse instead of restoring against a baseline it cannot trust.
        journal.noteRecordingFailure(session, turn)
        ctx.logger.error(`file journal record failed for turn ${String(turn)}: ${String(error)}`)
      }
    }
  })

  // An out-of-workspace write is provable from two filesystem signals: the
  // intent waterfall names the target before the mutation, and `fs/observed`
  // confirms it landed. Both are forwarded; a target inside the workspace is
  // left to the turn's own baseline and rescan.
  const noteWrite = (target: FsTarget, actor: object | undefined, phase: 'intent' | 'observed'): void => {
    const session = actorSession(actor)
    if (session === undefined) return
    journal.noteFilesystemWrite(session, target, phase)
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    noteWrite(target, actor, 'intent')
    return next()
  })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    noteWrite(target, actor, 'intent')
    return next()
  })
  ctx.on('fs/observed', (target: FsTarget, _observation, actor: object | undefined) => {
    noteWrite(target, actor, 'observed')
  })

  ctx.on('agent/disposed', (payload: AgentDisposedPayload) => {
    journal.forget(payload.agent.session)
  })
}

/** The slice of a filesystem observation actor this plugin reads. */
interface FsObservationActor {
  agent?: { session?: Parameters<FileJournal['noteFilesystemWrite']>[0] }
}

/**
 * Narrow the opaque `fs/observed` actor to the session that owns the write.
 * @param actor - the observation's actor object.
 * @returns the owning session, or undefined when the caller has none.
 */
function actorSession(actor: object | undefined): Parameters<FileJournal['noteFilesystemWrite']>[0] | undefined {
  // The analyzers disagree on this weak type, exactly as in dsh-fs-observation-policy:
  // tsgolint calls the assertion unnecessary while tsc still needs it for property access.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsgolint/tsc divergence on a weak actor type.
  return (actor as FsObservationActor | undefined)?.agent?.session
}

/**
 * The step the addressed turn has reached, read from the journal projection so
 * the tag a change batch carries survives a restart unchanged.
 * @param ctx - context carrying the projection registry.
 * @param session - the session whose turn is addressed.
 * @param turn - the turn to find the newest step of.
 * @returns the newest step number of `turn`, or 0 when the projection is unavailable.
 */
function lastStepOf(
  ctx: Context,
  session: Parameters<FileJournal['forget']>[0],
  turn: number,
): number {
  const facts = journalFactsOf(ctx.sessionProjections.stateOf(session, 'fileJournal'))
  return facts.turn === turn ? facts.step : 0
}
