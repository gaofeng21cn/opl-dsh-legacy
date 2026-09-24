/**
 * The replayable fold of the `file/checkpoint` and `file/change` log events.
 *
 * A restore must work in a process that never observed the turn it is undoing:
 * after a restart, or while answering a retry, the only facts available are the
 * log events. This unit reconstructs exactly what a live journal knew from those
 * events alone — the baseline each turn captured and every change it recorded —
 * so a rewind needs no hidden state and a recorded turn replays identically.
 *
 * The fold is state-only (no wire view): file paths and content addresses are
 * not client presentation, and the rewind receipt a command returns is the
 * client's source of truth for what moved.
 *
 * @module @deepseek-ai/dsh-session-rewind-files/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileChangeEventData, FileChangeRecord, FileCheckpointEventData } from './types.ts'

/** One turnaround's recorded baseline as the fold retains it. */
export interface JournalCheckpoint {
  readonly turn: number
  readonly promptSeq: number
  readonly workspaceRoot: string
  readonly coveredPaths: number
  readonly coveredBytes: number
  readonly unrecorded: readonly string[]
  readonly truncated: boolean
}

/** One recorded execution's changes as the fold retains them. */
export interface JournalChangeBatch {
  readonly turn: number
  readonly step: number
  readonly changes: readonly FileChangeRecord[]
  readonly outsideWorkspace: readonly string[]
  readonly unrecorded: readonly string[]
}

/** Reconstructed journal facts for one session. */
export interface FileJournalState {
  /**
   * Turn the log has reached, and the newest step it opened in that turn. The
   * recorder tags a change batch with them, and a rewind reads the same numbers
   * from the log after any restart, so the recorded facts do not depend on
   * process lifetime.
   */
  readonly turn: number
  readonly step: number
  /**
   * Turns that dispatched at least one tool, in first-dispatch order. A turn
   * with no dispatch cannot have written through one, which is what lets a
   * rewind treat its missing baseline as a no-op instead of a gap.
   */
  readonly toolCallTurns: readonly number[]
  readonly checkpoints: readonly JournalCheckpoint[]
  readonly batches: readonly JournalChangeBatch[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    fileJournal: FileJournalState
  }
}

const fileJournalSchema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  toolCallTurns: z.array(z.number().int()).readonly(),
  checkpoints: z.custom<readonly JournalCheckpoint[]>().readonly(),
  batches: z.custom<readonly JournalChangeBatch[]>().readonly(),
}).readonly()

const EMPTY: FileJournalState = { turn: 0, step: 0, toolCallTurns: [], checkpoints: [], batches: [] }

/**
 * The `fileJournal` projection unit: a pure fold retaining each turn's baseline
 * and every recorded change batch, in log order.
 */
export const fileJournalProjectionDefinition = {
  key: 'fileJournal',
  stateVersion: 1,
  stateSchema: fileJournalSchema,
  init: () => EMPTY,
  apply: (state: FileJournalState, event: SessionEvent): FileJournalState => {
    switch (event.type) {
      case 'turn/start':
        return { ...state, turn: event.data.turn, step: 0 }
      case 'step/start':
        return { ...state, step: event.data.step }
      case 'tool/call':
        return state.toolCallTurns.includes(event.data.turn)
          ? state
          : { ...state, toolCallTurns: [...state.toolCallTurns, event.data.turn] }
      case 'file/checkpoint':
        return { ...state, checkpoints: [...state.checkpoints, toCheckpoint(event.data)] }
      case 'file/change':
        return { ...state, batches: [...state.batches, toBatch(event.data)] }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'fileJournal', FileJournalState>

/**
 * Read one session's reconstructed journal facts.
 * @param state - the projection state, or undefined when the unit is unregistered.
 * @returns the fold's facts, or an empty set.
 */
export function journalFactsOf(state: FileJournalState | undefined): FileJournalState {
  return state ?? EMPTY
}

/** Convert a checkpoint event payload into its folded form. */
function toCheckpoint(data: FileCheckpointEventData): JournalCheckpoint {
  return {
    turn: data.turn,
    promptSeq: data.promptSeq,
    workspaceRoot: data.workspaceRoot,
    coveredPaths: data.coveredPaths,
    coveredBytes: data.coveredBytes,
    unrecorded: [...data.unrecorded],
    truncated: data.truncated,
  }
}

/** Convert a change event payload into its folded form. */
function toBatch(data: FileChangeEventData): JournalChangeBatch {
  return {
    turn: data.turn,
    step: data.step,
    changes: [...data.changes],
    outsideWorkspace: [...data.outsideWorkspace],
    unrecorded: [...data.unrecorded],
  }
}
