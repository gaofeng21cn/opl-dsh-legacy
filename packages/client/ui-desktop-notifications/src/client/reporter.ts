/**
 * Which Host facts become task notifications.
 *
 * Every kind here comes from a fact the Client already receives, and each is a
 * real state change rather than a transport event:
 *
 * - `finished` is the running-to-idle edge of `api-session/status`, which the
 *   Host publishes only when an Agent's driver actually stops. A dropped
 *   connection publishes nothing, so a disconnect can never be reported as a
 *   finished task, and a session that is already idle when the Client attaches
 *   produces no edge.
 * - `failed` is a live Agent failure reported while that session was running.
 *   The failure text stays in the application: the report carries the event,
 *   never the message.
 * - `approval` and `input` are entries in the Client's pending-interaction
 *   registry, which is what makes an interactive pause answerable. Its request
 *   key changes per request, so answering one and receiving the next notifies
 *   again, while a re-delivered pending request keeps its session's entry and
 *   stays silent.
 *
 * Report identities are derived from the observed fact, so a repeat delivery of
 * one event is dropped by the shell instead of shown twice. A run outcome also
 * carries an identity minted once per reporter instance, because a run number
 * counted here names a run only inside the renderer that counted it.
 *
 * @module @deepseek-ai/dsh-client-ui-desktop-notifications/client/reporter
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DesktopNotificationKind, DesktopNotificationReport } from './bridge.ts'

/** Longest session title this half reports, in code points. */
export const REPORTED_TITLE_CODE_POINTS = 120

/** Most sessions whose run state is retained before the oldest is dropped. */
export const REMEMBERED_SESSIONS = 512

/** One session's observed run interval. */
interface SessionRun {
  /** Counts running edges, so each completion has its own identity. */
  epoch: number
  /** Whether the session is running right now. */
  running: boolean
  /** Whether a live failure was already reported for this run. */
  failed: boolean
}

/** Everything the reporter needs from the Client and the shell. */
export interface DesktopNotificationReporterOptions {
  /** Send one report to the desktop shell. */
  readonly report: (report: DesktopNotificationReport) => void
  /** Display title of one session, when the Client knows it. */
  readonly titleOf: (sessionId: SessionId) => string | undefined
  /** Whether one session is a subagent child, as the Client's session list knows it. */
  readonly isSubagent: (sessionId: SessionId) => boolean
}

/** Turns subscribed Client facts into desktop notification reports. */
export class DesktopNotificationReporter {
  /**
   * Distinguishes the run numbers this instance counts from every other
   * instance's, so a renderer that reloads cannot reuse the identity of a run
   * the shell already reported.
   */
  readonly instanceId: string
  private readonly runs = new Map<SessionId, SessionRun>()
  /** Last pending-interaction key reported per session. */
  private readonly pendingKeys = new Map<SessionId, string>()
  /** Sessions the Host announced as subagent children. */
  private readonly subagents = new Set<SessionId>()

  /** @param options - report sink and the session facts a report needs. */
  constructor(private readonly options: DesktopNotificationReporterOptions) {
    this.instanceId = mintInstanceId()
  }

  /**
   * Apply one Agent running-state change.
   * @param sessionId - session whose Agent changed state.
   * @param running - current Agent running state.
   */
  sessionStatus(sessionId: SessionId, running: boolean): void {
    const current = this.runs.get(sessionId)
    if (running) {
      this.remember(sessionId, { epoch: (current?.epoch ?? 0) + 1, running: true, failed: false })
      return
    }
    if (current === undefined || !current.running) return
    this.remember(sessionId, { ...current, running: false, failed: false })
    // A failed run already reported its own outcome; a subagent's completion is
    // the parent's turn, not the user's task.
    if (current.failed || this.isSubagent(sessionId)) return
    this.emit(sessionId, 'finished', this.runIdentity(sessionId, 'finished', current.epoch))
  }

  /**
   * Apply one live Agent failure.
   * @param sessionId - session whose Agent failed.
   */
  sessionError(sessionId: SessionId): void {
    const current = this.runs.get(sessionId)
    // A failure outside a run is a session-open or activation failure, which
    // says nothing about a task the user is waiting for.
    if (current === undefined || !current.running || current.failed) return
    // The run is marked failed either way, so the idle edge that follows a
    // subagent's failure stays silent for the same reason its completion does.
    this.remember(sessionId, { ...current, failed: true })
    if (this.isSubagent(sessionId)) return
    this.emit(sessionId, 'failed', this.runIdentity(sessionId, 'failed', current.epoch))
  }

  /**
   * Apply one Session the Host announced.
   *
   * The Client's session list holds the subagents on its current navigation
   * chain, so a child outside that chain would otherwise read as a task the
   * user started. The announcement carries the child's own parent and origin,
   * which is what makes the suppression independent of where the user is
   * looking.
   * @param sessionId - announced session identity.
   * @param isSubagent - whether the Host created it as a subagent child.
   */
  sessionAdded(sessionId: SessionId, isSubagent: boolean): void {
    if (!isSubagent) return
    this.subagents.delete(sessionId)
    this.subagents.add(sessionId)
    while (this.subagents.size > REMEMBERED_SESSIONS) {
      const oldest = this.subagents.values().next().value
      /* v8 ignore next -- the loop condition proves at least one entry exists */
      if (oldest === undefined) return
      this.subagents.delete(oldest)
    }
  }

  /**
   * Apply one Session's current pending interaction.
   * @param sessionId - session whose UI can answer the interaction.
   * @param key - request identity; a replacement request uses a new key.
   * @param kind - domain-owned presentation discriminator.
   */
  pendingInteraction(sessionId: SessionId, key: string, kind: string): void {
    if (this.pendingKeys.get(sessionId) === key) return
    this.pendingKeys.set(sessionId, key)
    const notificationKind = notificationKindOf(kind)
    // An interaction from a domain this plugin does not know is remembered but
    // not announced, so a later request from a known domain still notifies.
    if (notificationKind === undefined) return
    this.emit(sessionId, notificationKind, `${sessionId}:${notificationKind}:${key}`)
  }

  /**
   * Drop the state retained for one session that left the Host registry.
   * @param sessionId - removed session identity.
   */
  sessionRemoved(sessionId: SessionId): void {
    // The run numbering outlives the removal: a session that runs again is a
    // new event, and restarting its count would reuse an identity the shell
    // already dropped as a duplicate.
    const current = this.runs.get(sessionId)
    if (current !== undefined) this.remember(sessionId, { ...current, running: false, failed: false })
    this.pendingKeys.delete(sessionId)
  }

  /** Drop every retained session fact; the plugin is being disposed. */
  dispose(): void {
    this.runs.clear()
    this.pendingKeys.clear()
    this.subagents.clear()
  }

  /** Whether one session is a subagent child, from either available source. */
  private isSubagent(sessionId: SessionId): boolean {
    return this.subagents.has(sessionId) || this.options.isSubagent(sessionId)
  }

  /** Identity of one run outcome, unique across renderer instances. */
  private runIdentity(sessionId: SessionId, kind: DesktopNotificationKind, epoch: number): string {
    return `${this.instanceId}:${sessionId}:${kind}:${String(epoch)}`
  }

  /** Report one event with its session's current display title. */
  private emit(sessionId: SessionId, kind: DesktopNotificationKind, id: string): void {
    this.options.report({
      id,
      kind,
      sessionId,
      title: reportTitle(this.options.titleOf(sessionId)),
    })
  }

  /** Record one session's run interval, bounding how many are retained. */
  private remember(sessionId: SessionId, run: SessionRun): void {
    this.runs.delete(sessionId)
    this.runs.set(sessionId, run)
    while (this.runs.size > REMEMBERED_SESSIONS) {
      const oldest = this.runs.keys().next().value
      /* v8 ignore next -- the loop condition proves at least one key exists */
      if (oldest === undefined) return
      this.runs.delete(oldest)
    }
  }
}

/** The notification kind for one pending-interaction discriminator. */
function notificationKindOf(kind: string): DesktopNotificationKind | undefined {
  switch (kind) {
    // The two interactive-pause domains the shipped Client composes.
    case 'approval': return 'approval'
    case 'question':
    case 'plan-review': return 'input'
    // Merge-extensible: an interaction from another domain is not announced
    // until this plugin knows which notification it deserves.
    default: return undefined
  }
}

/** Bound one session title into the single line a notification body carries. */
function reportTitle(title: string | undefined): string {
  if (title === undefined) return ''
  const collapsed = title.replaceAll(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()
  const codePoints = Array.from(collapsed)
  return codePoints.length <= REPORTED_TITLE_CODE_POINTS
    ? collapsed
    : codePoints.slice(0, REPORTED_TITLE_CODE_POINTS).join('')
}

/**
 * Mint one reporter instance identity.
 *
 * `crypto.getRandomValues` is the platform's own random source and is present
 * on insecure origins, unlike `crypto.randomUUID`. The value only has to differ
 * between renderer instances, so 64 bits is enough.
 */
function mintInstanceId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
