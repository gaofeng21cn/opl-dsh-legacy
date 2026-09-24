import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { promptSurfaceProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import type { SessionEditPromptRequest } from '../src/types.ts'
import { installSessionReadTestServices } from './test-remote.ts'

interface EditHarness {
  readonly ctx: Context
  readonly session: Session
  readonly controller: SessionCommandController
  readonly inbox: Inbox
  readonly followup: ReturnType<typeof vi.fn>
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

/** Two completed prompt turns, the second one the editable last user message. */
async function editHarness(
  options: { archived?: boolean; status?: AgentStatus; routable?: boolean } = {},
): Promise<EditHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  // The command reads prompt branches from the loop's projection, so the real
  // fold is registered here rather than stubbed.
  ctx.sessionProjections.register(promptSurfaceProjectionDefinition)
  const sessionId = SessionId('edit-session')
  const session = ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
  const firstSeq = prompt(session, 'first prompt')
  appendTurn(session, 1, 'first reply')
  const secondSeq = prompt(session, 'second prompt')
  appendTurn(session, 2, 'second reply')
  const tailSeq = secondSeq + 3

  const inbox = createInboxStub()
  const followup = vi.fn((message: UserMessage) => { inbox.append('next-turn', message) })
  const agent = {
    id: session.id,
    session,
    inbox,
    status: options.status ?? 'idle',
    ctx,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  await ctx.agents.register(agent)
  ctx.provide('workspaceRegistry', {
    get: () => undefined,
    list: () => [],
    archivedSessionIds: options.archived === true ? [sessionId] : [],
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  ctx.provide('llm', {
    listProviders: () => options.routable === false ? [] : [{ id: 'fixture', name: 'fixture' }],
    resolveModelInfo: () => Promise.resolve({ inputModalities: ['text'] }),
  } as never)
  ctx.provide('attachments', {
    imageLimits: {},
    admitPromptContent: (content: readonly unknown[]) => Promise.resolve(content),
  } as never)
  ctx.provide('fileUploads', {
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  } as never)
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'fixture-model' },
    assembled: undefined,
  }
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    selectionFor: () => selection,
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
    composeAgent: () => Promise.resolve({ setup: () => {} }),
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    session,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    inbox,
    followup,
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

describe('session editPrompt', () => {
  it('replaces the last user message branch and resends it as the next turn', async () => {
    const { session, controller, inbox, followup, secondSeq, tailSeq } = await editHarness()
    const logLengthBefore = session.seq

    const result = await controller.editPrompt({
      requestId: 'edit-1' as never,
      sessionId: session.id,
      seq: secondSeq,
      content: [{ type: 'text', text: 'edited prompt' }],
    })

    const replacement = session.eventAt(SessionSeq(result.seq))
    expect(replacement?.type).toBe('user/message')
    if (replacement?.type !== 'user/message') throw new Error('replacement missing')
    expect(replacement.data.content).toEqual([{ type: 'text', text: 'edited prompt' }])
    // The replaced range spans the prompt and the reply that answered it; the
    // turn and step boundaries between them are log-only, never surface nodes.
    expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: secondSeq, endSeq: tailSeq })
    expect([...(replacement.sourceEventSeqs ?? [])].sort()).toEqual([secondSeq, tailSeq].sort())
    expect(session.seq).toBe(logLengthBefore + 1)

    // The visible branch keeps the first turn and the edited prompt; the
    // abandoned reply left it while remaining in the log.
    expect(derivedUserTexts(session)).toEqual(['first prompt', 'edited prompt'])
    expect(session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'second reply'))).toBe(true)

    // The edited message is the resend: queued once, carrying the client identity.
    expect(followup).toHaveBeenCalledTimes(1)
    const queued = inbox.nextTurn.at(0)
    expect(queued?.content).toEqual([{ type: 'text', text: 'edited prompt' }])
    expect(queued?.id).toBe(replacement.data.id)
    expect(result).toEqual({ accepted: true, seq: replacement.seq })
  })

  it('refuses a non-last user message without touching the log or the inbox', async () => {
    const { session, controller, inbox, firstSeq } = await editHarness()
    const before = session.seq

    await expect(controller.editPrompt({
      requestId: 'edit-stale' as never,
      sessionId: session.id,
      seq: firstSeq,
      content: [{ type: 'text', text: 'rewrite the first prompt' }],
    })).rejects.toMatchObject({ code: 'session/edit-unavailable', details: { reason: 'not-last' } })

    expect(session.seq).toBe(before)
    expect(inbox.nextTurn).toHaveLength(0)
  })

  it('refuses a Session with no user message', async () => {
    const { ctx, session, controller } = await editHarness()
    const empty = ctx.sessions.create(SessionId('empty-session'), { meta: { cwd: '/workspace' } })
    const agents = {
      resolveAgent: () => Promise.resolve({ agent: { id: empty.id, session: empty } as unknown as Agent }),
      selectionFor: () => ({ current: { provider: 'fixture', model: 'fixture-model' } }),
      serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
    } as unknown as ApiSessionAgentController
    const bare = new SessionCommandController(ctx, agents, '/workspace')

    await expect(bare.editPrompt({
      requestId: 'edit-empty' as never,
      sessionId: empty.id,
      seq: 0,
      content: [{ type: 'text', text: 'nothing to edit' }],
    })).rejects.toMatchObject({ code: 'session/edit-unavailable', details: { reason: 'no-user-message' } })

    expect(empty.seq).toBe(0)
    expect(session.seq).toBeGreaterThan(0)
    expect(controller).toBeDefined()
  })

  it('refuses an archived Session without touching the log', async () => {
    const { session, controller, inbox, secondSeq } = await editHarness({ archived: true })
    const before = session.seq

    await expect(controller.editPrompt({
      requestId: 'edit-archived' as never,
      sessionId: session.id,
      seq: secondSeq,
      content: [{ type: 'text', text: 'edited' }],
    })).rejects.toMatchObject({ code: 'session/edit-unavailable', details: { reason: 'archived' } })

    expect(session.seq).toBe(before)
    expect(inbox.nextTurn).toHaveLength(0)
  })

  it('refuses while a turn is running', async () => {
    const { session, controller, inbox, secondSeq } = await editHarness({ status: 'running' })
    const before = session.seq

    await expect(controller.editPrompt({
      requestId: 'edit-busy' as never,
      sessionId: session.id,
      seq: secondSeq,
      content: [{ type: 'text', text: 'edited' }],
    })).rejects.toMatchObject({ code: 'session/edit-unavailable', details: { reason: 'busy' } })

    expect(session.seq).toBe(before)
    expect(inbox.nextTurn).toHaveLength(0)
  })

  it('acknowledges a retried edit once and queues the message once', async () => {
    const { session, controller, inbox, followup, secondSeq } = await editHarness()
    const request: SessionEditPromptRequest = {
      requestId: 'edit-retry' as never,
      sessionId: session.id,
      seq: secondSeq,
      content: [{ type: 'text', text: 'edited once' }],
    }

    const first = await controller.editPrompt(request)
    const second = await controller.editPrompt(request)

    expect(second).toEqual(first)
    expect(session.seq).toBe(first.seq + 1)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(inbox.nextTurn).toHaveLength(1)
  })

  it('keeps a synthetic context message inside the replaced branch', async () => {
    const { session, controller, secondSeq } = await editHarness()
    const injectedSeq = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected notice' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    }), { surfaceOp: 'append' }).seq

    const result = await controller.editPrompt({
      requestId: 'edit-context' as never,
      sessionId: session.id,
      seq: secondSeq,
      content: [{ type: 'text', text: 'edited around context' }],
    })

    const replacement = session.eventAt(SessionSeq(result.seq))
    expect(replacement?.type).toBe('user/message')
    if (replacement?.type !== 'user/message') throw new Error('replacement missing')
    expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: secondSeq, endSeq: injectedSeq })
    expect(derivedUserTexts(session)).toEqual(['first prompt', 'edited around context'])
  })

  it('rejects empty content, a bad seq, and an unroutable model', async () => {
    const { session, controller, secondSeq } = await editHarness()

    await expect(controller.editPrompt({
      requestId: 'edit-blank' as never,
      sessionId: session.id,
      seq: secondSeq,
      content: [{ type: 'text', text: '   ' }],
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })

    await expect(controller.editPrompt({
      requestId: 'edit-bad-seq' as never,
      sessionId: session.id,
      seq: -1,
      content: [{ type: 'text', text: 'edited' }],
    })).rejects.toMatchObject({ code: 'gateway/bad-request' })

    const unroutable = await editHarness({ routable: false })
    const unroutableBefore = unroutable.session.seq
    await expect(unroutable.controller.editPrompt({
      requestId: 'edit-unroutable' as never,
      sessionId: unroutable.session.id,
      seq: unroutable.secondSeq,
      content: [{ type: 'text', text: 'edited' }],
    })).rejects.toMatchObject({ code: 'session/model-unavailable' })
    expect(unroutable.session.seq).toBe(unroutableBefore)
  })
})
