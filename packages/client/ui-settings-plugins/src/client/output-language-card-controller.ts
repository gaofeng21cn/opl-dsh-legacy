/**
 * The output-language card's staged form over the `system-prompt.outputLanguage` configuration.
 *
 * One fixed-choice field: the Host schema accepts exactly these three values,
 * so the select offers exactly them and a save can never stage one the Host
 * would refuse. Choosing re-inherits nothing — `default` is itself a stored
 * value, so the reset control clears the user layer and the schema default
 * resolves back to `default`, which is what an untouched document already says.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsChoiceField,
  type SettingsFormActions, type SettingsFieldState, type SettingsFormShell, type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the output-language setting. Spelled here rather than imported:
 * a client package must not depend on a Host package.
 */
export const OUTPUT_LANGUAGE_NS = 'system-prompt'

/** The stored values the Host schema accepts, in display order. */
export const OUTPUT_LANGUAGE_VALUES = ['default', 'zh', 'en'] as const

/** One stored output-language value. */
export type OutputLanguageValue = typeof OUTPUT_LANGUAGE_VALUES[number]

/** The field this card edits inside the namespace section. */
export const OUTPUT_LANGUAGE_FIELD = 'outputLanguage'

/** The output-language section this card edits. */
export interface OutputLanguageSettings {
  /** Selected language; the Host's schema default makes an absent value `default`. */
  outputLanguage?: string
}

/** What the output-language card renders. */
export interface OutputLanguageCardState extends SettingsFormShell {
  /** The staged or stored language. */
  language: SettingsFieldState
}

/** The registration-side face the output-language card's slot entry injects. */
export interface OutputLanguageCardFace extends SettingsFormActions {
  hooks: {
    /** Card snapshot bound by the renderer as useOutputLanguageCard. */
    outputLanguageCard: SnapshotStore<OutputLanguageCardState>
  }
}

/** Bridges the `system-prompt` form onto the card. */
export class OutputLanguageCardController {
  private readonly form: SettingsFormModel<OutputLanguageSettings>
  private readonly store: SnapshotStore<OutputLanguageCardState>

  /**
   * @param scope - the bound settings scope for the `system-prompt` entry.
   */
  constructor(scope: SettingsFormScope<OutputLanguageSettings>) {
    this.form = new SettingsFormModel(scope, [settingsChoiceField(OUTPUT_LANGUAGE_FIELD, [...OUTPUT_LANGUAGE_VALUES])])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      language: this.form.field(OUTPUT_LANGUAGE_FIELD),
    }))
  }

  /** Release the shared form subscription. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): OutputLanguageCardFace {
    return { hooks: { outputLanguageCard: this.store }, ...this.form.actions() }
  }
}
