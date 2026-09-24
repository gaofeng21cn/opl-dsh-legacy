/**
 * Task feedback's automatic resume over the real Agent loop.
 *
 * The service, the Session command controller, the Agent registry, the Inbox,
 * the loop, and the Session log are the production ones. Only the model
 * transport is a scripted adapter, so this spec proves the timing a test double
 * cannot: the instruction the controller queues is claimed by a real turn, the
 * real loop records it and runs the resumed turn to completion, and a
 * registration delayed past that turn still binds it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { ApiSessionAgentController } from '../../session-controller/src/agent.ts'
import { SessionCommandController } from '../../session-controller/src/commands.ts'
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import TaskFeedback from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const owned = new Set<Context>()

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/** The one provider failure the bounded automatic resume handles. */
function reasoningTextFailure(message = 'provider rejected the request: reasoning_text must be passed back'): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'INVALID_REQUEST', status: 400 } } },
  ]
}

/** Mount the in-memory storage stack the task feedback domain opens. */
async function mountMemoryStorage(ctx: Context): Promise<void> {
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
}

/** Wait for the agent's next transition to idle. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Wait for one event the live feed is about to publish on one Session. */
function nextSessionEvent(
  ctx: Context,
  session: Session,
  matches: (event: SessionEvent) => boolean,
): Promise<SessionEvent> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (subject: Session, event: SessionEvent) => {
      if (subject.id !== session.id || !matches(event)) return
      dispose()
      resolve(event)
    }, { global: true })
  })
}

/** Whether one recorded event is the deterministic resume instruction. */
function isResumeInstruction(event: SessionEvent, requestId: string): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data.source
  return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId
}

/** Every text block one model request carried, in order. */
function requestTexts(options: GenerateOptions | undefined): string[] {
  return (options?.messages ?? []).flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

/** The attempt's own deliveries, in outbox order. */
function attemptDeliveries(service: TaskFeedback): string[] {
  return service.deliveries().map(delivery => delivery.deliveryId).filter(id => id.startsWith('root#r1@'))
}

/**
 * A Host whose resume goes through the production prompt surface and loop.
 *
 * The only replaced pieces are the model transport (a scripted adapter), the
 * model selection the controller reads, and the attachment pass-throughs a
 * text-only prompt never uses. The Agent, its Inbox, the loop, the Session log,
 * the projections, and the service are real.
 */
async function loopHarness(script: (StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]))[]): Promise<{
  ctx: Context
  service: TaskFeedback
  commands: SessionCommandController
  adapter: MockAdapter
  agent: Agent
  session: Session
}> {
  const ctx = new Context()
  owned.add(ctx)
  await mountMemoryStorage(ctx)
  await mountAgentLoopTestDependencies(ctx)
  installSessionWaitProjection(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await loop.create(SessionId('loop-resume'), { provider: 'mock', model: 'mock' }, { cwd: '/workspace' })

  // The controller routes a Session id to its Agent and model selection; those
  // two lookups are the routing seam, and the queue they feed is the real
  // Agent's own Inbox.
  const selection: ModelSelectionRef = { current: { provider: 'mock', model: 'mock' }, assembled: undefined }
  ctx.provide('attachments', { admitPromptContent: async (content: unknown) => content } as never)
  ctx.provide('fileUploads', {
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  } as never)
  const commands = new SessionCommandController(ctx, {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController, '/workspace')
  ctx.provide('sessionController', commands as never)

  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
  return { ctx, service: ctx.taskFeedback, commands, adapter, agent, session: agent.session }
}

/** Register the task whose turn 1 is about to fail. */
async function registerFailedTurn1(ctx: Context, service: TaskFeedback, agent: Agent, session: Session): Promise<void> {
  await service.register({
    taskId: 'root',
    sessionId: session.id,
    turn: 1,
    target: { kind: 'codex-thread', threadId: 'codex-thread-1' },
    acceptance: 'the reviewer checks the recorded evidence',
  })
  const failed = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'dispatched work' }],
    source: { kind: 'user' },
  }))
  await failed
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

describe('automatic resume over the real Agent loop', () => {
  it('binds a resumed turn the real loop consumed and completed before the task write landed', async () => {
    const { ctx, service, commands, adapter, agent, session } = await loopHarness([
      reasoningTextFailure(),
      textResponse('resumed turn'),
    ])
    const prompt = vi.spyOn(commands, 'prompt')
    await registerFailedTurn1(ctx, service, agent, session)
    expect(service.task({ taskId: 'root' })).toMatchObject({ state: 'failed', resumeEligible: true })

    loseFollowupWrite(service)
    const requestId = 'task-feedback-resume:root:1'
    // Both events are subscribed before the submission, so the assertions do
    // not depend on how far the loop got while the task write was failing.
    const recorded = nextSessionEvent(ctx, session, event => isResumeInstruction(event, requestId))
    const completed = nextSessionEvent(ctx, session, event => event.type === 'turn/end' && event.data.turn === 2)
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' }))
      .rejects.toThrow('followup task write failed')

    // The real queue and loop claimed the instruction and ran the turn.
    expect(await recorded).toMatchObject({ type: 'user/message', data: { source: { rpcId: requestId } } })
    expect(await completed).toMatchObject({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await agent.whenIdle()
    await service.settled()
    expect(service.tasks().map(task => task.taskId)).toEqual(['root'])

    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' })
    await service.settled()

    expect(replay).toMatchObject({ decision: 'resumed', attempt: { taskId: 'root#r1', attempt: 2 } })
    // The instruction was admitted once, ran once, and the turn it ran in is
    // what settles the follow-up task.
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(adapter.requests).toHaveLength(2)
    expect(requestTexts(adapter.requests[1]).some(text => text.includes('Automatic protocol recovery'))).toBe(true)
    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
    })
    expect(attemptDeliveries(service)).toEqual(['root#r1@completed'])
  })

  it('does not mistake a manual turn that ran after the resumed one', async () => {
    const { ctx, service, adapter, agent, session } = await loopHarness([
      reasoningTextFailure(),
      textResponse('resumed turn'),
      textResponse('manual turn'),
    ])
    await registerFailedTurn1(ctx, service, agent, session)
    loseFollowupWrite(service)
    const resumed = nextSessionEvent(ctx, session, event => event.type === 'turn/end' && event.data.turn === 2)
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' }))
      .rejects.toThrow('followup task write failed')
    await resumed
    await agent.whenIdle()

    // The operator continues the Session by hand and that turn fails.
    const manual = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'manual continuation' }],
      source: { kind: 'user', rpcId: 'manual-1' as never },
    }))
    await manual
    await service.settled()
    expect(adapter.requests).toHaveLength(3)

    await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' })
    await service.settled()

    expect(service.task({ taskId: 'root#r1' })).toMatchObject({
      state: 'completed',
      turn: 2,
      summary: 'the turn completed',
      evidence: { turn: 2 },
    })
    expect(attemptDeliveries(service)).toEqual(['root#r1@completed'])
  })
})
