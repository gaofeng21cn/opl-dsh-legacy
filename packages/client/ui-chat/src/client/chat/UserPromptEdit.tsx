/**
 * Edit-and-resend and rewind controls for one user message: the icon actions,
 * the draft panel with cancel and resend, and the refusal copy of each verb.
 * The owning row holds the draft state; these are its presentation seats.
 * @module @deepseek-ai/dsh-client-ui-chat/client/UserPromptEdit
 */

import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { IconEditOutlineRegular, IconUndoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatKey } from '../locale.ts'
import type {
  ChatPromptEditFailure, ChatPromptRewindFailure, ChatViewSlotProps,
} from '../contract/slots.ts'
import css from './UserPromptEdit.module.css'

/**
 * How long after `compositionend` the draft still treats a keydown as IME input.
 * Safari delivers the composition-closing keydown after that event.
 */
const COMPOSITION_GRACE_MS = 10

/**
 * Whether one draft keydown belongs to an IME composition and must not run a
 * draft shortcut, mirroring the composer keymap's guard: `isComposing` covers
 * most engines, keyCode 229 is the legacy signal engines emit without it, and
 * the composition watch keeps the guard through the closing keydown.
 * @param event - the draft's keydown.
 * @param recentlyComposing - whether the composition watch is inside its window.
 * @returns true when the keystroke belongs to the IME.
 */
function isComposingEvent(event: KeyboardEvent<HTMLTextAreaElement>, recentlyComposing: () => boolean): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  // oxlint-disable-next-line typescript/no-deprecated
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || recentlyComposing()
}

/**
 * Refusal copy for one rejected edit, keyed by the stable code pairs the Host
 * reports; every unlisted pair reads the generic line so a new reason still
 * reaches the user as a failure rather than as silence.
 */
const FAILURE_COPY: Readonly<Record<string, ChatKey>> = {
  'session/edit-unavailable:not-last': 'message.edit.failed.notLast',
  'session/edit-unavailable:busy': 'message.edit.failed.busy',
  'session/edit-unavailable:archived': 'message.edit.failed.archived',
  'session/edit-unavailable:no-user-message': 'message.edit.failed.noUserMessage',
}

/** Refusal copy for one rejected rewind, keyed the same way. */
const REWIND_FAILURE_COPY: Readonly<Record<string, ChatKey>> = {
  'session/rewind-unavailable:not-last': 'message.rewind.failed.notLast',
  'session/rewind-unavailable:busy': 'message.rewind.failed.busy',
  'session/rewind-unavailable:archived': 'message.rewind.failed.archived',
  'session/rewind-unavailable:no-user-message': 'message.rewind.failed.noUserMessage',
  'session/rewind-unavailable:turn-open': 'message.rewind.failed.turnOpen',
}

/**
 * Refusal copy for a rewind that could not put the turn's files back, keyed by
 * the condition the Host named. Every arm states that nothing was rewound,
 * because a refused restore leaves the workspace exactly as it found it.
 */
const REWIND_FILE_FAILURE_COPY: Readonly<Record<string, ChatKey>> = {
  'file-journal-absent': 'message.rewind.failed.fileJournalAbsent',
  'file-outside-workspace': 'message.rewind.failed.fileOutsideWorkspace',
  'file-unrecoverable': 'message.rewind.failed.fileUnrecoverable',
  'file-checkpoint-over-budget': 'message.rewind.failed.fileCheckpointOverBudget',
  'file-conflict': 'message.rewind.failed.fileConflict',
  'file-blob-missing': 'message.rewind.failed.fileBlobMissing',
  'file-workspace-busy': 'message.rewind.failed.fileWorkspaceBusy',
}

/**
 * Resolve one refusal into localized copy.
 * @param failure - the Host refusal, or null when the edit was accepted.
 * @param t - the owning view's locale seat.
 * @returns the copy, or null while no edit has failed.
 */
export function promptEditFailureCopy(
  failure: ChatPromptEditFailure | null,
  t: ChatViewSlotProps['t'],
): string | null {
  if (failure === null) return null
  const key = `${failure.code}:${failure.reason ?? ''}`
  return t(FAILURE_COPY[key] ?? 'message.edit.failed')
}

/**
 * Resolve one rewind refusal into localized copy.
 * @param failure - the Host refusal, or null when the rewind was accepted.
 * @param t - the owning view's locale seat.
 * @returns the copy, or null while no rewind has failed.
 */
export function promptRewindFailureCopy(
  failure: ChatPromptRewindFailure | null,
  t: ChatViewSlotProps['t'],
): string | null {
  if (failure === null) return null
  if (failure.fileReason !== undefined) {
    return t(REWIND_FILE_FAILURE_COPY[failure.fileReason] ?? 'message.rewind.failed.filesUnavailable')
  }
  const key = `${failure.code}:${failure.reason ?? ''}`
  return t(REWIND_FAILURE_COPY[key] ?? 'message.rewind.failed')
}

/**
 * Render one prompt action's refusal under its row.
 * @param props - resolved copy and the owning view's locale seat.
 * @returns the alert line.
 */
export function PromptActionFailure({ copy }: { readonly copy: string }) {
  return <p className={css.failure} role="alert">{copy}</p>
}

/** Props of the icon action that opens one message's edit draft. */
export interface UserPromptEditActionProps {
  /** Whether this message is the Session's editable prompt and no turn is active. */
  readonly enabled: boolean
  /** Open the draft. */
  readonly onOpen: () => void
  /** The owning view's locale seat, passed down as a plain prop. */
  readonly t: ChatViewSlotProps['t']
}

/**
 * Render the edit-and-resend icon action.
 * @param props - availability, the open callback, and the locale seat.
 * @returns the action button, or null when this message is not editable.
 */
export function UserPromptEditAction({ enabled, onOpen, t }: UserPromptEditActionProps) {
  if (!enabled) return null
  return (
    <button
      type="button"
      className={css.action}
      aria-label={t('message.edit.action')}
      data-prompt-edit-action=""
      onClick={onOpen}
    >
      <IconEditOutlineRegular size={12} />
    </button>
  )
}

/** Props of the icon action that rolls the conversation back past one message. */
export interface UserPromptRewindActionProps {
  /** Whether this message is the Session's last prompt and no turn is active. */
  readonly enabled: boolean
  /** A rewind is in flight; the action is inert until it settles. */
  readonly pending: boolean
  /** Roll the conversation back past this message. */
  readonly onRewind: () => void
  /** The owning view's locale seat, passed down as a plain prop. */
  readonly t: ChatViewSlotProps['t']
}

/**
 * Render the rewind icon action.
 * @param props - availability, in-flight state, the rewind callback, and the locale seat.
 * @returns the action button, or null when this message is not rewindable.
 */
export function UserPromptRewindAction({ enabled, pending, onRewind, t }: UserPromptRewindActionProps) {
  if (!enabled) return null
  return (
    <button
      type="button"
      className={css.action}
      aria-label={t('message.rewind.action')}
      aria-disabled={pending || undefined}
      data-prompt-rewind-action=""
      onClick={pending ? undefined : onRewind}
    >
      <IconUndoOutlineRegular size={12} />
    </button>
  )
}

/** Props of the inline edit draft below one user bubble. */
export interface UserPromptEditorProps {
  /** Current draft text. */
  readonly draft: string
  /** A resend is in flight; the draft and both buttons are frozen. */
  readonly pending: boolean
  /** Localized refusal copy of the last resend; null when none failed. */
  readonly failure: string | null
  /** Replace the draft text. */
  readonly onDraft: (text: string) => void
  /** Close the draft without resending. */
  readonly onCancel: () => void
  /** Resend the draft as this Session's edited prompt. */
  readonly onResend: () => void
  /** The owning view's locale seat, passed down as a plain prop. */
  readonly t: ChatViewSlotProps['t']
}

/**
 * Render the inline draft of one user message.
 * @param props - draft text, settlement state, failure copy, and the three verbs.
 * @returns the draft panel, including its cancel and resend controls.
 */
export function UserPromptEditor({
  draft, pending, failure, onDraft, onCancel, onResend, t,
}: UserPromptEditorProps) {
  const composing = useRef(false)
  const composingUntil = useRef(0)
  const recentlyComposing = (): boolean => composing.current || Date.now() < composingUntil.current
  return (
    <div className={css.editor} data-prompt-editor="">
      <textarea
        className={css.draft}
        aria-label={t('message.edit.draft')}
        value={draft}
        readOnly={pending}
        onChange={(event) => { onDraft(event.target.value) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => {
          composing.current = false
          composingUntil.current = Date.now() + COMPOSITION_GRACE_MS
        }}
        onKeyDown={(event) => {
          // Escape and the composition-closing Enter belong to the IME while it
          // is composing: neither may cancel the draft or resend it. The browser
          // owns the gesture, so nothing is prevented here.
          if (isComposingEvent(event, recentlyComposing)) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !pending && draft.trim() !== '') {
            event.preventDefault()
            onResend()
          }
        }}
      />
      {failure !== null && <p className={css.failure} role="alert">{failure}</p>}
      <div className={css.buttons}>
        <button type="button" className={css.secondary} disabled={pending} onClick={onCancel}>
          {t('message.edit.cancel')}
        </button>
        <button
          type="button"
          className={css.primary}
          disabled={pending || draft.trim() === ''}
          onClick={onResend}
        >
          {pending ? t('message.edit.resending') : t('message.edit.resend')}
        </button>
      </div>
    </div>
  )
}
