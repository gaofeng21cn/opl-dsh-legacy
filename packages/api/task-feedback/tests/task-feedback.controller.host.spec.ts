/**
 * Task feedback's automatic resume over the real Session prompt path.
 *
 * The service is the real one, and the prompt surface is the production
 * `SessionCommandController` over the real Agent registry, Session log, and
 * Inbox. Only the external model selection and the transport are replaced, so
 * the admission check, the request-id deduplication, and the queued follow-up
 * are the shipped ones rather than a test double.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ApiSessionAgentController } from '../../session-controller/src/agent.ts'
import { SessionCommandController } from '../../session-controller/src/commands.ts'
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import type { ReceiptRecordState } from '../src/spec.ts'
import TaskFeedback from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const owned = new Set<Context>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/**
 * One durable table reached through the service's private accessor.
 *
 * The case below installs a failing write on the table itself, so the accessor
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

/** A real task-feedback Host whose prompt surface is the production controller. */
async function controllerHarness(): Promise<{
  ctx: Context
  service: TaskFeedback
  commands: SessionCommandController
  session: Session
  inbox: Inbox
  failFollowup: { value: boolean }
}> {
  const ctx = new Context()
  owned.add(ctx)
  await mountMemoryStorage(ctx)
  await mountSessionStack(ctx)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('controller-resume'), { meta: { cwd: '/workspace' } })
  const inbox = createInboxStub()
  const failFollowup = { value: false }
  const followup = vi.fn((message: UserMessage) => {
    if (failFollowup.value) {
      failFollowup.value = false
      throw new Error('the queue refused the instruction')
    }
    inbox.append('next-turn', message)
  })
  const agent = {
    id: session.id,
    session,
    inbox,
    status: 'idle',
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  await ctx.agents.register(agent)

  // Only the external model/default selection is a double; the controller sees
  // a provider it can route to and a selected model, exactly as configured.
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture', name: 'Fixture' }],
    listModels: async () => [{ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }],
    resolveModelInfo: () => Promise.resolve({ provider: 'fixture', id: 'fixture-model', name: 'Fixture' }),
  } as never)
  ctx.provide('attachments', {
    admitPromptContent: async (content: unknown) => content,
  } as never)
  ctx.provide('fileUploads', {
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  } as never)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  const commands = new SessionCommandController(ctx, agents, '/workspace')
  ctx.provide('sessionController', commands as never)

  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
  return { ctx, service: ctx.taskFeedback, commands, session, inbox, failFollowup }
}

/** Register the one failed task every case resumes. */
async function registerFailedTask(service: TaskFeedback, session: Session): Promise<void> {
  await service.register({
    taskId: 'root',
    sessionId: session.id,
    turn: 1,
    target: { kind: 'codex-thread', threadId: 'thread-explicit-1' },
    acceptance: 'the reviewer checks the recorded evidence',
  })
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', {
    turn: 1,
    reason: {
      kind: 'error',
      error: { message: 'reasoning_text must be passed back', code: 'INVALID_REQUEST', status: 400 },
    },
  })
  await service.settled()
}

/** The request ids of the instructions the real Inbox is holding. */
function queuedRequestIds(inbox: Inbox): unknown[] {
  return inbox.nextTurn.map((message) => {
    const source = message.source
    return source.kind === 'user' && 'rpcId' in source ? source.rpcId : undefined
  })
}

describe('task feedback over the real Session prompt path', () => {
  it('admits one queued resume through the real prompt surface and replays idempotently', async () => {
    const { service, commands, session, inbox } = await controllerHarness()
    const prompt = vi.spyOn(commands, 'prompt')
    await registerFailedTask(service, session)

    const first = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' })
    expect(first.decision).toBe('resumed')
    // The production prompt admitted exactly one instruction into the real queue.
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(queuedRequestIds(inbox)).toEqual(['task-feedback-resume:root:1'])

    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' })
    expect(replay.decision).toBe('resumed')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(queuedRequestIds(inbox)).toEqual(['task-feedback-resume:root:1'])
  })

  it('stands down a failed queue attempt once a manual turn started', async () => {
    const { service, commands, session, inbox, failFollowup } = await controllerHarness()
    const prompt = vi.spyOn(commands, 'prompt')
    await registerFailedTask(service, session)

    failFollowup.value = true
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' }))
      .rejects.toMatchObject({ code: 'task-feedback/resume-submit-failed' })
    expect(inbox.nextTurn).toHaveLength(0)

    session.append('turn/start', { turn: 2 })
    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' })
    expect(['running', 'superseded']).toContain(replay.decision)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(inbox.nextTurn).toHaveLength(0)
  })

  it('recovers a queued instruction whose receipt flag write failed without resubmitting', async () => {
    const { service, commands, session, inbox } = await controllerHarness()
    const prompt = vi.spyOn(commands, 'prompt')
    await registerFailedTask(service, session)

    const receipts = privateTable(service, 'requireReceipts') as KvTable<string, ReceiptRecordState>
    const originalPut = receipts.put.bind(receipts)
    let failed = false
    vi.spyOn(receipts, 'put').mockImplementation(async (key, value) => {
      if (!failed && value.resumeSubmitted) {
        failed = true
        throw new Error('receipt flag write failed')
      }
      await originalPut(key, value)
    })
    await expect(service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' }))
      .rejects.toThrow('receipt flag write failed')
    // The instruction is already in the real queue; the flag that records it is
    // the write that was lost.
    expect(queuedRequestIds(inbox)).toEqual(['task-feedback-resume:root:1'])

    const replay = await service.resumeFailed({ taskId: 'root', deliveryId: 'root@failed', consumerId: 'receiver' })
    expect(replay.decision).toBe('resumed')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(queuedRequestIds(inbox)).toEqual(['task-feedback-resume:root:1'])
  })
})
