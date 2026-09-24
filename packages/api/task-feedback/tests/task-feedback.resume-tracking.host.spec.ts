/**
 * Task feedback: tracking the resumed turn when its follow-up task write is
 * delayed or lost.
 *
 * The automatic resume is admitted and submitted before its follow-up task is
 * registered, so a task-table failure in that window leaves a resumed turn that
 * runs untracked. These cases keep the regression where that turn already
 * completed, failed, paused, or is still open when the registration finally
 * happens, and where a manual turn ended after it. Every case runs the real
 * Session log, projections, and storage; the only double is the prompt surface,
 * which records the instruction as the submitted user message the Session
 * records, and the injected task-table failure stays inside the fixture.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
// Relative source import: the wait fold is the session controller's own
// projection, and this spec mounts it exactly as that controller does.
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import TaskFeedback from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const owned = new Set<Context>()
const roots: string[] = []
let serial = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Mount the in-memory storage stack the task feedback domain opens. */
async function mountMemoryStorage(ctx: Context): Promise<void> {
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
}

/** Mount the session store, projections, and the wait fold a recovery reads. */
async function mountSessionStack(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  installSessionWaitProjection(ctx)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
}

/**
 * A simulated Session prompt surface.
 *
 * It records the accepted instruction as the durable user message a Session
 * records for a submitted prompt, deduplicating by request id the way the
 * controller's prompt does. This is the one external seam these cases replace;
 * the Session, storage, projections, and the service are the real ones.
 */
class SimulatedPromptSurface {
  readonly calls: { requestId: string; text: string }[] = []
  private readonly admitted = new Set<string>()

  constructor(private readonly ctx: Context) {}

  prompt(request: {
    requestId: string
    sessionId: SessionId
    content: readonly { type: string; text?: string }[]
  }): Promise<{ accepted: true }> {
    const text = request.content.find(part => part.type === 'text')?.text ?? ''
    this.calls.push({ requestId: request.requestId, text })
    if (this.admitted.has(request.requestId)) return Promise.resolve({ accepted: true })
    this.admitted.add(request.requestId)
    // The real controller queues the message and the loop records it inside the
    // turn that claims it; a surface that records it immediately is the timing
    // the follow-up binding has to survive.
    this.ctx.sessions.get(request.sessionId)?.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: request.requestId as never },
    }), { surfaceOp: 'append' })
    return Promise.resolve({ accepted: true })
  }
}

/** One Host generation over a durable root, with no Session attached yet. */
async function durableHost(
  root: string,
  restored?: { id: string; seed: SessionEvent[] },
): Promise<{ ctx: Context; service: TaskFeedback }> {
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountSessionStack(ctx)
  // A saved Session restored before the service mounts is the recovery order
  // where the service's own pass reads it and no session/created edge follows.
  if (restored !== undefined) {
    ctx.sessions.create(SessionId(restored.id), { meta: { cwd: '/workspace' }, seed: restored.seed })
  }
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
  return { ctx, service: ctx.taskFeedback }
}

/** A Host with the real session stack, the service, and its prompt surface. */
async function harness(): Promise<{
  ctx: Context
  service: TaskFeedback
  surface: SimulatedPromptSurface
  createSession: (id: string) => Session
}> {
  const ctx = new Context()
  owned.add(ctx)
  await mountMemoryStorage(ctx)
  await mountSessionStack(ctx)
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
  const surface = new SimulatedPromptSurface(ctx)
  ctx.provide('sessionController', surface as never)
  return {
    ctx,
    service: ctx.taskFeedback,
    surface,
    createSession: id => ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } }),
  }
}

/** Register the one failure every case resumes. */
async function registerFailedTask(service: TaskFeedback, session: Session): Promise<void> {
  await service.register({
    taskId: 'root',
    sessionId: session.id,
    turn: 1,
    target: { kind: 'codex-thread', threadId: 'codex-thread-1' },
    acceptance: 'the reviewer checks the recorded evidence',
  })
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', {
    turn: 1,
    reason: {
      kind: 'error',
      error: { message: 'provider rejected the request: reasoning_text must be passed back', code: 'INVALID_REQUEST', status: 400 },
    },
  })
  await service.settled()
}

/** The service's durable task table, reached to inject one lost write. */
function taskTable(service: TaskFeedback): { put: (...args: unknown[]) => Promise<void> } {
  return (service as unknown as {
    requireTasks(): { put: (...args: unknown[]) => Promise<void> }
  }).requireTasks()
}

/** Make the first follow-up task write fail, as a rejected or lost write does. */
function loseFollowupWrite(service: TaskFeedback): void {
  const tasks = taskTable(service)
  const put = tasks.put.bind(tasks)
  let failed = false
  vi.spyOn(tasks, 'put').mockImplementation(async (...args: unknown[]) => {
    if (!failed && args[0] === 'root#r1') {
      failed = true
      throw new Error('followup task write failed')
    }
    return put(...args)
  })
}

/**
 * Admit one resume, lose the follow-up task write, and stop before the resumed
 * turn runs. This is the exact window the defect needs: the instruction is
 * accepted and recorded, and no task exists to observe what happens next.
 */
async function admitLostFollowup(): Promise<{
  service: TaskFeedback
  surface: SimulatedPromptSurface
  session: Session
}> {
  const { service, surface, createSession } = await harness()
  serial += 1
  const session = createSession(`lost-followup-${String(serial)}`)
  await registerFailedTask(service, session)
  loseFollowupWrite(service)
  await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
    .rejects.toThrow('followup task write failed')
  // The admitted instruction is on the Session; the follow-up task is not, and
  // the failure must not have been resubmitted.
  expect(surface.calls).toHaveLength(1)
  expect(service.tasks().map(task => task.taskId)).toEqual(['root'])
  return { service, surface, session }
}

/** Complete one turn of the Session, the way the loop's own events do. */
function completeTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** The attempt's own deliveries, in outbox order. */
function attemptDeliveries(service: TaskFeedback): string[] {
  return service.deliveries().map(delivery => delivery.deliveryId).filter(id => id.startsWith('root#r1@'))
}

/**
 * The Session's recorded events plus turns that committed while the Host was
 * down.
 *
 * The live watcher was gone for those turns, so no observation folded them;
 * only the restored history carries them. A manual turn is appended with its
 * own user message so it cannot be mistaken for the attempt's instruction.
 */
function historyAcrossRestart(
  recorded: readonly SessionEvent[],
  turns: readonly { turn: number; reason: TurnEndReason; manual?: boolean }[],
): SessionEvent[] {
  const events: SessionEvent[] = [...recorded]
  let seq = Number(events.at(-1)?.seq ?? 0) + 1
  for (const { turn, reason, manual } of turns) {
    events.push({ type: 'turn/start', seq: seq++ as never, time: Date.now(), data: { turn } })
    if (manual === true) {
      events.push({
        type: 'user/message',
        seq: seq++ as never,
        time: Date.now(),
        data: createUserMessage({
          content: [{ type: 'text', text: `manual turn ${String(turn)}` }],
          source: { kind: 'user', rpcId: `manual-${String(turn)}` as never },
        }),
        surfaceOp: 'append',
      })
    }
    events.push({ type: 'turn/end', seq: seq++ as never, time: Date.now(), data: { turn, reason } })
  }
  return events
}

/**
 * Admit one resume over a durable root whose instruction the Session recorded
 * before any turn claimed it, then stop.
 *
 * This leaves exactly the crash window the cold recovery has to close: the
 * instruction is durable and accepted, the follow-up task is registered with
 * `turn: null`, and the task-table write that would bind it never landed.
 */
async function durableUnboundAttempt(root: string, sessionId: string): Promise<{
  first: Context
  service: TaskFeedback
  session: Session
  recorded: SessionEvent[]
}> {
  const { ctx, service } = await durableHost(root)
  ctx.provide('sessionController', new SimulatedPromptSurface(ctx) as never)
  const session = ctx.sessions.create(SessionId(sessionId), { meta: { cwd: '/workspace' } })
  await registerFailedTask(service, session)
  await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
  await service.settled()
  expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'accepted', turn: null })
  return { first: ctx, service, session, recorded: [...session.snapshotEvents()] }
}

describe('automatic resume cold recovery', () => {
  it('rebinds a registered but unbound attempt when the saved Session attaches after the service recovers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-cold-unbound-'))
    roots.push(root)
    const { first, recorded } = await durableUnboundAttempt(root, 'cold-unbound')
    const seed = historyAcrossRestart(recorded, [{ turn: 2, reason: { kind: 'completed' } }])
    await first.fiber.dispose()
    owned.delete(first)

    // The service recovers before its Session is restored, then the saved
    // history attaches without a per-event feed.
    const second = await durableHost(root)
    second.ctx.sessions.create(SessionId('cold-unbound'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()

    expect(second.service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
      parentTaskId: 'root',
      rootTaskId: 'root',
    })
    expect(attemptDeliveries(second.service)).toEqual(['root#r1@completed'])
  })

  it('rebinds an unbound attempt when the saved Session is already attached as the service recovers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-cold-attached-'))
    roots.push(root)
    const { first, recorded } = await durableUnboundAttempt(root, 'cold-attached')
    const seed = historyAcrossRestart(recorded, [
      { turn: 2, reason: { kind: 'completed' } },
      { turn: 3, reason: { kind: 'error', error: { message: 'manual turn failed', code: 'SERVER' } }, manual: true },
    ])
    await first.fiber.dispose()
    owned.delete(first)

    // The Session is restored before the service mounts, so the service's own
    // recovery pass reads it and no session/created edge follows.
    const second = await durableHost(root, { id: 'cold-attached', seed })
    await second.service.settled()

    expect(second.service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
      evidence: { turn: 2 },
    })
    // The later manual turn is not reported as the resume's outcome.
    expect(second.service.task({ taskId: 'root' }).state).toBe('failed')
    expect(attemptDeliveries(second.service)).toEqual(['root#r1@completed'])
  })

  it('reports an unbound attempt whose resumed turn is still open after the restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-cold-open-'))
    roots.push(root)
    const { first, recorded } = await durableUnboundAttempt(root, 'cold-open')
    const seed = [...recorded]
    seed.push({ type: 'turn/start', seq: (Number(seed.at(-1)!.seq) + 1) as never, time: Date.now(), data: { turn: 2 } })
    await first.fiber.dispose()
    owned.delete(first)

    const second = await durableHost(root)
    second.ctx.sessions.create(SessionId('cold-open'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()

    expect(second.service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'running',
      turn: 2,
      summary: 'turn 2 is already open',
    })
    expect(attemptDeliveries(second.service)).toEqual([])
  })

  it('settles an already bound attempt from restored history without a second notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-cold-bound-'))
    roots.push(root)
    const { first, service, session } = await durableUnboundAttempt(root, 'cold-bound')
    // The live watcher binds the task when the resumed turn starts, then the
    // Host stops before that turn's end reaches storage.
    session.append('turn/start', { turn: 2 })
    await service.settled()
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'running', turn: 2 })
    const seed = historyAcrossRestart([...session.snapshotEvents()], [{ turn: 2, reason: { kind: 'completed' } }])
    await first.fiber.dispose()
    owned.delete(first)

    const second = await durableHost(root)
    second.ctx.sessions.create(SessionId('cold-bound'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()
    expect(second.service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'completed', turn: 2 })
    expect(attemptDeliveries(second.service)).toEqual(['root#r1@completed'])

    // A second cold recovery over the same durable state must not add another
    // notification or reopen the settled task.
    await second.ctx.fiber.dispose()
    owned.delete(second.ctx)
    const third = await durableHost(root)
    third.ctx.sessions.create(SessionId('cold-bound'), { meta: { cwd: '/workspace' }, seed })
    await third.service.settled()
    expect(third.service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'completed', turn: 2 })
    expect(attemptDeliveries(third.service)).toEqual(['root#r1@completed'])
  })
})

describe('automatic resume tracking', () => {
  it('recovers the completed resumed turn after the follow-up task write failed', async () => {
    const { service, surface, session } = await admitLostFollowup()
    completeTurn(session, 2)
    await service.settled()

    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()

    expect(replay).toMatchObject({ decision: 'resumed', attempt: { taskId: 'root#r1', attempt: 2 } })
    expect(surface.calls).toHaveLength(1)
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
      parentTaskId: 'root',
      rootTaskId: 'root',
      evidence: { turn: 2 },
    })
    expect(attemptDeliveries(service)).toEqual(['root#r1@completed'])
    // The resumed turn's outcome still notifies the original Codex target.
    expect(service.deliveries().find(delivery => delivery.deliveryId === 'root#r1@completed')?.target)
      .toEqual({ kind: 'codex-thread', threadId: 'codex-thread-1' })
  })

  it('binds the resumed turn, not a manual turn that ended after it', async () => {
    const { service, session } = await admitLostFollowup()
    completeTurn(session, 2)
    // A manual turn fails after the automatic one. Reading the last turn end
    // would report this failure as the resume's outcome.
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'manual continuation' }],
      source: { kind: 'user', rpcId: 'manual-1' as never },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 3, reason: { kind: 'error', error: { message: 'manual turn failed', code: 'SERVER' } } })
    await service.settled()

    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()

    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
      evidence: { turn: 2 },
    })
    expect(attemptDeliveries(service)).toEqual(['root#r1@completed'])
  })

  it('repeats the recovery without a second submission or a second notification', async () => {
    const { service, surface, session } = await admitLostFollowup()
    completeTurn(session, 2)
    await service.settled()

    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()
    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()

    expect(replay.decision).toBe('resumed')
    expect(surface.calls).toHaveLength(1)
    expect(service.task({ taskId: 'root#r1' }).state).toBe('completed')
    expect(attemptDeliveries(service)).toEqual(['root#r1@completed'])
  })

  it('reports a resumed turn that is still open when the registration happens', async () => {
    const { service, session } = await admitLostFollowup()
    session.append('turn/start', { turn: 2 })
    await service.settled()

    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()

    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'running',
      turn: 2,
      summary: 'turn 2 is already open',
    })
    expect(attemptDeliveries(service)).toEqual([])
  })

  it('reports a resumed turn that failed again as the eligible failure', async () => {
    const { service, session } = await admitLostFollowup()
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', {
      turn: 2,
      reason: {
        kind: 'error',
        error: { message: 'provider rejected the request: reasoning_text must be passed back', code: 'INVALID_REQUEST', status: 400 },
      },
    })
    await service.settled()

    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()

    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'failed',
      turn: 2,
      resumeEligible: true,
    })
    expect(attemptDeliveries(service)).toEqual(['root#r1@failed'])
  })

  it('reports a resumed turn that is waiting for an approval', async () => {
    const { service, session } = await admitLostFollowup()
    const ask = ApprovalRequestId('resume-approval')
    session.append('turn/start', { turn: 2 })
    session.append('approval/asked', { id: ask, toolName: 'bash' })
    await service.settled()

    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await service.settled()

    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'waiting_approval',
      turn: 2,
      summary: 'waiting for an approval on bash',
    })
    expect(attemptDeliveries(service)).toEqual([`root#r1@waiting_approval@${String(ask)}`])
  })

  it('recovers the completed resumed turn after a restart with the follow-up task never written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-resume-tracking-'))
    roots.push(root)
    const first = await durableHost(root)
    const surface = new SimulatedPromptSurface(first.ctx)
    first.ctx.provide('sessionController', surface as never)
    const session = first.ctx.sessions.create(SessionId('restart-resume'), { meta: { cwd: '/workspace' } })
    await registerFailedTask(first.service, session)
    loseFollowupWrite(first.service)
    await expect(first.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toThrow('followup task write failed')
    completeTurn(session, 2)
    await first.service.settled()
    const seed: SessionEvent[] = [...session.snapshotEvents()]
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    const second = await durableHost(root)
    // The service recovered before its Session was restored, so the attempt task
    // does not exist yet and the replay has to register it from the admission.
    second.ctx.sessions.create(SessionId('restart-resume'), { meta: { cwd: '/workspace' }, seed })
    const replay = await second.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    await second.service.settled()

    expect(replay.decision).toBe('resumed')
    expect(second.service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'completed', turn: 2 })
    expect(attemptDeliveries(second.service)).toEqual(['root#r1@completed'])
  })
})
