/** Locale bundles for the built-in plugins settings section. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the section renders. */
export type PluginsSettingsLocaleKey = 'desktopTitle' | 'desktopDescription' | 'desktopFailed' | 'desktopLoading' | 'desktopPreferences' | 'desktopNotifications' | 'desktopCloseBehavior' | 'desktopCloseAsk' | 'desktopCloseTray' | 'desktopCloseExit' | 'desktopEnvironment' | 'desktopEnvironmentHint' | 'desktopNative' | 'desktopWsl' | 'desktopDistribution' | 'desktopWslUnavailable' | 'desktopRestart'
  | 'nav' | 'title' | 'intro' | 'tabs' | 'empty' | 'unavailable'
  | 'overridden' | 'reset' | 'readOnly' | 'save' | 'saving' | 'saveFailed' | 'outputLanguageTitle' | 'outputLanguageDescription' | 'outputLanguageLabel' | 'outputLanguageHint' | 'outputLanguageDefault' | 'outputLanguageChinese' | 'outputLanguageEnglish' | 'outputLanguageInvalid'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  desktopTitle: 'Desktop',
  desktopDescription: 'Configure notifications, window closing, and the Windows execution environment.',
  desktopFailed: 'The desktop could not apply or read these settings. Try again.',
  desktopLoading: 'Loading desktop settings…',
  desktopPreferences: 'Desktop preferences',
  desktopNotifications: 'Notify when a task finishes, fails, or needs attention',
  desktopCloseBehavior: 'When closing the window',
  desktopCloseAsk: 'Ask each time',
  desktopCloseTray: 'Keep running in the tray',
  desktopCloseExit: 'Quit the application',
  desktopEnvironment: 'Execution environment',
  desktopEnvironmentHint: 'Saved environment changes apply after fully quitting and restarting the app.',
  desktopNative: 'Windows Native',
  desktopWsl: 'WSL2',
  desktopDistribution: 'WSL2 distribution',
  desktopWslUnavailable: 'No usable WSL2 distribution was detected. Check that WSL2, Node.js, and the DSH host are installed.',
  desktopRestart: 'Restart the application to use the saved environment.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  outputLanguageTitle: 'Output language',
  outputLanguageDescription: 'The language of the agent\'s replies and generated documents.',
  outputLanguageLabel: 'Output language',
  outputLanguageHint: 'Sets the language of the agent\'s replies and of the documents and reports it generates, starting with the next request. Code, paths, and quoted source stay as they are; the model\'s internal reasoning is not changed.',
  outputLanguageDefault: 'Default',
  outputLanguageChinese: '中文',
  outputLanguageEnglish: 'English',
  outputLanguageInvalid: 'Choose one of the offered languages.',
  nav: 'Built-in plugins',
  title: 'Built-in plugins',
  intro: 'Inspect the plugins this deployment ships.',
  tabs: 'Plugin views',
  empty: 'This deployment exposes no plugin views.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  desktopTitle: '桌面',
  desktopDescription: '设置通知、关闭窗口的行为和 Windows 执行环境。',
  desktopFailed: '桌面应用未能读取或应用设置，请重试。',
  desktopLoading: '正在读取桌面设置…',
  desktopPreferences: '桌面偏好',
  desktopNotifications: '任务完成、失败或需要处理时通知',
  desktopCloseBehavior: '关闭窗口时',
  desktopCloseAsk: '每次询问',
  desktopCloseTray: '继续在托盘运行',
  desktopCloseExit: '退出应用',
  desktopEnvironment: '执行环境',
  desktopEnvironmentHint: '保存后完全退出并重新启动应用，执行环境才会切换。',
  desktopNative: 'Windows 本机',
  desktopWsl: 'WSL2',
  desktopDistribution: 'WSL2 发行版',
  desktopWslUnavailable: '未检测到可用的 WSL2 发行版，请检查 WSL2、Node.js 和 DSH Host 是否已安装。',
  desktopRestart: '重新启动应用后将使用已保存的执行环境。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  outputLanguageTitle: '输出语言',
  outputLanguageDescription: 'Agent 回复与生成文档所用的语言。',
  outputLanguageLabel: '输出语言',
  outputLanguageHint: '决定 Agent 回复以及它生成的文档、报告使用哪种语言，从下一次请求生效。代码、路径与引用原文保持原样；不改变模型内部的思考语言。',
  outputLanguageDefault: '默认',
  outputLanguageChinese: '中文',
  outputLanguageEnglish: 'English',
  outputLanguageInvalid: '请选择提供的语言之一。',
  nav: '内置插件',
  title: '内置插件',
  intro: '查看内置部署的插件列表',
  tabs: '插件视图',
  empty: '本部署没有开放任何插件视图。',
}

/**
 * Build localized chrome for the shared settings form.
 * @param t - this package's locale reader.
 * @returns the form labels.
 */
export function formLabels(t: (key: PluginsSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
