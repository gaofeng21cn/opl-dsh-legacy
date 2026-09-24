import { describe, expect, it, vi } from 'vitest'
import { en, zh, type DesktopMessages } from '../src/locale.ts'

const electron = vi.hoisted(() => {
  const trayInstances: FakeTray[] = []
  class FakeTray {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    readonly handlers = new Map<string, () => void>()
    constructor(readonly image: unknown) {
      if (unavailable) throw new Error('no StatusNotifier host')
      trayInstances.push(this)
    }
    on(event: string, listener: () => void) { this.handlers.set(event, listener) }
  }
  let imageEmpty = false
  let unavailable = false
  return {
    trayInstances,
    FakeTray,
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => imageEmpty })) },
    Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template })) },
    setImageEmpty: (value: boolean) => { imageEmpty = value },
    setUnavailable: (value: boolean) => { unavailable = value },
  }
})

vi.mock('electron', () => ({
  Tray: electron.FakeTray,
  nativeImage: electron.nativeImage,
  Menu: electron.Menu,
}))

const { createDesktopTray, desktopTrayMenuTemplate } = await import('../src/tray.ts')

describe('desktop tray', () => {
  it('offers exactly the restore and exit entries', () => {
    const onOpen = vi.fn()
    const onExit = vi.fn()
    const template = desktopTrayMenuTemplate(en, onOpen, onExit)
    expect(template.map(entry => entry.label ?? entry.type)).toEqual(['Open DeepSeek Harness', 'separator', 'Exit'])

    const open = template[0] as { click?: () => void }
    const exit = template[2] as { click?: () => void }
    open.click?.()
    exit.click?.()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('localizes the tray menu', () => {
    const template = desktopTrayMenuTemplate(zh, vi.fn(), vi.fn())
    expect(template[0]?.label).toBe(zh.trayOpen)
    expect(template[2]?.label).toBe(zh.quit)
  })

  it('opens the window from a click on the icon', () => {
    electron.trayInstances.length = 0
    electron.setImageEmpty(false)
    const onOpen = vi.fn()
    const tray = createDesktopTray({
      iconPath: '/app/renderer/tray-icon.png',
      messages: () => en,
      onOpen,
      onExit: vi.fn(),
    })
    expect(tray).toBeDefined()
    const instance = electron.trayInstances[0]
    expect(electron.nativeImage.createFromPath).toHaveBeenCalledWith('/app/renderer/tray-icon.png')
    expect(instance?.setToolTip).toHaveBeenCalledWith(en.trayTooltip)
    instance?.handlers.get('click')?.()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('rebuilds the menu for a new language and disposes once', () => {
    electron.trayInstances.length = 0
    electron.setImageEmpty(false)
    let messages: DesktopMessages = en
    const tray = createDesktopTray({
      iconPath: '/app/renderer/tray-icon.png',
      messages: () => messages,
      onOpen: vi.fn(),
      onExit: vi.fn(),
    })
    const instance = electron.trayInstances[0]
    expect(instance?.setContextMenu).toHaveBeenCalledTimes(1)
    messages = zh
    tray?.refresh()
    expect(instance?.setContextMenu).toHaveBeenCalledTimes(2)
    expect(electron.Menu.buildFromTemplate).toHaveBeenLastCalledWith([
      expect.objectContaining({ label: zh.trayOpen }),
      expect.objectContaining({ type: 'separator' }),
      expect.objectContaining({ label: zh.quit }),
    ])
    tray?.dispose()
    expect(instance?.destroy).toHaveBeenCalledOnce()
  })

  it('answers no tray for a build without a usable icon', () => {
    electron.setImageEmpty(true)
    expect(createDesktopTray({
      iconPath: '/app/renderer/missing.png',
      messages: () => en,
      onOpen: vi.fn(),
      onExit: vi.fn(),
    })).toBeUndefined()
  })

  it('answers no tray when the platform refuses to create one', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    electron.trayInstances.length = 0
    electron.setImageEmpty(false)
    electron.setUnavailable(true)
    expect(createDesktopTray({
      iconPath: '/app/renderer/tray-icon.png',
      messages: () => en,
      onOpen: vi.fn(),
      onExit: vi.fn(),
    })).toBeUndefined()
    // The caller keeps the close prompt's exit answer when no icon was
    // installed, so the failure is reported rather than thrown out of startup.
    expect(logged).toHaveBeenCalledWith('desktop tray could not be created', expect.any(Error))
    electron.setUnavailable(false)
  })
})
