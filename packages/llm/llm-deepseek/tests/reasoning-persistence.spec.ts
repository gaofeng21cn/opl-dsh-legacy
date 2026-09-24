import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { closeMockServers, mockServer } from './mock-server.ts'
import type { MockServer } from './mock-server.ts'

/**
 * The CoT the endpoint streams under the gateway alias. Delivered in two
 * fragments so the test also covers reassembly across streamed deltas.
 */
const THINKING_PARTS = ['Let me look that up ', 'carefully.'] as const
const THINKING = THINKING_PARTS.join('')
const CALL_ID = 'chatcmpl-tool-alias-1'
const TOOL_NAME = 'echo_number'
const SESSION = SessionId('alias-reasoning-reload')
const MODEL = 'deepseek-v4-pro'

let testHome: string
const dirs: string[] = []

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-deepseek-reload-home-'))
  vi.stubEnv('DSH_HOME', testHome)
  vi.stubEnv('DSH_REASONING_TRACE_DIR', join(testHome, 'trace'))
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  rmSync(testHome, { recursive: true, force: true })
})

/** One SSE body carrying alias-reasoning fragments followed by a structured tool call. */
function aliasToolCallEvents(): string[] {
  return [
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning":""}}]}',
    ...THINKING_PARTS.map(part => JSON.stringify({
      choices: [{ delta: { content: null, reasoning: part } }],
    })),
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: CALL_ID,
            type: 'function',
            function: { name: TOOL_NAME, arguments: '{"value":7}' },
          }],
        },
      }],
    }),
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9}}',
    '[DONE]',
  ]
}

/** One SSE body carrying a plain text answer. */
function textEvents(text: string): string[] {
  return [
    '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5}}',
    '[DONE]',
  ]
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * A real harness over real JSONL persistence and the real DeepSeek adapter.
 *
 * Every layer here is production code: the agent loop derives each request from
 * the session, the adapter serializes it, and the JSONL backend stores the log.
 */
async function mountPersistentHarness(root: string, baseURL: string): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmDeepSeek, { protocol: 'chat-completions', baseURL })
  // The backend mounts BEFORE the loop so root teardown unwinds the loop first
  // and live agents drain their writers into still-open handles.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

/** Register the side-effect-free tool the scripted call targets. */
function registerEchoTool(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: TOOL_NAME,
    description: 'Return the number it was given. Has no side effects.',
    parameters: { value: { type: 'number' } },
    execute: args => Promise.resolve([{ type: 'text', text: `echo:${String(args.value)}` }]),
  }))
}

function agentOptions() {
  return { provider: 'deepseek-official', model: MODEL }
}

/** One wire message as this suite reads it; the adapter owns the real type. */
interface WireAssistant {
  role: string
  content?: string
  reasoning_content?: string
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}

function wireMessages(server: MockServer, index: number): WireAssistant[] {
  const body = server.requests[index] as { messages?: WireAssistant[] } | undefined
  if (body?.messages === undefined) throw new Error(`mock request ${index} carried no messages`)
  return body.messages
}

async function startServer(): Promise<MockServer> {
  return mockServer([
    { kind: 'sse', events: aliasToolCallEvents() },
    { kind: 'sse', events: textEvents('The tool returned seven.') },
    { kind: 'sse', events: textEvents('Confirmed after reload.') },
  ])
}

describe('reasoning persistence across a real session save and reload', () => {
  it('rebuilds the next request with the alias CoT and its paired tool result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-deepseek-reload-'))
    dirs.push(root)
    const server = await startServer()

    // ---- Lifecycle 1: one tool-calling turn, saved through real persistence.
    const ctx1 = await mountPersistentHarness(root, server.url)
    registerEchoTool(ctx1)
    const first = await ctx1.agents.create({ sessionId: SESSION, agentOptions: agentOptions() })
    first.agent.followup(userMessage('Call echo_number with 7, then report it.'))
    await first.agent.whenIdle()

    // The alias arrived on the wire and became a durable reasoning block.
    const assistantEvent = first.agent.session.snapshotEvents()
      .find(event => event.type === 'assistant/message')
    if (assistantEvent?.type !== 'assistant/message') throw new Error('no assistant message was committed')
    const reasoningBlocks = assistantEvent.data.message.content.filter(block => block.type === 'reasoning')
    expect(reasoningBlocks.map(block => block.text)).toEqual([THINKING])
    // The CoT stayed out of the visible text of that same message.
    const textBlocks = assistantEvent.data.message.content.filter(block => block.type === 'text')
    expect(textBlocks.map(block => block.text).join('')).not.toContain(THINKING)
    expect(server.requests).toHaveLength(2)

    await first.dispose()
    await ctx1.fiber.dispose()

    // ---- Lifecycle 2: a brand-new context reads the stored log back.
    const ctx2 = await mountPersistentHarness(root, server.url)
    registerEchoTool(ctx2)
    const resumed = await ctx2.agents.resume({ resumeSessionId: SESSION, agentOptions: agentOptions() })

    // The reloaded session reconstructs the same reasoning block.
    const restored = resumed.agent.session.deriveMessages()
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.content)
      .filter(block => block.type === 'reasoning')
    expect(restored.map(block => block.text)).toEqual([THINKING])

    // A new turn makes the loop derive and send the next real request.
    resumed.agent.followup(userMessage('Now confirm the number.'))
    await resumed.agent.whenIdle()
    expect(server.requests).toHaveLength(3)

    // ---- The rebuilt request: CoT under the official passback name, paired result.
    const rebuilt = wireMessages(server, 2)
    const assistant = rebuilt.find(message => message.role === 'assistant' && message.tool_calls !== undefined)
    if (assistant === undefined) throw new Error('rebuilt request carried no assistant tool-call message')
    expect(assistant.reasoning_content).toBe(THINKING)
    // Reasoning is never folded into the visible content.
    expect(assistant.content).toBe('')
    expect(assistant.content).not.toContain(THINKING)
    expect(assistant.tool_calls).toEqual([{
      id: CALL_ID,
      type: 'function',
      function: { name: TOOL_NAME, arguments: '{"value":7}' },
    }])

    // The tool result travels as its own paired wire message.
    const assistantIndex = rebuilt.indexOf(assistant)
    const toolResult = rebuilt[assistantIndex + 1]
    expect(toolResult?.role).toBe('tool')
    expect(toolResult).toMatchObject({ tool_call_id: CALL_ID })
    expect(toolResult?.content).toContain('echo:7')

    type HistoryFacts = { sha256: string; count: number; tail: { reasoning: { sha256: string }; tools: string[] }[] }
    type TraceFacts = { blocks: { tools: string[]; reasoning: { sha256: string } }; request: { input: HistoryFacts; output: HistoryFacts } }
    const traces = readdirSync(join(testHome, 'trace')).map(file => (
      JSON.parse(readFileSync(join(testHome, 'trace', file), 'utf8')) as TraceFacts
    ))
    const responseTrace = traces.find(t => t.blocks.tools.length > 0)
    if (responseTrace === undefined) throw new Error('missing tool-call response trace')
    const replays = traces.filter(t => t.request.input.count > 0)
    expect(replays.length).toBeGreaterThanOrEqual(2)
    for (const trace of replays) {
      expect(trace.request.input.sha256).toBe(trace.request.output.sha256)
      expect(trace.request.input.tail[0]?.reasoning.sha256).toBe(responseTrace.blocks.reasoning.sha256)
      expect(trace.request.input.tail[0]?.tools).toEqual(responseTrace.blocks.tools)
    }

    await resumed.dispose()
    await ctx2.fiber.dispose()
  })

  it('keeps the official reasoning name working across the same reload', async () => {
    // The counterpart direction: the official field must pass back too, so the
    // alias support cannot have replaced it.
    const root = mkdtempSync(join(tmpdir(), 'dsh-deepseek-reload-official-'))
    dirs.push(root)
    const official = [
      '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
      JSON.stringify({ choices: [{ delta: { content: null, reasoning_content: THINKING } }] }),
      JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: CALL_ID,
              type: 'function',
              function: { name: TOOL_NAME, arguments: '{"value":7}' },
            }],
          },
        }],
      }),
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":9}}',
      '[DONE]',
    ]
    const server = await mockServer([
      { kind: 'sse', events: official },
      { kind: 'sse', events: textEvents('The tool returned seven.') },
      { kind: 'sse', events: textEvents('Confirmed after reload.') },
    ])

    const ctx1 = await mountPersistentHarness(root, server.url)
    registerEchoTool(ctx1)
    const first = await ctx1.agents.create({ sessionId: SessionId('official-reasoning-reload'), agentOptions: agentOptions() })
    first.agent.followup(userMessage('Call echo_number with 7, then report it.'))
    await first.agent.whenIdle()
    await first.dispose()
    await ctx1.fiber.dispose()

    const ctx2 = await mountPersistentHarness(root, server.url)
    registerEchoTool(ctx2)
    const resumed = await ctx2.agents.resume({
      resumeSessionId: SessionId('official-reasoning-reload'),
      agentOptions: agentOptions(),
    })
    resumed.agent.followup(userMessage('Now confirm the number.'))
    await resumed.agent.whenIdle()

    const assistant = wireMessages(server, 2)
      .find(message => message.role === 'assistant' && message.tool_calls !== undefined)
    expect(assistant?.reasoning_content).toBe(THINKING)

    await resumed.dispose()
    await ctx2.fiber.dispose()
  })
})
