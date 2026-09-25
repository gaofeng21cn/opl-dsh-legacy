import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekAdapter, resolveAdapterOptions } from '../src/index.ts'
import type { DeepSeekAdapterOptions } from '../src/types.ts'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { attemptAnomaly, controlMarkerFamilies, describeAttemptAnomaly, WireObserver } from '../src/protocol-anomaly.ts'
import type { AttemptFacts, BlockFacts, WireFacts } from '../src/protocol-anomaly.ts'
import { chunks, end, options, prepareExtensions, server, sse, start } from './helpers.ts'

const BAR = '\uFF5C'
const dsmlTag = (name: string): string => `</${BAR}DSML${BAR}${name}>`
const servers: Awaited<ReturnType<typeof server>>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(item => item.close())) })
const delta = (text: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
const openText = (text = '', index = 0) => ({ type: 'content_block_start', index, content_block: { type: 'text', text } })
const closeBlock = (index = 0) => ({ type: 'content_block_stop', index })
const thinking = (text: string) => ({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: text } })

async function run(events: Record<string, unknown>[], sink?: DeepSeekAdapterOptions['onProtocolAnomaly']) {
  const endpoint = await server((response) => {
    response.setHeader('request-id', 'request-123')
    response.end(sse(events))
  })
  servers.push(endpoint)
  const adapter = new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ baseURL: endpoint.url }),
    resolveAuth: async () => ({ headers: { 'x-api-key': 'SECRET-KEY' } }),
    resolveUserId: () => 'test' as AnonymousUserId,
    ...(sink === undefined ? {} : { onProtocolAnomaly: sink }),
    prepareExtensions,
  })
  return chunks(adapter.stream(options()))
}

describe('control marker families', () => {
  it('recognizes the thinking delimiter in either spelling', () => {
    expect(controlMarkerFamilies('<thinking>plan</thinking>')).toEqual(['thinking-tag'])
    expect(controlMarkerFamilies('<think>plan</think>')).toEqual(['thinking-tag'])
  })

  it('recognizes the DSML-wrapped and the bare tag spellings', () => {
    const observed = [dsmlTag('parameter'), dsmlTag('invoke'), dsmlTag('tool_calls')].join('\n')
    expect(controlMarkerFamilies(observed)).toEqual(['dsml', 'invoke-tag', 'parameter-tag', 'tool-calls-tag'])
    expect(controlMarkerFamilies('</parameter></invoke>')).toEqual(['invoke-tag', 'parameter-tag'])
  })

  it('reports ordinary prose as carrying no marker', () => {
    expect(controlMarkerFamilies('The typecheck passed; now the docs.')).toEqual([])
    // Discussing the syntax in prose is not emitting it.
    expect(controlMarkerFamilies('A tool name may not contain a bare DSML word.')).toEqual([])
  })
})

describe('WireObserver: native Messages facts before translation', () => {
  it('keeps native thinking, visible text, signatures and tool-use indexes separate', () => {
    const wire = new WireObserver()
    wire.observe(thinking('private reasoning'))
    wire.observe({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'secret signature' } })
    wire.observe(closeBlock())
    wire.observe(openText('answer', 1))
    wire.observe({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'secret', name: 'echo', input: {} } })
    wire.observe({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } })
    for (const event of end('tool_use')) wire.observe(event)
    expect(wire.facts()).toEqual({
      fields: [
        { field: 'thinking', fragments: 1, chars: 17 }, { field: 'signature', fragments: 1, chars: 16 },
        { field: 'text', fragments: 1, chars: 6 }, { field: 'tool_use', fragments: 1, chars: 0 },
        { field: 'partial_json', fragments: 1, chars: 2 },
      ],
      toolCallIndexes: 1, contentMarkers: [], reasoningMarkers: [], finishReasons: ['tool_use'], complete: true,
    })
    expect(JSON.stringify(wire.facts())).not.toContain('secret')
  })
  it('finds markers split across deltas or inside long fragments', () => {
    const wire = new WireObserver()
    wire.observe(openText('answer <thin'))
    wire.observe(delta(`king>${'x'.repeat(512)}`))
    expect(wire.facts().contentMarkers).toEqual(['thinking-tag'])
    const second = new WireObserver()
    second.observe(thinking(`${'x'.repeat(100)}<thinking>${'x'.repeat(100)}`))
    expect(second.facts().reasoningMarkers).toEqual(['thinking-tag'])
    expect(second.facts().contentMarkers).toEqual([])
  })
  it('does not invent markers by concatenating different native blocks', () => {
    const wire = new WireObserver()
    wire.observe(openText('<thin'))
    wire.observe(closeBlock())
    wire.observe(openText('king>', 1))
    expect(wire.facts().contentMarkers).toEqual([])
    expect(wire.facts().complete).toBe(false)
  })
  it('ignores malformed or unknown data without replacing translation errors', () => {
    const wire = new WireObserver()
    for (const event of [{ type: 'unknown' }, { type: 'content_block_start', content_block: null }, { type: 'content_block_delta', delta: [] }]) wire.observe(event)
    expect(wire.facts().fields).toEqual([])
  })
})

describe('attemptAnomaly: comparing wire against produced blocks', () => {
  /** Build one comparison from explicit wire and block sides. */
  function facts(wire: Partial<WireFacts>, blocks: Partial<BlockFacts>): AttemptFacts {
    return {
      wire: {
        fields: [],
        toolCallIndexes: 0,
        contentMarkers: [],
        reasoningMarkers: [],
        finishReasons: [],
        complete: true,
        ...wire,
      },
      blocks: {
        textChars: 0,
        reasoningChars: 0,
        textMarkers: [],
        reasoningMarkers: [],
        structuredToolCalls: 0,
        finishReason: 'stop',
        ...blocks,
      },
    }
  }

  it('reports markers that both sides show in visible content', () => {
    const anomaly = attemptAnomaly(facts(
      { contentMarkers: ['thinking-tag'] },
      { textMarkers: ['thinking-tag'], textChars: 40 },
    ))
    expect(anomaly?.findings).toEqual(['content-markers-upstream'])
  })

  it('reports a family the reasoning channel carried but the text block received', () => {
    const anomaly = attemptAnomaly(facts(
      { reasoningMarkers: ['thinking-tag'] },
      { textMarkers: ['thinking-tag'], textChars: 40 },
    ))
    expect(anomaly?.findings).toContain('reasoning-mapped-into-text')
  })

  it('does not treat a marker written inside the CoT as a defect', () => {
    // Both sides agree the syntax is reasoning text, which a model may write.
    expect(attemptAnomaly(facts(
      { reasoningMarkers: ['thinking-tag'] },
      { reasoningMarkers: ['thinking-tag'], reasoningChars: 40 },
    ))).toBeUndefined()
  })

  it('reports wire tool-call fragments that assembled into no call', () => {
    const anomaly = attemptAnomaly(facts(
      { fields: [{ field: 'tool_use', fragments: 2, chars: 0 }], toolCallIndexes: 1, finishReasons: ['tool_use'] },
      { structuredToolCalls: 0, finishReason: 'tool-calls' },
    ))
    expect(anomaly?.findings).toContain('tool-calls-lost-locally')
    expect(anomaly?.findings).toContain('tool-calls-announced-not-assembled')
  })

  it('reports an announced tool call that never assembled', () => {
    const anomaly = attemptAnomaly(facts(
      { finishReasons: ['tool_use'] },
      { structuredToolCalls: 0, finishReason: 'tool-calls' },
    ))
    expect(anomaly?.findings).toEqual(['tool-calls-announced-not-assembled'])
  })

  it('records an incomplete wire stream as context, not as a reason to report', () => {
    // A transport failure is already reported by the retry machinery; a
    // partial tally must not invent a marker finding on its own.
    expect(attemptAnomaly(facts({ complete: false }, {}))).toBeUndefined()
  })

  it('stays silent for a clean attempt that assembled its structured call', () => {
    expect(attemptAnomaly(facts(
      { fields: [{ field: 'tool_use', fragments: 2, chars: 0 }], toolCallIndexes: 1, finishReasons: ['tool_use'] },
      { structuredToolCalls: 1, finishReason: 'tool-calls' },
    ))).toBeUndefined()
  })
})

describe('describeAttemptAnomaly: the report carries both sides and no content', () => {
  it('renders the wire facts beside the produced block facts', () => {
    const anomaly = attemptAnomaly({
      wire: {
        fields: [{ field: 'content', fragments: 145, chars: 2_103 }],
        toolCallIndexes: 0,
        contentMarkers: ['thinking-tag', 'dsml'],
        reasoningMarkers: [],
        finishReasons: ['stop'],
        complete: true,
      },
      blocks: {
        textChars: 2_103,
        reasoningChars: 0,
        textMarkers: ['thinking-tag', 'dsml'],
        reasoningMarkers: [],
        structuredToolCalls: 0,
        finishReason: 'stop',
      },
      requestId: 'req-8f2c',
    })
    expect(anomaly).toBeDefined()
    expect(describeAttemptAnomaly('chat-completions', anomaly!)).toBe(
      'protocol=chat-completions findings=[content-markers-upstream]'
      + ' wire={fields=[content(n=145,chars=2103)] toolCallIndexes=0'
      + ' contentMarkers=[thinking-tag,dsml] reasoningMarkers=[none] finish=[stop] complete=true}'
      + ' blocks={textChars=2103 reasoningChars=0 textMarkers=[thinking-tag,dsml]'
      + ' reasoningMarkers=[none] structuredToolCalls=0 finish=stop} requestId=req-8f2c',
    )
  })

  it('marks an absent request id rather than omitting the field', () => {
    const anomaly = attemptAnomaly({
      wire: {
        fields: [],
        toolCallIndexes: 0,
        contentMarkers: ['dsml'],
        reasoningMarkers: [],
        finishReasons: [],
        complete: true,
      },
      blocks: {
        textChars: 4,
        reasoningChars: 0,
        textMarkers: ['dsml'],
        reasoningMarkers: [],
        structuredToolCalls: 0,
        finishReason: 'stop',
      },
    })
    expect(describeAttemptAnomaly('chat-completions', anomaly!)).toContain('requestId=none')
  })
})

describe('native adapter anomaly hook', () => {
  it('reports raw visible control syntax while preserving the original output', async () => {
    const reports: string[] = []
    const result = await run([start, openText(), delta('<thin'), delta('king>SECRET-THINK'), closeBlock(), ...end()], ({ report }) => { reports.push(report) })
    expect(result.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { type: 'text', text: '<thinking>SECRET-THINK' } })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('protocol=messages')
    expect(reports[0]).toContain('content-markers-upstream')
    expect(reports[0]).toContain('complete=true')
    expect(reports[0]).toContain('requestId=request-123')
    expect(reports[0]).not.toContain('SECRET')
  })
  it('leaves ordinary reasoning and native structured tools unreported', async () => {
    const reports: string[] = []
    await run([start, thinking('<thinking>private reasoning'), closeBlock(),
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'echo', input: {} } },
      closeBlock(1), ...end('tool_use')], ({ report }) => { reports.push(report) })
    expect(reports).toEqual([])
  })
  it('reports tool-use finish without a structured tool', async () => {
    const reports: string[] = []
    await run([start, openText('answer'), closeBlock(), ...end('tool_use')], ({ report }) => { reports.push(report) })
    expect(reports[0]).toContain('tool-calls-announced-not-assembled')
  })
  it('preserves STREAM_CLOSED and partial-wire evidence', async () => {
    const reports: string[] = []
    await expect(run([start, openText('<thinking>partial')], ({ report }) => { reports.push(report) }))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    expect(reports[0]).toContain('wire-incomplete')
    expect(reports[0]).toContain('content-markers-upstream')
  })
  it('contains diagnostic callback failure after success and after provider failure', async () => {
    const sink = () => { throw new Error('sink failed') }
    expect((await run([start, openText('<thinking>answer'), closeBlock(), ...end()], sink)).at(-1)).toMatchObject({ type: 'finish' })
    await expect(run([start, openText('<thinking>partial')], sink)).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
  it('supports adapters without a diagnostic callback', async () => {
    expect((await run([start, openText('answer'), closeBlock(), ...end()])).at(-1)).toMatchObject({ type: 'finish' })
  })
})
