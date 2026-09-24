/**
 * Task feedback: telling an unusable outcome apart from a finished one.
 *
 * These cases pin the boundaries a dispatcher acts on. A `completed` turn whose
 * final visible text carries tool protocol syntax is reported as completed with
 * an explicit unverified outcome instead of a business success. An SSE stream
 * that ended without `[DONE]`, a reasoning_text failure, an operator stop, and a
 * manual continuation each keep their own state, reason, and recovery answer.
 *
 * Every case runs the real Session log, projections, storage, and service. The
 * only doubles are the prompt surface and the Agent registry's inbox, which are
 * the same external seams the production deployment supplies.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
// Relative source import: the wait fold is the session controller's own
// projection, and this spec mounts it exactly as that controller does.
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import TaskFeedback from '../src/index.ts'
import { composeWakeMessage } from '../src/wake.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const owned = new Set<Context>()
const roots: string[] = []
let serial = 0

/** The DSML wrapper the observed DeepSeek markup spells its tool tags with. */
const BAR = '｜'

/** One tool-invocation tag in the DSML-wrapped spelling a leaked message used. */
function dsmlTag(name: string): string {
  return `<${BAR}DSML${BAR}${name}>`
}

afterEach(async () => {
  vi.useRealTimers()
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
 * The Session's live Inbox, as this watcher reads and mutates it.
 *
 * A queued prompt lives here until a turn claims it, which is what makes a
 * manual stop able to withdraw one; `remove` reports whether the occurrence was
 * still pending, exactly as the production Inbox does.
 */
class RecordingInbox {
  readonly nextTurn: { id: string; source: { kind: string; rpcId?: string } }[] = []
  readonly nextStep: { id: string; source: { kind: string; rpcId?: string } }[] = []
  private minted = 0

  /**
   * Queue one message the way the Session controller's queued prompt does.
   * @param requestId - the submitted prompt's durable identity.
   * @returns the queued occurrence's identity.
   */
  queue(requestId: string): string {
    this.minted += 1
    const id = `inbox-${String(this.minted)}`
    this.nextTurn.push({ id, source: { kind: 'user', rpcId: requestId } })
    return id
  }

  /**
   * Remove one pending occurrence.
   * @param messageId - identity returned by {@link queue}.
   * @returns whether the occurrence was still pending.
   */
  remove(messageId: string): boolean {
    for (const list of [this.nextTurn, this.nextStep]) {
      const index = list.findIndex(message => message.id === messageId)
      if (index === -1) continue
      list.splice(index, 1)
      return true
    }
    return false
  }
}

/**
 * A prompt surface that queues instead of recording.
 *
 * The production controller admits a queued prompt into the inbox and the loop
 * records it inside the turn that claims it, so an instruction that no turn has
 * claimed yet exists only in the inbox. This double keeps that timing.
 */
class QueuedPromptSurface {
  readonly calls: { requestId: string; text: string }[] = []

  constructor(private readonly inbox: RecordingInbox) {}

  prompt(request: { requestId: string; content: readonly { type: string; text?: string }[] }): Promise<{ accepted: true }> {
    const text = request.content.find(part => part.type === 'text')?.text ?? ''
    this.calls.push({ requestId: request.requestId, text })
    this.inbox.queue(request.requestId)
    return Promise.resolve({ accepted: true })
  }
}

/** A Host with the real session stack, the service, a queued prompt surface, and its inbox. */
async function harness(config: Record<string, unknown> = {}): Promise<{
  ctx: Context
  service: TaskFeedback
  surface: QueuedPromptSurface
  inbox: RecordingInbox
  createSession: (id: string) => Session
}> {
  const ctx = new Context()
  owned.add(ctx)
  await mountMemoryStorage(ctx)
  await mountSessionStack(ctx)
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false, ...config }))
  const inbox = new RecordingInbox()
  const surface = new QueuedPromptSurface(inbox)
  ctx.provide('sessionController', surface as never)
  const sessionIds = new Set<string>()
  ctx.provide('agents', {
    get: (id: string) => sessionIds.has(id) ? { inbox } : undefined,
  } as never)
  return {
    ctx,
    service: ctx.taskFeedback,
    surface,
    inbox,
    createSession: (id) => {
      sessionIds.add(id)
      return ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } })
    },
  }
}

/** Register one task against a Session turn. */
async function register(service: TaskFeedback, session: Session, taskId: string, turn = 1): Promise<void> {
  serial += 1
  await service.register({
    taskId,
    sessionId: session.id,
    turn,
    target: { kind: 'codex-thread', threadId: 'codex-thread-1' },
    acceptance: 'the reviewer checks the recorded evidence',
  })
}

/** Append one assistant message carrying visible text and optional reasoning. */
function appendAssistant(session: Session, turn: number, step: number, text: string, reasoning?: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text },
        ...reasoning === undefined ? [] : [{ type: 'reasoning' as const, text: reasoning }],
      ],
      source: { provider: 'fixture', model: 'fixture' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

/** End one turn `completed`. */
function completeTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** End one turn with the provider's reasoning_text protocol failure. */
function failTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', {
    turn,
    reason: {
      kind: 'error',
      error: {
        message: 'provider rejected the request: reasoning_text must be passed back',
        code: 'INVALID_REQUEST',
        status: 400,
      },
    },
  })
}

/** End one turn with the same reasoning_text failure, without another turn start. */
function failTurn2(session: Session, turn: number): void {
  session.append('turn/end', {
    turn,
    reason: {
      kind: 'error',
      error: {
        message: 'provider rejected the request: reasoning_text must be passed back',
        code: 'INVALID_REQUEST',
        status: 400,
      },
    },
  })
}

/** End one turn the way the operator's `stop` does. */
function stopTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } })
}

/**
 * Have a running turn claim the queued automatic-resume instruction, the way
 * the loop does when it takes the next-turn inbox entry.
 * @param session - the Session running the turn.
 * @param inbox - the live inbox holding the queued instruction.
 * @param surface - the prompt surface that submitted it, for its request id.
 * @param turn - the turn claiming the instruction.
 */
function claimQueued(session: Session, inbox: RecordingInbox, surface: QueuedPromptSurface, turn: number): void {
  const [queued] = inbox.nextTurn
  expect(queued).toBeDefined()
  inbox.remove(queued!.id)
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Automatic protocol recovery' }],
    source: { kind: 'user', rpcId: surface.calls[0]!.requestId as never },
  }), { surfaceOp: 'append' })
}

/** The one delivery a settled task owes, as the outbox holds it. */
function onlyDelivery(service: TaskFeedback): ReturnType<TaskFeedback['deliveries']>[number] {
  const deliveries = service.deliveries()
  expect(deliveries).toHaveLength(1)
  return deliveries[0]!
}

/**
 * One Host generation over a durable JSON root, with no Session attached yet.
 *
 * This is the cold-start order that makes the service read a recorded turn end
 * instead of observing it live.
 * @param root - durable storage root shared across generations.
 * @returns the mounted context and its service.
 */
async function durableHost(root: string): Promise<{ ctx: Context; service: TaskFeedback }> {
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomainPlugin, { backend: 'json' })
  await mountSessionStack(ctx)
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
  return { ctx, service: ctx.taskFeedback }
}

describe('completion outcome diagnostics', () => {
  it('reports a completed turn whose final text carries tool syntax as unverified', async () => {
    const { service, createSession } = await harness()
    const session = createSession('leaked')
    await register(service, session, 'root')
    session.append('turn/start', { turn: 1 })
    appendAssistant(session, 1, 1, `Reading the file now\n${dsmlTag('invoke')}\n${dsmlTag('parameter')}`)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.settled()

    const task = service.task({ taskId: 'root' })
    // The loop's own fact is preserved, and the field a dispatcher reads says
    // the business outcome is not established by it.
    expect(task.state).toBe('completed')
    expect(task.leakedToolSyntax).toEqual(['dsml', 'invoke-tag', 'parameter-tag'])
    expect(task.summary).toContain('the business outcome is not verified')
    expect(task.summary).toContain('invoke-tag')
    expect(task.resumeEligible).toBe(false)

    const delivery = onlyDelivery(service)
    expect(delivery.payload.leakedToolSyntax).toEqual(['dsml', 'invoke-tag', 'parameter-tag'])
    const message = composeWakeMessage(delivery.payload, delivery.deliveryId)
    expect(message).toContain('attention:')
    expect(message).toContain('not verified')
    // The unverified completion is not a recovery candidate, so the
    // notification never offers the resume operation.
    expect(message).not.toContain('resume-failed')

    const refused = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@completed', consumerId: 'owner' })
    expect(refused.decision).toBe('not-applicable')
    expect(refused.attempt).toBeNull()
  })

  it('leaves an ordinary completed turn verified and unremarkable', async () => {
    const { service, createSession } = await harness()
    const session = createSession('plain')
    await register(service, session, 'root')
    session.append('turn/start', { turn: 1 })
    appendAssistant(session, 1, 1, 'The typecheck passed; the diff is committed.')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.settled()

    expect(service.task({ taskId: 'root' })).toMatchObject({
      state: 'completed',
      summary: 'the turn completed',
      leakedToolSyntax: null,
    })
    const delivery = onlyDelivery(service)
    expect(delivery.payload.leakedToolSyntax).toBeNull()
    expect(composeWakeMessage(delivery.payload, delivery.deliveryId)).not.toContain('attention:')
  })

  it('ignores markup an earlier step or a reasoning block carried', async () => {
    const { service, createSession } = await harness()
    const session = createSession('earlier-step')
    await register(service, session, 'root')
    session.append('turn/start', { turn: 1 })
    // A step that quoted the syntax and went on to call its tool normally is
    // not what ends the turn, so it cannot mark the turn's outcome.
    appendAssistant(session, 1, 1, `I will call it like this: ${dsmlTag('invoke')}`)
    session.append('tool/call', { turn: 1, step: 1, callId: 'call-1' as never, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    // The final message carries the delimiter only in its reasoning channel,
    // which is where Chain-of-Thought belongs.
    appendAssistant(session, 1, 2, 'Both files are updated.', `plan ${dsmlTag('invoke')}`)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.settled()

    expect(service.task({ taskId: 'root' })).toMatchObject({
      state: 'completed',
      summary: 'the turn completed',
      leakedToolSyntax: null,
    })
  })

  it('ignores tool syntax recorded by an earlier turn', async () => {
    const { service, createSession } = await harness()
    const session = createSession('earlier-turn')
    await register(service, session, 'root', 2)
    session.append('turn/start', { turn: 1 })
    appendAssistant(session, 1, 1, `stale attempt\n${dsmlTag('invoke')}`)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    appendAssistant(session, 2, 1, 'The second turn produced the real answer.')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await service.settled()

    expect(service.task({ taskId: 'root' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
      leakedToolSyntax: null,
    })
  })

  it('keeps an SSE stream that ended without [DONE] as its own failure and refuses a resume', async () => {
    const { service, createSession } = await harness()
    const session = createSession('stream-closed')
    await register(service, session, 'root')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: { message: 'SSE stream ended without [DONE]', code: 'STREAM_CLOSED' },
      },
    })
    await service.settled()

    const task = service.task({ taskId: 'root' })
    expect(task).toMatchObject({
      state: 'failed',
      summary: 'the turn failed: SSE stream ended without [DONE]',
      resumeEligible: false,
      leakedToolSyntax: null,
    })
    const delivery = onlyDelivery(service)
    expect(delivery.payload.resumeEligible).toBe(false)
    expect(delivery.payload.summary).toBe('the turn failed: SSE stream ended without [DONE]')
    expect(composeWakeMessage(delivery.payload, delivery.deliveryId)).not.toContain('resume-failed')

    // Only the exact reasoning_text condition is resumable, so a transport
    // failure is reported as outside the recovery operation.
    const refused = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(refused.decision).toBe('not-applicable')
    expect(refused.reason).toContain('reasoning_text')
  })
})

describe('recovery from a recorded turn end', () => {
  it('reports an unverified completion read back from restored history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-leak-recovery-'))
    roots.push(root)
    const first = await durableHost(root)
    const session = first.ctx.sessions.create(SessionId('leak-cold'), { meta: { cwd: '/workspace' } })
    await register(first.service, session, 'root')
    session.append('turn/start', { turn: 1 })
    appendAssistant(session, 1, 1, `Reading the file
${dsmlTag('invoke')}`)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const seed: SessionEvent[] = [...session.snapshotEvents()]
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    // The turn ended while this Host was down: the recorded end is the only
    // evidence, and it must not read as a business completion either.
    const second = await durableHost(root)
    second.ctx.sessions.create(SessionId('leak-cold'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()

    const restored = second.service.task({ taskId: 'root' })
    expect(restored).toMatchObject({ state: 'completed', leakedToolSyntax: ['dsml', 'invoke-tag'] })
    expect(restored.summary).toContain('not verified')
    expect(second.service.deliveries()[0]?.payload.leakedToolSyntax).toEqual(['dsml', 'invoke-tag'])
  })

  it('keeps the recorded failure reason of a turn that ended while the Host was down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-reason-recovery-'))
    roots.push(root)
    const first = await durableHost(root)
    const session = first.ctx.sessions.create(SessionId('reason-cold'), { meta: { cwd: '/workspace' } })
    await register(first.service, session, 'root')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', {
      turn: 1,
      reason: {
        kind: 'error',
        error: { message: 'SSE stream ended without [DONE]', code: 'STREAM_CLOSED' },
      },
    })
    const seed: SessionEvent[] = [...session.snapshotEvents()]
    await first.ctx.fiber.dispose()
    owned.delete(first.ctx)

    const second = await durableHost(root)
    second.ctx.sessions.create(SessionId('reason-cold'), { meta: { cwd: '/workspace' }, seed })
    await second.service.settled()

    expect(second.service.task({ taskId: 'root' })).toMatchObject({
      state: 'failed',
      turn: 1,
      summary: 'the turn failed: SSE stream ended without [DONE]',
      resumeEligible: false,
    })
    const delivery = second.service.deliveries()[0]
    expect(delivery?.payload).toMatchObject({
      state: 'failed',
      turn: 1,
      summary: 'the turn failed: SSE stream ended without [DONE]',
      resumeEligible: false,
    })
    expect(delivery?.payload.evidence.turn).toBe(1)
  })
})

describe('bounded recovery answers', () => {
  it('resumes the reasoning_text failure once and reports the spent budget afterwards', async () => {
    const { service, surface, inbox, createSession } = await harness({ maxAutoResumes: 1 })
    const session = createSession('budget')
    await register(service, session, 'root')
    failTurn(session, 1)
    await service.settled()

    expect((await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('resumed')
    expect(surface.calls).toHaveLength(1)

    // The resumed turn fails again with the same protocol error, which is the
    // only thing that spends the second call.
    claimQueued(session, inbox, surface, 2)
    failTurn2(session, 2)
    await service.settled()
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'failed', turn: 2, resumeEligible: true })
    const exhausted = await service.resumeFailed({ taskId: 'root#r1', deliveryId: 'root#r1@failed', consumerId: 'owner' })
    expect(exhausted.decision).toBe('budget-exhausted')
    expect(exhausted.reason).toContain('already used 1 of 1 automatic resumes')
    expect(exhausted.attempt).toBeNull()
    expect(surface.calls).toHaveLength(1)

    // A repeated notification cannot re-spend the budget or submit again.
    const replay = await service.resumeFailed({ taskId: 'root#r1', deliveryId: 'root#r1@failed', consumerId: 'owner' })
    expect(replay.decision).toBe('budget-exhausted')
    expect(surface.calls).toHaveLength(1)
    expect(service.task({ taskId: 'root' }).autoResumeCount).toBe(1)
  })

  it('reports superseded when the operator continued manually after the failure', async () => {
    const { service, surface, createSession } = await harness()
    const session = createSession('manual-continue')
    await register(service, session, 'root')
    failTurn(session, 1)
    await service.settled()

    // The operator sends their own continuation and it completes.
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'I will finish this myself' }],
      source: { kind: 'user', rpcId: 'manual-1' as never },
    }), { surfaceOp: 'append' })
    appendAssistant(session, 2, 1, 'Done by hand.')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await service.settled()

    const refused = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(refused.decision).toBe('superseded')
    expect(refused.reason).toContain('no longer records this failure')
    expect(refused.attempt).toBeNull()
    // No old delivery may append a continuation after the operator took over.
    expect(surface.calls).toHaveLength(0)
    expect(service.tasks().map(task => task.taskId)).toEqual(['root'])
  })

  it('answers running while the manual continuation is still open and never appends to it', async () => {
    const { service, surface, createSession } = await harness()
    const session = createSession('manual-running')
    await register(service, session, 'root')
    failTurn(session, 1)
    await service.settled()

    session.append('turn/start', { turn: 2 })
    expect((await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })).decision)
      .toBe('running')
    expect(surface.calls).toHaveLength(0)
  })
})

describe('manual stop and continuation tracking', () => {
  it('reports the operator stop as cancelled with its cause', async () => {
    const { service, createSession } = await harness()
    const session = createSession('stopped')
    await register(service, session, 'root')
    stopTurn(session, 1)
    await service.settled()

    expect(service.task({ taskId: 'root' })).toMatchObject({
      state: 'cancelled',
      summary: 'the turn was cancelled (user)',
    })
    // `cancelled` does not notify by default, and it is never resumable.
    expect(service.deliveries()).toEqual([])
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@cancelled', consumerId: 'owner' }))
      .rejects.toMatchObject({ code: 'task-feedback/delivery-not-found' })
  })

  it('withdraws a queued automatic resume when the operator stops the session', async () => {
    const { service, surface, inbox, createSession } = await harness()
    const session = createSession('stop-queued')
    await register(service, session, 'root')
    failTurn(session, 1)
    await service.settled()

    const admitted = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(admitted.decision).toBe('resumed')
    expect(inbox.nextTurn).toHaveLength(1)
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'accepted', turn: null })

    // The operator stops before any turn claimed the queued instruction.
    stopTurn(session, 2)
    await service.settled()

    expect(inbox.nextTurn).toEqual([])
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'cancelled',
      turn: null,
      summary: 'the operator stopped the Session; the queued automatic resume instruction was withdrawn',
    })
    // The stand-down spends no new delivery: the withdrawal is a terminal state
    // the default policy does not notify.
    expect(service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['root@failed'])

    // A replay re-validates against the stopped Session and reports it instead
    // of admitting a second attempt.
    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })
    expect(replay.decision).toBe('superseded')
    expect(surface.calls).toHaveLength(1)

    // The operator's own continuation is not the withdrawn attempt.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'continue from here' }],
      source: { kind: 'user', rpcId: 'manual-2' as never },
    }), { surfaceOp: 'append' })
    completeTurn(session, 3)
    await service.settled()
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'cancelled', turn: null })
  })

  it('keeps a claimed automatic resume when the stop hits the turn that consumed it', async () => {
    const { service, surface, inbox, createSession } = await harness()
    const session = createSession('stop-claimed')
    await register(service, session, 'root')
    failTurn(session, 1)
    await service.settled()
    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'owner' })

    // A turn claims the queued instruction, which is what records it; the
    // operator then stops that turn.
    claimQueued(session, inbox, surface, 2)
    await service.settled()
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'running', turn: 2 })

    stopTurn(session, 2)
    await service.settled()
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({ state: 'cancelled', turn: 2 })
    // A stop is not notified by default, so the attempt adds no delivery.
    expect(service.deliveries().map(delivery => delivery.deliveryId)).toEqual(['root@failed'])
  })
})

describe('consumer claim ownership', () => {
  it('rejects a consume from a different consumer even with the current generation', async () => {
    vi.useFakeTimers()
    const { service, createSession } = await harness({ claimLeaseMs: 1_000 })
    const session = createSession('ownership')
    await register(service, session, 'root')
    completeTurn(session, 1)
    await service.settled()

    expect((await service.receive({ taskId: 'root', deliveryId: 'root@completed', consumerId: 'owner' })).action)
      .toBe('review')
    vi.advanceTimersByTime(2_000)
    const takeover = await service.receive({ taskId: 'root', deliveryId: 'root@completed', consumerId: 'new' })
    expect(takeover).toMatchObject({ action: 'resume', receipt: { claimEpoch: 2, ownerId: 'new' } })

    // Knowing the current generation is not ownership: the old consumer cannot
    // finish the review the new owner holds.
    await expect(service.consume({
      taskId: 'root',
      deliveryId: 'root@completed',
      claimEpoch: 2,
      consumerId: 'owner',
    })).rejects.toMatchObject({ code: 'task-feedback/stale-claim' })
    expect(service.receipts()[0]?.status).not.toBe('consumed')
  })

  it('leaves the owner and generation untouched when a second consumer is refused', async () => {
    const { service, createSession } = await harness()
    const session = createSession('busy')
    await register(service, session, 'root')
    completeTurn(session, 1)
    await service.settled()

    const owner = await service.receive({ taskId: 'root', deliveryId: 'root@completed', consumerId: 'owner' })
    const refused = await service.receive({ taskId: 'root', deliveryId: 'root@completed', consumerId: 'intruder' })
    expect(refused).toMatchObject({ action: 'busy', receipt: { ownerId: 'owner', claimEpoch: owner.receipt.claimEpoch } })
    // Consumption stays a no-op for the consumer that never held a claim, and
    // the owner still finishes its own review.
    await expect(service.consume({
      taskId: 'root',
      deliveryId: 'root@completed',
      claimEpoch: owner.receipt.claimEpoch,
      consumerId: 'intruder',
    })).rejects.toMatchObject({ code: 'task-feedback/stale-claim' })
    const consumed = await service.consume({
      taskId: 'root',
      deliveryId: 'root@completed',
      claimEpoch: owner.receipt.claimEpoch,
      consumerId: 'owner',
    })
    expect(consumed.receipt.status).toBe('consumed')
  })
})
