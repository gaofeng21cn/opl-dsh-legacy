/** Native menus that keep standard text editing available in every Desktop window. */

import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import { en, type DesktopMessages } from './locale.ts'

/**
 * Roles resolved to the platform editing commands.
 *
 * A packaged Desktop application replaces Electron's default menu with its own template. macOS
 * delivers the standard editing accelerators through the application menu, so a template without
 * an Edit menu leaves Cmd+C, Cmd+V, Cmd+X, Cmd+A, and Cmd+Z unhandled and the renderer receives
 * no paste or copy command. The `editMenu` role restores exactly those platform-provided entries.
 */
export const DESKTOP_EDIT_MENU_ROLE = 'editMenu'

/**
 * Build the application menu from the Desktop-owned entries plus the platform editing menu.
 * @param applicationLabel - Label of the first menu, the application menu on macOS.
 * @param submenu - Desktop-owned entries placed in the first menu.
 * @param messages - Labels in the current application language.
 * @returns A menu template covering the application entries and standard text editing.
 */
export function desktopApplicationMenuTemplate(
  applicationLabel: string,
  submenu: readonly MenuItemConstructorOptions[],
  messages: DesktopMessages = en,
): MenuItemConstructorOptions[] {
  return [
    { label: applicationLabel, submenu: [...submenu] },
    { role: DESKTOP_EDIT_MENU_ROLE, label: messages.editMenu, submenu: [
      { role: 'undo', label: messages.undo },
      { role: 'redo', label: messages.redo },
      { type: 'separator' },
      { role: 'cut', label: messages.cut },
      { role: 'copy', label: messages.copy },
      { role: 'paste', label: messages.paste },
      { role: 'pasteAndMatchStyle', label: messages.pasteAndMatchStyle },
      { type: 'separator' },
      { role: 'selectAll', label: messages.selectAll },
    ] },
  ]
}

/**
 * Build the context menu for one right-click target.
 * @param params - Context menu parameters reported by the window's web contents.
 * @param messages - Labels in the current application language.
 * @returns Editing entries for an editable field or selected text, or an empty list.
 */
export function desktopContextMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'editFlags'>,
  messages: DesktopMessages = en,
): MenuItemConstructorOptions[] {
  const { editFlags } = params
  if (params.isEditable) {
    return [
      { role: 'undo', label: messages.undo, enabled: editFlags.canUndo },
      { role: 'redo', label: messages.redo, enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: messages.cut, enabled: editFlags.canCut },
      { role: 'copy', label: messages.copy, enabled: editFlags.canCopy },
      { role: 'paste', label: messages.paste, enabled: editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: messages.pasteAndMatchStyle },
      { type: 'separator' },
      { role: 'selectAll', label: messages.selectAll, enabled: editFlags.canSelectAll },
    ]
  }
  if (!editFlags.canCopy) return []
  return [
    { role: 'copy', label: messages.copy },
    { role: 'selectAll', label: messages.selectAll, enabled: editFlags.canSelectAll },
  ]
}

/**
 * Give one window the Desktop context menu.
 * @param window - Window whose web contents own the right-click target.
 * @param getMessages - Reads the current language when the context menu opens.
 */
export function installDesktopContextMenu(window: BrowserWindow, getMessages: () => DesktopMessages = () => en): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = desktopContextMenuTemplate(params, getMessages())
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window })
  })
}
