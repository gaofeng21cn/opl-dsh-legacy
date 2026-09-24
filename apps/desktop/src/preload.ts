/** Context-isolated renderer bridge for desktop package and update operations. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  type DesktopShellPreferences,
  type DshDesktopApi,
  type DesktopUpdateState,
} from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'
const api: DshDesktopApi = {
  protocolVersion: 1,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as Promise<ReturnType<DshDesktopApi['locale']> extends Promise<infer T> ? T : never>,
  plugins: {
    list: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsList) as Promise<ReturnType<DshDesktopApi['plugins']['list']> extends Promise<infer T> ? T : never>,
    add: spec => ipcRenderer.invoke(DESKTOP_IPC.pluginsAdd, spec) as Promise<void>,
    remove: name => ipcRenderer.invoke(DESKTOP_IPC.pluginsRemove, name) as Promise<void>,
    toggle: (name, enabled) => ipcRenderer.invoke(DESKTOP_IPC.pluginsToggle, name, enabled) as Promise<void>,
    disableAll: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
    update: (name, version) => ipcRenderer.invoke(DESKTOP_IPC.pluginsUpdate, name, version) as Promise<void>,
  },
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopApi['backend']['status']>,
    retry: () => ipcRenderer.invoke(DESKTOP_IPC.backendRetry) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  updates: {
    check: () => ipcRenderer.invoke(DESKTOP_IPC.updatesCheck) as Promise<DesktopUpdateState>,
    install: () => ipcRenderer.invoke(DESKTOP_IPC.updatesInstall) as Promise<void>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesState, handle) }
    },
  },
  environment: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.environmentStatus) as ReturnType<DshDesktopApi['environment']['status']>,
    select: selection => ipcRenderer.invoke(DESKTOP_IPC.environmentSelect, selection) as ReturnType<DshDesktopApi['environment']['select']>,
  },
  preferences: {
    get: () => ipcRenderer.invoke(DESKTOP_IPC.preferencesGet) as Promise<DesktopShellPreferences>,
    set: update => ipcRenderer.invoke(DESKTOP_IPC.preferencesSet, update) as Promise<DesktopShellPreferences>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, value: DesktopShellPreferences): void => { listener(value) }
      ipcRenderer.on(DESKTOP_IPC.preferencesState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.preferencesState, handle) }
    },
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)
