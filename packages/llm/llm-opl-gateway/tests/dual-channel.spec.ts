/** Failover must never replay output, cancelled work, or a tool call. */
import { describe, expect, it, vi } from 'vitest'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DualChannelAdapter, OPENAI_PROVIDER } from '../src/dual-channel.ts'

const request: GenerateOptions = { provider: 'opl-gateway', model: 'deepseek-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
class Adapter extends LlmAdapter {
  constructor(readonly generate: (options: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  stream(options: GenerateOptions) { return this.generate(options) }
}
async function collect(adapter: LlmAdapter, options = request) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}
function setup(primary: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const fallback = vi.fn(async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    expect(options.provider).toBe(OPENAI_PROVIDER)
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const changed = vi.fn()
  return { fallback, changed, adapter: new DualChannelAdapter(new Adapter(primary), new Adapter(fallback), changed, vi.fn()) }
}
describe('OPL dual-channel failover', () => {
  it.each(['SERVER', 'TIMEOUT', 'TRANSPORT', 'AUTH', 'RATE_LIMIT', 'QUOTA', 'HTTP_404', 'MISSING_CREDENTIAL'])('falls back on %s before output', async (code) => {
    const { adapter, fallback, changed } = setup(async function* () { throw new LlmError('failed', code) })
    expect(await collect(adapter)).toHaveLength(1)
    expect(fallback).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledWith('codex')
  })
  it('handles an in-band error before any output', async () => {
    const { adapter, fallback } = setup(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'failed' } } } })
    await collect(adapter)
    expect(fallback).toHaveBeenCalledOnce()
  })
  it.each(['INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED'])('does not mask %s', async (code) => {
    const { adapter, fallback } = setup(async function* () { throw new LlmError('failed', code) })
    await expect(collect(adapter)).rejects.toMatchObject({ code })
    expect(fallback).not.toHaveBeenCalled()
  })
  it.each(['text', 'tool-call'] as const)('never retries after a %s block starts', async (blockType) => {
    const { adapter, fallback } = setup(async function* () {
      yield { type: 'block-start', index: 0, blockType }
      throw new LlmError('connection lost', 'TRANSPORT')
    })
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(fallback).not.toHaveBeenCalled()
  })
  it('does not turn caller cancellation into failover', async () => {
    const controller = new AbortController()
    const { adapter, fallback } = setup(async function* () { controller.abort(); throw new LlmError('failed', 'TRANSPORT') })
    await expect(collect(adapter, { ...request, signal: controller.signal })).rejects.toBeDefined()
    expect(fallback).not.toHaveBeenCalled()
  })
  it('exposes a direct compatibility route', async () => {
    const primary = vi.fn(async function* (): AsyncGenerator<StreamChunk> { throw new Error('must not call') })
    const { adapter, fallback } = setup(primary)
    await collect(adapter, { ...request, provider: OPENAI_PROVIDER })
    expect(primary).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })
})
