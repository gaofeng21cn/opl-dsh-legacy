/**
 * `session.rewind` against the real workspace file journal: which files come
 * back, which refusals leave the workspace untouched, and how a retry or a
 * concurrent request settles. The journal's own behavior (baselines, scans,
 * content addressing, path discipline) is covered beside it; this suite is the
 * command's contract with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { promptSurfaceProjectionDefinition, turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture, ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as rewindFilesPlugin from '@deepseek-ai/dsh-session-rewind-files'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly controller: SessionCommandController
  readonly inbox: Inbox
  /** Event seq of the last human prompt, the addressable rewind target. */
  readonly promptSeq: number
}

let workspace: string
let blobRoot: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-rewind-cmd-ws-'))
  blobRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-cmd-blobs-'))
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(blobRoot, { recursive: true, force: true })
})

/** Append one completed turn whose assistant reply names the prompt it answered. */
function appendTurn(session: Session, turn: number, reply: string): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: reply }],
      source: { provider: 'fixture', model: 'fixture-model' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append one direct human prompt. */
function prompt(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/**
 * Boot the command against the real journal plugin.
 * @param options - harness switches.
 * @param options.withJournal - whether the profile composes the journal plugin.
 * @returns the booted harness.
 */
async function boot(options: { withJournal?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(promptSurfaceProjectionDefinition)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  if (options.withJournal !== false) await ctx.plugin(rewindFilesPlugin, { blobRoot })

  const session = ctx.sessions.create(SessionId('rewind-command-session'), { meta: { cwd: workspace } })
  const inbox = createInboxStub()
  prompt(session, 'first prompt')
  appendTurn(session, 1, 'first reply')
  const promptSeq = prompt(session, 'second prompt')
  appendTurn(session, 2, 'second reply')

  const agent = {
    id: session.id,
    session,
    inbox,
    status: 'idle',
    ctx,
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Agent
  await ctx.agents.register(agent)
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
    archivedSessionIds: [],
  } as never)
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  return { ctx, session, controller: new SessionCommandController(ctx, agents, workspace), inbox, promptSeq }
}

/**
 * Register a writing tool and run one closed turn through the real pipeline, so
 * the journal records the turn's workspace changes exactly as it would live.
 * @param harness - the booted harness.
 * @param body - the writes the turn performs.
 * @param turn - the turn number to open.
 */
async function runWritingTurn(harness: Harness, body: () => Promise<void>, turn = 3): Promise<void> {
  harness.ctx.tools.register(defineContentToolFixture({
    name: 'fixture_write',
    description: 'Test-only tool that performs the writes a case needs.',
    parameters: {},
    async execute() {
      await body()
      return []
    },
  }))
  const agent = harness.ctx.agents.get(harness.session.id)
  if (agent === undefined) throw new Error('harness agent is not registered')
  harness.session.append('turn/start', { turn })
  harness.session.append('step/start', { turn, step: 1 })
  await harness.ctx.tools.execute({
    callId: `call-fixture-${String(turn)}` as never,
    name: 'fixture_write',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  })
  harness.session.append('step/end', { turn, step: 1 })
  harness.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Raw text of one workspace file, or undefined when it does not exist. */
async function textOf(relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(join(workspace, relativePath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

describe('session.rewind with the workspace file journal', () => {
  it('restores the turn’s files and reports them in the receipt', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await boot()
    await runWritingTurn(harness, async () => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed by the turn')
      await writeFile(join(workspace, 'created.txt'), 'brand new')
    })

    const result = await harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq })

    expect(await textOf('tracked.txt')).toBe('original')
    expect(await textOf('created.txt')).toBeUndefined()
    expect(result.files.map(entry => `${entry.action}:${entry.path}`).sort())
      .toEqual(['deleted:created.txt', 'restored:tracked.txt'])
  })

  it('refuses a turn whose journal is not composed, leaving both log and workspace alone', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await boot({ withJournal: false })
    await runWritingTurn(harness, async () => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed by the turn')
    })
    const seqBefore = harness.session.seq

    await expect(harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq }))
      .rejects.toMatchObject({
        code: 'session/rewind-unavailable',
        details: { reason: 'file-unavailable', fileReason: 'file-journal-absent' },
      })
    expect(await textOf('tracked.txt')).toBe('changed by the turn')
    expect(harness.session.seq).toBe(seqBefore)
  })

  it('refuses on a later edit instead of discarding it', async () => {
    await writeFile(join(workspace, 'contested.txt'), 'before the turn')
    const harness = await boot()
    await runWritingTurn(harness, async () => {
      await writeFile(join(workspace, 'contested.txt'), 'written by the turn')
    })
    await writeFile(join(workspace, 'contested.txt'), 'edited by the user afterwards')

    await expect(harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq }))
      .rejects.toMatchObject({
        code: 'session/rewind-unavailable',
        details: { reason: 'file-unavailable', fileReason: 'file-conflict', path: 'contested.txt' },
      })
    expect(await textOf('contested.txt')).toBe('edited by the user afterwards')
  })

  it('answers a retry with the committed rewind and restores nothing twice', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await boot()
    await runWritingTurn(harness, async () => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed by the turn')
    })

    const first = await harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq })
    await writeFile(join(workspace, 'tracked.txt'), 'written after the rewind')
    const retry = await harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq })

    expect(retry.seq).toBe(first.seq)
    expect(retry.files).toEqual([])
    expect(await textOf('tracked.txt')).toBe('written after the rewind')
    expect(harness.session.seq).toBe(first.seq + 1)
  })

  it('serializes two concurrent requests into one restore and one marker', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await boot()
    await runWritingTurn(harness, async () => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed by the turn')
    })

    const request = { sessionId: harness.session.id, seq: harness.promptSeq }
    const [first, second] = await Promise.all([
      harness.controller.rewind(request),
      harness.controller.rewind(request),
    ])

    expect(second.seq).toBe(first.seq)
    expect(await textOf('tracked.txt')).toBe('original')
    expect(harness.session.seq).toBe(first.seq + 1)
  })

  it('refuses while another agent runs in the same workspace', async () => {
    await writeFile(join(workspace, 'tracked.txt'), 'original')
    const harness = await boot()
    await runWritingTurn(harness, async () => {
      await writeFile(join(workspace, 'tracked.txt'), 'changed by the turn')
    })
    const otherSession = harness.ctx.sessions.create(SessionId('other-runner'), { meta: { cwd: workspace } })
    await harness.ctx.agents.register({
      id: otherSession.id,
      session: otherSession,
      inbox: createInboxStub(),
      status: 'running',
      ctx: harness.ctx,
      steer: vi.fn(),
      followup: vi.fn(),
      cancel: vi.fn(),
    } as unknown as Agent)

    await expect(harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq }))
      .rejects.toMatchObject({
        code: 'session/rewind-unavailable',
        details: { reason: 'file-unavailable', fileReason: 'file-workspace-busy' },
      })
    expect(await textOf('tracked.txt')).toBe('changed by the turn')
  })

  it('rewinds a turn that ran no tool without touching the workspace', async () => {
    await writeFile(join(workspace, 'untouched.txt'), 'not ours to change')
    const harness = await boot()
    harness.session.append('turn/start', { turn: 3 })
    harness.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    const result = await harness.controller.rewind({ sessionId: harness.session.id, seq: harness.promptSeq })

    expect(result.files).toEqual([])
    expect(await textOf('untouched.txt')).toBe('not ours to change')
  })
})
