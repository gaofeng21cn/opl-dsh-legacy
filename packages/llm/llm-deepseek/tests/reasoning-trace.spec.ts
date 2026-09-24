import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAssistantMessage, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import { ReasoningTrace } from '../src/protocols/chat-completions/reasoning-trace.ts'

const roots: string[] = []
interface TraceReport {
  wire: {
    fields: { reasoning: { chars: number }; reasoning_content: { fragments: number }; reasoning_text: { chars: number } }
    selected: { sha256: string; chars: number }
    complete: boolean
  }
  blocks: { tools: string[]; reasoning: { sha256: string; chars: number } }
  response: { status: number }
  request: {
    input: { sha256: string }
    output: { sha256: string; tail: { reasoning: { sha256: string }; tools: string[] }[] }
  }
}
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'reasoning-trace-'))
  roots.push(root)
  vi.stubEnv('DSH_REASONING_TRACE_DIR', root)
  return root
}
function adapter(url: string) {
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL: url }),
    resolveApiKey: () => Promise.resolve('SECRET-KEY'),
    resolveUserId: () => 'test' as AnonymousUserId,
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
}
const options = (): GenerateOptions => ({
  provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: ReasoningEffortId('max'),
  messages: [createUserMessage({ content: [{ type: 'text', text: 'SECRET-PROMPT' }], source: { kind: 'plugin', plugin: 'test' } })],
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('links raw reasoning, assembled blocks and the next serialized request without retaining text', async () => {
  const root = directory()
  const reasoning = 'SECRET-THINK中文😀'
  const events = [
    ...[reasoning.slice(0, -1), reasoning.slice(-1)].map(text => JSON.stringify({ choices: [{ delta: { reasoning_content: '', reasoning: text } }] })),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'SECRET-CALL', type: 'function', function: { name: 'test', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]
  const server = await mockServer([{ kind: 'sse', events }, { kind: 'http-error', status: 400, body: JSON.stringify({ error: { message: 'reasoning_text required' } }), headers: { 'x-request-id': 'test-request' } }])
  const client = adapter(server.url)
  const blocks: ContentBlock[] = []
  for await (const chunk of client.stream(options())) if (chunk.type === 'block-end') blocks.push(chunk.block)
  const firstFile = readdirSync(root)[0]!
  const first = JSON.parse(readFileSync(join(root, firstFile), 'utf8')) as TraceReport
  expect(first.wire.fields.reasoning.chars).toBe(reasoning.length)
  expect(first.wire.fields.reasoning_content.fragments).toBe(2)
  expect(first.wire.selected.sha256).toBe(first.blocks.reasoning.sha256)
  expect(first.wire.complete).toBe(true)
  const replay = options()
  replay.messages.push(createAssistantMessage({ content: blocks, source: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }))
  await expect((async () => {
    for await (const _chunk of client.stream(replay)) { /* Consume the failed attempt. */ }
  })()).rejects.toMatchObject({ failure: { status: 400 } })
  const secondFile = readdirSync(root).find(f => f !== firstFile)!
  const second = JSON.parse(readFileSync(join(root, secondFile), 'utf8')) as TraceReport
  expect(second.response.status).toBe(400)
  expect(second.request.input.sha256).toBe(second.request.output.sha256)
  expect(second.request.output.tail[0]?.reasoning.sha256).toBe(first.blocks.reasoning.sha256)
  expect(second.request.output.tail[0]?.tools).toEqual(first.blocks.tools)
  const reports = readdirSync(root).map(f => readFileSync(join(root, f), 'utf8')).join('')
  for (const secret of ['SECRET-KEY', 'SECRET-PROMPT', 'SECRET-THINK', 'SECRET-CALL', '中文']) expect(reports).not.toContain(secret)
})

it('records an unrecognized reasoning_text field independently of translated output', () => {
  const root = directory()
  const trace = ReasoningTrace.open()!
  trace.payload(JSON.stringify({ choices: [{ delta: { reasoning_text: 'hidden' } }] }))
  trace.close()
  const report = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), 'utf8')) as TraceReport
  expect(report.wire.fields.reasoning_text.chars).toBe(6)
  expect(report.wire.selected.chars).toBe(0)
  expect(report.blocks.reasoning.chars).toBe(0)
  expect(report.wire.complete).toBe(false)
})

it('does not fail generation when the trace destination cannot be written', async () => {
  const root = directory()
  const file = join(root, 'file')
  writeFileSync(file, 'not a directory')
  vi.stubEnv('DSH_REASONING_TRACE_DIR', file)
  const server = await mockServer([{ kind: 'sse', events: textEvents }])
  const chunks = []
  for await (const chunk of adapter(server.url).stream(options())) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
})

it('is disabled without an absolute opt-in path', () => {
  expect(ReasoningTrace.open('')).toBeUndefined()
  expect(ReasoningTrace.open('relative')).toBeUndefined()
})
