/** The shell card's staged form over the `bash` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, choiceField, numberField, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/**
 * Namespace of the shell capability. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the executor families
 * that own it spell the same value.
 */
export const SHELL_NS = 'shell'

/**
 * Agent command shells a Windows Native host offers, in display order. Spelled
 * here for the same reason as {@link SHELL_NS}: the Host schema's union is the
 * authority, and the control offers exactly these values so a save can never
 * stage one the Host would reject.
 */
export const AGENT_SHELL_CHOICES = ['powershell', 'git-bash'] as const

/** The shell fields this card edits — a subset of the served schema by design. */
export interface BashSettings {
  /** Foreground command timeout in milliseconds. */
  timeoutMs?: number
  /** Per-stream in-memory output cap in bytes. */
  maxOutputBytes?: number
  /** Agent command shell on a Windows Native host; inert on a POSIX host. */
  agentShell?: string
  /** Explicit Git for Windows `bash.exe`; empty uses the well-known locations. */
  gitBashPath?: string
}

/** What the shell card renders. */
export interface BashCardState extends CardShell {
  /** Command timeout in milliseconds. */
  timeoutMs: CardFieldState
  /** Per-stream output cap in bytes. */
  maxOutputBytes: CardFieldState
  /** Agent command shell selection. */
  agentShell: CardFieldState
  /** Git for Windows executable the user pinned, if any. */
  gitBashPath: CardFieldState
}

/** The registration-side face the shell card's slot entry injects. */
export interface BashCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useBashCard. */
    bashCard: SnapshotStore<BashCardState>
  }
}

/** Bridges the `bash` scope onto the shell card's staged form. */
export class BashCardController {
  private readonly form: CardForm<BashSettings>
  private readonly store: SnapshotStore<BashCardState>

  /** @param scope - the bound settings scope for the `bash` namespace. */
  constructor(scope: SettingsScope<BashSettings>) {
    this.form = new CardForm(scope, [
      numberField('timeoutMs'),
      numberField('maxOutputBytes'),
      choiceField('agentShell', AGENT_SHELL_CHOICES),
      // The path stays free text: the Host resolves and identifies the
      // executable, and its validator is what refuses one that is not Git for
      // Windows, so the card must not narrow the draft to a fixed list.
      textField('gitBashPath'),
    ], [], true)
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): BashCardState {
    return {
      ...this.form.shell(),
      timeoutMs: this.form.field('timeoutMs'),
      maxOutputBytes: this.form.field('maxOutputBytes'),
      agentShell: this.form.field('agentShell'),
      gitBashPath: this.form.field('gitBashPath'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): BashCardFace {
    return { hooks: { bashCard: this.store }, ...this.form.actions() }
  }
}
