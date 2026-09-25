/** Copy shared by the Codex settings page. */
export const en = {
  nav: 'Codex collaboration',
  intro: 'Install the coordination skill into local Codex. Codex can then start DSH and delegate work to its sessions.',
  directory: 'Skill directory',
  missing: 'Not installed',
  current: 'Installed and up to date',
  update: 'Update available',
  modified: 'Skill files were modified. Back up your changes and move the existing directory before reinstalling.',
  unmanaged: 'This directory is not managed by OPL DSH, or contains unsupported files. Move it after reviewing its contents before installing.',
  unavailable: 'Bundled skill resources are unavailable. Use an OPL DSH desktop distribution.',
  autoStart: 'Automatically start DSH when Codex dispatches work',
  autoStartHint: 'When disabled, open DSH before using the skill. This does not configure startup at login.',
  install: 'Install skill',
  save: 'Update skill and save settings',
  refresh: 'Check status',
  busy: 'Working…',
  saved: 'Saved. Open a new Codex task to load the skill; if it is still missing, restart Codex.',
  failure: 'The operation failed. Check directory permissions and available disk space, then check the status again.',
  loading: 'Reading installation status…',
  limits: 'The skill runs on this computer and requires Node.js. It uses the current Codex task ID. Automatic background notifications require a separately configured wake bridge.',
} as const

/** Keys shared by the English and Chinese Codex settings dictionaries. */
export type CodexLocaleKey = keyof typeof en

/** Chinese copy for Codex coordination settings. */
export const zh: Record<CodexLocaleKey, string> = {
  nav: 'Codex 协作',
  intro: '将协作 Skill 安装到本机 Codex。之后 Codex 可以启动 DSH，并将工作交给 DSH 会话执行。',
  directory: 'Skill 安装目录',
  missing: '尚未安装',
  current: '已安装，内容为当前版本',
  update: '有可用更新',
  modified: 'Skill 文件已被修改。请先备份改动并移走现有目录，再重新安装。',
  unmanaged: '现有目录不由 OPL DSH 管理，或包含不支持的文件。请检查内容并移走该目录后再安装。',
  unavailable: '应用内的 Skill 资源不可用，请使用 OPL DSH 桌面发行版。',
  autoStart: 'Codex 分派任务时自动启动 DSH',
  autoStartHint: '关闭后，需要先打开 DSH 才能使用 Skill。此选项不会设置开机启动。',
  install: '安装 Skill',
  save: '更新 Skill 并保存设置',
  refresh: '检查状态',
  busy: '正在处理…',
  saved: '已保存。请新建 Codex 任务以加载 Skill；若仍未出现，请重启 Codex。',
  failure: '操作失败。请检查目录权限和可用磁盘空间，然后重新检查状态。',
  loading: '正在读取安装状态…',
  limits: 'Skill 在本机运行，需要 Node.js，并使用当前 Codex 任务 ID。后台自动通知需要另行配置唤醒桥接。',
}
