/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopCloseBehavior } from './desktop-preferences.ts'
import type { DesktopNotificationReport } from './notifications.ts'
import type { DesktopKeyboardApi, DesktopShortcutsApi } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserBridge } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  environmentStatus: 'dsh-desktop:environment-status',
  environmentSelect: 'dsh-desktop:environment-select',
  preferencesGet: 'dsh-desktop:preferences-get',
  preferencesSet: 'dsh-desktop:preferences-set',
  preferencesState: 'dsh-desktop:preferences-state',
  notificationsReport: 'dsh-desktop:notifications-report',
  notificationsActivate: 'dsh-desktop:notifications-activate',
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
  boot: 'dsh-desktop:boot',
  enterWorkspace: 'dsh-desktop:enter-workspace',
  onboardingActive: 'dsh-desktop:onboarding-active',
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  bootFailed: 'dsh-desktop:boot-failed',
  browserAcquire: 'dsh-desktop:browser-acquire',
  browserRelease: 'dsh-desktop:browser-release',
  browserOpenRequested: 'dsh-desktop:browser-open-requested',
  directoryPick: 'dsh-desktop:directory-pick',
  localeBootstrap: 'dsh-desktop:locale-bootstrap',
  localeChanged: 'dsh-desktop:locale-changed',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
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
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
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

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi extends DshDesktopAppApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
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

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'dsh-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
