import { describe, expect, it, vi } from 'vitest'
import { en, zh } from '../src/locale.ts'
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

const menus = await vi.hoisted(() => ({ popup: vi.fn(), templates: [] as unknown[] }))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => {
      menus.templates.push(template)
      return { popup: menus.popup }
    },
  },
}))

const { desktopApplicationMenuTemplate, desktopContextMenuTemplate, installDesktopContextMenu } =
  await import('../src/menus.ts')

function editFlags(overrides: Partial<ContextMenuParams['editFlags']> = {}): ContextMenuParams['editFlags'] {
  return {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
    ...overrides,
  }
}

function roles(template: readonly MenuItemConstructorOptions[]): string[] {
  return template.flatMap(entry => (typeof entry.role === 'string' ? [entry.role] : []))
}

describe('desktop application menu', () => {
  it('keeps the platform editing menu beside the Desktop entries', () => {
    const template = desktopApplicationMenuTemplate('DeepSeek Harness', [
      { label: 'Desktop Plugins…' },
      { role: 'quit' },
    ])
    expect(template[0]).toMatchObject({ label: 'DeepSeek Harness' })
    expect(template[0]?.submenu).toHaveLength(2)
    // The editMenu role is what keeps Cmd+C, Cmd+V, Cmd+X, Cmd+A, and Cmd+Z dispatched.
    expect(roles(template)).toEqual(['editMenu'])
  })
})

describe('desktop context menu', () => {
  it('offers the full editing set for one editable field', () => {
    const template = desktopContextMenuTemplate({
      isEditable: true,
      editFlags: editFlags({ canUndo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }),
    })
    expect(roles(template)).toEqual([
      'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll',
    ])
    const byRole = new Map(template.map(entry => [entry.role, entry]))
    expect(byRole.get('undo')?.enabled).toBe(true)
    expect(byRole.get('redo')?.enabled).toBe(false)
    expect(byRole.get('paste')?.enabled).toBe(true)
  })

  it('offers copying for selected non-editable text', () => {
    const template = desktopContextMenuTemplate({
      isEditable: false,
      editFlags: editFlags({ canCopy: true, canSelectAll: true }),
    })
    expect(roles(template)).toEqual(['copy', 'selectAll'])
  })

  it('stays silent without an editable target or a selection', () => {
    expect(desktopContextMenuTemplate({ isEditable: false, editFlags: editFlags() })).toEqual([])
  })
})

describe('desktop context menu installation', () => {
  it('pops the template built from the reported target', () => {
    const listeners: ((event: unknown, params: unknown) => void)[] = []
    const window = {
      webContents: {
        on: (_event: string, listener: (event: unknown, params: unknown) => void) => {
          listeners.push(listener)
        },
      },
    }
    installDesktopContextMenu(window as never)
    expect(listeners).toHaveLength(1)
    menus.templates.length = 0
    listeners[0]?.({}, { isEditable: true, editFlags: editFlags({ canPaste: true }) })
    expect(menus.templates).toHaveLength(1)
    expect(menus.popup).toHaveBeenCalledWith({ window })
    menus.popup.mockClear()
    menus.templates.length = 0
    listeners[0]?.({}, { isEditable: false, editFlags: editFlags() })
    expect(menus.templates).toEqual([])
    expect(menus.popup).not.toHaveBeenCalled()
  })
})


it('localizes native editing labels while preserving command roles', () => {
  for (const messages of [zh, en]) {
    const menu = desktopApplicationMenuTemplate(messages.application, [{ role: 'quit', label: messages.quit }], messages)
    expect(menu[1]?.label).toBe(messages.editMenu)
    const entries = menu[1]?.submenu as MenuItemConstructorOptions[]
    expect(entries.find(entry => entry.role === 'copy')?.label).toBe(messages.copy)
    expect(entries.find(entry => entry.role === 'selectAll')?.label).toBe(messages.selectAll)
    const context = desktopContextMenuTemplate({ isEditable: true, editFlags: editFlags() }, messages)
    expect(context.find(entry => entry.role === 'paste')?.label).toBe(messages.paste)
  }
})
