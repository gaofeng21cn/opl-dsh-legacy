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
import { end, start } from './helpers.ts'
import type { WireMessage } from '../src/wire-types.ts'

/**
 * The native thinking that the endpoint streams. Delivered in two
 * fragments so the test also covers reassembly across streamed deltas.
 */
const THINKING_PARTS = ['Let me look that up ', 'carefully.'] as const
const THINKING = THINKING_PARTS.join('')
const CALL_ID = 'native-thinking-tool-1'
const TOOL_NAME = 'echo_number'
const SESSION = SessionId('native-thinking-reload')
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

/** Native thinking, signature and tool-use events from the Messages endpoint. */
function thinkingToolCallEvents(): string[] {
  return [
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ...THINKING_PARTS.map(part => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: part } })),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'test-thinking-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: CALL_ID, name: TOOL_NAME, input: { value: 7 } } },
    { type: 'content_block_stop', index: 1 },
    ...end('tool_use'),
  ].map(event => JSON.stringify(event))
}

/** One native Messages SSE answer. */
function textEvents(text: string): string[] {
  return [start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 }, ...end(),
  ].map(event => JSON.stringify(event))
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
  await ctx.plugin(LlmDeepSeek, { baseURL })
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

function wireMessages(server: MockServer, index: number): WireMessage[] {
  const body = server.requests[index] as { messages?: WireMessage[] } | undefined
  if (body?.messages === undefined) throw new Error(`mock request ${index} carried no messages`)
  return body.messages
}

async function startServer(): Promise<MockServer> {
  return mockServer([
    { kind: 'sse', events: thinkingToolCallEvents() },
    { kind: 'sse', events: textEvents('The tool returned seven.') },
    { kind: 'sse', events: textEvents('Confirmed after reload.') },
  ])
}

describe('reasoning persistence across a real session save and reload', () => {
  it('rebuilds native thinking, its signature and paired tool result after reload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-deepseek-reload-'))
    dirs.push(root)
    const server = await startServer()

    // ---- Lifecycle 1: one tool-calling turn, saved through real persistence.
    const ctx1 = await mountPersistentHarness(root, server.url)
    registerEchoTool(ctx1)
    const first = await ctx1.agents.create({ sessionId: SESSION, agentOptions: agentOptions() })
    first.agent.followup(userMessage('Call echo_number with 7, then report it.'))
    await first.agent.whenIdle()

    // Native thinking arrived on the wire and became a durable reasoning block.
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

    // The native Messages replay preserves thinking and its signature.
    const rebuilt = wireMessages(server, 2)
    const assistant = rebuilt.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool_use'))
    if (assistant === undefined) throw new Error('rebuilt request carried no assistant tool-call message')
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: THINKING, signature: 'test-thinking-signature' },
      { type: 'tool_use', id: CALL_ID, name: TOOL_NAME, input: { value: 7 } },
    ])
    const assistantIndex = rebuilt.indexOf(assistant)
    const toolResult = rebuilt[assistantIndex + 1]
    expect(toolResult?.role).toBe('user')
    expect(toolResult?.content).toEqual([{
      type: 'tool_result', tool_use_id: CALL_ID, is_error: false, content: [{ type: 'text', text: 'echo:7' }],
    }])

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

})
