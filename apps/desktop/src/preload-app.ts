/**
 * Startup controls for shell documents, and the task-event bridge the
 * application document uses to reach the desktop shell's notifications.
 *
 * The app bridge stays deliberately narrow: an application document reports a
 * task event and subscribes to notification clicks. It receives no filesystem
 * access, no raw IPC, and no shell management API.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  type DshDesktopAppApi,
  type DshDesktopStartupApi,
} from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'

const startup: DshDesktopStartupApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopStartupApi['locale']>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopStartupApi['backend']['status']>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

/**
 * Clicks that arrive before the application document registers its listener.
 *
 * The shell may push a click while the window still shows the startup page, so
 * the newest identity waits here and is handed to the first listener that
 * arrives. Delivering it consumes it, which is what stops a later reload from
 * reopening a session the user already saw.
 */
let pendingActivation: string | undefined
const activationListeners = new Set<(sessionId: string) => void>()

ipcRenderer.on(DESKTOP_IPC.notificationsActivate, (_event, sessionId: unknown) => {
  if (typeof sessionId !== 'string' || sessionId === '') return
  const listeners = [...activationListeners]
  if (listeners.length === 0) {
    pendingActivation = sessionId
    return
  }
  for (const listener of listeners) listener(sessionId)
})

const notifications: DshDesktopAppApi['notifications'] = {
  report: report => ipcRenderer.invoke(DESKTOP_IPC.notificationsReport, report) as Promise<void>,
  onActivate(listener) {
    activationListeners.add(listener)
    const waiting = pendingActivation
    if (waiting !== undefined) {
      pendingActivation = undefined
      listener(waiting)
    }
    return () => { activationListeners.delete(listener) }
  },
}

const appBridge: DshDesktopAppApi = { protocolVersion: 1, notifications }

contextBridge.exposeInMainWorld(
  'dshDesktop',
  location.protocol === 'dsh-app:' && location.hostname === 'shell' ? startup : appBridge,
)

// The client owns the language setting and publishes its resolved value on <html>.
// Keep this bridge private: the application receives no shell management API.
if (location.protocol === 'dsh-app:' && location.hostname === 'app') {
  window.addEventListener('DOMContentLoaded', () => {
    let previous = ''
    const sync = (): void => {
      const language = document.documentElement.lang
      if (!language || language === previous) return
      previous = language
      void ipcRenderer.invoke(DESKTOP_IPC.localeSet, language).catch((error: unknown) => {
        console.error('Desktop menu language synchronization failed', error)
      })
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    window.addEventListener('pagehide', () => { observer.disconnect() }, { once: true })
    sync()
  }, { once: true })
}
