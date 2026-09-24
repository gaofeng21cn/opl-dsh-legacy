/**
 * Structural view of the desktop shell's notification bridge.
 *
 * The bridge is exposed by the Electron preload as `globalThis.dshDesktop`
 * inside the desktop application window and is absent in an ordinary browser
 * session, so this module is what makes the browser half inert outside the
 * Desktop shell. The value crosses a process boundary: only its two members
 * are read, each is checked as a function, and the notification payload is
 * built here rather than forwarded from anything the page receives.
 *
 * @module @deepseek-ai/dsh-client-ui-desktop-notifications/client/bridge
 */

/** Kinds the shell turns into a system notification. */
export type DesktopNotificationKind = 'finished' | 'failed' | 'approval' | 'input'

/** One task event reported to the desktop shell. */
export interface DesktopNotificationReport {
  /** Stable identity of the event; the shell drops a repeat of the same id. */
  readonly id: string
  readonly kind: DesktopNotificationKind
  /** Session the notification opens when clicked. */
  readonly sessionId: string
  /** Session display title; the shell bounds and sanitizes it again. */
  readonly title: string
}

/** The desktop shell's notification operations. */
export interface DesktopNotificationBridge {
  /**
   * Report one task event.
   * @param report - event identity, kind, session, and display title.
   * @returns completion of the shell call; the shell decides whether it notifies.
   */
  report(report: DesktopNotificationReport): Promise<void>
  /**
   * Subscribe to notification clicks.
   * @param listener - receives the session a clicked notification named.
   * @returns the unsubscribe function.
   */
  onActivate(listener: (sessionId: string) => void): () => void
}

/** Window-like scope carrying the preload bridge. */
export interface DesktopNotificationScope {
  readonly dshDesktop?: { readonly notifications?: unknown }
}

/**
 * Read the notification bridge out of one global scope.
 * @param scope - global object carrying the preload bridge, `globalThis` by default.
 * @returns the bridge, or undefined outside the Desktop shell.
 */
export function desktopNotificationBridge(
  scope: DesktopNotificationScope = globalThis as DesktopNotificationScope,
): DesktopNotificationBridge | undefined {
  const candidate = scope.dshDesktop?.notifications
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const bridge = candidate as Partial<DesktopNotificationBridge>
  if (typeof bridge.report !== 'function' || typeof bridge.onActivate !== 'function') return undefined
  return bridge as DesktopNotificationBridge
}
