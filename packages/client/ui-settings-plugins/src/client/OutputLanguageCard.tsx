/**
 * The output-language card: one fixed choice deciding the language of the
 * agent's written output. The language names stay in their own language in
 * both dictionaries — a reader looking for Chinese looks for 中文, not for the
 * current UI language's word for it.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsChoiceField, SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import { formLabels } from './locales.ts'
import { OUTPUT_LANGUAGE_FIELD, OUTPUT_LANGUAGE_VALUES } from './output-language-card-controller.ts'
import type { OutputLanguageCardFace, OutputLanguageValue } from './output-language-card-controller.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

/** Props the renderer binds for the output-language card. */
export type OutputLanguageCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<OutputLanguageCardFace>

/**
 * Render the output-language card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function OutputLanguageCard(props: OutputLanguageCardProps) {
  const { t } = props
  const state = props.useOutputLanguageCard(snapshot => snapshot)
  if (props.view === 'summary') return t('outputLanguageDescription')
  const labels: Record<OutputLanguageValue, string> = {
    default: t('outputLanguageDefault'),
    zh: t('outputLanguageChinese'),
    en: t('outputLanguageEnglish'),
  }
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsChoiceField
        id="plugin-config-output-language"
        label={t('outputLanguageLabel')}
        hint={t('outputLanguageHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('outputLanguageInvalid')}
        disabled={!state.writable}
        {...state.language}
        options={OUTPUT_LANGUAGE_VALUES.map(value => ({ value, label: labels[value] }))}
        onEdit={(text) => { props.edit(OUTPUT_LANGUAGE_FIELD, text) }}
        onReset={() => { props.resetField(OUTPUT_LANGUAGE_FIELD) }}
      />
    </SettingsForm>
  )
}
