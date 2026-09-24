import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { promptSurfaceProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { isRewindSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-controller-fixture': { kind: 'session-controller-fixture' }
  }
}

interface RewindHarness {
  readonly ctx: Context
  readonly session: Session
  readonly controller: SessionCommandController
  readonly inbox: Inbox
  readonly firstSeq: number
  readonly secondSeq: number
  readonly tailSeq: number
}

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

function prompt(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/**
 * Admit one pending inbox message the way the production Inbox does: the
 * durable splice event first, then the live list.
 */
function admit(
  session: Session,
  inbox: Inbox,
  target: InboxTarget,
  message: UserMessage,
): void {
  const pending = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep
  session.append('agent/inbox/spliced', { target, start: pending.length, inserted: [message] })
  inbox.append(target, message)
}

/** Two completed prompt turns, the second one the rewindable last user message. */
async function rewindHarness(
  options: {
    archived?: boolean
    status?: AgentStatus
    /** Pending inbox work admitted before the rewindable prompt exists. */
    admitBeforeLastPrompt?: UserMessage
  } = {},
): Promise<RewindHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  // The command reads prompt branches from the loop's projection, so the real
  // fold is registered here rather than stubbed.
  ctx.sessionProjections.register(promptSurfaceProjectionDefinition)
  const sessionId = SessionId('rewind-session')
  const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
  const inbox = createInboxStub()
  const firstSeq = prompt(session, 'first prompt')
  appendTurn(session, 1, 'first reply')
  if (options.admitBeforeLastPrompt !== undefined) {
    admit(session, inbox, 'next-step', options.admitBeforeLastPrompt)
  }
  const secondSeq = prompt(session, 'second prompt')
  appendTurn(session, 2, 'second reply')
  const tailSeq = secondSeq + 3

  const agent = {
    id: session.id,
    session,
    inbox,
    status: options.status ?? 'idle',
    ctx,
    steer: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
  } as unknown as Agent
  await ctx.agents.register(agent)
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
    archivedSessionIds: options.archived === true ? [sessionId] : [],
  } as never)
  // This suite covers the surface and queue effects of a rewind, so it stubs the
  // workspace file journal: restoring files is that service's own behavior,
  // covered beside it. Without a journal the command correctly refuses, which is
  // its own case in `commands-rewind-files.host.spec.ts`.
  ctx.provide('fileJournal', {
    restoreTurn: () => Promise.resolve({ kind: 'restored', receipt: { restored: 0, deleted: 0, actions: [] } }),
  } as never)
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    session,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    inbox,
    firstSeq,
    secondSeq,
    tailSeq,
  }
}

/** Model-visible user texts in derived order. */
function derivedUserTexts(session: Session): string[] {
  return session.deriveMessages()
    .filter(message => message.role === 'user')
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

/** The marker node one rewind committed. */
function marker(session: Session, events: readonly SessionEvent[]): SessionEvent<'developer/message'> {
  const found = events.findLast(
    (event): event is SessionEvent<'developer/message'> => isRewindSurfaceEvent(event),
  )
  if (found === undefined) throw new Error('no rewind marker committed')
  expect(session.surface.nodes).toContain(found.seq)
  return found
}

describe('session rewind', () => {
  it('returns the conversation to the state before the last prompt', async () => {
    const { session, controller, secondSeq, tailSeq } = await rewindHarness()
    const logLengthBefore = session.seq

    const result = await controller.rewind({ sessionId: session.id, seq: secondSeq })

    const events = session.snapshotEvents()
    const replacement = marker(session, events)
    expect(replacement.seq).toBe(result.seq)
    // The replacement holds the rewound prompt's surface position and cites the
    // branch it shadowed; `turn`/`step` are the coordinates it happened at.
    expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: secondSeq, endSeq: tailSeq })
    expect([...(replacement.sourceEventSeqs ?? [])]).toEqual([secondSeq, tailSeq])
    expect(replacement.data.turn).toBe(2)
    expect(replacement.data.step).toBe(1)
    expect(replacement.data.message.content).toEqual([])
    expect(session.seq).toBe(logLengthBefore + 1)

    // The model-visible history is the prefix before the rewound prompt; the
    // abandoned turn stays in the append-only log.
    expect(derivedUserTexts(session)).toEqual(['first prompt'])
    expect(events.some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'second reply'))).toBe(true)
    expect(result).toEqual({
      accepted: true,
      seq: replacement.seq,
      shadowedSeqs: [secondSeq, tailSeq],
      discarded: [],
      files: [],
    })
  })

  it('acknowledges a retried rewind once and appends nothing the second time', async () => {
    const { session, controller, secondSeq } = await rewindHarness()

    const first = await controller.rewind({ sessionId: session.id, seq: secondSeq })
    const logLength = session.seq
    const second = await controller.rewind({ sessionId: session.id, seq: secondSeq })

    expect(second).toEqual({ ...first, discarded: [] })
    expect(session.seq).toBe(logLength)
  })

  it('acknowledges a retried rewind even after the Session was archived', async () => {
    const { ctx, session, controller, secondSeq } = await rewindHarness()
    const first = await controller.rewind({ sessionId: session.id, seq: secondSeq })
    const registry = ctx.get('workspaceRegistry') as unknown as { archivedSessionIds: string[] }
    registry.archivedSessionIds.push(session.id)
    const logLength = session.seq

    const second = await controller.rewind({ sessionId: session.id, seq: secondSeq })

    // A landed rollback stays acknowledged: archiving after the fact must not
    // turn a lost confirmation into a reported failure.
    expect(second).toEqual({ ...first, discarded: [] })
    expect(session.seq).toBe(logLength)
  })

  it('refuses a prompt that is not the last one without touching the log', async () => {
    const { session, controller, firstSeq } = await rewindHarness()
    const before = session.seq

    await expect(controller.rewind({ sessionId: session.id, seq: firstSeq }))
      .rejects.toMatchObject({ code: 'session/rewind-unavailable', details: { reason: 'not-last' } })

    expect(session.seq).toBe(before)
    expect(derivedUserTexts(session)).toEqual(['first prompt', 'second prompt'])
  })

  it('refuses an archived Session without touching the log', async () => {
    const { session, controller, secondSeq } = await rewindHarness({ archived: true })
    const before = session.seq

    await expect(controller.rewind({ sessionId: session.id, seq: secondSeq }))
      .rejects.toMatchObject({ code: 'session/rewind-unavailable', details: { reason: 'archived' } })

    expect(session.seq).toBe(before)
  })

  it('refuses while the turn is still running', async () => {
    const { session, controller, secondSeq } = await rewindHarness({ status: 'running' })
    const before = session.seq

    await expect(controller.rewind({ sessionId: session.id, seq: secondSeq }))
      .rejects.toMatchObject({ code: 'session/rewind-unavailable', details: { reason: 'busy' } })

    expect(session.seq).toBe(before)
  })

  it('refuses a prompt whose turn never closed', async () => {
    const { session, controller, secondSeq } = await rewindHarness()
    session.append('turn/start', { turn: 3 })
    session.append('step/start', { turn: 3, step: 1 })
    const before = session.seq

    await expect(controller.rewind({ sessionId: session.id, seq: secondSeq }))
      .rejects.toMatchObject({ code: 'session/rewind-unavailable', details: { reason: 'turn-open' } })

    expect(session.seq).toBe(before)
  })

  it('refuses a Session with no user message and a malformed seq', async () => {
    const { ctx, session, controller } = await rewindHarness()
    const empty = ctx.sessions.create(SessionId('empty-rewind-session'), { meta: { cwd: '/workspace' } })
    const agents = {
      resolveAgent: () => Promise.resolve({ agent: { id: empty.id, session: empty } as unknown as Agent }),
    } as unknown as ApiSessionAgentController
    const bare = new SessionCommandController(ctx, agents, '/workspace')

    await expect(bare.rewind({ sessionId: empty.id, seq: 0 }))
      .rejects.toMatchObject({ code: 'session/rewind-unavailable', details: { reason: 'no-user-message' } })
    await expect(controller.rewind({ sessionId: session.id, seq: -1 }))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })

    expect(empty.seq).toBe(0)
    expect(session.seq).toBeGreaterThan(0)
  })

  it('discards queued work the rewound turn produced but keeps typed prompts', async () => {
    const { session, controller, inbox, secondSeq } = await rewindHarness()
    admit(session, inbox, 'next-step', createUserMessage({
      content: [{ type: 'text', text: 'file changed: a.ts' }],
      source: { kind: 'session-controller-fixture' },
    }))
    const typed = createUserMessage({
      content: [{ type: 'text', text: 'queued follow-up' }],
      source: { kind: 'user' },
    })
    admit(session, inbox, 'next-turn', typed)

    const result = await controller.rewind({ sessionId: session.id, seq: secondSeq })

    expect(inbox.nextStep).toHaveLength(0)
    expect(inbox.nextTurn.map(message => message.id)).toEqual([typed.id])
    expect(result.discarded).toHaveLength(1)
  })

  it('leaves queue work admitted before the rewound prompt pending', async () => {
    const earlier = createUserMessage({
      content: [{ type: 'text', text: 'admitted before the rewound prompt' }],
      source: { kind: 'session-controller-fixture' },
    })
    const { session, controller, inbox, secondSeq } = await rewindHarness({ admitBeforeLastPrompt: earlier })
    const result = await controller.rewind({ sessionId: session.id, seq: secondSeq })

    // The admission window is the log suffix from the rewound prompt, so work
    // admitted before it stays queued.
    expect(inbox.nextStep.map(message => message.id)).toEqual([earlier.id])
    expect(result.discarded).toEqual([])
  })
})
