/**
 * The primary window's close prompt and the decision read from its answer.
 *
 * The prompt is the first close's only question: keep running in the tray, or
 * stop the application. The tray answer is the default and the escape answer
 * because hiding a window is recoverable and stopping the application is not.
 * The checkbox lets the user stop being asked, and the Desktop settings
 * surface changes that remembered answer afterwards.
 *
 * @module dsh-desktop/close-prompt
 */

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopMessages } from './locale.ts'

/** Keep-in-tray answer index inside {@link desktopClosePrompt}'s buttons. */
export const CLOSE_PROMPT_TRAY_ANSWER = 0

/** What the close prompt decided. */
export interface DesktopCloseDecision {
  /** `tray` hides the window and keeps the process; `exit` stops the application. */
  readonly action: 'tray' | 'exit'
  /** Whether the answer replaces the stored preference. */
  readonly remember: boolean
}

/**
 * Build the first-close prompt in the current application language.
 * @param messages - labels in the current application language.
 * @returns message box arguments asking what closing the window should do.
 */
export function desktopClosePrompt(messages: DesktopMessages): MessageBoxOptions {
  return {
    type: 'question',
    title: messages.closePromptTitle,
    message: messages.closePromptMessage,
    detail: messages.closePromptDetail,
    buttons: [messages.closePromptTray, messages.closePromptExit],
    defaultId: CLOSE_PROMPT_TRAY_ANSWER,
    cancelId: CLOSE_PROMPT_TRAY_ANSWER,
    noLink: true,
    checkboxLabel: messages.closePromptRemember,
    checkboxChecked: false,
  }
}

/**
 * Read the decision from one prompt answer.
 * @param result - message box response and checkbox state.
 * @returns the chosen action and whether it should be remembered.
 */
export function closeDecisionFromResult(
  result: Pick<MessageBoxReturnValue, 'response' | 'checkboxChecked'>,
): DesktopCloseDecision {
  return {
    action: result.response === CLOSE_PROMPT_TRAY_ANSWER ? 'tray' : 'exit',
    remember: result.checkboxChecked,
  }
}
