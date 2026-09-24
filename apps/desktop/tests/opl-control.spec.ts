/**
 * CLI-level checks for the packaged `opl-dsh-control.mjs` entry: a spawned
 * Node process reads a real control binding and talks to a local fake desktop,
 * so argument validation and the wire request are observed rather than
 * re-derived from the script's source.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const controlPath = fileURLToPath(new URL('../opl/opl-dsh-control.mjs', import.meta.url))

/** One finished CLI run: exit code and both captured streams. */
interface CliRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Spawn the packaged control CLI against one home directory. */
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

/** A local control endpoint that records every request body it answers. */
interface FakeDesktop {
  readonly requests: Record<string, unknown>[]
  stop(): Promise<void>
}

/** One scripted bridge answer, used where a test needs a business refusal. */
type Responder = (request: Record<string, unknown>) => { status: number; body: unknown }

/** The acknowledgement `session.prompt` and `session.updateQueue` return on success. */
const accepted: Responder = () => ({ status: 200, body: { ok: true, value: { accepted: true } } })

/**
 * Publish a real binding file for a loopback endpoint that answers every call.
 * @param home - desktop home the CLI reads its binding from.
 * @param respond - answer to return; defaults to a successful value for every call.
 * @returns the recorded request bodies and the shutdown operation.
 */
async function fakeDesktop(home: string, respond?: Responder): Promise<FakeDesktop> {
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body) as Record<string, unknown>
      requests.push(request)
      const answer = respond?.(request) ?? { status: 200, body: { ok: true, value: { moved: true } } }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake control endpoint did not bind')
  const stop = (): Promise<void> => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })
  try {
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'desktop', 'control.json'), JSON.stringify({
      version: 1,
      endpoint: `http://127.0.0.1:${String(address.port)}/rpc`,
      token: 'test-token',
    }))
  } catch (error) {
    await stop()
    throw error
  }
  return { requests, stop }
}

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'opl-control-cli-'))
  homes.push(home)
  return home
}

/**
 * Read the named arguments of the single request the CLI sent.
 * @param desktop - fake endpoint holding the recorded calls.
 * @returns the recorded `args.request` body.
 */
function sentRequest(desktop: FakeDesktop): Record<string, unknown> {
  const wire = desktop.requests[0]
  if (wire === undefined) throw new Error('the control CLI sent no request')
  return (wire.args as { request: Record<string, unknown> }).request
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

it('refuses missing and conflicting move-session targets before any control request', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home)
  try {
    const missingSession = await runControl(home, ['move-session'])
    expect(missingSession.code).toBe(1)
    expect(missingSession.stderr).toContain('move-session requires SESSION')

    const missingTarget = await runControl(home, ['move-session', 's1'])
    expect(missingTarget.code).toBe(1)
    expect(missingTarget.stderr).toContain('move-session requires --project WORKSPACE_ID or --out')

    const bothTargets = await runControl(home, ['move-session', 's1', '--project', 'w1', '--out'])
    expect(bothTargets.code).toBe(1)
    expect(bothTargets.stderr).toContain('not both')

    const bothTargetsReversed = await runControl(home, ['move-session', 's1', '--out', '--project', 'w1'])
    expect(bothTargetsReversed.code).toBe(1)
    expect(bothTargetsReversed.stderr).toContain('not both')

    const valuelessProject = await runControl(home, ['move-session', 's1', '--project', '--out'])
    expect(valuelessProject.code).toBe(1)
    expect(valuelessProject.stderr).toContain('--project requires a value')

    expect(desktop.requests).toEqual([])
  } finally {
    await desktop.stop()
  }
})

it('routes --project and --out to distinct moveSession requests', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home)
  try {
    const moved = await runControl(home, ['move-session', 's1', '--project', 'w1'])
    expect(moved.code).toBe(0)
    expect(desktop.requests).toEqual([{
      namespace: 'workspace',
      method: 'moveSession',
      args: { request: { sessionId: 's1', workspaceId: 'w1' } },
    }])

    const outside = await runControl(home, ['move-session', 's1', '--out'])
    expect(outside.code).toBe(0)
    expect(desktop.requests).toEqual([
      {
        namespace: 'workspace',
        method: 'moveSession',
        args: { request: { sessionId: 's1', workspaceId: 'w1' } },
      },
      {
        namespace: 'workspace',
        method: 'moveSession',
        args: { request: { sessionId: 's1' } },
      },
    ])
  } finally {
    await desktop.stop()
  }
})

it('sends one prompt as a queued request by default and echoes the requested mode', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home, accepted)
  const prompt = join(home, 'prompt.txt')
  writeFileSync(prompt, 'first line\nsecond line\n')
  try {
    const sent = await runControl(home, ['send', 's1', '--file', prompt])
    expect(sent.code).toBe(0)
    expect(desktop.requests).toHaveLength(1)
    expect(desktop.requests[0]).toMatchObject({ namespace: 'session', method: 'prompt' })
    const request = sentRequest(desktop)
    expect(request).toMatchObject({
      sessionId: 's1',
      mode: 'queue',
      content: [{ type: 'text', text: 'first line\nsecond line\n' }],
    })
    const requestId = request.requestId
    expect(typeof requestId).toBe('string')
    const receipt = JSON.parse(sent.stdout) as { value: unknown; requestId: string; requestMode: string }
    expect(receipt.value).toEqual({ accepted: true })
    expect(receipt.requestMode).toBe('queue')
    // The receipt must name the request that was actually sent, so a caller can
    // correlate admission without reading a second control call.
    expect(receipt.requestId).toBe(requestId)
  } finally {
    await desktop.stop()
  }
})

it('passes an explicit steer mode and the prompt bytes through unchanged', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home, accepted)
  const prompt = join(home, 'unicode.txt')
  const text = '补充：不要改 UI，先跑测试。\nEmoji 😀 and tabs\tstay\n'
  writeFileSync(prompt, text, 'utf8')
  try {
    const sent = await runControl(home, ['send', 's1', '--file', prompt, '--mode', 'steer'])
    expect(sent.code).toBe(0)
    expect(sentRequest(desktop)).toMatchObject({
      sessionId: 's1',
      mode: 'steer',
      content: [{ type: 'text', text }],
    })
    expect(JSON.parse(sent.stdout)).toMatchObject({
      ok: true,
      value: { accepted: true },
      requestMode: 'steer',
    })
  } finally {
    await desktop.stop()
  }
})

it('refuses an unusable mode and missing send values before any control request', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home)
  const prompt = join(home, 'prompt.txt')
  writeFileSync(prompt, 'text')
  try {
    const badMode = await runControl(home, ['send', 's1', '--file', prompt, '--mode', 'interrupt'])
    expect(badMode.code).toBe(1)
    expect(badMode.stderr).toContain('--mode must be queue or steer')

    const valuelessMode = await runControl(home, ['send', 's1', '--file', prompt, '--mode'])
    expect(valuelessMode.code).toBe(1)
    expect(valuelessMode.stderr).toContain('--mode requires a value')

    const flagAsMode = await runControl(home, ['send', 's1', '--file', prompt, '--mode', '--request-id', 'r1'])
    expect(flagAsMode.code).toBe(1)
    expect(flagAsMode.stderr).toContain('--mode requires a value')

    const missingFile = await runControl(home, ['send', 's1', '--mode', 'steer'])
    expect(missingFile.code).toBe(1)
    expect(missingFile.stderr).toContain('send requires --file PROMPT.txt')

    const valuelessFile = await runControl(home, ['send', 's1', '--file'])
    expect(valuelessFile.code).toBe(1)
    expect(valuelessFile.stderr).toContain('--file requires a value')

    const missingSession = await runControl(home, ['send', '--file', prompt])
    expect(missingSession.code).toBe(1)
    expect(missingSession.stderr).toContain('send requires SESSION')

    expect(desktop.requests).toEqual([])
  } finally {
    await desktop.stop()
  }
})

it('steers one pending queue item by id and requires both positional arguments', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home, accepted)
  try {
    const steered = await runControl(home, ['steer-queued', 's1', 'q-42'])
    expect(steered.code).toBe(0)
    expect(desktop.requests).toEqual([{
      namespace: 'session',
      method: 'updateQueue',
      args: { request: { sessionId: 's1', itemId: 'q-42', action: { kind: 'steer' } } },
    }])
    expect(JSON.parse(steered.stdout)).toEqual({ ok: true, value: { accepted: true } })

    const missingSession = await runControl(home, ['steer-queued'])
    expect(missingSession.code).toBe(1)
    expect(missingSession.stderr).toContain('steer-queued requires SESSION')

    const missingItem = await runControl(home, ['steer-queued', 's1'])
    expect(missingItem.code).toBe(1)
    expect(missingItem.stderr).toContain('steer-queued requires ITEM')

    const flagAsItem = await runControl(home, ['steer-queued', 's1', '--mode', 'steer'])
    expect(flagAsItem.code).toBe(1)
    expect(flagAsItem.stderr).toContain('steer-queued requires ITEM')

    expect(desktop.requests).toHaveLength(1)
  } finally {
    await desktop.stop()
  }
})

it('reports a refused steer with its server code and a failing exit code instead of requeueing it', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home, (request) => {
    const args = request.args as { request: { itemId: string } }
    return args.request.itemId === 'q-gone'
      ? { status: 400, body: { ok: false, error: 'queued item is no longer pending', code: 'session/queue-item-not-found', details: { itemId: 'q-gone' } } }
      : { status: 400, body: { ok: false, error: 'current turn no longer accepts steering', code: 'session/steer-unavailable', details: { itemId: 'q-42' } } }
  })
  try {
    const unavailable = await runControl(home, ['steer-queued', 's1', 'q-42'])
    expect(unavailable.code).toBe(1)
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      ok: false,
      code: 'session/steer-unavailable',
      details: { itemId: 'q-42' },
    })

    const gone = await runControl(home, ['steer-queued', 's1', 'q-gone'])
    expect(gone.code).toBe(1)
    expect(JSON.parse(gone.stdout)).toMatchObject({ ok: false, code: 'session/queue-item-not-found' })

    // A refusal never turns into a prompt: the two calls carry exactly the two
    // addressed queue mutations, so nothing was silently queued instead.
    expect(desktop.requests).toEqual([
      {
        namespace: 'session',
        method: 'updateQueue',
        args: { request: { sessionId: 's1', itemId: 'q-42', action: { kind: 'steer' } } },
      },
      {
        namespace: 'session',
        method: 'updateQueue',
        args: { request: { sessionId: 's1', itemId: 'q-gone', action: { kind: 'steer' } } },
      },
    ])
  } finally {
    await desktop.stop()
  }
})

it('lists the notification outbox, filtered to one target thread and to pending deliveries', async () => {
  const home = makeHome()
  /** One stored delivery, with the needs-input payload the CLI must pass through. */
  const delivery = (
    deliveryId: string,
    threadId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    deliveryId,
    taskId: deliveryId.split('@')[0],
    target: { kind: 'codex-thread', threadId },
    stage: 'enqueued',
    attempts: 0,
    nextAttemptAt: null,
    acknowledged: false,
    retired: false,
    payload: {
      taskId: deliveryId.split('@')[0],
      state: 'waiting_input',
      sessionId: 'session-paused',
      turn: 1,
      summary: 'the Session asked its human a question',
      evidence: { sessionId: 'session-paused', turn: 1, seq: 3, eventSeqs: [] },
      acceptance: 'the human answered the question in the Session',
      resumeEligible: false,
      leakedToolSyntax: null,
      needsInput: {
        kind: 'question',
        sessionId: 'session-paused',
        turn: 1,
        seq: 3,
        pauseId: '3:q-1',
        questions: [{ id: 'q-1', question: 'Which branch?', header: null, options: [], multiSelect: false, intent: null }],
        approval: null,
      },
    },
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  })
  const desktop = await fakeDesktop(home, () => ({
    status: 200,
    body: {
      ok: true,
      value: [
        delivery('task-a@waiting_input@3:q-1', 'thread-a'),
        delivery('task-b@completed', 'thread-b', { acknowledged: true, stage: 'received' }),
        delivery('task-c@failed', 'thread-b', { retired: true, nextAttemptAt: null }),
      ],
    },
  }))
  try {
    const all = await runControl(home, ['outbox'])
    expect(all.code).toBe(0)
    expect(desktop.requests).toEqual([{ namespace: 'taskFeedback', method: 'outbox', args: {} }])
    const listed = JSON.parse(all.stdout) as { value: { deliveryId: string }[] }
    expect(listed.value.map(entry => entry.deliveryId))
      .toEqual(['task-a@waiting_input@3:q-1', 'task-b@completed', 'task-c@failed'])
    // The needs-input payload survives the read: a dispatcher that was not
    // woken still learns the question and which Session is waiting for its human.
    expect(listed.value[0]).toMatchObject({
      payload: { needsInput: { kind: 'question', sessionId: 'session-paused', questions: [{ id: 'q-1', question: 'Which branch?' }] } },
    })

    const pending = await runControl(home, ['outbox', '--pending'])
    expect(JSON.parse(pending.stdout).value.map((entry: { deliveryId: string }) => entry.deliveryId))
      .toEqual(['task-a@waiting_input@3:q-1'])

    const thread = await runControl(home, ['outbox', '--thread', 'thread-b'])
    expect(JSON.parse(thread.stdout).value.map((entry: { deliveryId: string }) => entry.deliveryId))
      .toEqual(['task-b@completed', 'task-c@failed'])

    const both = await runControl(home, ['outbox', '--thread', 'thread-b', '--pending'])
    expect(JSON.parse(both.stdout).value).toEqual([])

    // Every read addressed the same read-only method: listing never creates,
    // claims, or consumes a delivery.
    expect(desktop.requests).toEqual(Array.from({ length: 4 }, () => ({
      namespace: 'taskFeedback',
      method: 'outbox',
      args: {},
    })))

    const valueless = await runControl(home, ['outbox', '--thread'])
    expect(valueless.code).toBe(1)
    expect(valueless.stderr).toContain('--thread requires a value')
    expect(desktop.requests).toHaveLength(4)
  } finally {
    await desktop.stop()
  }
})

it('reports a resume-failed decision other than resumed as its own exit code', async () => {
  const home = makeHome()
  const decisions: Record<string, string> = {
    'd-resumed': 'resumed',
    'd-budget': 'budget-exhausted',
    'd-superseded': 'superseded',
    'd-na': 'not-applicable',
  }
  const desktop = await fakeDesktop(home, (request) => {
    const args = request.args as { request: { deliveryId: string } }
    const decision = decisions[args.request.deliveryId]
    return {
      status: 200,
      body: {
        ok: true,
        value: {
          decision,
          reason: decision === 'budget-exhausted' ? 'the original task already used 1 of 1 automatic resumes' : 'observed reason',
          attempt: decision === 'resumed' ? { taskId: 'root#r1', attempt: 1, requestId: 'task-feedback-resume:root:1' } : null,
        },
      },
    }
  })
  try {
    const resumed = await runControl(home, ['resume-failed', 'root', 'd-resumed', '--consumer', 'owner'])
    expect(resumed.code).toBe(0)
    expect(resumed.stderr).toBe('')
    expect(JSON.parse(resumed.stdout)).toMatchObject({ ok: true, value: { decision: 'resumed' } })

    // An answered call that submitted nothing is not a recovery: the caller
    // cannot read exit 0 as "the task was resumed", and the reason is on stderr.
    const exhausted = await runControl(home, ['resume-failed', 'root', 'd-budget', '--consumer', 'owner'])
    expect(exhausted.code).toBe(5)
    expect(exhausted.stderr).toContain('spent its automatic-resume budget')
    expect(JSON.parse(exhausted.stdout)).toMatchObject({ value: { decision: 'budget-exhausted' } })

    const superseded = await runControl(home, ['resume-failed', 'root', 'd-superseded', '--consumer', 'owner'])
    expect(superseded.code).toBe(5)
    expect(superseded.stderr).toContain('continue manually')

    const inapplicable = await runControl(home, ['resume-failed', 'root', 'd-na', '--consumer', 'owner'])
    expect(inapplicable.code).toBe(5)
    expect(inapplicable.stderr).toContain('not the reasoning_text protocol failure')

    // Every call addressed exactly one resume request: a stand-down never
    // becomes a second attempt through the CLI.
    expect(desktop.requests.map(request => (request.args as { request: { deliveryId: string } }).request.deliveryId))
      .toEqual(['d-resumed', 'd-budget', 'd-superseded', 'd-na'])
  } finally {
    await desktop.stop()
  }
})

it('keeps a server refusal on exit code 1 and missing resume arguments off the wire', async () => {
  const home = makeHome()
  const desktop = await fakeDesktop(home, () => ({
    status: 400,
    body: { ok: false, error: 'no receipt', code: 'task-feedback/receipt-not-found', details: { taskId: 'root', deliveryId: 'd-1' } },
  }))
  try {
    const refused = await runControl(home, ['resume-failed', 'root', 'd-1'])
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, code: 'task-feedback/receipt-not-found' })

    const missingTask = await runControl(home, ['resume-failed'])
    expect(missingTask.code).toBe(1)
    expect(missingTask.stderr).toContain('resume-failed requires TASK')

    const missingDelivery = await runControl(home, ['resume-failed', 'root'])
    expect(missingDelivery.code).toBe(1)
    expect(missingDelivery.stderr).toContain('resume-failed requires DELIVERY')

    expect(desktop.requests).toHaveLength(1)
  } finally {
    await desktop.stop()
  }
})
