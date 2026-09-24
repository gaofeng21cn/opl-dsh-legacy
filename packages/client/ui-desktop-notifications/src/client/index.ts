/**
 * Desktop notification plugin, browser half.
 *
 * Inside the Desktop shell this package turns Host facts the Client already
 * receives into system notifications: a task run stopping, a live failure, and
 * an interactive pause waiting for the user. In an ordinary browser session
 * there is no shell bridge, so the plugin installs nothing at all.
 *
 * The plugin reports events; it never decides presentation. The shell owns the
 * notification center, the user's on/off setting, whether the application is in
 * the foreground, and the click that reopens the session. The report carries no
 * message content — only the event identity, its kind, the session, and that
 * session's display title.
 *
 * @module @deepseek-ai/dsh-client-ui-desktop-notifications/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { desktopNotificationBridge } from './bridge.ts'
import { DesktopNotificationReporter } from './reporter.ts'

/** Required services: the Session object layer, Remote events, and pending interactions. */
export const inject = ['sessions', 'remote', 'uiSession', 'uiWorkspace']

/**
 * Install the task-event reporters once a desktop shell bridge is present.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const bridge = desktopNotificationBridge()
  if (bridge === undefined) return
  const summaryOf = (sessionId: SessionId) => ctx.sessions.list.getSnapshot().byId[sessionId]
  const reporter = new DesktopNotificationReporter({
    report: (report) => {
      void bridge.report(report).catch((error: unknown) => {
        console.error('[desktop-notifications] report failed:', error)
      })
    },
    titleOf: sessionId => summaryOf(sessionId)?.displayTitle,
    isSubagent: sessionId => summaryOf(sessionId)?.origin === 'subagent',
  })
  ctx.effect(() => () => { reporter.dispose() }, 'ui-desktop-notifications: reporter')
  ctx.remote.$on('api-session/added', (summary) => {
    // The Client's list holds the subagents on its current navigation chain, so
    // the announcement's own parent and origin are what identify a child the
    // user has navigated away from.
    reporter.sessionAdded(summary.sessionId, summary.origin === 'subagent' || summary.parentSessionId !== undefined)
  })
  ctx.remote.$on('api-session/status', (sessionId, running) => {
    reporter.sessionStatus(sessionId, running)
  })
  ctx.remote.$on('api-session/error', (sessionId) => { reporter.sessionError(sessionId) })
  ctx.remote.$on('api-session/removed', (sessionId) => { reporter.sessionRemoved(sessionId) })
  // Pending interactions are the Client's own answerable-pause registry, so a
  // pause is reported when it becomes answerable rather than when a Host
  // waterfall happens to reach this renderer.
  const interactions = ctx.uiSession.sessionStatus
  const publish = (): void => {
    for (const [sessionId, status] of interactions.getSnapshot()) {
      const interaction = status.pendingInteraction
      if (interaction === undefined) continue
      reporter.pendingInteraction(sessionId, interaction.key, interaction.kind)
    }
  }
  const unsubscribe = interactions.subscribe(publish)
  ctx.effect(() => () => { unsubscribe() }, 'ui-desktop-notifications: pending interactions')
  publish()
  ctx.effect(() => bridge.onActivate((candidate) => {
    // The click crosses a process boundary, so the identity is a claim until
    // the Client's own list confirms it names a listed Session.
    if (!Object.hasOwn(ctx.sessions.list.getSnapshot().byId, candidate)) return
    ctx.uiWorkspace.openSession(candidate as SessionId)
  }), 'ui-desktop-notifications: activation')
}
