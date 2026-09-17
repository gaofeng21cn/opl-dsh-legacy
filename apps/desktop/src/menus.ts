/** Native menus that keep standard text editing available in every Desktop window. */

import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'

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
 * @returns A menu template covering the application entries and standard text editing.
 */
export function desktopApplicationMenuTemplate(
  applicationLabel: string,
  submenu: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return [
    { label: applicationLabel, submenu: [...submenu] },
    { role: DESKTOP_EDIT_MENU_ROLE },
  ]
}

/**
 * Build the context menu for one right-click target.
 * @param params - Context menu parameters reported by the window's web contents.
 * @returns Editing entries for an editable field or selected text, or an empty list.
 */
export function desktopContextMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'editFlags'>,
): MenuItemConstructorOptions[] {
  const { editFlags } = params
  if (params.isEditable) {
    return [
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { role: 'pasteAndMatchStyle' },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ]
  }
  if (!editFlags.canCopy) return []
  return [
    { role: 'copy' },
    { role: 'selectAll', enabled: editFlags.canSelectAll },
  ]
}

/**
 * Give one window the Desktop context menu.
 * @param window - Window whose web contents own the right-click target.
 */
export function installDesktopContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = desktopContextMenuTemplate(params)
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window })
  })
}
