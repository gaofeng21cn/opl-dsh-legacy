/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord } from './project-manager.ts'
import type { DesktopLocale } from './locale.ts'
import type { DesktopBackendState } from './backend-controller.ts'
import type { DesktopCloseBehavior } from './desktop-preferences.ts'
import type { DesktopNotificationReport } from './notifications.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeSet: 'dsh-desktop:locale-set',
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  pluginsToggle: 'dsh-desktop:plugins-toggle',
  pluginsDisableAll: 'dsh-desktop:plugins-disable-all',
  backendStatus: 'dsh-desktop:backend-status',
  backendRetry: 'dsh-desktop:backend-retry',
  applicationRestart: 'dsh-desktop:application-restart',
  configurationReset: 'dsh-desktop:configuration-reset',
  backendState: 'dsh-desktop:backend-state',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
  environmentStatus: 'dsh-desktop:environment-status',
  environmentSelect: 'dsh-desktop:environment-select',
  preferencesGet: 'dsh-desktop:preferences-get',
  preferencesSet: 'dsh-desktop:preferences-set',
  preferencesState: 'dsh-desktop:preferences-state',
  notificationsReport: 'dsh-desktop:notifications-report',
  notificationsActivate: 'dsh-desktop:notifications-activate',
} as const

/** Desktop shell preferences as the settings surface reads them. */
export interface DesktopShellPreferences {
  readonly notificationsEnabled: boolean
  readonly closeBehavior: DesktopCloseBehavior
}

/** Partial preference change requested by the settings surface. */
export interface DesktopShellPreferencesUpdate {
  readonly notificationsEnabled?: boolean
  readonly closeBehavior?: DesktopCloseBehavior
}

/** Notification reporting exposed to the application renderer. */
export interface DshDesktopNotificationApi {
  /** Report one task event; the shell decides whether it becomes a notification. */
  report(report: DesktopNotificationReport): Promise<void>
  /**
   * Subscribe to notification clicks.
   * @param listener - receives the session a clicked notification named.
   * @returns the unsubscribe function.
   */
  onActivate(listener: (sessionId: string) => void): () => void
}

/** Narrow bridge exposed to backend-provided application documents. */
export interface DshDesktopAppApi {
  readonly protocolVersion: 1
  readonly notifications: DshDesktopNotificationApi
}

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
}

/** One installed WSL2 distribution offered by the environment settings. */
export interface DesktopWslDistribution {
  readonly name: string
  readonly isDefault: boolean
  /** Linux Node.js version, absent when the distribution cannot host the Host. */
  readonly nodeVersion?: string
  /** Stable reason the distribution cannot host the Host, absent when it can. */
  readonly problem?: 'not-wsl2' | 'unreachable' | 'node-missing' | 'node-too-old' | 'host-missing'
}

/** Current execution environment, as the settings surface presents it. */
export interface DesktopEnvironmentState {
  /** Environment the running Desktop is currently using. */
  readonly current: 'windows-native' | 'wsl2'
  /** Distribution the running Desktop uses, when it uses WSL2. */
  readonly currentDistro?: string
  /** Environment the next launch will use. */
  readonly selected: 'windows-native' | 'wsl2'
  /** Distribution the next launch will use, when it uses WSL2. */
  readonly selectedDistro?: string
  /**
   * Whether the running and selected environments differ, which means the
   * change needs a restart before it takes effect.
   */
  readonly restartRequired: boolean
  /** Installed distributions, empty when WSL2 is unavailable. */
  readonly distributions: readonly DesktopWslDistribution[]
  /** Why the environment surface cannot offer WSL2, when it cannot. */
  readonly unavailable?: 'not-windows' | 'not-installed' | 'no-usable-distribution'
}

/** One environment selection request from the settings surface. */
export interface DesktopEnvironmentSelection {
  readonly environment: 'windows-native' | 'wsl2'
  readonly distro?: string
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 1
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
    toggle(name: string, enabled: boolean): Promise<void>
    disableAll(): Promise<void>
  }
  readonly backend: {
    status(): Promise<DesktopBackendState>
    retry(): Promise<void>
    subscribe(listener: (state: DesktopBackendState) => void): () => void
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
  readonly environment: {
    status(): Promise<DesktopEnvironmentState>
    select(selection: DesktopEnvironmentSelection): Promise<DesktopEnvironmentState>
  }
  readonly preferences: {
    get(): Promise<DesktopShellPreferences>
    set(update: DesktopShellPreferencesUpdate): Promise<DesktopShellPreferences>
    subscribe(listener: (preferences: DesktopShellPreferences) => void): () => void
  }
}

/** Startup-page controls, unavailable to backend-provided application documents. */
export interface DshDesktopStartupApi extends Pick<DshDesktopApi, 'protocolVersion' | 'locale'> {
  readonly backend: Omit<DshDesktopApi['backend'], 'retry'>
  disablePlugins(): Promise<void>
  restart(): Promise<void>
  resetConfiguration(): Promise<void>
}
