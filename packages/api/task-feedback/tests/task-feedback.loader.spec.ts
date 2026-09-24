/**
 * The task-feedback plugin through a real Loader and Include tree.
 *
 * The fixture `cordis.yml` names the package's real default-exported service
 * class and the real storage, session, and projection plugins, resolved through
 * the Loader's import seam. This exercises the shipped composition path
 * (injection, Config resolution, service publication) that a hand-built
 * `ctx.plugin(...)` suite cannot: no model, key, or network take part.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
// Function plugins publish named `apply`/`inject`/`Config`; the Loader resolves
// the module namespace, so the fixture maps the namespace rather than a default.
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Relative source import: the wait fold is the session controller's own
// projection, and this spec mounts it exactly as that controller does.
import { installSessionWaitProjection } from '../../session-controller/src/wait.ts'
import TaskFeedback from '../src/index.ts'
import type { WakeAdapter, WakeDelivery } from '../src/types.ts'

const owned: Context[] = []
let root: string | undefined

afterEach(async () => {
  await Promise.all(owned.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A simulated receiving Session that records what the assembled service sends. */
class LoaderReceiver implements WakeAdapter {
  readonly id = 'loader-receiver'
  readonly sent: WakeDelivery[] = []
  send(delivery: WakeDelivery): Promise<{ accepted: boolean; detail: string }> {
    this.sent.push(delivery)
    return Promise.resolve({ accepted: true, detail: 'accepted' })
  }
  probe(): Promise<{ started: boolean; detail: string }> {
    return Promise.resolve({ started: true, detail: 'the configured executable started' })
  }
}

/**
 * Boot one Host generation through the real Loader over one durable root.
 * @param dir - directory holding `cordis.yml` and the JSON storage root.
 * @returns the loaded context.
 */
async function bootLoader(dir: string): Promise<Context> {
  const configPath = join(dir, 'cordis.yml')
  const storageRoot = join(dir, 'storage')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(storageRoot)}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-api-task-feedback'",
    '  config:',
    '    autoDeliver: false',
    '',
  ].join('\n'))

  const ctx = new Context()
  owned.push(ctx)
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-api-task-feedback', TaskFeedback],
  ])
  ctx.loader.internal = {
    version: 'v2',
    import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  // Recovery reads these two folds; they are what the real session controller
  // and agent loop register on the same registry the Loader just published.
  installSessionWaitProjection(ctx)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  return ctx
}

/** Detach one generation so the next boots over the same durable root. */
async function shutdown(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
  owned.splice(owned.indexOf(ctx), 1)
}

describe('task feedback real Loader composition', () => {
  it('loads the real service over real providers, delivers, and records a receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-loader-'))
    const ctx = await bootLoader(root)

    const service = ctx.taskFeedback
    expect(service).toBeInstanceOf(TaskFeedback)
    const session = ctx.sessions.create(SessionId('loader-session'), { meta: { cwd: '/workspace' } })
    await service.register({
      taskId: 'loader-task',
      sessionId: session.id,
      turn: 1,
      target: { kind: 'codex-thread', threadId: 'loader-thread' },
      acceptance: 'a receipt is recorded',
    })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await service.settled()

    const receiver = new LoaderReceiver()
    service.setWakeAdapter(receiver)
    expect(await service.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    // The assembled service produced the notification, and the receiver — not
    // the sender — advances it through claim and consumption.
    expect(receiver.sent.map(delivery => delivery.deliveryId)).toEqual(['loader-task@completed'])
    expect(receiver.sent[0]?.message).toContain('delivery: loader-task@completed')
    expect(await service.receive({ taskId: 'loader-task', deliveryId: 'loader-task@completed', consumerId: 'loader-receiver' }))
      .toMatchObject({ action: 'review', receipt: { status: 'received', claimEpoch: 1 } })
    expect(await service.consume({ taskId: 'loader-task', deliveryId: 'loader-task@completed', claimEpoch: 1 }))
      .toMatchObject({ receipt: { status: 'consumed' } })
    // Consuming the delivery is what makes a repeated message a no-op.
    expect(await service.receive({ taskId: 'loader-task', deliveryId: 'loader-task@completed', consumerId: 'loader-receiver' }))
      .toMatchObject({ action: 'skip' })
  })

  it('carries a needs-input pause through the real loader composition', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-loader-needs-input-'))
    const ctx = await bootLoader(root)
    const service = ctx.taskFeedback
    const session = ctx.sessions.create(SessionId('loader-needs-input'), { meta: { cwd: '/workspace' } })
    await service.register({
      taskId: 'loader-needs-input',
      sessionId: session.id,
      turn: 1,
      target: { kind: 'codex-thread', threadId: 'loader-thread' },
      acceptance: 'the human answered the question in the Session',
    })
    session.append('turn/start', { turn: 1 })
    await ctx.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q-1', question: 'Which branch?' }], agent: { session } as never },
      () => Promise.resolve({ answers: [] }),
    )
    await service.settled()

    const receiver = new LoaderReceiver()
    service.setWakeAdapter(receiver)
    expect(await service.flush()).toMatchObject({ attempted: 1, delivered: 1 })
    const delivery = service.deliveries()[0]!
    expect(delivery.deliveryId).toBe(`loader-needs-input@waiting_input@${String(delivery.payload.needsInput?.pauseId)}`)
    expect(delivery.payload.needsInput).toMatchObject({
      kind: 'question',
      sessionId: 'loader-needs-input',
      turn: 1,
      questions: [{ id: 'q-1', question: 'Which branch?' }],
    })
    // The transported message names the Session the answer belongs to, and a
    // repeated read of the outbox never adds a second delivery.
    expect(receiver.sent[0]?.message).toContain('answer location: DSH session loader-needs-input, turn 1')
    expect(service.deliveries()).toHaveLength(1)
    expect(await service.receive({
      taskId: 'loader-needs-input',
      deliveryId: delivery.deliveryId,
      consumerId: 'loader-receiver',
    })).toMatchObject({ action: 'review', receipt: { status: 'received', claimEpoch: 1 } })
    expect(await service.consume({
      taskId: 'loader-needs-input',
      deliveryId: delivery.deliveryId,
      claimEpoch: 1,
    })).toMatchObject({ receipt: { status: 'consumed' } })
    // The loop closed on the notification only: the paused Session still holds
    // exactly the turn it was running, with no answer submitted for its human.
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['turn/start'])
  })

  it('runs the bounded automatic resume through the real loader composition', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-loader-resume-'))
    const ctx = await bootLoader(root)
    const calls: string[] = []
    // The Session prompt surface is the one external service this flow calls;
    // the Session, storage, projections, and the loaded service are the real ones.
    ctx.provide('sessionController', {
      prompt(request: { requestId: string; sessionId: SessionId; content: readonly { type: string; text?: string }[] }) {
        calls.push(request.requestId)
        const session = ctx.sessions.get(request.sessionId)
        session?.append('user/message', createUserMessage({
          content: [{ type: 'text', text: request.content[0]?.text ?? '' }],
          source: { kind: 'user', rpcId: request.requestId as never },
        }), { surfaceOp: 'append' })
        return Promise.resolve({ accepted: true })
      },
    } as never)

    const service = ctx.taskFeedback
    const session = ctx.sessions.create(SessionId('loader-resume'), { meta: { cwd: '/workspace' } })
    await service.register({
      taskId: 'loader-resume',
      sessionId: session.id,
      turn: 1,
      target: { kind: 'codex-thread', threadId: 'loader-thread' },
      acceptance: 'a bounded resume is submitted',
    })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'reasoning_text must be passed back', code: 'INVALID_REQUEST', status: 400 } },
    })
    await service.settled()

    const value = await service.resumeFailed({ taskId: 'loader-resume', deliveryId: 'loader-resume@failed', consumerId: 'loader-receiver' })
    expect(value).toMatchObject({ decision: 'resumed', attempt: { taskId: 'loader-resume#r1', attempt: 2 } })
    expect(calls).toEqual(['task-feedback-resume:loader-resume:1'])
    // The follow-up task tracks the resumed turn and notifies the same target.
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await service.settled()
    expect(service.task({ taskId: 'loader-resume#r1' })).toMatchObject({ state: 'completed', parentTaskId: 'loader-resume' })
    expect(service.deliveries().map(delivery => delivery.deliveryId)).toContain('loader-resume#r1@completed')
  })

  it('settles a task whose saved Session attaches after the loader recovers it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-task-feedback-loader-cold-'))
    const first = await bootLoader(root)
    const session = first.sessions.create(SessionId('loader-cold'), { meta: { cwd: '/workspace' } })
    await first.taskFeedback.register({
      taskId: 'loader-cold',
      sessionId: session.id,
      turn: 1,
      target: { kind: 'codex-thread', threadId: 'loader-thread' },
      acceptance: 'a receipt is recorded',
    })
    session.append('turn/start', { turn: 1 })
    await first.taskFeedback.settled()
    // One saved log with the turn already ended; the next generation restores
    // it only after the service has recovered.
    const builder = first.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    builder.append('turn/start', { turn: 1 })
    builder.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const seed: SessionEvent[] = [...builder.snapshotEvents()]
    await shutdown(first)

    const second = await bootLoader(root)
    // No Session is attached at recovery, so the task starts disconnected.
    expect(second.taskFeedback.task({ taskId: 'loader-cold' }).state).toBe('disconnected')
    second.sessions.create(SessionId('loader-cold'), { meta: { cwd: '/workspace' }, seed })
    await second.taskFeedback.settled()
    expect(second.taskFeedback.task({ taskId: 'loader-cold' })).toMatchObject({
      state: 'completed',
      summary: 'the turn completed',
    })
    expect(second.taskFeedback.deliveries().map(delivery => delivery.deliveryId)).toEqual(['loader-cold@completed'])
  })
})
