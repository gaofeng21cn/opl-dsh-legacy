/**
 * `session.wait`: event-driven settling on a Session's terminal outcome.
 *
 * The wait is exercised against the real agent loop, so the durable
 * `turn/end` reasons it reports are the loop's own rather than fixtures.
 * Approval pauses are staged through the real approval audit events, which is
 * the one interactive bracket the log records.
 *
 * Two Session lifecycles are covered because they differ by design: a Session
 * with a live Agent always waits for the next terminal fact (it may open a
 * turn at any moment), while a Session with no live Agent settles immediately
 * from its recorded log.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  type AgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'
import type { SessionWaitState } from '../src/wait.ts'
import { installSessionWaitProjection, outcomeOfTurnEnd, sessionWaitProjectionDefinition } from '../src/wait.ts'

const owned = new Set<Context>()
let serial = 1

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/** A Session on the real loop, plus the direct Remote face over it. */
interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly loop: AgentLoopTestHarness
  readonly remote: TestSessionRemote
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  owned.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId(`session-wait-${String(serial++)}`), {}, { cwd: '/workspace' })
  installSessionWaitProjection(ctx)
  return {
    ctx,
    agent,
    loop,
    remote: createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/workspace',
    }),
  }
}

/** Unwrap one direct Remote result, failing loudly on an error result. */
function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Let a pending wait install its `session/event` subscription. */
const subscribed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/**
 * Fail fast when a wait that should have settled does not.
 *
 * A hang is the defect under test, so the assertion has to be a deadline rather
 * than the suite's own timeout: that keeps the failure message about the wait.
 * @param pending - the wait under test.
 * @returns the wait's value.
 * @throws when the wait has not settled by the deadline.
 */
async function settlesWithin<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('session.wait did not settle')) }, 500)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Drive the lifecycle status one wait observes.
 *
 * Reaching these states through the loop's own driver needs an LLM adapter and
 * a whole turn; a wait reads exactly `session` and `status`, so this seam
 * stages the transition under test and emits the same `agent/status` the driver
 * would.
 * @param ctx - Host context owning the Agent registry.
 * @param agent - Agent whose status is staged.
 * @param initial - status the Agent starts in.
 * @returns the staged status and a transition trigger.
 */
function controlAgentStatus(
  ctx: Context,
  agent: Agent,
  initial: 'idle' | 'running',
): { readonly status: 'idle' | 'running'; to(status: 'idle' | 'running'): void } {
  const view = { status: initial }
  vi.spyOn(ctx.agents, 'get').mockImplementation(id => (
    id === agent.id
      ? { id: agent.id, session: agent.session, ctx: agent.ctx, get status() { return view.status } } as unknown as Agent
      : undefined
  ))
  return {
    get status() { return view.status },
    to(status) {
      view.status = status
      agentEvents(ctx, agent).emit('agent/status', { status })
    },
  }
}

describe('session.wait on a Session with a live Agent', () => {
  it('resolves completed from the turn it was observing', async () => {
    const { ctx, agent, remote } = await harness()
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(await pending).toEqual({ ok: true, value: { turn: 1, outcome: { kind: 'completed' } } })
  })

  it('reports a structured failure with the recorded message and code', async () => {
    const { ctx, agent, remote } = await harness()
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'upstream refused', code: 'SERVER_ERROR' } },
    })
    expect(value(await pending).outcome)
      .toEqual({ kind: 'failed', message: 'upstream refused', code: 'SERVER_ERROR' })
  })

  it('reports cancellation with its cause', async () => {
    const { ctx, agent, remote } = await harness()
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(value(await pending).outcome).toEqual({ kind: 'cancelled', cause: 'user' })
  })

  it('reports a pending approval as needs-input', async () => {
    const { ctx, agent, remote } = await harness()
    // A pending ask is only announced when the approval seam is mounted.
    ctx.provide('approval', {} as never)
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('approval/asked', { id: ApprovalRequestId('a1'), toolName: 'bash' })
    expect(value(await pending).outcome).toEqual({
      kind: 'needs-input',
      request: { sessionId: agent.id, approvalId: 'a1', toolName: 'bash' },
    })
  })

  it('reports an approval that was already pending when the wait arrived', async () => {
    const { ctx, agent, remote } = await harness()
    ctx.provide('approval', {} as never)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('approval/asked', { id: ApprovalRequestId('prior'), toolName: 'pwsh' })
    expect(value(await remote.wait({ sessionId: agent.id })).outcome).toEqual({
      kind: 'needs-input',
      request: { sessionId: agent.id, approvalId: 'prior', toolName: 'pwsh' },
    })
  })

  it('ignores a decided approval and keeps waiting for the turn', async () => {
    const { ctx, agent, remote } = await harness()
    ctx.provide('approval', {} as never)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('approval/asked', { id: ApprovalRequestId('old'), toolName: 'bash' })
    agent.session.append('approval/decided', { id: ApprovalRequestId('old'), outcome: 'allowed-once' })
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(await pending).outcome).toEqual({ kind: 'completed' })
  })

  it('does not report an ask abandoned by a cancelled turn', async () => {
    // A turn the user stopped leaves its unanswered ask on the log: the
    // approval audit pair is only closed from inside the turn. The next turn
    // must not inherit it, so a wait issued while that turn runs settles on
    // the new turn's own outcome instead of the abandoned ask.
    const { ctx, agent, remote } = await harness()
    ctx.provide('approval', {} as never)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('approval/asked', { id: ApprovalRequestId('abandoned'), toolName: 'bash' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    controlAgentStatus(ctx, agent, 'running')

    agent.session.append('turn/start', { turn: 3 })
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(pending))).toEqual({ turn: 3, outcome: { kind: 'completed' } })
  })

  it('replays a cancelled turn without carrying its ask into later turns', async () => {
    // Restart recovery: a projection is rebuilt by folding the log, so the
    // same fold that drops the orphan live must drop it on replay, including
    // when a permission switch sits between the cancelled turn and the next.
    const { agent } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('approval/asked', { id: ApprovalRequestId('abandoned'), toolName: 'bash' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    agent.session.append('permission/preset', { preset: 'danger-full-access' })
    agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('turn/start', { turn: 3 })

    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const replayed = agent.session.snapshotEvents().reduce<SessionWaitState>(
      (state, event) => sessionWaitProjectionDefinition.apply(state, event),
      sessionWaitProjectionDefinition.init(),
    )
    expect(replayed.pendingApprovals).toEqual({})
    expect(replayed.lastEndTurn).toBe(1)
  })

  it('awaits the exact requested turn rather than an earlier one', async () => {
    const { ctx, agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // An awaited turn ahead of the log is coming only while a driver is active.
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id, turn: 2 })
    await subscribed()
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(value(await pending)).toEqual({ turn: 2, outcome: { kind: 'completed' } })
  })

  it('reports the recorded outcome for an already-closed requested turn', async () => {
    const { agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    expect(value(await remote.wait({ sessionId: agent.id, turn: 1 })).outcome).toEqual({
      kind: 'failed',
      message: 'a step reached its output-token ceiling',
    })
  })

  it('fails loudly for a requested turn the log has already passed', async () => {
    const { agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 3 })
    agent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const settled = value(await remote.wait({ sessionId: agent.id, turn: 1 }))
    expect(settled.turn).toBe(1)
    expect(settled.outcome).toMatchObject({ kind: 'failed' })
  })

  it('rejects when the caller cancels, and stops observing afterward', async () => {
    const { agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    const controller = new AbortController()
    const pending = remote.wait({ sessionId: agent.id }, controller.signal)
    await subscribed()
    controller.abort()
    expect((await pending).ok).toBe(false)

    // A late turn end must not reach a caller that already gave up.
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await subscribed()
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
  })

  it('rejects a wait whose signal was already aborted', async () => {
    const { agent, remote } = await harness()
    const controller = new AbortController()
    controller.abort()
    expect((await remote.wait({ sessionId: agent.id }, controller.signal)).ok).toBe(false)
  })
})

describe('session.wait once the final turn has closed', () => {
  it('settles a Session whose last turn ended while its Agent is still registered', async () => {
    // A parent reaches exactly this state once its last child or subtask has
    // finished: the turn is closed and the Agent stays registered but idle.
    // Treating registration alone as "still working" left the wait with no
    // event that could ever settle it.
    const { agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(remote.wait({ sessionId: agent.id }))))
      .toEqual({ turn: 1, outcome: { kind: 'completed' } })
  })

  it('settles a parent once its final child has finished', async () => {
    const { ctx, loop, remote } = await harness()
    const parent = await loop.create(SessionId(`session-wait-parent-${String(serial++)}`), {}, { cwd: '/workspace' })
    const child = await loop.create(SessionId(`session-wait-child-${String(serial++)}`), {}, { cwd: '/workspace' })
    // The child runs to completion, then the parent's delegating turn closes.
    child.session.append('turn/start', { turn: 1 })
    child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    parent.session.append('turn/start', { turn: 1 })
    parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(value(await settlesWithin(remote.wait({ sessionId: child.id }))))
      .toEqual({ turn: 1, outcome: { kind: 'completed' } })
    expect(value(await settlesWithin(remote.wait({ sessionId: parent.id }))))
      .toEqual({ turn: 1, outcome: { kind: 'completed' } })
    // Both Agents are still registered, which is what made this hang.
    expect(ctx.agents.get(parent.id)).toBeDefined()
  })

  it('reports a failed final turn rather than leaving the parent in progress', async () => {
    const { agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'child failed', code: 'UNKNOWN' } },
    })
    expect(value(await settlesWithin(remote.wait({ sessionId: agent.id }))).outcome)
      .toEqual({ kind: 'failed', message: 'child failed', code: 'UNKNOWN' })
  })

  it('keeps waiting while the Agent is still running', async () => {
    // The intent behind waiting on a live Agent: waking input puts the driver
    // in `running` before the turn opens, so a wait issued straight after a
    // prompt must observe that prompt's turn rather than the previous one.
    const { ctx, agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const driver = controlAgentStatus(ctx, agent, 'running')

    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(pending))).toEqual({ turn: 2, outcome: { kind: 'completed' } })
    expect(driver.status).toBe('running')
  })

  it('settles when the running driver goes idle without opening another turn', async () => {
    // The event that closes the remaining gap: a driver that ends without
    // publishing a further turn/end must still release its waiters.
    const { ctx, agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const driver = controlAgentStatus(ctx, agent, 'running')

    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    driver.to('idle')
    expect(value(await settlesWithin(pending))).toEqual({ turn: 1, outcome: { kind: 'completed' } })
  })

  it('fails a requested turn the idle Agent can never open', async () => {
    const { agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const settled = value(await settlesWithin(remote.wait({ sessionId: agent.id, turn: 4 })))
    expect(settled.turn).toBe(4)
    expect(settled.outcome).toMatchObject({ kind: 'failed' })
  })

  it('ignores a status change for another Session and a driver that starts running', async () => {
    const { ctx, loop, agent, remote } = await harness()
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const other = await loop.create(SessionId(`session-wait-other-${String(serial++)}`), {}, { cwd: '/workspace' })

    // Registration alone is not work, so this wait must settle even though
    // unrelated lifecycle traffic keeps arriving.
    const settled = value(await settlesWithin(remote.wait({ sessionId: agent.id })))
    expect(settled).toEqual({ turn: 1, outcome: { kind: 'completed' } })

    // Neither event may settle a wait that is still observing an active driver.
    const driver = controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    agentEvents(ctx, other).emit('agent/status', { status: 'idle' })
    driver.to('running')
    await subscribed()
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(pending))).toEqual({ turn: 2, outcome: { kind: 'completed' } })
  })

  it('ignores facts that arrive after it already settled', async () => {
    const { ctx, agent, remote } = await harness()
    ctx.provide('approval', {} as never)
    agent.session.append('turn/start', { turn: 1 })
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    // The ask answers the wait; the turn closing in the same tick, and a second
    // idle notification, must both be discarded rather than change that answer.
    agent.session.append('approval/asked', { id: ApprovalRequestId('first'), toolName: 'bash' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    expect(value(await pending).outcome).toEqual({
      kind: 'needs-input',
      request: { sessionId: agent.id, approvalId: 'first', toolName: 'bash' },
    })
  })

  it('ignores a turn it was not asked about while awaiting an exact turn', async () => {
    const { ctx, agent, remote } = await harness()
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id, turn: 2 })
    await subscribed()
    // A closer for another turn belongs to a different question.
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'earlier', code: 'UNKNOWN' } } })
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(pending))).toEqual({ turn: 2, outcome: { kind: 'completed' } })
  })

  it('ignores an approval ask when no answerer is mounted', async () => {
    const { ctx, agent, remote } = await harness()
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    // Without the approval seam the ask cannot be answered here, so it is not a
    // usable `needs-input` result and the wait keeps observing the turn.
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('approval/asked', { id: ApprovalRequestId('unserved'), toolName: 'bash' })
    await subscribed()
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(pending)).outcome).toEqual({ kind: 'completed' })
  })

  it('fails a requested turn on a Session that never ran', async () => {
    const { agent, remote } = await harness()
    // No recorded turn at all, so the awaited turn can never be reached.
    const settled = value(await settlesWithin(remote.wait({ sessionId: agent.id, turn: 1 })))
    expect(settled.turn).toBe(1)
    expect(settled.outcome).toMatchObject({ kind: 'failed' })
  })

  it('ignores events from another Session and a decision it never asked for', async () => {
    const { ctx, loop, agent, remote } = await harness()
    const other = await loop.create(SessionId(`session-wait-neighbour-${String(serial++)}`), {}, { cwd: '/workspace' })
    controlAgentStatus(ctx, agent, 'running')
    const pending = remote.wait({ sessionId: agent.id })
    await subscribed()
    // A neighbouring Session's turn is not this Session's business.
    other.session.append('turn/start', { turn: 1 })
    other.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'neighbour', code: 'UNKNOWN' } } })
    // Nor is a decision for an ask this Session never made.
    agent.session.append('approval/decided', { id: ApprovalRequestId('unknown'), outcome: 'rejected' })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(pending)).outcome).toEqual({ kind: 'completed' })
  })

  it('treats a registry entry for another Session as no driver', async () => {
    const { ctx, loop, agent, remote } = await harness()
    const other = await loop.create(SessionId(`session-wait-alias-${String(serial++)}`), {}, { cwd: '/workspace' })
    // Identity is the pair of id and Session, so an entry answering for this id
    // but driving another Session is not this Session's driver.
    vi.spyOn(ctx.agents, 'get').mockReturnValue(other)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(await settlesWithin(remote.wait({ sessionId: agent.id }))).outcome).toEqual({ kind: 'completed' })
  })
})

describe('session.wait on a detached Session', () => {
  /** A recorded Session with no live Agent, plus the Remote face over it. */
  async function detached(): Promise<{ ctx: Context; sessionId: SessionId; remote: TestSessionRemote }> {
    const ctx = new Context()
    owned.add(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(SessionId(`session-detached-${String(serial++)}`), { meta: { cwd: '/workspace' } })
    return {
      ctx,
      sessionId: session.id,
      // The Remote face installs the controller, which registers the wait fold.
      remote: createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
        cwd: '/workspace',
      }),
    }
  }

  it('resolves an already-finished Session from its recorded outcome', async () => {
    const { ctx, sessionId, remote } = await detached()
    const session = ctx.sessions.get(sessionId)
    session?.append('turn/start', { turn: 1 })
    session?.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(await remote.wait({ sessionId }))).toEqual({ turn: 1, outcome: { kind: 'completed' } })
  })

  it('resolves a never-used Session as completed', async () => {
    const { sessionId, remote } = await detached()
    expect(value(await remote.wait({ sessionId }))).toEqual({ turn: 0, outcome: { kind: 'completed' } })
  })

  it('rejects a wait on a Session this Host does not hold', async () => {
    const { remote } = await detached()
    expect((await remote.wait({ sessionId: SessionId('not-attached') })).ok).toBe(false)
  })
})

describe('wait outcome vocabulary', () => {
  it('classifies every durable turn-end reason', () => {
    expect(outcomeOfTurnEnd({ kind: 'completed' })).toEqual({ kind: 'completed' })
    expect(outcomeOfTurnEnd({ kind: 'blocked' })).toMatchObject({ kind: 'failed' })
    expect(outcomeOfTurnEnd({ kind: 'max-tokens' })).toMatchObject({ kind: 'failed' })
    expect(outcomeOfTurnEnd({ kind: 'interrupted' })).toMatchObject({ kind: 'failed' })
    expect(outcomeOfTurnEnd({ kind: 'aborted', reason: { kind: 'disposed' } }))
      .toEqual({ kind: 'cancelled', cause: 'disposed' })
    expect(outcomeOfTurnEnd({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }))
      .toEqual({ kind: 'failed', message: 'boom', code: 'UNKNOWN' })
  })

  it('treats a plugin-added reason variant as unsettled rather than successful', () => {
    const extended = { kind: 'plugin-defined' } as never
    expect(outcomeOfTurnEnd(extended)).toMatchObject({ kind: 'failed' })
  })
})
