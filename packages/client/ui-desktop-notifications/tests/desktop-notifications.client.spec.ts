/** Desktop notification plugin wiring inside a Client context. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopNotificationReport } from '../src/client/bridge.ts'
import { apply, inject } from '../src/client/index.ts'

const SESSION_ID = 'session-1' as SessionId
const CHILD_ID = 'session-child' as SessionId
/** A subagent child the session list never holds, as out-of-chain children are. */
const OFF_CHAIN_ID = 'session-off-chain' as SessionId

type RemoteListener = (...args: readonly never[]) => void

/** One Client context carrying exactly the services this plugin injects. */
async function bench(options: { readonly bridge?: unknown } = {}) {
  const ctx = new Context()
  const listeners = new Map<string, RemoteListener>()
  const disposals: string[] = []
  ctx.provide('remote', {
    $on: (event: string, listener: RemoteListener) => {
      listeners.set(event, listener)
      return () => {
        listeners.delete(event)
        disposals.push(event)
      }
    },
  } as never)
  const rows: Record<string, { displayTitle: string; origin?: 'subagent' }> = {
    [SESSION_ID]: { displayTitle: 'Release notes' },
    [CHILD_ID]: { displayTitle: 'Child task', origin: 'subagent' },
  }
  const open = vi.fn()
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: rows }) } } as never)
  ctx.provide('uiWorkspace', { openSession: open } as never)
  const pending = new Map<SessionId, { key: string; kind: string }>()
  const pendingListeners = new Set<() => void>()
  ctx.provide('uiSession', {
    sessionStatus: {
      getSnapshot: () => new Map([...pending].map(([id, interaction]) => [id, { pendingInteraction: interaction }])),
      subscribe: (listener: () => void) => {
        pendingListeners.add(listener)
        return () => { pendingListeners.delete(listener) }
      },
    },
  } as never)
  if (options.bridge !== undefined) vi.stubGlobal('dshDesktop', { notifications: options.bridge })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    listeners,
    disposals,
    open,
    pending,
    /** Publish one pending interaction the way an interactive-pause domain does. */
    publishInteraction(sessionId: SessionId, key: string, kind: string): void {
      pending.set(sessionId, { key, kind })
      for (const listener of [...pendingListeners]) listener()
    },
    emit(event: string, ...args: readonly unknown[]): void {
      const listener = listeners.get(event)
      if (listener === undefined) throw new Error(`no listener for ${event}`)
      ;(listener as unknown as (...values: readonly unknown[]) => void)(...args)
    },
  }
}

function bridge() {
  return {
    report: vi.fn(async (_report: DesktopNotificationReport) => undefined),
    onActivate: vi.fn((_listener: (sessionId: string) => void) => () => undefined),
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'remote', 'uiSession', 'uiWorkspace'])
  })

  it('installs nothing in a browser session without the shell bridge', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.listeners.size).toBe(0)
  })

  it('reports completions, failures, and paused interactions to the shell', async () => {
    const notifications = bridge()
    const b = await bench({ bridge: notifications })
    await b.fiber.await()

    b.emit('api-session/status', SESSION_ID, true)
    b.emit('api-session/status', SESSION_ID, false)
    const finished = notifications.report.mock.calls.at(-1)?.[0]
    // The run identity carries the reporter instance, so a reloaded renderer
    // cannot reuse the identity of a run the shell already reported.
    expect(finished?.id).toMatch(/^[0-9a-f]{16}:session-1:finished:1$/)
    expect(finished).toMatchObject({ kind: 'finished', sessionId: SESSION_ID, title: 'Release notes' })

    // A subagent finishing is not the user's task finishing.
    b.emit('api-session/status', CHILD_ID, true)
    b.emit('api-session/status', CHILD_ID, false)
    expect(notifications.report).toHaveBeenCalledTimes(1)

    // Nor is a subagent failing, even when the Client's list does not hold it:
    // the Host's own announcement carries the child's origin and parent.
    b.emit('api-session/added', { sessionId: OFF_CHAIN_ID, parentSessionId: SESSION_ID, origin: 'subagent' })
    b.emit('api-session/status', OFF_CHAIN_ID, true)
    b.emit('api-session/error', OFF_CHAIN_ID)
    b.emit('api-session/status', OFF_CHAIN_ID, false)
    expect(notifications.report).toHaveBeenCalledTimes(1)

    b.emit('api-session/status', SESSION_ID, true)
    b.emit('api-session/error', SESSION_ID)
    expect(notifications.report).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'failed' }))

    b.publishInteraction(CHILD_ID, 'approval:1', 'approval')
    expect(notifications.report).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'approval',
      sessionId: CHILD_ID,
      title: 'Child task',
    }))

    // A removed session keeps its run numbering, so its next run is a new event
    // rather than an identity the shell already dropped as a duplicate. The
    // failed run above counted as interval two.
    b.emit('api-session/removed', SESSION_ID)
    b.emit('api-session/status', SESSION_ID, true)
    b.emit('api-session/status', SESSION_ID, false)
    expect(notifications.report.mock.calls.at(-1)?.[0]?.id).toMatch(/:session-1:finished:3$/)
  })

  it('contains a shell call that fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const notifications = bridge()
    notifications.report.mockRejectedValueOnce(new Error('ipc closed'))
    const b = await bench({ bridge: notifications })
    await b.fiber.await()

    b.emit('api-session/status', SESSION_ID, true)
    b.emit('api-session/status', SESSION_ID, false)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith('[desktop-notifications] report failed:', expect.any(Error))
    })
  })

  it('opens only a listed session when a notification is clicked', async () => {
    const notifications = bridge()
    const b = await bench({ bridge: notifications })
    await b.fiber.await()
    const activate = notifications.onActivate.mock.calls[0]?.[0]
    expect(activate).toBeDefined()

    activate?.(SESSION_ID)
    expect(b.open).toHaveBeenCalledWith(SESSION_ID)
    activate?.('session-unknown')
    expect(b.open).toHaveBeenCalledTimes(1)
  })

  it('publishes the interactions already pending when it installs, and stops with its lifetime', async () => {
    const notifications = bridge()
    const b = await bench({ bridge: notifications })
    b.pending.set(SESSION_ID, { key: 'question:1', kind: 'question' })
    await b.fiber.await()
    expect(notifications.report).toHaveBeenCalledWith(expect.objectContaining({ kind: 'input' }))

    await b.fiber.dispose()
    b.publishInteraction(SESSION_ID, 'question:2', 'question')
    expect(notifications.report).toHaveBeenCalledTimes(1)
  })
})
