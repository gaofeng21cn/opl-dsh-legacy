import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq as Seq } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

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

function send(agent: Agent, text: string, rpcId?: string): UserMessage {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId: rpcId as never }) },
  })
  agent.followup(message)
  return message
}

/** Text of every user and assistant message one request carried, in order. */
function requestTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? [])
    .filter(message => message.role !== 'system')
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

/** Current surface prompt: its seq, the surface tail, and every shadowed node. */
function lastSurfacePrompt(agent: Agent): { seq: Seq; endSeq: Seq; shadowed: Seq[] } {
  const nodes = agent.session.surface.nodes
  const endSeq = nodes.at(-1)
  if (endSeq === undefined) throw new Error('surface is empty')
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = agent.session.eventAt(seq)
    if (event?.type === 'user/message' && event.data.source.kind === 'user') {
      return { seq, endSeq, shadowed: nodes.slice(index) }
    }
  }
  throw new Error('no surface prompt')
}

describe('edit-and-resend branch', () => {
  it('runs the resent turn over the rewritten branch without logging the prompt twice', async () => {
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('second reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('edit-resend'), { provider: 'mock', model: 'mock' })

    send(agent, 'first prompt')
    await waitForIdle(ctx, agent)
    // The rendered system prompt, the prompt, and its reply.
    expect(agent.session.surface.nodes).toHaveLength(3)

    // The edit command's durable effect: the edited message replaces the branch
    // the original prompt opened, and the same message is then claimed as the
    // next turn's input.
    const prompt = lastSurfacePrompt(agent)
    const edited = createUserMessage({
      content: [{ type: 'text', text: 'edited prompt' }],
      source: { kind: 'user', rpcId: 'edit-1' as never },
    })
    const replacement = agent.session.append('user/message', edited, {
      surfaceOp: { op: 'replace', startSeq: prompt.seq, endSeq: prompt.endSeq },
      sourceEventSeqs: prompt.shadowed,
    })
    agent.followup(edited)
    await waitForIdle(ctx, agent)

    // The resent request derives the edited branch: the abandoned reply is gone.
    expect(requestTexts(adapter.requests.at(-1))).toEqual(['edited prompt'])
    // The claim did not append the message a second time.
    const logged = agent.session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.id === edited.id)
    expect(logged.map(event => event.seq)).toEqual([replacement.seq])
    // The visible branch carries the edit; the replaced history stays traceable.
    expect(agent.session.deriveMessages()
      .filter(message => message.role !== 'system')
      .map(message => message.content)).toEqual([
      edited.content,
      [{ type: 'text', text: 'second reply' }],
    ])
    expect(agent.session.snapshotEvents().some(event =>
      event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'first reply'))).toBe(true)
  })

  it('still appends ordinary prompts after an edited branch', async () => {
    const adapter = new MockAdapter([textResponse('reply one'), textResponse('reply two'), textResponse('reply three')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('edit-then-send'), { provider: 'mock', model: 'mock' })

    send(agent, 'first prompt')
    await waitForIdle(ctx, agent)
    const prompt = lastSurfacePrompt(agent)
    const edited = createUserMessage({
      content: [{ type: 'text', text: 'edited prompt' }],
      source: { kind: 'user', rpcId: 'edit-1' as never },
    })
    agent.session.append('user/message', edited, {
      surfaceOp: { op: 'replace', startSeq: prompt.seq, endSeq: prompt.endSeq },
      sourceEventSeqs: prompt.shadowed,
    })
    agent.followup(edited)
    await waitForIdle(ctx, agent)

    send(agent, 'follow-up prompt')
    await waitForIdle(ctx, agent)

    expect(requestTexts(adapter.requests.at(-1))).toEqual(['edited prompt', 'reply two', 'follow-up prompt'])
    // System prompt, edited prompt, its reply, the follow-up, and its reply.
    expect(agent.session.surface.nodes).toHaveLength(5)
  })

  it('skips only the replaced message when steering joins the same claim', async () => {
    const adapter = new MockAdapter([textResponse('first reply'), textResponse('resent reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('edit-steer-race'), { provider: 'mock', model: 'mock' })

    send(agent, 'first prompt')
    await waitForIdle(ctx, agent)
    const prompt = lastSurfacePrompt(agent)
    const edited = createUserMessage({
      content: [{ type: 'text', text: 'edited prompt' }],
      source: { kind: 'user', rpcId: 'edit-race' as never },
    })
    agent.session.append('user/message', edited, {
      surfaceOp: { op: 'replace', startSeq: prompt.seq, endSeq: prompt.endSeq },
      sourceEventSeqs: prompt.shadowed,
    })
    // Steering lands after the replacement, so the resent prompt is no longer
    // the surface tail when the driver claims both messages in one batch.
    const steering = createUserMessage({
      content: [{ type: 'text', text: 'steering note' }],
      source: { kind: 'user', rpcId: 'steer-race' as never },
    })
    agent.steer(steering)
    agent.followup(edited)
    await waitForIdle(ctx, agent)

    // Steering woke the driver synchronously, so its claim ran before the
    // resent prompt entered the inbox: the resent turn then derived a surface
    // that had moved past the replacement, and still appended it only once.
    expect(requestTexts(adapter.requests.at(-1))).toEqual(['edited prompt', 'steering note', 'resent reply'])
    const resent = agent.session.snapshotEvents().filter(event =>
      event.type === 'user/message' && event.data.id === edited.id)
    expect(resent).toHaveLength(1)
    expect(agent.session.deriveMessages()
      .filter(message => message.role !== 'system')
      .map(message => message.id)).toEqual([edited.id, steering.id, expect.any(String)])
  })
})
