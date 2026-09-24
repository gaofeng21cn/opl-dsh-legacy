/**
 * Task feedback: registration, the model-free watcher, and the durable outbox.
 *
 * Every case runs on the real session log, the real projection registry, the
 * real domain storage, and a simulated receiving Session. No model, no API
 * key, and no network take part: what is under test is which durable fact moves
 * a task, and what a notification is allowed to claim.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
// Relative source import: the wait fold is the session controller's own
// projection, and this spec mounts it exactly as that controller does.
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import TaskFeedback from '../src/index.ts'
import type { WakeAdapter, WakeDelivery } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const owned = new Set<Context>()
const roots: string[] = []
let serial = 0

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
    return Promise.resolve({ started: true, detail: 'simulated transport is reachable' })
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

/** Complete one turn on a Session, the way the loop's own events do. */
function completeTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}


describe('independent review regressions', () => {
  it('times out a transport attempt and retries without blocking other deliveries', async () => {
    vi.useFakeTimers()
    const { service, createSession } = await autoHarness({ sendTimeoutMs: 100, retryBaseMs: 100 })
    const session = createSession('timeout')
    await register(service, session, { taskId: 'timeout', turn: 1 })
    completeTurn(session, 1)
    let attempts = 0
    service.setWakeAdapter({ id: 'hang-once', send() {
      attempts += 1
      return attempts === 1 ? new Promise(() => {}) : Promise.resolve({ accepted: true, detail: 'ok' })
    }, probe: () => Promise.resolve({ started: true, detail: 'ok' }) })
    await service.settled()
    await vi.advanceTimersByTimeAsync(500)
    await service.idle()
    expect(attempts).toBe(2)
    expect(service.deliveries().every(d => d.stage === 'delivered')).toBe(true)
  })
  it('bounds a hung transport and aborts it on unload', async () => {
    const { ctx, service, createSession } = await harness()
    const session = createSession('hung')
    await register(service, session, { taskId: 'hung', turn: 1 })
    completeTurn(session, 1)
    await service.settled()
    const started = Promise.withResolvers<undefined>()
    let aborted = false
    service.setWakeAdapter({ id: 'hung', send(_delivery, signal) {
      started.resolve(undefined)
      signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Promise(() => {})
    }, probe: () => Promise.resolve({ started: true, detail: 'ok' }) })
    const pass = service.flush()
    await started.promise
    await ctx.fiber.dispose()
    owned.delete(ctx)
    await pass
    expect(aborted).toBe(true)
  })

  it('serializes concurrent acknowledgments without downgrading review-started', async () => {
    const { service, createSession } = await harness()
    const session = createSession('concurrent-ack')
    await register(service, session, { taskId: 'ack', turn: 1 })
    completeTurn(session, 1)
    await service.settled()
    await Promise.all([
      service.ack({ taskId: 'ack', deliveryId: 'ack@completed', stage: 'review-started' }),
      service.ack({ taskId: 'ack', deliveryId: 'ack@completed', stage: 'received' }),
    ])
    expect(service.deliveries().find(d => d.deliveryId === 'ack@completed')?.stage).toBe('review-started')
  })

  it('keeps a future turn registration unchanged during the current turn', async () => {
    const { service, createSession } = await harness()
    const session = createSession('future-turn')
    await register(service, session, { taskId: 'future', turn: 2 })
    await register(service, session, { taskId: 'current', turn: 1 })
    session.append('turn/start', { turn: 1 })
    session.append('approval/asked', { id: ApprovalRequestId('current-ask'), toolName: 'bash' })
    await service.settled()
    expect(service.task({ taskId: 'future' }).state).toBe('accepted')
    expect(service.task({ taskId: 'current' }).state).toBe('waiting_approval')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.settled()
    expect(service.task({ taskId: 'current' }).state).toBe('completed')
  })
  it('preserves an ack received before transport send resolves', async () => {
    const { service,createSession }=await harness(); const session=createSession('ack-race')
    await register(service,session,{ taskId:'ack',turn:1 }); completeTurn(session,1); await service.settled()
    service.setWakeAdapter({ id:'ack-first',async send(d){
      await service.ack({ taskId:'ack',deliveryId:d.deliveryId,stage:'review-started' })
      return { accepted:true,detail:'ok' }
    }, probe: () => Promise.resolve({ started: true, detail: 'ok' }) })
    await service.flush()
    expect(service.deliveries().every(d=>d.stage==='review-started' && d.acknowledged)).toBe(true)
  })
  it('notifies a second distinct approval in the same turn', async () => {
    const { service,createSession,receiver }=await harness(); const session=createSession('repeat-approval')
    await register(service,session,{ taskId:'approval',turn:1 });session.append('turn/start',{ turn:1 })
    session.append('approval/asked',{ id:ApprovalRequestId('one'),toolName:'bash' });await service.flush()
    session.append('approval/decided',{ id:ApprovalRequestId('one'),outcome:'allowed-once' })
    session.append('approval/asked',{ id:ApprovalRequestId('two'),toolName:'bash' });await service.flush()
    expect(receiver.sent.filter(d=>d.message.includes('waiting_approval'))).toHaveLength(2)
  })
  it('observes both registered tasks on the same session', async () => {
    const { service,createSession }=await harness(); const session=createSession('shared')
    await register(service,session,{ taskId:'first',turn:1 });await register(service,session,{ taskId:'second',turn:1 })
    completeTurn(session,1);await service.settled()
    expect(service.task({ taskId:'second' }).state).toBe('completed')
  })
  it('does not re-enqueue an accepted message when its receipt is delayed', async () => {
    vi.useFakeTimers();const { service,createSession,receiver }=await autoHarness({ retryBaseMs:100 })
    const session=createSession('delayed-receipt');await register(service,session,{ taskId:'delayed',turn:1 });completeTurn(session,1)
    await service.settled();await vi.advanceTimersByTimeAsync(1000);await service.idle()
    const first=receiver.sent.length;expect(first).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(600000);await service.idle()
    expect(receiver.sent.length).toBe(first)
    expect(service.deliveries()[0]).toMatchObject({ stage:'delivered',acknowledged:false,nextAttemptAt:null })
  })
  it('contains transport exceptions and records a retry', async () => {
    const { service,createSession }=await harness();const session=createSession('throws')
    await register(service,session,{ taskId:'throws',turn:1 });completeTurn(session,1);await service.settled()
    service.setWakeAdapter({ id:'throw',async send(){throw new Error('network disconnected')}, probe: () => Promise.resolve({ started: true, detail: 'ok' }) })
    await expect(service.flush()).resolves.toMatchObject({ delivered:0 })
    expect(service.deliveries()[0]?.attempts).toBe(1)
  })
})
