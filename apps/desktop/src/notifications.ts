/**
 * System notification policy for the desktop application.
 *
 * The application renderer reports facts it already subscribes to — a task run
 * stopping, a live agent failure, or a pending approval or question — and this
 * module decides whether a Windows notification is raised. The decision lives
 * in the main process because only it knows whether the application is in the
 * foreground and whether the user enabled notifications.
 *
 * Reports are events, never message content: the body is locale-owned status
 * copy plus a bounded session title, so a credential or a model/user message
 * cannot reach the notification center. Report identities are remembered, so a
 * repeated delivery of one event (a reconnected event stream, a reloaded
 * renderer) is dropped instead of shown twice.
 *
 * @module dsh-desktop/notifications
 */

import type { DesktopMessages } from './locale.ts'

/** What one notification reports. */
export type DesktopNotificationKind = 'finished' | 'failed' | 'approval' | 'input'

/** Every reportable kind, used to validate reports crossing the process boundary. */
const NOTIFICATION_KINDS: readonly DesktopNotificationKind[] = ['finished', 'failed', 'approval', 'input']

/** One event the application renderer asks the shell to surface. */
export interface DesktopNotificationReport {
  /** Stable identity of the reported event; a repeat of the same id is dropped. */
  readonly id: string
  readonly kind: DesktopNotificationKind
  /** Session the notification opens when clicked. */
  readonly sessionId: string
  /** Session title for the body; bounded and stripped before display. */
  readonly title: string
}

/** What the shell did with one report. */
export type DesktopNotificationOutcome =
  | 'shown'
  | 'suppressed'
  | 'disabled'
  | 'unsupported'
  | 'duplicate'

/** Longest session title carried into a notification body, in code points. */
export const NOTIFICATION_TITLE_CODE_POINTS = 120

/** Longest accepted report identity, in code units. */
export const NOTIFICATION_ID_LENGTH = 200

/** Longest accepted session identity, in code units. */
export const NOTIFICATION_SESSION_ID_LENGTH = 200

/** Raised notifications still referenced when the platform reports no close. */
export const NOTIFICATION_LIFETIME_LIMIT = 16

/** A raised notification whose click callback must outlive the call that raised it. */
export interface HeldDesktopNotification {
  /**
   * Subscribe to one notification lifecycle event.
   * @param event - `click` when the user activates it, `close` when it leaves the screen.
   * @param listener - runs when the event fires.
   */
  on(event: 'click' | 'close', listener: () => void): void
}

/**
 * Keep raised notifications referenced until the user or the platform settles
 * them.
 *
 * Electron collects a notification whose only reference was the local variable
 * that raised it, and a collected notification cannot run the click handler
 * that reopens its Session. Holding each one until it reports `click` or
 * `close` keeps that callback alive; the bound covers a platform that never
 * reports a close for a toast the user ignored.
 */
export class DesktopNotificationLifetime {
  private readonly live = new Set<HeldDesktopNotification>()

  /**
   * Hold one notification until it settles.
   * @param notification - the notification just raised.
   * @param onActivate - runs on a click, after the notification is released.
   */
  hold(notification: HeldDesktopNotification, onActivate: () => void): void {
    this.live.add(notification)
    const release = (): void => { this.live.delete(notification) }
    notification.on('click', () => { release(); onActivate() })
    notification.on('close', release)
    while (this.live.size > NOTIFICATION_LIFETIME_LIMIT) {
      const oldest = this.live.values().next().value
      /* v8 ignore next -- the loop condition proves at least one entry exists */
      if (oldest === undefined) return
      this.live.delete(oldest)
    }
  }

  /** Drop every held notification; the process is leaving. */
  releaseAll(): void {
    this.live.clear()
  }

  /** How many notifications are currently referenced, for diagnostics. */
  get held(): number {
    return this.live.size
  }
}

/** Native operations the policy needs, kept injectable for tests. */
export interface DesktopNotificationPorts {
  /** Whether this platform can raise notifications at all. */
  isSupported(): boolean
  /** Whether the application already has the user's attention. */
  isForeground(): boolean
  /**
   * Raise one notification.
   * @param options - localized title and body.
   * @param onActivate - runs when the user clicks the notification.
   */
  show(options: { readonly title: string; readonly body: string }, onActivate: () => void): void
}

/** Construction inputs for {@link DesktopNotificationCenter}. */
export interface DesktopNotificationCenterOptions {
  readonly ports: DesktopNotificationPorts
  /** Reads the current language when a notification is raised. */
  readonly messages: () => DesktopMessages
  /** Opens the session behind a clicked notification. */
  readonly onActivate: (sessionId: string) => void
  /** Distinct report identities remembered to drop repeats. */
  readonly rememberedLimit?: number
}

/** How many report identities a shell remembers by default. */
export const DEFAULT_REMEMBERED_NOTIFICATIONS = 64

/**
 * Collapse a session title into one bounded notification line.
 *
 * Control characters become spaces so a title cannot forge extra notification
 * lines, runs of whitespace collapse, and the result is cut on code points so a
 * surrogate pair is never split.
 * @param title - raw session title.
 * @returns a single-line title within {@link NOTIFICATION_TITLE_CODE_POINTS}.
 */
export function sanitizeSessionTitle(title: string): string {
  const collapsed = title.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()
  const codePoints = Array.from(collapsed)
  return codePoints.length <= NOTIFICATION_TITLE_CODE_POINTS
    ? collapsed
    : codePoints.slice(0, NOTIFICATION_TITLE_CODE_POINTS).join('')
}

/**
 * Validate one report crossing the renderer/main boundary.
 * @param value - raw IPC payload.
 * @returns the report, or undefined when the payload is not one.
 */
export function parseDesktopNotificationReport(value: unknown): DesktopNotificationReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const { id, kind, sessionId, title } = candidate
  if (typeof id !== 'string' || id === '' || id.length > NOTIFICATION_ID_LENGTH) return undefined
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > NOTIFICATION_SESSION_ID_LENGTH) return undefined
  if (typeof title !== 'string' || title.length > 4096) return undefined
  if (typeof kind !== 'string') return undefined
  const reportKind = NOTIFICATION_KINDS.find(candidateKind => candidateKind === kind)
  if (reportKind === undefined) return undefined
  return { id, kind: reportKind, sessionId, title }
}

/** One notification per real state change, with repeats dropped. */
export class DesktopNotificationCenter {
  /** Report identities already handled, oldest first. */
  private readonly remembered = new Set<string>()
  private readonly rememberedLimit: number
  private enabled = true

  /** @param options - native ports, copy source, activation, and dedup bound. */
  constructor(private readonly options: DesktopNotificationCenterOptions) {
    this.rememberedLimit = options.rememberedLimit ?? DEFAULT_REMEMBERED_NOTIFICATIONS
  }

  /**
   * Apply the user's notification setting.
   * @param enabled - whether notifications may be raised.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** Whether notifications are currently enabled. */
  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Handle one report.
   * @param report - validated report from the application renderer.
   * @returns what the shell did, for logging and tests.
   */
  report(report: DesktopNotificationReport): DesktopNotificationOutcome {
    if (this.remembered.has(report.id)) return 'duplicate'
    this.remember(report.id)
    if (!this.enabled) return 'disabled'
    if (!this.options.ports.isSupported()) return 'unsupported'
    // A user looking at the application already sees the state the
    // notification would carry.
    if (this.options.ports.isForeground()) return 'suppressed'
    const messages = this.options.messages()
    const body = this.describe(report, messages)
    try {
      this.options.ports.show({ title: messages.notificationTitle, body }, () => {
        this.options.onActivate(report.sessionId)
      })
    } catch (error: unknown) {
      console.error('desktop notification could not be raised', error)
      return 'unsupported'
    }
    return 'shown'
  }

  /** Status copy for one kind plus the session that produced it. */
  private describe(report: DesktopNotificationReport, messages: DesktopMessages): string {
    const status = statusMessage(report.kind, messages)
    const title = sanitizeSessionTitle(report.title)
    return title === '' ? status : `${status}\n${title}`
  }

  /** Remember one identity, dropping the oldest beyond the bound. */
  private remember(id: string): void {
    this.remembered.add(id)
    while (this.remembered.size > this.rememberedLimit) {
      const oldest = this.remembered.values().next().value
      /* v8 ignore next -- the loop condition proves at least one entry exists */
      if (oldest === undefined) return
      this.remembered.delete(oldest)
    }
  }
}

/** Locale-owned status line for one report kind. */
function statusMessage(kind: DesktopNotificationKind, messages: DesktopMessages): string {
  switch (kind) {
    case 'finished': return messages.notificationFinished
    case 'failed': return messages.notificationFailed
    case 'approval': return messages.notificationApproval
    case 'input': return messages.notificationInput
  }
}
