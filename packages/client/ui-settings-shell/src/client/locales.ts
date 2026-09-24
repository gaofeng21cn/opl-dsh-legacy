/** Locale bundles for the shell executor's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type ShellSettingsLocaleKey =
  | 'title' | 'description'
  | 'bashAgentShell' | 'bashAgentShellHint' | 'bashAgentShellPowershell' | 'bashAgentShellGitBash' | 'bashGitBashPath' | 'bashGitBashPathHint' | 'bashAgentShellRestart' | 'invalidShellValue'
  | 'timeoutMs' | 'timeoutMsHint' | 'maxOutputBytes' | 'maxOutputBytesHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<ShellSettingsLocaleKey, string> = {
  invalidShellValue: 'Choose a supported shell or enter an executable path.',
  bashAgentShell: 'Agent shell',
  bashAgentShellHint: 'The shell the agent runs commands in on Windows Native. Other platforms always use bash. Git for Windows must be installed for the Git Bash choice; PowerShell is the default. On Windows, Git Bash currently requires full access; use PowerShell for read-only or workspace-write. Selecting Git Bash never changes permissions.',
  bashAgentShellPowershell: 'PowerShell',
  bashAgentShellGitBash: 'Git Bash',
  bashGitBashPath: 'Git Bash path',
  bashGitBashPathHint: 'Full path to Git for Windows bash.exe. Leave blank to use the standard Git for Windows locations.',
  bashAgentShellRestart: 'Save, then fully quit and restart the app to apply the shell and executable path. Command limits apply immediately.',
  title: 'Shell',
  description: 'Limit how long each command may run and how much it may output.',
  timeoutMs: 'Command timeout (ms)',
  timeoutMsHint: 'How long one command may run before it is terminated.',
  maxOutputBytes: 'Output cap per stream (bytes)',
  maxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ShellSettingsLocaleKey, string> = {
  invalidShellValue: '请选择支持的 shell，或填写可执行文件路径。',
  bashAgentShell: 'Agent shell',
  bashAgentShellHint: 'Windows 本机环境下 Agent 执行命令所用的 shell；其他平台固定使用 bash。选择 Git Bash 需要本机已安装 Git for Windows；默认保持 PowerShell。Git Bash 目前仅支持完全访问；只读或工作区内修改请使用 PowerShell。切换 shell 不会改变权限。',
  bashAgentShellPowershell: 'PowerShell',
  bashAgentShellGitBash: 'Git Bash',
  bashGitBashPath: 'Git Bash 路径',
  bashGitBashPathHint: 'Git for Windows 的 bash.exe 完整路径。留空表示使用 Git for Windows 的默认安装位置。',
  bashAgentShellRestart: '保存后请完全退出并重新启动应用，shell 和路径才会生效。命令时限等设置立即生效。',
  title: '终端',
  description: '限制每条命令最多能跑多久、最多输出多少内容。',
  timeoutMs: '命令超时（毫秒）',
  timeoutMsHint: '单条命令允许运行多久，超时即终止。',
  maxOutputBytes: '单流输出上限（字节）',
  maxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: ShellSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
