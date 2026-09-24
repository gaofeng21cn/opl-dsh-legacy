/**
 * The user-selected output language for model-authored prose.
 *
 * The system-prompt configuration carries the preference; the prompt registry renders it
 * as a single directive section. `default` adds no directive at all, so an
 * absent section and an explicit `default` both preserve the model's own
 * choice — the behavior of a deployment without this setting.
 *
 * The directive covers written output only. It states nothing about how the
 * model reasons internally, and nothing in this package reads or rewrites
 * reasoning content.
 *
 * @module @deepseek-ai/dsh-system-prompt/output-language
 */

import z from '@deepseek-ai/schemastery'

/** Loader entry whose configuration carries the output-language preference. */
export const OUTPUT_LANGUAGE_SETTINGS_NAMESPACE = 'system-prompt'

/** Selectable output languages; `default` renders no directive. */
export const OUTPUT_LANGUAGES = ['default', 'zh', 'en'] as const

/** One selectable output language. */
export type OutputLanguage = typeof OUTPUT_LANGUAGES[number]

/** Output language used when the user document overrides nothing. */
export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'default'

/** Standalone output-language preference value. */
export interface OutputLanguageSettings {
  /** Language for model-authored user-facing prose; `default` adds no directive. */
  language: OutputLanguage
}

/** Durable output-language schema; an absent section resolves to {@link DEFAULT_OUTPUT_LANGUAGE}. */
export const OutputLanguageSettingsSchema: z<OutputLanguageSettings> = z.object({
  language: z.union([...OUTPUT_LANGUAGES]).default(DEFAULT_OUTPUT_LANGUAGE),
})

/** The prompt section name this package registers for the preference. */
export const OUTPUT_LANGUAGE_SECTION = 'harness:output-language'

/** Directive for `zh`: user-facing prose is written in Simplified Chinese. */
const ZH_DIRECTIVE = 'Write your final replies, and every document, report, or documentation file you produce, '
  + 'in Simplified Chinese (简体中文). Keep code, identifiers, commands, file paths, and quoted source text '
  + 'in their original form. If the user explicitly requests a different language for a specific item, follow that request.'

/** Directive for `en`: user-facing prose is written in English. */
const EN_DIRECTIVE = 'Write your final replies, and every document, report, or documentation file you produce, '
  + 'in English. Keep code, identifiers, commands, file paths, and quoted source text in their original form. '
  + 'If the user explicitly requests a different language for a specific item, follow that request.'

/** The directive each language renders; the map's type keeps every language covered. */
const DIRECTIVES: Record<OutputLanguage, string> = {
  default: '',
  zh: ZH_DIRECTIVE,
  en: EN_DIRECTIVE,
}

/**
 * Render the model-facing directive for one language.
 * @param language - the resolved setting; `default` renders nothing.
 * @returns the directive text, or `''` when the model keeps its own language choice.
 */
export function outputLanguageDirective(language: OutputLanguage): string {
  return DIRECTIVES[language]
}
