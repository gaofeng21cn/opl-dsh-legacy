/** Origin-scoped boot, native directory selection, host paths of picked files, and update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_IPC, SCHEME, type DshDesktopProductApi, type DesktopUpdatePresentation, type DesktopEnvironmentState, type DesktopShellPreferences } from './ipc.ts'
import { PLATFORM_IPC } from './platform-ipc.ts'
import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'
import { installMandatoryUpdateOverlay } from './preload-mandatory-overlay.ts'
import { createDesktopBrowserBridge } from './preload-browser.ts'

let pendingActivation: string | undefined
const activationListeners = new Set<(sessionId: string) => void>()
const notifications: DshDesktopProductApi['notifications'] = {
  report: report => ipcRenderer.invoke(DESKTOP_IPC.notificationsReport, report) as Promise<void>,
  onActivate(listener) {
    activationListeners.add(listener)
    const waiting = pendingActivation
    if (waiting !== undefined) { pendingActivation = undefined; listener(waiting) }
    return () => { activationListeners.delete(listener) }
  },
}
if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  ipcRenderer.on(DESKTOP_IPC.notificationsActivate, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (activationListeners.size === 0) { pendingActivation = sessionId; return }
    for (const listener of [...activationListeners]) listener(sessionId)
  })
}

function createProductApi(): DshDesktopProductApi {
  return {
    protocolVersion: 1,
    notifications,
    environment: {
      status: () => ipcRenderer.invoke(DESKTOP_IPC.environmentStatus) as Promise<DesktopEnvironmentState>,
      select: selection => ipcRenderer.invoke(DESKTOP_IPC.environmentSelect, selection) as Promise<DesktopEnvironmentState>,
    },
    preferences: {
      get: () => ipcRenderer.invoke(DESKTOP_IPC.preferencesGet) as Promise<DesktopShellPreferences>,
      set: update => ipcRenderer.invoke(DESKTOP_IPC.preferencesSet, update) as Promise<DesktopShellPreferences>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, preferences: DesktopShellPreferences): void => { listener(preferences) }
        ipcRenderer.on(DESKTOP_IPC.preferencesState, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.preferencesState, handle) }
      },
    },
    browser: createDesktopBrowserBridge(),
    updates: {
      status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
      open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
        ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
      },
    },
  }
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  ipcRenderer.on(DESKTOP_IPC.enterWorkspace, () => {
    const body = document.body
    const previous = body.getAttribute('tabindex')
    body.tabIndex = -1
    body.focus({ preventScroll: true })
    if (previous === null) body.removeAttribute('tabindex')
    else body.setAttribute('tabindex', previous)
  })
  syncWindowsAppearance()
  if (process.platform === 'win32') installMandatoryUpdateOverlay()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  // The composer cites dropped, picked, and pasted files and folders that
  // have a real path as `@path` references instead of uploading them; a
  // File without one (pasted bytes) answers '' and uploads as before.
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor: (file: File) => webUtils.getPathForFile(file),
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
  contextBridge.exposeInMainWorld('dshPlatform', {
    open: (page: 'usage' | 'top-up', bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.open, page, bounds),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.bounds, bounds),
    close: () => ipcRenderer.invoke(PLATFORM_IPC.close),
  })
}

markDocumentPlatform()
syncWindowFullscreen()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? createProductApi() : { protocolVersion: 1 })

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
    read: () => ipcRenderer.invoke(DESKTOP_IPC.localeBootstrap),
    onChange: (locale: string) => { ipcRenderer.send(DESKTOP_IPC.localeChanged, locale) },
  })
}
