import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopEnvironmentState } from '../src/ipc.ts'

/**
 * Load the plugin-management document with a scripted Desktop API.
 * @param overrides - API members this case replaces.
 * @returns the DOM and the member doubles.
 */
function loadManager(overrides: Record<string, unknown> = {}) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    environment: {
      status: async (): Promise<DesktopEnvironmentState> => ({
        current: 'windows-native', selected: 'windows-native', restartRequired: false, distributions: [],
      }),
      select: vi.fn(async () => ({
        current: 'windows-native', selected: 'windows-native', restartRequired: false, distributions: [],
      })),
    },
    preferences: {
      get: async () => ({ notificationsEnabled: true, closeBehavior: 'ask' as const }),
      set: vi.fn(async (update: { notificationsEnabled?: boolean; closeBehavior?: string }) => ({
        notificationsEnabled: update.notificationsEnabled ?? true,
        closeBehavior: (update.closeBehavior ?? 'ask') as 'ask' | 'tray' | 'exit',
      })),
      subscribe: vi.fn(() => () => {}),
    },
    ...overrides,
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  return { dom, api }
}

it('keeps disabled packages visible and offers recovery without a running backend', async () => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  let enabled = true
  let ready = false
  const disableAll = vi.fn(async () => { enabled = false; ready = true })
  const toggle = vi.fn(async (_name: string, active: boolean) => { enabled = active })
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    backend: { status: async () => ready ? { phase: 'ready' } : { phase: 'error', message: 'plugin requires Cordis ^2.0.0' }, retry: vi.fn() },
    plugins: { list: async () => [{ name: 'example-plugin', version: '1.0.0', enabled }], disableAll, toggle },
    environment: {
      status: async () => ({
        current: 'windows-native' as const, selected: 'windows-native' as const, restartRequired: false,
        distributions: [],
      }),
      select: vi.fn(),
    },
    preferences: {
      get: async () => ({ notificationsEnabled: true, closeBehavior: 'ask' as const }),
      set: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
    expect(document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(false)
    expect(document.querySelector('#startup-error')?.textContent).toBe('plugin requires Cordis ^2.0.0')
    document.querySelector<HTMLButtonElement>('#disable-all')?.click()
    await expect.poll(() => document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(true)
    expect(disableAll).toHaveBeenCalledOnce()
    expect(document.querySelector('#plugins li')?.textContent).toMatchInlineSnapshot('"example-plugin1.0.0 · DisabledEnableUpdateRemove"')
    document.querySelector<HTMLButtonElement>('#plugins li button')?.click()
    await expect.poll(() => toggle.mock.calls).toEqual([['example-plugin', true]])
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toBe('example-plugin1.0.0DisableUpdateRemove')
  } finally { dom.window.close() }
})

it('shows the in-use and next-launch environments and offers each usable distribution', async () => {
  const select = vi.fn(async () => ({
    current: 'windows-native' as const,
    selected: 'wsl2' as const,
    selectedDistro: 'Ubuntu',
    restartRequired: true,
    distributions: [
      { name: 'Ubuntu', isDefault: true, nodeVersion: 'v22.19.0' },
      { name: 'Legacy', isDefault: false, problem: 'not-wsl2' as const },
    ],
  }))
  const { dom } = loadManager({
    environment: {
      status: async () => ({
        current: 'windows-native' as const,
        selected: 'wsl2' as const,
        selectedDistro: 'Ubuntu',
        restartRequired: true,
        distributions: [
          { name: 'Ubuntu', isDefault: true, nodeVersion: 'v22.19.0' },
          { name: 'Legacy', isDefault: false, problem: 'not-wsl2' as const },
        ],
      }),
      select,
    },
  })
  try {
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#environment-current')?.textContent).toBe('Windows Native')
    expect(document.querySelector('#environment-selected')?.textContent).toBe('WSL2 — Ubuntu')
    // A saved switch must be presented as needing a restart, never as live.
    expect(document.querySelector<HTMLElement>('#environment-restart')?.hidden).toBe(false)
    const options = [...document.querySelectorAll<HTMLOptionElement>('#environment-distribution option')]
    expect(options.map(option => option.value)).toEqual(['', 'Ubuntu', 'Legacy'])
    // An unusable distribution is listed with its reason but cannot be chosen.
    expect(options[2]?.disabled).toBe(true)
    expect(options[2]?.textContent).toContain('not a WSL2 distribution')
    expect(options[1]?.selected).toBe(true)

    document.querySelector<HTMLButtonElement>('#environment-apply')?.click()
    await expect.poll(() => select.mock.calls).toEqual([[{ environment: 'wsl2', distro: 'Ubuntu' }]])
  } finally { dom.window.close() }
})

it('offers Windows Native when no distribution can host the Harness', async () => {
  const { dom } = loadManager({
    environment: {
      status: async () => ({
        current: 'windows-native' as const,
        selected: 'windows-native' as const,
        restartRequired: false,
        distributions: [{ name: 'Legacy', isDefault: true, problem: 'not-wsl2' as const }],
        unavailable: 'no-usable-distribution' as const,
      }),
      select: vi.fn(),
    },
  })
  try {
    const document = dom.window.document
    await expect.poll(() => document.querySelector<HTMLElement>('#environment-unavailable')?.hidden).toBe(false)
    expect(document.querySelector('#environment-unavailable')?.textContent)
      .toContain('Installed distributions cannot host the Harness')
    expect(document.querySelector('#environment-unavailable')?.textContent).toContain('Legacy: not a WSL2 distribution')
  } finally { dom.window.close() }
})

it('shows and changes the close behavior and the notification setting', async () => {
  const set = vi.fn(async (update: { notificationsEnabled?: boolean; closeBehavior?: string }) => ({
    notificationsEnabled: update.notificationsEnabled ?? true,
    closeBehavior: (update.closeBehavior ?? 'ask') as 'ask' | 'tray' | 'exit',
  }))
  const { dom } = loadManager({
    preferences: {
      get: async () => ({ notificationsEnabled: true, closeBehavior: 'tray' as const }),
      set,
      subscribe: vi.fn(() => () => {}),
    },
  })
  try {
    const document = dom.window.document
    const behavior = document.querySelector<HTMLSelectElement>('#close-behavior')
    const enabled = document.querySelector<HTMLInputElement>('#notifications-enabled')
    await expect.poll(() => behavior?.value).toBe('tray')
    // The prompt is offered as a choice again, so a remembered answer is never
    // a permanent decision.
    expect([...behavior?.options ?? []].map(option => option.value)).toEqual(['ask', 'tray', 'exit'])
    expect(enabled?.checked).toBe(true)

    if (behavior === null || enabled === null) throw new Error('settings controls missing')
    behavior.value = 'exit'
    behavior.dispatchEvent(new dom.window.Event('change'))
    await expect.poll(() => set.mock.calls).toEqual([[{ closeBehavior: 'exit' }]])
    await expect.poll(() => document.querySelector('#window-settings-status')?.textContent).toBe('Saved.')

    enabled.checked = false
    enabled.dispatchEvent(new dom.window.Event('change'))
    await expect.poll(() => set.mock.calls).toEqual([
      [{ closeBehavior: 'exit' }],
      [{ notificationsEnabled: false }],
    ])
  } finally { dom.window.close() }
})

it('keeps the stored choice when the shell rejects a settings change', async () => {
  const { dom } = loadManager({
    preferences: {
      get: async () => ({ notificationsEnabled: false, closeBehavior: 'ask' as const }),
      set: vi.fn(async () => { throw new Error('dsh desktop: unknown close behavior') }),
      subscribe: vi.fn(() => () => {}),
    },
  })
  try {
    const document = dom.window.document
    const behavior = document.querySelector<HTMLSelectElement>('#close-behavior')
    await expect.poll(() => behavior?.value).toBe('ask')
    if (behavior === null) throw new Error('settings control missing')
    behavior.value = 'tray'
    behavior.dispatchEvent(new dom.window.Event('change'))
    await expect.poll(() => document.querySelector('#window-settings-status')?.textContent)
      .toContain('dsh desktop: unknown close behavior')
    // The control follows the shell's stored value rather than the rejected one.
    await expect.poll(() => behavior.value).toBe('ask')
  } finally { dom.window.close() }
})
