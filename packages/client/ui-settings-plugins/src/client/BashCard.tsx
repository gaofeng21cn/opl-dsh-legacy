/** The shell plugin's card: which shell the agent runs, and the limits every command is bound by. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ChoiceField, RestartNotice, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { BashCardFace } from './bash-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the shell card. */
export type BashCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<BashCardFace>

/**
 * Render the shell card.
 *
 * The Agent shell choice is a load-time fact: the composition that mounts the
 * executor and the model-facing tool reads it before any session exists, so the
 * card states that a change applies on the next load. It only ever writes the
 * value — nothing here reloads or restarts anything.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function BashCard(props: BashCardProps) {
  const { t } = props
  const state = props.useBashCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="bashTitle"
      descriptionKey="bashDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ChoiceField
        id="plugin-config-bash-agent-shell"
        label={t('bashAgentShell')}
        hint={t('bashAgentShellHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidShellValue')}
        options={[
          { value: 'powershell', label: t('bashAgentShellPowershell') },
          { value: 'git-bash', label: t('bashAgentShellGitBash') },
        ]}
        disabled={disabled}
        {...state.agentShell}
        onEdit={(text) => { props.edit('agentShell', text) }}
        onReset={() => { props.resetField('agentShell') }}
      />
      <ValueField
        id="plugin-config-bash-git-path"
        label={t('bashGitBashPath')}
        hint={t('bashGitBashPathHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidShellValue')}
        disabled={disabled}
        {...state.gitBashPath}
        onEdit={(text) => { props.edit('gitBashPath', text) }}
        onReset={() => { props.resetField('gitBashPath') }}
      />
      <RestartNotice text={t('bashAgentShellRestart')} />
      <ValueField
        id="plugin-config-bash-timeout"
        label={t('bashTimeoutMs')}
        hint={t('bashTimeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <ValueField
        id="plugin-config-bash-output"
        label={t('bashMaxOutputBytes')}
        hint={t('bashMaxOutputBytesHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.maxOutputBytes}
        onEdit={(text) => { props.edit('maxOutputBytes', text) }}
        onReset={() => { props.resetField('maxOutputBytes') }}
      />
    </PluginCard>
  )
}
