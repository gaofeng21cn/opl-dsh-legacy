import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { desktopNotificationBridge, type DesktopNotificationScope } from '../src/client/bridge.ts'
import {
  DesktopNotificationReporter,
  REPORTED_TITLE_CODE_POINTS,
  type DesktopNotificationReporterOptions,
} from '../src/client/reporter.ts'
import type { DesktopNotificationReport } from '../src/client/bridge.ts'

/** One session identity as the Session object layer carries it. */
const sid = (value: string): SessionId => value as SessionId

describe('desktop notification bridge', () => {
  it('reads the shell bridge out of the application window', () => {
    const report = vi.fn()
    const onActivate = vi.fn()
    const scope: DesktopNotificationScope = { dshDesktop: { notifications: { report, onActivate } } }
    expect(desktopNotificationBridge(scope)).toEqual({ report, onActivate })
  })

  it('answers nothing in a browser session or from a malformed bridge', () => {
    expect(desktopNotificationBridge({})).toBeUndefined()
    expect(desktopNotificationBridge({ dshDesktop: {} })).toBeUndefined()
    expect(desktopNotificationBridge({ dshDesktop: { notifications: 'yes' } })).toBeUndefined()
    expect(desktopNotificationBridge({ dshDesktop: { notifications: { report: vi.fn() } } })).toBeUndefined()
    expect(desktopNotificationBridge({ dshDesktop: { notifications: { onActivate: vi.fn() } } })).toBeUndefined()
  })
})

function options(overrides: Partial<DesktopNotificationReporterOptions> = {}): {
  readonly reports: DesktopNotificationReport[]
  readonly options: DesktopNotificationReporterOptions
} {
  const reports: DesktopNotificationReport[] = []
  return {
    reports,
    options: {
      report: (report) => { reports.push(report) },
      titleOf: () => 'Release notes',
      isSubagent: () => false,
      ...overrides,
    },
  }
}

describe('desktop notification reporter', () => {
  it('reports one completion per running interval', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    // A session that is already idle when the Client attaches has no edge.
    reporter.sessionStatus(sid('session-1'), false)
    expect(reports).toEqual([])

    reporter.sessionStatus(sid('session-1'), true)
    reporter.sessionStatus(sid('session-1'), false)
    expect(reports).toEqual([{
      id: `${reporter.instanceId}:session-1:finished:1`,
      kind: 'finished',
      sessionId: 'session-1',
      title: 'Release notes',
    }])

    // The next run is a new event rather than a duplicate of the first.
    reporter.sessionStatus(sid('session-1'), true)
    reporter.sessionStatus(sid('session-1'), false)
    expect(reports.map(report => report.id)).toEqual([
      `${reporter.instanceId}:session-1:finished:1`,
      `${reporter.instanceId}:session-1:finished:2`,
    ])

    // A repeated idle report is not a state change.
    reporter.sessionStatus(sid('session-1'), false)
    expect(reports).toHaveLength(2)
  })

  it('never reports a disconnect as a completion', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    reporter.sessionStatus(sid('session-1'), true)
    // A dropped connection delivers no status at all; the session stays running
    // until the Host itself says otherwise.
    expect(reports).toEqual([])
  })

  it('reports a live failure once and not the completion that follows it', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    reporter.sessionStatus(sid('session-1'), true)
    reporter.sessionError(sid('session-1'))
    reporter.sessionError(sid('session-1'))
    reporter.sessionStatus(sid('session-1'), false)
    expect(reports).toEqual([{
      id: `${reporter.instanceId}:session-1:failed:1`,
      kind: 'failed',
      sessionId: 'session-1',
      title: 'Release notes',
    }])
  })

  it('ignores a failure that belongs to no running task', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    // Opening or activating a session can fail; that is not a task outcome.
    reporter.sessionError(sid('session-1'))
    expect(reports).toEqual([])
  })

  it('leaves subagent outcomes to the parent task', () => {
    const { reports, options: ports } = options({ isSubagent: sessionId => sessionId === sid('child') })
    const reporter = new DesktopNotificationReporter(ports)
    reporter.sessionStatus(sid('child'), true)
    reporter.sessionStatus(sid('child'), false)
    expect(reports).toEqual([])
    // A subagent failing is the parent turn's failure to report, exactly as its
    // completion is.
    reporter.sessionStatus(sid('child'), true)
    reporter.sessionError(sid('child'))
    reporter.sessionStatus(sid('child'), false)
    expect(reports).toEqual([])
    // A subagent that needs an answer still blocks the run it belongs to.
    reporter.pendingInteraction(sid('child'), 'approval:1', 'approval')
    expect(reports.map(report => report.kind)).toEqual(['approval'])
  })

  it('suppresses an announced subagent its own session list does not hold', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    // The Client's list holds the subagents on its current navigation chain, so
    // the Host's own announcement is what identifies a child the user has
    // navigated away from.
    reporter.sessionAdded(sid('child'), true)
    reporter.sessionStatus(sid('child'), true)
    reporter.sessionError(sid('child'))
    reporter.sessionStatus(sid('child'), false)
    expect(reports).toEqual([])

    reporter.sessionAdded(sid('session-1'), false)
    reporter.sessionStatus(sid('session-1'), true)
    reporter.sessionStatus(sid('session-1'), false)
    expect(reports.map(report => report.kind)).toEqual(['finished'])
  })

  it('gives each reporter instance its own run identities', () => {
    const first = options()
    const second = options()
    const one = new DesktopNotificationReporter(first.options)
    const two = new DesktopNotificationReporter(second.options)
    expect(one.instanceId).not.toBe(two.instanceId)
    expect(first.reports).toEqual([])

    for (const reporter of [one, two]) {
      reporter.sessionStatus(sid('session-1'), true)
      reporter.sessionStatus(sid('session-1'), false)
    }
    expect(first.reports[0]?.id).toBe(`${one.instanceId}:session-1:finished:1`)
    // A reloaded renderer numbers its first observed run 1 again; the instance
    // identity is what keeps the shell from dropping it as a repeat.
    expect(second.reports[0]?.id).toBe(`${two.instanceId}:session-1:finished:1`)
  })

  it('reports an interactive pause once per request key', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    reporter.pendingInteraction(sid('session-1'), 'approval:1', 'approval')
    reporter.pendingInteraction(sid('session-1'), 'approval:1', 'approval')
    expect(reports).toEqual([{
      id: 'session-1:approval:approval:1',
      kind: 'approval',
      sessionId: 'session-1',
      title: 'Release notes',
    }])

    // A plan review and a question are both a request for the user's answer.
    reporter.pendingInteraction(sid('session-1'), 'question:2', 'question')
    reporter.pendingInteraction(sid('session-2'), 'question:3', 'plan-review')
    expect(reports.slice(1).map(report => report.kind)).toEqual(['input', 'input'])

    // A replacement request carries a new key and notifies again.
    reporter.pendingInteraction(sid('session-1'), 'approval:4', 'approval')
    expect(reports).toHaveLength(4)
  })

  it('stays quiet for an interaction domain it does not know', () => {
    const { reports, options: ports } = options()
    const reporter = new DesktopNotificationReporter(ports)
    reporter.pendingInteraction(sid('session-1'), 'foreign:1', 'something-else')
    expect(reports).toEqual([])
    // The unknown request is still remembered, so a later known request for the
    // same session is a change rather than a repeat.
    reporter.pendingInteraction(sid('session-1'), 'approval:2', 'approval')
    expect(reports).toHaveLength(1)
  })

  it('bounds a reported title and keeps a removed session run numbering', () => {
    const { reports, options: ports } = options({
      titleOf: sessionId => (sessionId === sid('long') ? `Fix\u0000the\n${'🐋'.repeat(200)}` : undefined),
    })
    const reporter = new DesktopNotificationReporter(ports)
    reporter.sessionStatus(sid('long'), true)
    reporter.sessionStatus(sid('long'), false)
    const title = reports[0]?.title ?? ''
    expect(Array.from(title)).toHaveLength(REPORTED_TITLE_CODE_POINTS)
    expect(title.startsWith('Fix the 🐋')).toBe(true)

    reporter.sessionRemoved(sid('long'))
    reporter.sessionStatus(sid('long'), true)
    reporter.sessionStatus(sid('long'), false)
    // The removed session keeps its run numbering, so the next run is a new
    // event rather than an identity the shell already dropped as a duplicate.
    expect(reports[1]?.id).toBe(`${reporter.instanceId}:long:finished:2`)

    reporter.dispose()
    reporter.sessionRemoved(sid('long'))
  })

  it('reports an absent title as an empty one', () => {
    const { reports, options: ports } = options({ titleOf: () => undefined })
    const reporter = new DesktopNotificationReporter(ports)
    reporter.pendingInteraction(sid('session-1'), 'approval:1', 'approval')
    expect(reports[0]?.title).toBe('')
  })
})
