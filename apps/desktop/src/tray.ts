/**
 * Tray presence for the desktop application.
 *
 * The tray is what makes "keep running in the tray" a real state rather than a
 * hidden window with no way back: its menu restores the primary window and
 * stops the application, and its tooltip names the product. The icon is the
 * packaged product icon, so a build that changes the application icon changes
 * the tray with it.
 *
 * A missing icon returns no tray instead of an invisible one; the caller then
 * keeps the close prompt's exit behavior meaningful.
 *
 * @module dsh-desktop/tray
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { DesktopMessages } from './locale.ts'

/** Tray control the shell owns for the process lifetime. */
export interface DesktopTray {
  /** Rebuild the context menu after a language change. */
  refresh(): void
  /** Remove the icon; safe to call more than once. */
  dispose(): void
}

/** Inputs the tray needs from the shell. */
export interface DesktopTrayOptions {
  /** Absolute path of the tray icon shipped with this application. */
  readonly iconPath: string
  /** Reads the current language whenever the menu is built. */
  readonly messages: () => DesktopMessages
  /** Restore and focus the primary window. */
  readonly onOpen: () => void
  /** Stop the application through its normal quit path. */
  readonly onExit: () => void
}

/**
 * Build the tray context menu.
 * @param messages - labels in the current application language.
 * @param onOpen - restores and focuses the primary window.
 * @param onExit - stops the application.
 * @returns the menu template.
 */
export function desktopTrayMenuTemplate(
  messages: DesktopMessages,
  onOpen: () => void,
  onExit: () => void,
): MenuItemConstructorOptions[] {
  return [
    { label: messages.trayOpen, click: onOpen },
    { type: 'separator' },
    { label: messages.quit, click: onExit },
  ]
}

/**
 * Install the tray icon.
 * @param options - icon path, label source, and the two tray actions.
 * @returns the tray handle, or undefined when this build carries no usable icon.
 */
export function createDesktopTray(options: DesktopTrayOptions): DesktopTray | undefined {
  const image = nativeImage.createFromPath(options.iconPath)
  if (image.isEmpty()) return undefined
  let tray: Tray
  try {
    tray = new Tray(image)
  } catch (error: unknown) {
    // A session with no notification area (a Linux desktop without a
    // StatusNotifier host) cannot hold an icon. Answering no tray keeps the
    // close prompt's exit answer reachable instead of failing startup into the
    // emergency page over a decoration.
    console.error('desktop tray could not be created', error)
    return undefined
  }
  tray.setToolTip(options.messages().trayTooltip)
  const apply = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate(
      desktopTrayMenuTemplate(options.messages(), options.onOpen, options.onExit),
    ))
  }
  apply()
  // A left click on the icon is the ordinary way back to the window; the menu
  // owns the explicit entries.
  tray.on('click', options.onOpen)
  return {
    refresh: apply,
    dispose: () => { tray.destroy() },
  }
}
