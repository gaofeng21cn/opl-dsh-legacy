/**
 * Task feedback: registration, the model-free watcher, and the durable outbox.
 *
 * Every case runs on the real session log, the real projection registry, the
 * real domain storage, and a simulated receiving Session. No model, no API
 * key, and no network take part: what is under test is which durable fact moves
 * a task, and what a notification is allowed to claim.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
// Relative source import: the wait fold is the session controller's own
// projection, and this spec mounts it exactly as that controller does.
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { receiptRecord, taskRecord } from '../src/spec.ts'
import type { ReceiptRecordState, TaskRecordState } from '../src/spec.ts'
import TaskFeedback from '../src/index.ts'
import { WAKE_UNCONNECTED_REASON, composeWakeMessage } from '../src/wake.ts'
import type { TaskState, WakeAdapter, WakeDelivery } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const owned = new Set<Context>()
const roots: string[] = []
let serial = 0

/**
 * One durable table reached through the service's private accessor.
 *
 * The cases below install a failing write on the table itself, so the accessor
 * is called the way the service calls it and the result is typed as the table
 * the spy replaces.
 * @param service - the mounted service holding the table.
 * @param accessor - private accessor name, such as `requireReceipts`.
 * @returns the table that accessor returns.
 */
function privateTable(service: TaskFeedback, accessor: string): unknown {
  const read = (service as unknown as Record<string, (() => unknown) | undefined>)[accessor]
  if (read === undefined) throw new Error(`task-feedback: the service has no ${accessor} accessor`)
  return read.call(service)
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * A simulated receiving Session.
 *
 * It records what it was handed and accepts only while its operator says so, so
 * a case can tell "the transport took it" apart from "the Session took it".
 */
class SimulatedReceiver implements WakeAdapter {
  readonly id = 'simulated'
  readonly sent: WakeDelivery[] = []
  accepts = true
  /** Set when the transport is up but the receiving Session is gone. */
  reason = 'the receiving Session is not reachable'

  send(delivery: WakeDelivery): Promise<{ accepted: boolean; detail: string }> {
    this.sent.push(delivery)
    return Promise.resolve(this.accepts
      ? { accepted: true, detail: 'handed to the receiving Session' }
      : { accepted: false, detail: this.reason })
  }

  probe(): Promise<{ started: boolean; detail: string }> {
    return Promise.resolve({ started: this.accepts, detail: this.accepts ? 'simulated transport is reachable' : this.reason })
  }
}

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

/** A Host with the service mounted, plus its simulated receiver. */
async function harness(config: Record<string, unknown> = {}): Promise<{
  ctx: Context
  service: TaskFeedback
  receiver: SimulatedReceiver
  createSession: (id: string) => Session
}> {
  const ctx = new Context()
  owned.add(ctx)
  await mountMemoryStorage(ctx)
  await mountSessionStack(ctx)
  // The explicit-flush cases drive the outbox themselves; the automatic
  // scheduler has its own describe block below.
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false, ...config }))
  const service = ctx.taskFeedback
  const receiver = new SimulatedReceiver()
  service.setWakeAdapter(receiver)
  return {
    ctx,
    service,
    receiver,
    createSession: id => ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } }),
  }
}

/** A Host whose outbox is driven by the service's own scheduler. */
function autoHarness(config: Record<string, unknown> = {}): ReturnType<typeof harness> {
  return harness({ autoDeliver: true, ...config })
}

/** Let the armed wake-up run, then wait for the pass it started. */
async function runScheduler(service: TaskFeedback, advanceMs = 0): Promise<void> {
  await service.settled()
  await vi.advanceTimersByTimeAsync(advanceMs)
  await service.idle()
}

/**
 * One Host generation over a durable root, with no Session attached yet.
 *
 * This is the cold-start order: the service opens its tables and recovers
 * before any Session is restored, which is what leaves a bound task
 * `disconnected` until its Session is attached.
 * @param root - durable storage root shared across generations.
 * @param config - TaskFeedback overrides.
 * @returns the mounted context and its service.
 */
async function durableHost(root: string, config: Record<string, unknown> = {}): Promise<{ ctx: Context; service: TaskFeedback }> {
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountSessionStack(ctx)
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false, ...config }))
  return { ctx, service: ctx.taskFeedback }
}

/** A saved log with one completed turn, as a later generation would restore it. */
function completedTurnSeed(ctx: Context, turn: number): SessionEvent[] {
  const builder = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
  completeTurn(builder, turn)
  return [...builder.snapshotEvents()]
}

/** Register one task with a caller-chosen id. */
async function register(
  service: TaskFeedback,
  session: Session,
  overrides: { taskId?: string; turn?: number } = {},
): Promise<string> {
  serial += 1
  const taskId = overrides.taskId ?? `task-${String(serial)}`
  await service.register({
    taskId,
    sessionId: session.id,
    ...overrides.turn === undefined ? {} : { turn: overrides.turn },
    target: { kind: 'codex-thread', threadId: 'thread-explicit-1' },
    acceptance: 'the reviewer checks the recorded evidence',
  })
  return taskId
}

/** Read one task's state after the watcher's writes have settled. */
async function stateOf(service: TaskFeedback, taskId: string): Promise<TaskState> {
  await service.settled()
  return service.task({ taskId }).state
}

/** Complete one turn on a Session, the way the loop's own events do. */
function completeTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** End one turn the way the reasoning_text protocol failure does. */
function failTurn(
  session: Session,
  turn: number,
  failure: { message?: string; code?: string; status?: number } = {},
): void {
  session.append('turn/start', { turn })
  session.append('turn/end', {
    turn,
    reason: {
      kind: 'error',
      error: {
        message: failure.message ?? 'provider rejected the request: reasoning_text must be passed back',
        code: failure.code ?? 'INVALID_REQUEST',
        status: failure.status ?? 400,
      },
    },
  })
}

/**
 * A simulated Session prompt surface.
 *
 * It records every instruction it was asked to submit and appends the accepted
 * one as a real durable user message, deduplicating by request id the way the
 * Session controller's prompt does. It replaces only the model-facing model
 * call; the real Session, storage, and Remote service methods are under test.
 */
class SimulatedPromptSurface {
  readonly calls: { requestId: string; sessionId: string; text: string }[] = []
  failNext = false
  private readonly admitted = new Set<string>()

  constructor(private readonly ctx: Context) {}

  prompt(request: {
    requestId: string
    sessionId: SessionId
    content: readonly { type: string; text?: string }[]
  }): Promise<{ accepted: true }> {
    const text = request.content.find(part => part.type === 'text')?.text ?? ''
    this.calls.push({ requestId: request.requestId, sessionId: request.sessionId, text })
    if (this.failNext) {
      this.failNext = false
      throw new Error('simulated submission failure')
    }
    if (this.admitted.has(request.requestId)) return Promise.resolve({ accepted: true })
    this.admitted.add(request.requestId)
    const session = this.ctx.sessions.get(request.sessionId)
    session?.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: request.requestId as never },
    }), { surfaceOp: 'append' })
    return Promise.resolve({ accepted: true })
  }
}

/** Give one harness the deterministic resume surface and return it. */
function provideResumeSurface(ctx: Context): SimulatedPromptSurface {
  const surface = new SimulatedPromptSurface(ctx)
  ctx.provide('sessionController', surface as never)
  return surface
}

/** Report one pending inbox message for a Session, as a queued manual prompt would. */
function providePendingInput(ctx: Context, sessionId: string): void {
  ctx.provide('agents', {
    get: (id: string) => id === sessionId
      ? { inbox: { nextTurn: [{ role: 'user', source: { kind: 'user' } }], nextStep: [] } }
      : undefined,
  } as never)
}

describe('task feedback registration', () => {
  it('binds a task to the caller-named Session, turn, and target', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await service.register({
      taskId: 'task-1',
      sessionId: session.id,
      turn: 4,
      target: { kind: 'codex-thread', threadId: 'thread-explicit-9' },
      acceptance: 'tests pass',
    })
    expect(service.task({ taskId: 'task-1' })).toMatchObject({
      sessionId: 'session-a',
      turn: 4,
      target: { kind: 'codex-thread', threadId: 'thread-explicit-9' },
      acceptance: 'tests pass',
      state: 'accepted',
    })
  })

  it('is idempotent on the caller task id', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()
    // A retried dispatch must not resurrect or duplicate the finished task.
    await register(service, session, { taskId: 'task-1', turn: 1 })
    await service.settled()
    expect(service.task({ taskId: 'task-1' }).state).toBe('completed')
    expect(service.deliveries().filter(delivery => delivery.taskId === 'task-1').map(delivery => delivery.deliveryId))
      .toEqual(['task-1@completed'])
  })

  it('requires an explicit target thread and stated acceptance', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    const base = { taskId: 'task-1', sessionId: session.id, acceptance: 'tests pass' }
    await expect(service.register({ ...base, target: { kind: 'codex-thread', threadId: '  ' } }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(service.register({ ...base, acceptance: '', target: { kind: 'codex-thread', threadId: 't1' } }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(service.tasks()).toEqual([])
  })

  it('reports a task whose Session is not attached as queued', async () => {
    const { service } = await harness()
    await service.register({
      taskId: 'task-1',
      sessionId: SessionId('session-absent'),
      target: { kind: 'codex-thread', threadId: 't1' },
      acceptance: 'tests pass',
    })
    expect(service.task({ taskId: 'task-1' })).toMatchObject({
      state: 'queued',
      summary: 'registered; the bound Session is not attached to this Host',
    })
  })
})

describe('task feedback observation', () => {
  it('settles a completed turn and a failed turn', async () => {
    const { service, createSession } = await harness()
    const done = createSession('session-done')
    const failed = createSession('session-failed')
    await register(service, done, { taskId: 'done', turn: 2 })
    await register(service, failed, { taskId: 'failed', turn: 1 })

    completeTurn(done, 2)
    failed.append('turn/start', { turn: 1 })
    failed.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'upstream refused', code: 'SERVER_ERROR' } },
    })

    expect(await stateOf(service, 'done')).toBe('completed')
    expect(await stateOf(service, 'failed')).toBe('failed')
    expect(service.task({ taskId: 'failed' }).summary).toBe('the turn failed: upstream refused')
  })

  it('reports an aborted turn as cancelled rather than failed', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 3 })
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(await stateOf(service, 'task-1')).toBe('cancelled')
  })

  it('reports a pending approval and never answers it', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    session.append('approval/asked', { id: ApprovalRequestId('approval-1'), toolName: 'bash' })

    expect(await stateOf(service, 'task-1')).toBe('waiting_approval')
    expect(service.task({ taskId: 'task-1' }).summary).toBe('waiting for an approval on bash')
    // The watcher observed the pause; only the human's answer closes it.
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['turn/start', 'approval/asked'])
  })

  it('reports a structured question as waiting for input and delegates the answer', async () => {
    const { ctx, service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })

    let answered = false
    const answer = await ctx.waterfall(
      'user-questions/request',
      { questions: [], agent: { session } as never },
      () => { answered = true; return Promise.resolve({ answers: [] }) },
    )
    expect(answer).toEqual({ answers: [] })
    // The observer delegates: the composing deployment still answered.
    expect(answered).toBe(true)
    expect(await stateOf(service, 'task-1')).toBe('waiting_input')
  })

  it('keeps tasks isolated and ignores a repeated terminal event', async () => {
    const { service, createSession } = await harness()
    const first = createSession('session-first')
    const second = createSession('session-second')
    await register(service, first, { taskId: 'first', turn: 1 })
    await register(service, second, { taskId: 'second', turn: 1 })

    completeTurn(first, 1)
    // A replay or a late duplicate must not rewrite the recorded outcome.
    first.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'late rewrite', code: 'X' } } })

    expect(await stateOf(service, 'first')).toBe('completed')
    expect(await stateOf(service, 'second')).toBe('accepted')
    expect(service.deliveries().filter(delivery => delivery.taskId === 'first').map(delivery => delivery.deliveryId))
      .toEqual(['first@completed'])
    expect(service.deliveries().filter(delivery => delivery.taskId === 'second')).toEqual([])
  })
})

describe('task feedback outbox', () => {
  it('keeps every delivery pending while no wake transport is installed', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountMemoryStorage(ctx)
    await mountSessionStack(ctx)
    await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
    const session = ctx.sessions.create(SessionId('session-a'), { meta: { cwd: '/workspace' } })
    await register(ctx.taskFeedback, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)

    expect(await ctx.taskFeedback.wake()).toEqual({
      adapter: 'unconnected',
      status: 'not-connected',
      reason: WAKE_UNCONNECTED_REASON,
    })
    expect(await ctx.taskFeedback.flush()).toEqual({ attempted: 1, delivered: 0, pending: 1, exhausted: 0 })
    expect(ctx.taskFeedback.deliveries().map(delivery => delivery.stage)).toEqual(['enqueued'])
    // The refusal explains the unconfigured transport without asserting facts
    // about a particular machine's daemon or state store.
    expect(WAKE_UNCONNECTED_REASON).toContain('no wake transport is configured')
    expect(WAKE_UNCONNECTED_REASON).not.toContain('app-server')
    // The bound Session is untouched by the failed handoff.
    expect(session.snapshotEvents().at(-1)?.type).toBe('turn/end')
  })

  it('retries an unreachable receiver with bounded attempts and never drops the delivery', async () => {
    vi.useFakeTimers()
    const { service, receiver, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    receiver.accepts = false

    expect(await service.flush()).toMatchObject({ attempted: 1, delivered: 0 })
    expect(service.deliveries()[0]).toMatchObject({ stage: 'enqueued', attempts: 1, acknowledged: false })
    // The retry is scheduled, not immediate.
    expect(service.deliveries()[0]?.nextAttemptAt).not.toBeNull()
    expect(await service.flush()).toMatchObject({ attempted: 0 })

    for (let round = 0; round < 6; round += 1) {
      vi.advanceTimersByTime(120_000)
      await service.flush()
    }
    // The budget is spent: the delivery stops being scheduled and stays pending.
    expect(service.deliveries()[0]).toMatchObject({ stage: 'enqueued', attempts: 5, acknowledged: false })
    expect(await service.flush()).toMatchObject({ attempted: 0, pending: 1, exhausted: 1 })
  })

  it('advances a delivery only on the stage the receiving Session reports', async () => {
    const { service, receiver, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()

    const completed = service.deliveries().find(delivery => delivery.deliveryId === 'task-1@completed')
    expect(completed).toBeDefined()
    expect(composeWakeMessage(completed!.payload, completed!.deliveryId)).toContain('task-1')
    expect(composeWakeMessage(completed!.payload, completed!.deliveryId)).toContain('untrusted result data')
    expect(composeWakeMessage(completed!.payload, completed!.deliveryId)).toContain('delivery: task-1@completed')

    // The completed notification is delivered, and a transport acceptance is
    // `delivered` and nothing more.
    expect(await service.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    expect(service.deliveries().map(delivery => delivery.stage)).toEqual(['delivered'])
    expect(service.deliveries().every(delivery => !delivery.acknowledged)).toBe(true)
    expect(receiver.sent).toHaveLength(1)
    expect(receiver.sent[0]?.threadId).toBe('thread-explicit-1')

    // Re-flushing re-sends nothing: a delivered entry leaves the queue.
    expect(await service.flush()).toMatchObject({ attempted: 0, delivered: 0 })
    expect(receiver.sent).toHaveLength(1)

    expect(await service.ack({ taskId: 'task-1', deliveryId: 'task-1@completed', stage: 'received' }))
      .toMatchObject({ delivery: { stage: 'received', acknowledged: true } })
    expect(await service.ack({ taskId: 'task-1', deliveryId: 'task-1@completed', stage: 'review-started' }))
      .toMatchObject({ delivery: { stage: 'review-started' } })
    // A repeated, older acknowledgment is a no-op, so consuming twice is safe.
    expect(await service.ack({ taskId: 'task-1', deliveryId: 'task-1@completed', stage: 'received' }))
      .toMatchObject({ delivery: { stage: 'review-started' } })
    await expect(service.ack({ taskId: 'other', deliveryId: 'task-1@completed', stage: 'received' }))
      .rejects.toMatchObject({ code: 'task-feedback/delivery-not-found' })
  })

  it('leaves a delivery unacknowledged when the acknowledgment never arrives', async () => {
    const { service, receiver, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.flush()
    expect(receiver.sent.length).toBeGreaterThan(0)
    // The receiver took the transport handoff but never answered: every record
    // says `delivered`, not `received`, and every entry stays in the outbox.
    expect(service.deliveries().every(delivery => delivery.stage === 'delivered')).toBe(true)
    expect(service.deliveries().every(delivery => !delivery.acknowledged)).toBe(true)
  })
})

describe('task feedback recovery', () => {
  /**
   * One Host generation over the same durable root.
   * @param replay - session history this generation sees before the service mounts.
   * @returns the mounted context and its service.
   */
  async function generation(
    root: string,
    replay: (session: Session) => void,
    autoDeliver = false,
  ): Promise<{ ctx: Context; service: TaskFeedback }> {
    const ctx = new Context()
    owned.add(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await mountSessionStack(ctx)
    const session = ctx.sessions.create(SessionId('session-a'), { meta: { cwd: '/workspace' } })
    replay(session)
    await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver }))
    return { ctx, service: ctx.taskFeedback }
  }

  it('keeps prior state across a restart and sends a delivery never handed to transport', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-'))
    roots.push(root)

    const first = await generation(root, () => {})
    const firstSession = first.ctx.sessions.get(SessionId('session-a')) as Session
    await register(first.service, firstSession, { taskId: 'done', turn: 1 })
    await register(first.service, firstSession, { taskId: 'open', turn: 5 })
    completeTurn(firstSession, 1)
    firstSession.append('turn/start', { turn: 5 })
    await first.service.settled()
    expect(first.service.task({ taskId: 'done' }).state).toBe('completed')
    expect(first.service.task({ taskId: 'open' }).state).toBe('running')
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // The restart replays the same log; the finished task stays finished, the
    // open one keeps its place, and the delivery never handed to transport is sent.
    const second = await generation(root, (session) => {
      completeTurn(session, 1)
      session.append('turn/start', { turn: 5 })
    })
    const receiver = new SimulatedReceiver()
    second.service.setWakeAdapter(receiver)
    expect(second.service.task({ taskId: 'done' }).state).toBe('completed')
    expect(second.service.task({ taskId: 'open' })).toMatchObject({ state: 'running', turn: 5 })
    expect(await second.service.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    expect(receiver.sent.map(delivery => delivery.message).join('\n')).toContain('Task done reached state "completed"')
  })

  it('settles from the recorded turn end when the turn finished while down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-'))
    roots.push(root)

    const first = await generation(root, () => {})
    const firstSession = first.ctx.sessions.get(SessionId('session-a')) as Session
    await register(first.service, firstSession, { taskId: 'late', turn: 7 })
    firstSession.append('turn/start', { turn: 7 })
    await first.service.settled()
    expect(first.service.task({ taskId: 'late' }).state).toBe('running')
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // The turn ended while nothing was watching; recovery reads the durable
    // record instead of waiting for an event that already happened.
    const second = await generation(root, (session) => {
      session.append('turn/start', { turn: 7 })
      session.append('turn/end', { turn: 7, reason: { kind: 'completed' } })
    })
    expect(second.service.task({ taskId: 'late' })).toMatchObject({
      state: 'completed',
      summary: 'the turn completed',
    })
  })

  it('settles a task when its saved Session is attached after the service recovered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-cold-'))
    roots.push(root)

    const first = await durableHost(root)
    const session = first.ctx.sessions.create(SessionId('cold'), { meta: { cwd: '/workspace' } })
    await register(first.service, session, { taskId: 'cold', turn: 1 })
    session.append('turn/start', { turn: 1 })
    await first.service.settled()
    expect(first.service.task({ taskId: 'cold' }).state).toBe('running')
    const seed = completedTurnSeed(first.ctx, 1)
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // The restart recovers before the Session is restored, so the task starts
    // disconnected. Attaching the saved log afterwards must settle it; a
    // seeded Session publishes no per-event feed for the history it loads with.
    const second = await durableHost(root)
    expect(second.service.task({ taskId: 'cold' }).state).toBe('disconnected')
    second.ctx.sessions.create(SessionId('cold'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()
    expect(second.service.task({ taskId: 'cold' })).toMatchObject({
      state: 'completed',
      summary: 'the turn completed',
    })
    expect(second.service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['cold@completed'])
  })

  it('keeps a turn:null task open when the only recorded end predates registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-baseline-'))
    roots.push(root)

    const first = await durableHost(root)
    const session = first.ctx.sessions.create(SessionId('baseline'), { meta: { cwd: '/workspace' } })
    // A turn ends before the task exists; only a later end is the task's own.
    completeTurn(session, 1)
    await register(first.service, session, { taskId: 'baseline' })
    await first.service.settled()
    const seed = completedTurnSeed(first.ctx, 1)
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    const second = await durableHost(root)
    const restored = second.ctx.sessions.create(SessionId('baseline'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()
    // Recovery sees a recorded end, but it is the one already on the log when
    // the task registered: settling on it would report an old turn as this
    // task's outcome.
    expect(second.service.task({ taskId: 'baseline' }).state).toBe('accepted')
    restored.append('turn/start', { turn: 2 })
    restored.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await second.service.settled()
    expect(second.service.task({ taskId: 'baseline' }).state).toBe('completed')
  })

  it('re-enqueues a notifying state whose outbox write never landed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-split-'))
    roots.push(root)

    // The first generation notifies nothing, so the completed task is durable
    // with no delivery — the split write a crash between them leaves behind.
    const first = await durableHost(root, { notifyStates: [] })
    const session = first.ctx.sessions.create(SessionId('split'), { meta: { cwd: '/workspace' } })
    await register(first.service, session, { taskId: 'split', turn: 1 })
    completeTurn(session, 1)
    await first.service.settled()
    expect(first.service.task({ taskId: 'split' }).state).toBe('completed')
    expect(first.service.deliveries()).toEqual([])
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // Recovery repairs the missing delivery instead of leaving the outcome
    // unannounced forever.
    const second = await durableHost(root)
    expect(second.service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['split@completed'])
  })

  it('marks an unreachable Session as queued without ending or re-dispatching the task', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    expect(await stateOf(service, 'task-1')).toBe('running')

    await service.register({
      taskId: 'task-2',
      sessionId: SessionId('session-elsewhere'),
      target: { kind: 'codex-thread', threadId: 't1' },
      acceptance: 'tests pass',
    })
    expect(service.task({ taskId: 'task-2' }).state).toBe('queued')
    // Neither task was cancelled, re-dispatched, or reported as an outcome.
    expect(service.task({ taskId: 'task-1' }).state).toBe('running')
    // A progress-only `running` state produces no notification by default.
    expect(service.deliveries()).toEqual([])
  })
})

describe('task feedback consumption ledger', () => {
  it('claims one delivery once, continues the owned claim, and skips after consumption', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()

    // Two copies of one notification may already be queued before any claim.
    const first = await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'codex-thread-1' })
    expect(first.action).toBe('review')
    expect(first.receipt.status).toBe('received')
    expect(first.receipt.ownerId).toBe('codex-thread-1')
    expect(first.receipt.claimEpoch).toBe(1)
    // The claim is the receiver's `received`, so the sender stops retrying.
    expect(service.deliveries()[0]).toMatchObject({ stage: 'received', acknowledged: true })

    const duplicate = await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'codex-thread-1' })
    expect(duplicate.action).toBe('resume')
    expect(duplicate.receipt.claimEpoch).toBe(1)

    await service.consume({ taskId: 'task-1', deliveryId: 'task-1@completed', claimEpoch: 1 })
    const consumed = await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'codex-thread-1' })
    expect(consumed.action).toBe('skip')
    expect(consumed.receipt.status).toBe('consumed')
  })

  it('gives exactly one concurrent consumer permission to work and answers the other busy', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()

    // Two duplicate messages race the same claim with no identity of their own.
    const results = await Promise.all([
      service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed' }),
      service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed' }),
    ])
    // Only `review` and `resume` authorize work, and only one consumer may hold
    // a live claim; the loser is `busy`, a distinct non-working answer.
    expect(results.filter(result => result.action === 'review')).toHaveLength(1)
    expect(results.filter(result => result.action === 'busy')).toHaveLength(1)
    expect(results.filter(result => result.action === 'resume')).toHaveLength(0)
    expect(service.receipts()).toHaveLength(1)
  })

  it('answers a second consumer busy while the owner works and resumes the owner', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()

    expect((await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'owner' })).action).toBe('review')
    const other = await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'intruder' })
    expect(other.action).toBe('busy')
    expect(other.receipt.ownerId).toBe('owner')
    // The owner still holds generation 1 and may continue.
    expect((await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'owner' })).action).toBe('resume')
  })

  it('treats a redelivered message as a duplicate when the acknowledgment was lost', async () => {
    const { service, receiver, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()
    await service.flush()
    expect(receiver.sent.map(delivery => delivery.deliveryId)).toEqual(['task-1@completed'])

    // The owner claimed it but its reply never reached the sender, so the
    // sender retries; the durable claim still guards the work.
    expect((await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'owner' })).action).toBe('review')
    await service.flush()
    expect((await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'other' })).action).toBe('busy')
    expect((await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'owner' })).action).toBe('resume')
  })

  it('resumes the same consumer after a restart and does not let a stale owner consume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-receipt-'))
    roots.push(root)

    const first = await durableHost(root)
    const session = first.ctx.sessions.create(SessionId('resume'), { meta: { cwd: '/workspace' } })
    await register(first.service, session, { taskId: 'resume', turn: 1 })
    completeTurn(session, 1)
    await first.service.settled()
    const firstClaim = await first.service.receive({ taskId: 'resume', deliveryId: 'resume@completed', consumerId: 'receiver-a' })
    expect(firstClaim.action).toBe('review')
    // The receiver process dies before the review finishes and before it
    // consumes the claim.
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    const second = await durableHost(root)
    // The durable ledger is the recovery point: the outstanding claim is still
    // visible, and the same consumer identity resumes its own review.
    expect(second.service.receipts().filter(receipt => receipt.status !== 'consumed').map(receipt => receipt.deliveryId))
      .toEqual(['resume@completed'])
    const resumed = await second.service.receive({ taskId: 'resume', deliveryId: 'resume@completed', consumerId: 'receiver-a' })
    expect(resumed.action).toBe('resume')
    expect(resumed.receipt.claimEpoch).toBe(1)
    await second.service.consume({ taskId: 'resume', deliveryId: 'resume@completed', claimEpoch: 1, consumerId: 'receiver-a' })
    expect(second.service.receipts()).toEqual([
      expect.objectContaining({ deliveryId: 'resume@completed', status: 'consumed' }),
    ])
  })

  it('lets a different consumer take over an expired claim and rejects the old owner', async () => {
    vi.useFakeTimers()
    const { service, createSession } = await harness({ claimLeaseMs: 1_000 })
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()

    const old = await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'old' })
    expect(old.action).toBe('review')
    // While the lease is live a different consumer is refused.
    expect((await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'new' })).action).toBe('busy')
    // After it expires the crashed consumer's claim is reclaimed with a new generation.
    vi.advanceTimersByTime(2_000)
    const takeover = await service.receive({ taskId: 'task-1', deliveryId: 'task-1@completed', consumerId: 'new' })
    expect(takeover.action).toBe('resume')
    expect(takeover.receipt.claimEpoch).toBe(2)
    expect(takeover.receipt.ownerId).toBe('new')
    // The old owner cannot finish a review the new owner now holds.
    await expect(service.consume({ taskId: 'task-1', deliveryId: 'task-1@completed', claimEpoch: 1, consumerId: 'old' }))
      .rejects.toMatchObject({ code: 'task-feedback/stale-claim' })
    await service.consume({ taskId: 'task-1', deliveryId: 'task-1@completed', claimEpoch: 2, consumerId: 'new' })
    expect(service.receipts()[0]?.status).toBe('consumed')
  })

  it('refuses to consume a delivery that was never claimed', async () => {
    const { service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    await service.settled()
    await expect(service.consume({ taskId: 'task-1', deliveryId: 'task-1@completed', claimEpoch: 1 }))
      .rejects.toMatchObject({ code: 'task-feedback/receipt-not-found' })
    await expect(service.receive({ taskId: 'task-1', deliveryId: 'task-1@missing' }))
      .rejects.toMatchObject({ code: 'task-feedback/delivery-not-found' })
  })
})

describe('task feedback persistence compatibility', () => {
  it('applies defaults to a task or receipt record that predates the ownership and resume fields', () => {
    const task = taskRecord.parse({
      taskId: 'legacy', sessionId: 'legacy-session', turn: null,
      target: { kind: 'codex-thread', threadId: 'thread-1' },
      acceptance: 'a stored bar', fromSeq: 0, state: 'failed', summary: 'the turn failed',
      evidence: { sessionId: 'legacy-session', turn: null, seq: null, eventSeqs: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(task).toMatchObject({
      parentTaskId: null, rootTaskId: null, attempt: 1, autoResumeCount: 0, autoResumeLimit: 0, resumeEligible: false,
      leakedToolSyntax: null,
    })
    const receipt = receiptRecord.parse({
      deliveryId: 'legacy@failed', taskId: 'legacy', status: 'received',
      claimedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(receipt).toMatchObject({
      ownerId: null, claimEpoch: 0, leaseExpiresAt: null,
      resumeAttempt: null, resumeRootTaskId: null, resumeSubmitted: false,
    })
  })
})

describe('task feedback bounded automatic resume', () => {
  it('submits one persisted resume for the reasoning_text condition and tracks the new turn', async () => {
    const { ctx, service, receiver, createSession } = await harness()
    const surface = provideResumeSurface(ctx)
    const session = createSession('resume-a')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()
    await service.flush()

    expect(service.task({ taskId: 'root' })).toMatchObject({ state: 'failed', resumeEligible: true })
    const value = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'codex-thread-1' })
    expect(value.decision).toBe('resumed')
    expect(value.attempt).toEqual({ taskId: 'root#r1', attempt: 2, requestId: 'task-feedback-resume:root:1' })
    expect(surface.calls).toHaveLength(1)
    expect(surface.calls[0]?.text).toContain('reasoning_text must be passed back')
    // The original failed task is unchanged; the follow-up attempt is its own record.
    expect(service.task({ taskId: 'root' }).state).toBe('failed')
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'accepted',
      parentTaskId: 'root',
      rootTaskId: 'root',
      attempt: 2,
    })

    // The resumed turn completes and feeds back to the original Codex target.
    completeTurn(session, 2)
    await service.settled()
    await service.flush()
    expect(service.task({ taskId: 'root#r1' }).state).toBe('completed')
    expect(service.task({ taskId: 'root' }).state).toBe('failed')
    expect(receiver.sent.map(delivery => delivery.deliveryId)).toContain('root#r1@completed')
  })

  it('never admits a second resume for a duplicate notification', async () => {
    const { ctx, service, createSession } = await harness()
    const surface = provideResumeSurface(ctx)
    const session = createSession('resume-dup')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()
    await service.flush()

    const first = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    const second = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(first.decision).toBe('resumed')
    expect(second.decision).toBe('resumed')
    expect(second.attempt).toEqual(first.attempt)
    expect(surface.calls).toHaveLength(1)
    expect(service.task({ taskId: 'root' }).autoResumeCount).toBe(1)
  })

  it('completes an admitted attempt on replay after a submission failure', async () => {
    const { ctx, service, createSession } = await harness()
    const surface = provideResumeSurface(ctx)
    const session = createSession('resume-crash')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()
    await service.flush()

    surface.failNext = true
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-submit-failed' })
    // The attempt was admitted durably before submission, so the budget is spent
    // and the replay presents the same instruction instead of a new attempt.
    expect(service.task({ taskId: 'root' }).autoResumeCount).toBe(1)
    expect(surface.calls).toHaveLength(1)
    expect(service.receipts()[0]?.status).toBe('received')

    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(replay.decision).toBe('resumed')
    expect(replay.attempt?.requestId).toBe('task-feedback-resume:root:1')
    expect(surface.calls.map(call => call.requestId)).toEqual([
      'task-feedback-resume:root:1',
      'task-feedback-resume:root:1',
    ])
    // Only the replayed attempt's single instruction was admitted to the Session.
    expect(service.receipts()[0]?.status).toBe('received')
  })

  it('executes the notification claim and recovery under one consumer identity', async () => {
    const { ctx, service, createSession } = await harness()
    const surface = provideResumeSurface(ctx)
    const session = createSession('resume-notice')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()

    const delivery = service.deliveries()[0]!
    const notice = composeWakeMessage(delivery.payload, delivery.deliveryId)
    // The notification names the same stable identity for both steps, so a
    // receiver that follows it in order cannot block itself with a new owner.
    expect(notice).toContain('receive root root@failed --consumer <stable id>')
    expect(notice).toContain('resume-failed root root@failed --consumer <the same stable id given to receive>')

    expect(await service.receive({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'codex-stable' }))
      .toMatchObject({ action: 'review' })
    // Following the recover line without repeating the id continues the claim
    // the receiver already owns instead of minting a second, blocked one.
    const resumed = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' })
    expect(resumed.decision).toBe('resumed')
    // A repeated notification finds the instruction already submitted and does
    // no further work.
    expect((await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' })).decision).toBe('resumed')
    expect(surface.calls).toHaveLength(1)
    expect(service.task({ taskId: 'root' }).autoResumeCount).toBe(1)
  })

  it('does not append a stale admitted continuation after a manual turn started', async () => {
    const { ctx, service, createSession } = await harness()
    const surface = provideResumeSurface(ctx)
    const session = createSession('resume-manual')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()

    surface.failNext = true
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-submit-failed' })
    // The operator starts a new turn before the receiver retries the same
    // notification. The admitted-but-unsubmitted attempt must re-validate and
    // stand down rather than append the stale automatic continuation.
    session.append('turn/start', { turn: 2 })
    const replayed = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(['running', 'superseded']).toContain(replayed.decision)
    expect(surface.calls).toHaveLength(1)
    expect(service.task({ taskId: 'root' }).autoResumeCount).toBe(1)
  })

  it('does not leave an attempt task bound to a manual turn after a failed submission', async () => {
    const { ctx, service, createSession } = await harness()
    const surface = provideResumeSurface(ctx)
    const session = createSession('resume-orphan-attempt')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()

    surface.failNext = true
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-submit-failed' })
    // The instruction was never accepted, so no follow-up task exists to settle
    // the operator's manual turn as if it were the automatic resume.
    expect(() => service.task({ taskId: 'root#r1' })).toThrow()
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await service.settled()
    expect(() => service.task({ taskId: 'root#r1' })).toThrow()
    expect(service.deliveries().map(delivery => delivery.deliveryId)).not.toContain('root#r1@completed')
  })

  it('re-validates an admitted but unsubmitted attempt against every replacement', async () => {
    // A newer queued message replaces the failure before the retry.
    const queued = await harness()
    const queuedSurface = provideResumeSurface(queued.ctx)
    const queuedSession = queued.createSession('resume-admitted-queued')
    await register(queued.service, queuedSession, { taskId: 'root', turn: 1 })
    failTurn(queuedSession, 1)
    await queued.service.settled()
    queuedSurface.failNext = true
    await expect(queued.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-submit-failed' })
    providePendingInput(queued.ctx, 'resume-admitted-queued')
    expect((await queued.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('superseded')
    expect(queuedSurface.calls).toHaveLength(1)

    // A later turn ending with a different outcome replaces the failure.
    const later = await harness()
    const laterSurface = provideResumeSurface(later.ctx)
    const laterSession = later.createSession('resume-admitted-later')
    await register(later.service, laterSession, { taskId: 'root', turn: 1 })
    failTurn(laterSession, 1)
    await later.service.settled()
    laterSurface.failNext = true
    await expect(later.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-submit-failed' })
    laterSession.append('turn/start', { turn: 2 })
    laterSession.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'parent' } } })
    expect((await later.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('superseded')
    expect(laterSurface.calls).toHaveLength(1)
  })

  it('counts one admission once when either resume write fails', async () => {
    // The receipt write is the admission commit point: when it fails, a replay
    // retries the same index instead of spending a second one.
    const receipt = await harness()
    provideResumeSurface(receipt.ctx)
    const receiptSession = receipt.createSession('resume-receipt-write')
    await register(receipt.service, receiptSession, { taskId: 'root', turn: 1 })
    failTurn(receiptSession, 1)
    await receipt.service.settled()
    const receipts = privateTable(receipt.service, 'requireReceipts') as KvTable<string, ReceiptRecordState>
    const originalReceiptPut = receipts.put.bind(receipts)
    let failed = false
    vi.spyOn(receipts, 'put').mockImplementation(async (key, value) => {
      if (!failed && value.resumeAttempt === 1) {
        failed = true
        throw new Error('receipt write failed')
      }
      await originalReceiptPut(key, value)
    })
    await expect(receipt.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' }))
      .rejects.toThrow('receipt write failed')
    expect((await receipt.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('resumed')
    expect(receipt.service.task({ taskId: 'root' }).autoResumeCount).toBe(1)

    // The root task count is only a cache of the receipt ledger: losing that
    // write cannot lose the admission or let a replay spend budget again.
    const cache = await harness()
    const surface = provideResumeSurface(cache.ctx)
    const cacheSession = cache.createSession('resume-cache-write')
    await register(cache.service, cacheSession, { taskId: 'root', turn: 1 })
    failTurn(cacheSession, 1)
    await cache.service.settled()
    const tasks = privateTable(cache.service, 'requireTasks') as KvTable<string, TaskRecordState>
    const originalTaskPut = tasks.put.bind(tasks)
    vi.spyOn(tasks, 'put').mockImplementation(async (key, value) => {
      if (key === 'root' && value.autoResumeCount === 1) throw new Error('task write failed')
      await originalTaskPut(key, value)
    })
    const warn = vi.spyOn(cache.ctx.logger, 'warn').mockImplementation(() => {})
    expect((await cache.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('resumed')
    expect((await cache.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('resumed')
    expect(cache.service.task({ taskId: 'root' }).autoResumeCount).toBe(1)
    expect(surface.calls).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })

  it('refuses a failure that is not the exact reasoning_text protocol condition', async () => {
    const cases: { message: string; code: string; status: number }[] = [
      { message: 'the log mentions reasoning_text somewhere', code: 'INVALID_REQUEST', status: 400 },
      { message: 'reasoning_text must be passed back', code: 'INVALID_REQUEST', status: 500 },
      { message: 'reasoning_text must be passed back', code: 'VALIDATION_ERROR', status: 400 },
    ]
    for (const [index, failure] of cases.entries()) {
      const { ctx, service, createSession } = await harness()
      const surface = provideResumeSurface(ctx)
      const session = createSession(`resume-na-${String(index)}`)
      await register(service, session, { taskId: 'root', turn: 1 })
      failTurn(session, 1, failure)
      await service.settled()
      await service.flush()

      expect(service.task({ taskId: 'root' }).resumeEligible).toBe(false)
      const value = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
      expect(value.decision).toBe('not-applicable')
      expect(surface.calls).toHaveLength(0)
      expect(service.task({ taskId: 'root' }).autoResumeCount).toBe(0)
    }
  })

  it('refuses to resume when a newer turn, message, or cancellation replaced the failure', async () => {
    // A manual continuation already running.
    const running = await harness()
    provideResumeSurface(running.ctx)
    const runningSession = running.createSession('resume-running')
    await register(running.service, runningSession, { taskId: 'root', turn: 1 })
    failTurn(runningSession, 1)
    await running.service.settled()
    await running.service.flush()
    runningSession.append('turn/start', { turn: 2 })
    expect((await running.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' })).decision).toBe('running')

    // A newer user message is queued but its turn has not started.
    const queued = await harness()
    provideResumeSurface(queued.ctx)
    const queuedSession = queued.createSession('resume-queued')
    await register(queued.service, queuedSession, { taskId: 'root', turn: 1 })
    failTurn(queuedSession, 1)
    await queued.service.settled()
    await queued.service.flush()
    providePendingInput(queued.ctx, 'resume-queued')
    expect((await queued.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' })).decision).toBe('superseded')

    // The Session already recorded a later, different outcome.
    const later = await harness()
    provideResumeSurface(later.ctx)
    const laterSession = later.createSession('resume-later')
    await register(later.service, laterSession, { taskId: 'root', turn: 1 })
    failTurn(laterSession, 1)
    await later.service.settled()
    await later.service.flush()
    laterSession.append('turn/start', { turn: 2 })
    laterSession.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'parent' } } })
    expect((await later.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' })).decision).toBe('superseded')
  })

  it('persists the resume budget across attempts, a restart, and a retry task id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-resume-budget-'))
    roots.push(root)
    const first = await durableHost(root, { maxAutoResumes: 2 })
    const surface = provideResumeSurface(first.ctx)
    const session = first.ctx.sessions.create(SessionId('budget'), { meta: { cwd: '/workspace' } })
    await register(first.service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await first.service.settled()
    await first.service.flush()

    expect((await first.service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' })).decision).toBe('resumed')
    failTurn(session, 2)
    await first.service.settled()
    await first.service.flush()
    expect((await first.service.resumeFailed({ taskId: 'root#r1', deliveryId: 'root#r1@failed' })).decision).toBe('resumed')
    expect(first.service.task({ taskId: 'root' }).autoResumeCount).toBe(2)

    failTurn(session, 3)
    await first.service.settled()
    await first.service.flush()
    // The third failure is past the configured ceiling.
    expect((await first.service.resumeFailed({ taskId: 'root#r2', deliveryId: 'root#r2@failed' })).decision)
      .toBe('budget-exhausted')
    expect(surface.calls).toHaveLength(2)

    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)
    const second = await durableHost(root, { maxAutoResumes: 2 })
    // The spent budget survived the restart instead of resetting.
    expect(second.service.task({ taskId: 'root' })).toMatchObject({ autoResumeCount: 2, autoResumeLimit: 2 })
    const retrySession = second.ctx.sessions.create(SessionId('budget-retry'), { meta: { cwd: '/workspace' } })
    await second.service.register({
      taskId: 'root-retry',
      sessionId: retrySession.id,
      turn: 1,
      target: { kind: 'codex-thread', threadId: 'thread-explicit-1' },
      acceptance: 'the reviewer checks the recorded evidence',
      rootTaskId: 'root',
    })
    // A retry under a new task id mirrors the original budget instead of resetting it.
    expect(second.service.task({ taskId: 'root-retry' })).toMatchObject({ autoResumeCount: 2, autoResumeLimit: 2, rootTaskId: 'root' })
  })

  it('offers the resume operation in the notification only for the eligible failure', async () => {
    const { service, createSession } = await harness()
    const session = createSession('resume-message')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()
    const eligible = service.deliveries()[0]!
    expect(eligible.payload.resumeEligible).toBe(true)
    const notice = composeWakeMessage(eligible.payload, eligible.deliveryId)
    expect(notice).toContain('receive root root@failed')
    expect(notice).toContain('consume root root@failed')
    expect(notice).toContain('resume-failed root root@failed')
    expect(notice).toContain('budget-exhausted')

    const plain = composeWakeMessage({ ...eligible.payload, resumeEligible: false }, eligible.deliveryId)
    expect(plain).not.toContain('resume-failed')
  })

  it('fails loud when no Session prompt surface is mounted', async () => {
    const { service, createSession } = await harness()
    const session = createSession('resume-unavailable')
    await register(service, session, { taskId: 'root', turn: 1 })
    failTurn(session, 1)
    await service.settled()
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-unavailable' })
  })
})

describe('task feedback automatic delivery', () => {
  it('delivers a settled task without any explicit flush call', async () => {
    vi.useFakeTimers()
    const { service, receiver, createSession } = await autoHarness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)

    // The whole point of the dispatcher contract: nothing calls flush here.
    await runScheduler(service)

    expect(receiver.sent.map(delivery => delivery.deliveryId)).toEqual(['task-1@completed'])
    // A transport handoff is `delivered`; the wake claim still needs the
    // receiving Session's own acknowledgment.
    expect(service.deliveries().map(delivery => delivery.stage)).toEqual(['delivered'])
    expect(service.deliveries().every(delivery => !delivery.acknowledged)).toBe(true)
  })

  it('does not enqueue an accepted notification again while its receiver has not claimed it', async () => {
    vi.useFakeTimers()
    const { service, receiver, createSession } = await autoHarness({ ackTimeoutMs: 1_000 })
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)

    await runScheduler(service)
    expect(service.deliveries()[0]).toMatchObject({ stage: 'delivered', attempts: 1, acknowledged: false, nextAttemptAt: null })
    await runScheduler(service, 60_000)
    expect(receiver.sent).toHaveLength(1)
    expect(service.deliveries()[0]?.attempts).toBe(1)
    expect(await service.flush()).toMatchObject({ attempted: 0, pending: 1 })
  })

  it('never misses a delivery whose enqueue write is still in flight', async () => {
    // The window this closes: the watcher's live state updates before its
    // outbox write lands, so a pass started in between must wait for the write
    // rather than reading an outbox that does not hold the delivery yet.
    const { service, receiver, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)

    // No awaiting of `settled()` first: this is the racy call.
    const flushed = await service.flush()
    expect(flushed).toMatchObject({ attempted: 1, delivered: 1, pending: 1 })
    expect(receiver.sent.map(delivery => delivery.deliveryId)).toEqual(['task-1@completed'])
  })

  it('notifies each observed state once and re-delivers no state twice', async () => {
    vi.useFakeTimers()
    const { service, receiver, createSession } = await autoHarness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    session.append('approval/asked', { id: ApprovalRequestId('approval-1'), toolName: 'bash' })
    session.append('approval/decided', { id: ApprovalRequestId('approval-1'), outcome: 'allowed-once' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await runScheduler(service)

    expect(service.deliveries().map(delivery => delivery.deliveryId))
      .toEqual(['task-1@waiting_approval@1', 'task-1@completed'])
    const sent = receiver.sent.length
    expect(sent).toBe(2)
    for (const delivery of service.deliveries()) {
      await service.ack({ taskId: 'task-1', deliveryId: delivery.deliveryId, stage: 'received' })
    }

    // A replayed approval decision and a duplicated terminal event describe
    // states already delivered: neither may produce another notification.
    session.append('approval/decided', { id: ApprovalRequestId('approval-1'), outcome: 'rejected' })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'late', code: 'X' } } })
    await runScheduler(service, 60_000)
    expect(receiver.sent.length).toBe(sent)
    expect(service.task({ taskId: 'task-1' }).state).toBe('completed')
  })

  it('stops attempting an unreachable transport at the attempt budget without a busy loop', async () => {
    vi.useFakeTimers()
    // The shipped default adapter refuses; the service must stop by itself.
    const ctx = new Context()
    owned.add(ctx)
    await mountMemoryStorage(ctx)
    await mountSessionStack(ctx)
    await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: true, maxDeliveryAttempts: 3, retryBaseMs: 100, retryMaxMs: 400 }))
    const session = ctx.sessions.create(SessionId('session-a'), { meta: { cwd: '/workspace' } })
    await register(ctx.taskFeedback, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)

    await runScheduler(ctx.taskFeedback, 10_000)
    const attempts = ctx.taskFeedback.deliveries()[0]?.attempts
    expect(attempts).toBe(3)

    // Ten more minutes must not produce another attempt: the budget is spent.
    await runScheduler(ctx.taskFeedback, 600_000)
    expect(ctx.taskFeedback.deliveries().map(delivery => delivery.attempts)).toEqual([3])
    expect(ctx.taskFeedback.deliveries().every(delivery => delivery.stage === 'enqueued')).toBe(true)
    expect((await ctx.taskFeedback.wake()).status).toBe('not-connected')
    // A refused delivery never rewrites what the Session recorded.
    expect(ctx.taskFeedback.task({ taskId: 'task-1' })).toMatchObject({
      state: 'completed',
      summary: 'the turn completed',
    })
  })

  it('waits out the capped backoff before retrying a refused delivery', async () => {
    vi.useFakeTimers()
    const { service, receiver, createSession } = await autoHarness({ retryBaseMs: 1_000, retryMaxMs: 4_000 })
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    receiver.accepts = false

    await runScheduler(service)
    expect(service.deliveries()[0]).toMatchObject({ attempts: 1, stage: 'enqueued' })
    expect(service.deliveries()[0]?.nextAttemptAt).not.toBeNull()

    // Before the deadline: no second attempt.
    await runScheduler(service, 500)
    expect(service.deliveries()[0]?.attempts).toBe(1)
    // After it: exactly one more.
    await runScheduler(service, 1_000)
    expect(service.deliveries()[0]?.attempts).toBe(2)
  })

  it('sends every delivery once when explicit flushes race the scheduler', async () => {
    vi.useFakeTimers()
    const { service, receiver, createSession } = await autoHarness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)

    await Promise.all([service.flush(), service.flush()])
    await runScheduler(service)

    const ids = receiver.sent.map(delivery => delivery.deliveryId)
    expect(ids).toEqual(['task-1@completed'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(service.deliveries().map(delivery => delivery.stage)).toEqual(['delivered'])
  })

  it('cancels the pending wake-up and waits for the pass on unload', async () => {
    vi.useFakeTimers()
    const { ctx, service, receiver, createSession } = await autoHarness({ retryBaseMs: 1_000 })
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    completeTurn(session, 1)
    receiver.accepts = false

    await runScheduler(service)
    const sendsBeforeUnload = receiver.sent.length
    expect(service.deliveries()[0]?.attempts).toBe(1)

    await ctx.fiber.dispose()
    owned.delete(ctx)
    // The armed retry is gone: time passing must not reach the transport again.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(receiver.sent.length).toBe(sendsBeforeUnload)
  })

  it('does not re-enqueue a transport-accepted delivery after a restart', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-auto-'))
    roots.push(root)

    /** One Host generation over the same durable root. */
    const generation = async (replay: (session: Session) => void): Promise<{ ctx: Context; service: TaskFeedback }> => {
      const ctx = new Context()
      owned.add(ctx)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await mountSessionStack(ctx)
      const session = ctx.sessions.create(SessionId('session-a'), { meta: { cwd: '/workspace' } })
      replay(session)
      await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: true, retryBaseMs: 1_000 }))
      return { ctx, service: ctx.taskFeedback }
    }

    const first = await generation(() => {})
    const firstSession = first.ctx.sessions.get(SessionId('session-a')) as Session
    await register(first.service, firstSession, { taskId: 'done', turn: 1 })
    completeTurn(firstSession, 1)
    // The receiver accepts delivery but its acknowledgment is lost.
    await first.service.settled()
    first.service.setWakeAdapter(new SimulatedReceiver())
    await runScheduler(first.service)
    expect(first.service.deliveries().map(delivery => ({ stage: delivery.stage, attempts: delivery.attempts })))
      .toEqual([{ stage: 'delivered', attempts: 1 }])
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // The restart installs a transport and lets the recovery schedule run.
    // A successful queue handoff belongs to the receiver from this point;
    // only that receiver can recover its unconsumed receipt after restart.
    const second = await generation((session) => { completeTurn(session, 1) })
    const receiver = new SimulatedReceiver()
    second.service.setWakeAdapter(receiver)
    await runScheduler(second.service, 30_000)
    expect(receiver.sent).toEqual([])
    expect(second.service.deliveries().map(delivery => delivery.stage)).toEqual(['delivered'])
    expect(second.service.deliveries().every(delivery => !delivery.acknowledged)).toBe(true)
  })
})

describe('task feedback notification policy', () => {
  it('does not notify running by default', async () => {
    const { service, receiver, createSession } = await autoHarness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    await service.settled()
    await service.flush()
    // A progress state is observed and recorded, but it does not wake the
    // reviewer's model: no delivery and no transport attempt exist.
    expect(service.task({ taskId: 'task-1' }).state).toBe('running')
    expect(service.deliveries()).toEqual([])
    expect(receiver.sent).toEqual([])

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.settled()
    expect(service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['task-1@completed'])
  })

  it('notifies running only when the deployment adds the state', async () => {
    const { service, createSession } = await harness({ notifyStates: ['running', 'completed'] })
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    await service.settled()
    expect(service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['task-1@running'])
  })

  it('notifies two distinct questions at one log cursor', async () => {
    const { ctx, service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    const ask = (id: string): Promise<unknown> => ctx.waterfall(
      'user-questions/request',
      { questions: [{ id, question: id }], agent: { session } as never },
      () => Promise.resolve({ answers: [] }),
    )
    // No log event separates these two asks: each is a different request, so
    // each is a different pause and neither may be merged into the other.
    await ask('q-1')
    await service.settled()
    await ask('q-2')
    await service.settled()
    expect(service.deliveries().map(delivery => delivery.deliveryId)).toHaveLength(2)
    expect(service.deliveries().every(delivery => delivery.payload.state === 'waiting_input')).toBe(true)
  })

  it('never generates a second notification for the same event', async () => {
    const { ctx, service, createSession } = await harness()
    const session = createSession('session-a')
    await register(service, session, { taskId: 'task-1', turn: 1 })
    session.append('turn/start', { turn: 1 })
    await ctx.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q-1', question: 'first' }], agent: { session } as never },
      () => Promise.resolve({ answers: [] }),
    )
    await service.settled()
    expect(service.deliveries()).toHaveLength(1)
    // Replaying the same request at the same cursor and with the same question
    // ids is the same observation, not a second pause.
    await ctx.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q-1', question: 'first' }], agent: { session } as never },
      () => Promise.resolve({ answers: [] }),
    )
    await service.settled()
    expect(service.deliveries()).toHaveLength(1)
  })

  it('retires an unacknowledged legacy running delivery after an upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-legacy-'))
    roots.push(root)

    /** One Host generation over the same durable root, with chosen notify states. */
    const generation = async (
      notifyStates: TaskState[],
      replay: (session: Session) => void = () => {},
    ): Promise<{ ctx: Context; service: TaskFeedback }> => {
      const ctx = new Context()
      owned.add(ctx)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await mountSessionStack(ctx)
      const session = ctx.sessions.create(SessionId('session-a'), { meta: { cwd: '/workspace' } })
      replay(session)
      await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false, notifyStates }))
      return { ctx, service: ctx.taskFeedback }
    }

    // An older build enqueued `running`; the receiver never acknowledged it.
    const first = await generation(['running', 'completed'])
    const firstSession = first.ctx.sessions.get(SessionId('session-a')) as Session
    await register(first.service, firstSession, { taskId: 'legacy', turn: 1 })
    firstSession.append('turn/start', { turn: 1 })
    await first.service.settled()
    expect(first.service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['legacy@running'])
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // The upgrade defaults to outcome/pause states only: the old entry stops
    // being scheduled instead of being re-sent at the next attempt.
    const second = await generation(
      ['completed', 'failed', 'waiting_approval', 'waiting_input'],
      (session) => { session.append('turn/start', { turn: 1 }) },
    )
    const receiver = new SimulatedReceiver()
    second.service.setWakeAdapter(receiver)
    const legacy = second.service.deliveries().find(delivery => delivery.deliveryId === 'legacy@running')
    expect(legacy).toMatchObject({ retired: true, acknowledged: false, nextAttemptAt: null })
    expect(await second.service.flush()).toMatchObject({ attempted: 0, delivered: 0 })
    expect(receiver.sent).toEqual([])
  })
})

describe('task feedback wake configuration', () => {
  it('fails the load when codex-queue has no executable', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountMemoryStorage(ctx)
    await mountSessionStack(ctx)
    await expect(ctx.plugin(TaskFeedback, TaskFeedback.Config({
      autoDeliver: false, wakeTransport: 'codex-queue',
    }))).rejects.toThrow(/wakeExecutable is required/)
  })

  it('fails the load when wsl has no distribution', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountMemoryStorage(ctx)
    await mountSessionStack(ctx)
    await expect(ctx.plugin(TaskFeedback, TaskFeedback.Config({
      autoDeliver: false, wakeTransport: 'codex-queue', wakeExecution: 'wsl', wakeExecutable: '/usr/local/bin/codex',
    }))).rejects.toThrow(/wakeDistro is required/)
  })

  it('probes an explicitly configured native executable instead of claiming connected', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountMemoryStorage(ctx)
    await mountSessionStack(ctx)
    // Node with `--version` is a real executable that exits 0, so the probe
    // reports what it observed. It says the entry started, not that a target
    // thread or delivery channel exists.
    await ctx.plugin(TaskFeedback, TaskFeedback.Config({
      autoDeliver: false, wakeTransport: 'codex-queue', wakeExecution: 'native', wakeExecutable: process.execPath,
    }))
    const status = await ctx.taskFeedback.wake()
    expect(status).toMatchObject({ adapter: 'codex-queue', status: 'executable-started' })
    expect(status.detail).toContain('does not prove the target thread')
    expect(status.status).not.toBe('connected')
  })

  it('reports not-connected when the configured executable cannot start', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountMemoryStorage(ctx)
    await mountSessionStack(ctx)
    await ctx.plugin(TaskFeedback, TaskFeedback.Config({
      autoDeliver: false,
      wakeTransport: 'codex-queue',
      wakeExecution: 'native',
      wakeExecutable: 'definitely-not-an-executable-xyz',
    }))
    const status = await ctx.taskFeedback.wake()
    expect(status.status).toBe('not-connected')
    expect(status.reason).toContain('could not start')
  })
})
