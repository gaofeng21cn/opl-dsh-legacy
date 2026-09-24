import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopAppApi, type DshDesktopStartupApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

/** Deliver one IPC event to the handler this preload registered for a channel. */
function emit(channel: string, ...args: readonly unknown[]): void {
  for (const call of electron.ipcRenderer.on.mock.calls) {
    if (call[0] === channel) (call[1] as (...values: readonly unknown[]) => void)({}, ...args)
  }
}

it('exposes the task-event bridge to the application document alone', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopAppApi
  expect(Object.keys(api).sort()).toEqual(['notifications', 'protocolVersion'])
  expect(api).not.toHaveProperty('plugins')
  expect(api).not.toHaveProperty('preferences')
  expect(api).not.toHaveProperty('backend')
})

it('keeps the carrier marker away from every other document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://shell/startup.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopStartupApi
  expect(api.protocolVersion).toBe(1)
  expect(api).not.toHaveProperty('notifications')
})

it('provides startup controls and a removable state subscription to shell documents', async () => {
  vi.stubGlobal('location', new URL('dsh-app://shell/startup.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopStartupApi
  await api.locale()
  await api.backend.status()
  await api.disablePlugins()
  await api.resetConfiguration()
  await api.restart()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.localeGet], [DESKTOP_IPC.backendStatus],
    [DESKTOP_IPC.pluginsDisableAll], [DESKTOP_IPC.configurationReset], [DESKTOP_IPC.applicationRestart],
  ])
  const listener = vi.fn()
  const dispose = api.backend.subscribe(listener)
  emit(DESKTOP_IPC.backendState, { phase: 'error', message: 'startup failed' })
  expect(listener).toHaveBeenCalledWith({ phase: 'error', message: 'startup failed' })
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(
    DESKTOP_IPC.backendState,
    expect.any(Function),
  )
  expect(api).not.toHaveProperty('plugins')
  expect(api).not.toHaveProperty('preferences')
})

it('lets the application document report task events and follow notification clicks', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopAppApi
  expect(api.protocolVersion).toBe(1)
  expect(Object.keys(api)).toEqual(['protocolVersion', 'notifications'])

  const report = { id: 'run-1', kind: 'finished', sessionId: 'session-1', title: 'Release notes' } as const
  await api.notifications.report(report)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.notificationsReport, report)

  const first = vi.fn()
  const second = vi.fn()
  const disposeFirst = api.notifications.onActivate(first)
  emit(DESKTOP_IPC.notificationsActivate, 'session-1')
  expect(first).toHaveBeenCalledWith('session-1')
  expect(second).not.toHaveBeenCalled()
  disposeFirst()

  const disposeSecond = api.notifications.onActivate(second)
  emit(DESKTOP_IPC.notificationsActivate, 'session-2')
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledWith('session-2')
  // A click the shell cannot attribute is ignored rather than delivered as an
  // unusable session identity.
  emit(DESKTOP_IPC.notificationsActivate, 42)
  expect(second).toHaveBeenCalledTimes(1)
  disposeSecond()
})

it('holds a click that arrives before the application document subscribes', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopAppApi

  emit(DESKTOP_IPC.notificationsActivate, 'session-early')
  const listener = vi.fn()
  api.notifications.onActivate(listener)
  expect(listener).toHaveBeenCalledWith('session-early')

  // Delivering the held click consumes it, so a later reload cannot reopen a
  // session the user already saw.
  const next = vi.fn()
  api.notifications.onActivate(next)
  expect(next).not.toHaveBeenCalled()
})

it('synchronizes initial and changed document language without exposing new APIs', async () => {
  const listeners = new Map<string, () => void>()
  const root = { lang: 'zh-CN' }
  const disconnect = vi.fn()
  const observe = vi.fn()
  let changed!: () => void
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  vi.stubGlobal('document', { documentElement: root })
  vi.stubGlobal('window', { addEventListener: (name: string, listener: () => void) => { listeners.set(name, listener) } })
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { changed = callback }
    observe = observe
    disconnect = disconnect
  })
  electron.ipcRenderer.invoke.mockResolvedValue(undefined)
  await import('../src/preload-app.ts')
  listeners.get('DOMContentLoaded')?.()
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(DESKTOP_IPC.localeSet, 'zh-CN')
  expect(observe).toHaveBeenCalledWith(root, { attributes: true, attributeFilter: ['lang'] })
  root.lang = 'en'
  changed()
  changed()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([[DESKTOP_IPC.localeSet, 'zh-CN'], [DESKTOP_IPC.localeSet, 'en']])
  listeners.get('pagehide')?.()
  expect(disconnect).toHaveBeenCalledOnce()
})
