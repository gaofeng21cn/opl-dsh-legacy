/**
 * The needs-input control loop end to end: one real Session log, the real
 * task-feedback service, the real authenticated control bridge, and the real
 * packaged control CLI.
 *
 * The other suites check one seam each. This spec runs the chain a dispatcher
 * actually uses: the pause is raised through the real `user-questions/request`
 * waterfall, read back through `outbox`, claimed through `receive`, and finished
 * through `consume` — separate CLI processes talking to the bridge that fronts
 * the live service. Re-reading the outbox never creates a second delivery, and
 * no step submits an answer into the paused Session.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import TaskFeedback from '@deepseek-ai/dsh-api-task-feedback'
import type { TaskConsumeRequest, TaskReceiveRequest } from '@deepseek-ai/dsh-api-task-feedback/types'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { installSessionWaitProjection } from '../../../packages/api/session-controller/src/wait.ts'
import { startControlBridge } from '../../desktop-host/src/control-bridge.ts'

const controlPath = fileURLToPath(new URL('../opl/opl-dsh-control.mjs', import.meta.url))

const owned = new Set<Context>()
const roots: string[] = []

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One finished CLI run: exit code and both captured streams. */
interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawn the packaged control CLI against one home directory.
 * @param home - `DSH_OPL_HOME` holding the bridge binding the CLI reads.
 * @param args - CLI arguments after the node executable.
 * @returns the exit code and both captured streams.
 */
function runControl(home: string, args: readonly string[]): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [controlPath, ...args], {
      env: { ...process.env, DSH_OPL_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => { resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

/**
 * Read the RPC result the control CLI printed.
 * @param run - one finished CLI run.
 * @returns the `value` the bridge answered.
 */
function valueOf(run: CliRun): unknown {
  return (JSON.parse(run.stdout) as { value: unknown }).value
}

/** The live Host this spec drives: its service, its Session, and its home. */
interface NeedsInputHost {
  readonly ctx: Context
  readonly service: TaskFeedback
  readonly session: Session
  readonly home: string
}

/**
 * Mount the real service over a real Session log in one temporary home.
 * @returns the mounted Host, its service, its Session, and the CLI home.
 */
async function mountNeedsInputHost(): Promise<NeedsInputHost> {
  const root = mkdtempSync(join(tmpdir(), 'opl-needs-input-'))
  roots.push(root)
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  installSessionWaitProjection(ctx)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(TaskFeedback, TaskFeedback.Config({ autoDeliver: false }))
  const session = ctx.sessions.create(SessionId('session-paused'), { meta: { cwd: '/workspace' } })
  session.append('turn/start', { turn: 1 })
  await ctx.taskFeedback.register({
    taskId: 'task-paused',
    sessionId: session.id,
    turn: 1,
    target: { kind: 'codex-thread', threadId: 'thread-dispatcher' },
    acceptance: 'the human answered the question in the Session',
  })
  return { ctx, service: ctx.taskFeedback, session, home: join(root, 'home') }
}

/**
 * Ask one structured question through the real answerer waterfall.
 * @param ctx - the answering Host.
 * @param session - the Session whose agent asks.
 * @param questions - the questions to ask, in caller order.
 * @returns the answer the composing deployment returned.
 */
function ask(ctx: Context, session: Session, questions: AskUserQuestionItem[]): Promise<unknown> {
  return ctx.waterfall(
    'user-questions/request',
    { questions, agent: { session } as never },
    () => Promise.resolve({ answers: [] }),
  )
}

it('reads, claims, and consumes one needs-input delivery through the real bridge and control CLI', async () => {
  const { ctx, service, session, home } = await mountNeedsInputHost()
  await ask(ctx, session, [
    {
      id: 'scope',
      header: 'Scope',
      question: 'Which packages may this change touch?',
      options: [{ label: 'api only', description: 'task-feedback and its tests' }],
    },
  ])
  await service.settled()
  expect(service.task({ taskId: 'task-paused' }).state).toBe('waiting_input')

  // The bridge fronts the live service exactly as the Remote surface does: one
  // namespace, the allowlisted methods, and `args.request` as the parameter.
  const invoke = async (call: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> => {
    if (call.namespace !== 'taskFeedback') throw new Error(`unexpected namespace ${call.namespace}`)
    switch (call.method) {
      case 'outbox': return service.deliveries()
      case 'receipts': return service.receipts()
      case 'receive': return service.receive(call.args.request as TaskReceiveRequest)
      case 'consume': return service.consume(call.args.request as TaskConsumeRequest)
      default: throw new Error(`unexpected method ${call.method}`)
    }
  }
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, join(home, 'profiles', 'desktop', 'control.json'))
  try {
    // The CLI is the dispatcher's read: it resolves the binding, calls the
    // bridge, and prints the delivery the service holds.
    const listed = await runControl(home, ['outbox', '--pending'])
    expect(listed.code).toBe(0)
    const outbox = valueOf(listed) as Record<string, unknown>[]
    expect(outbox).toHaveLength(1)
    const deliveryId = String(outbox[0]?.deliveryId)
    expect(outbox[0]).toMatchObject({
      taskId: 'task-paused',
      target: { kind: 'codex-thread', threadId: 'thread-dispatcher' },
      payload: {
        state: 'waiting_input',
        needsInput: {
          kind: 'question',
          sessionId: 'session-paused',
          turn: 1,
          questions: [{ id: 'scope', header: 'Scope', question: 'Which packages may this change touch?' }],
          approval: null,
        },
      },
    })
    // Reading the outbox is a read: repeated CLI processes see the same single
    // delivery and create nothing.
    for (let round = 0; round < 2; round += 1) {
      const again = await runControl(home, ['outbox', '--pending'])
      expect(again.code).toBe(0)
      expect(valueOf(again) as unknown[]).toHaveLength(1)
    }
    expect(service.deliveries()).toHaveLength(1)
    expect(service.receipts()).toEqual([])

    // The claim names the owner and reports the review the receiver owes.
    const claimed = await runControl(home, ['receive', 'task-paused', deliveryId, '--consumer', 'dispatcher'])
    expect(claimed.code).toBe(0)
    expect(valueOf(claimed)).toMatchObject({
      action: 'review',
      receipt: { status: 'received', claimEpoch: 1 },
    })
    // A repeated message is decided by the durable ledger, not by arrival.
    const replay = await runControl(home, ['receive', 'task-paused', deliveryId, '--consumer', 'dispatcher'])
    expect(replay.code).toBe(0)
    expect(valueOf(replay)).toMatchObject({ action: 'resume' })

    const consumed = await runControl(home, ['consume', 'task-paused', deliveryId, '--epoch', '1'])
    expect(consumed.code).toBe(0)
    expect(valueOf(consumed)).toMatchObject({ receipt: { status: 'consumed' } })
    const after = await runControl(home, ['receive', 'task-paused', deliveryId, '--consumer', 'dispatcher'])
    expect(after.code).toBe(0)
    expect(valueOf(after)).toMatchObject({ action: 'skip' })

    // The ledger grew; the outbox did not. The answer is still the human's:
    // every step above was a control-plane read or claim and none of them
    // submitted anything into the paused Session.
    expect(service.deliveries()).toHaveLength(1)
    expect(service.receipts()).toMatchObject([{ deliveryId, status: 'consumed' }])
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['turn/start'])
    expect(service.task({ taskId: 'task-paused' }).state).toBe('waiting_input')
  } finally {
    await stop()
  }
})
