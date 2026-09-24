// @vitest-environment jsdom
/** Desktop preferences persist through the preload bridge and show its accepted state. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSettingsSection, type DesktopSettingsBridge, type DesktopSettingsSectionProps, type DesktopPreferences } from '../src/client/DesktopSettingsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function bridge() {
  const preferences = { notificationsEnabled: true, closeBehavior: 'ask' as const }
  const environment = {
    current: 'windows-native' as const, selected: 'windows-native' as const,
    restartRequired: false, distributions: [{ name: 'Ubuntu', isDefault: true, nodeVersion: '24.1.0' }],
  }
  const api = {
    preferences: {
      get: vi.fn(async () => preferences),
      set: vi.fn(async (update: Partial<DesktopPreferences>) => ({ ...preferences, ...update })),
      subscribe: vi.fn(() => vi.fn()),
    },
    environment: {
      status: vi.fn(async () => environment),
      select: vi.fn(async (selection: { environment: 'windows-native' | 'wsl2'; distro?: string }) => ({
        ...environment,
        selected: selection.environment,
        ...(selection.distro === undefined ? {} : { selectedDistro: selection.distro }),
        restartRequired: true,
      })),
    },
  }
  return api
}

function mount(desktop: DesktopSettingsBridge) {
  return render(<DesktopSettingsSection {...{ desktop, t: (key: keyof typeof en) => en[key] } as DesktopSettingsSectionProps} />)
}

describe('DesktopSettingsSection', () => {
  it('saves notification and close preferences through the desktop owner', async () => {
    const desktop = bridge()
    mount(desktop)
    await screen.findByLabelText(en.desktopNotifications)
    fireEvent.click(screen.getByLabelText(en.desktopNotifications))
    fireEvent.change(screen.getByLabelText(en.desktopCloseBehavior), { target: { value: 'tray' } })
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[0]!)
    await waitFor(() => { expect(desktop.preferences.set).toHaveBeenCalledWith({ notificationsEnabled: false, closeBehavior: 'tray' }) })
  })

  it('selects a usable WSL distribution and reports that a restart is required', async () => {
    const desktop = bridge()
    mount(desktop)
    await screen.findByLabelText(en.desktopEnvironment)
    fireEvent.change(screen.getByLabelText(en.desktopEnvironment), { target: { value: 'wsl2' } })
    expect(screen.getByLabelText(en.desktopDistribution)).toHaveProperty('value', 'Ubuntu')
    fireEvent.click(screen.getAllByRole('button', { name: en.save })[1]!)
    await screen.findByText(en.desktopRestart)
    expect(desktop.environment.select).toHaveBeenCalledWith({ environment: 'wsl2', distro: 'Ubuntu' })
  })

  it('shows failures and releases its desktop subscription when it leaves', async () => {
    const desktop = bridge()
    desktop.preferences.get.mockRejectedValue(new Error('unavailable'))
    const mounted = mount(desktop)
    await screen.findByRole('alert')
    expect(screen.getByText(en.desktopFailed)).toBeTruthy()
    mounted.unmount()
    expect(desktop.preferences.subscribe.mock.results[0]!.value).toHaveBeenCalledOnce()
  })
})
