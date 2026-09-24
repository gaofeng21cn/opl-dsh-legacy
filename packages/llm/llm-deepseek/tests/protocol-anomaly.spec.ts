import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { DONE } from '../src/protocols/chat-completions/sse.ts'
import {
  attemptAnomaly,
  controlMarkerFamilies,
  describeAttemptAnomaly,
  WireObserver,
} from '../src/common/protocol-anomaly.ts'
import type { AttemptFacts, BlockFacts, WireFacts } from '../src/common/protocol-anomaly.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
/** Full-width vertical bar, as the observed DeepSeek markup spells its DSML wrapper. */
const BAR = '\uFF5C'
/** The DSML-wrapped tag spelling the failing session used. */
const dsmlTag = (name: string): string => `</${BAR}DSML${BAR}${name}>`

afterEach(async () => {
  await closeMockServers()
})

function noExtensions() {
  return Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
}

/** The user message every adapter-path case sends; its text never reaches a report. */
function userMessage() {
  return createUserMessage({
    content: [{ type: 'text', text: 'SECRET-PROMPT-MARKER' }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

function adapterOf(baseURL: string, reports?: string[], sink?: (detail: { report: string }) => void): DeepSeekAdapter {
  return new DeepSeekAdapter({
    options: () => resolveAdapterOptions({ protocol: 'chat-completions', baseURL }),
    resolveApiKey: () => Promise.resolve('k'),
    resolveUserId: () => TEST_USER_ID,
    prepareExtensions: noExtensions,
    ...reports === undefined && sink === undefined ? {} : {
      onProtocolAnomaly: sink ?? ((detail: { report: string }) => { reports?.push(detail.report) }),
    },
  })
}

function streamOptions() {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    messages: [userMessage()],
  }
}

async function collect(adapter: DeepSeekAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(streamOptions())) chunks.push(chunk)
  return chunks
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

describe('WireObserver: raw facts before translation', () => {
  it('separates the official reasoning name, the alias, and visible content', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({
      choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '', reasoning: 'alias' } }],
    }))
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'visible' } }] }))
    wire.observe(DONE)
    wire.markComplete()

    const facts = wire.facts()
    expect(facts.fields).toEqual([
      { field: 'role', fragments: 1, chars: 9 },
      { field: 'content', fragments: 2, chars: 7 },
      { field: 'reasoning_content', fragments: 1, chars: 0 },
      { field: 'reasoning', fragments: 1, chars: 5 },
    ])
    expect(facts.complete).toBe(true)
  })

  it('counts structured tool-call fragments and their distinct indexes', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'echo' } }] } }],
    }))
    wire.observe(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }],
    }))
    wire.observe(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    wire.markComplete()

    const facts = wire.facts()
    expect(facts.fields).toEqual([{ field: 'tool_calls', fragments: 2, chars: 0 }])
    expect(facts.toolCallIndexes).toBe(1)
    expect(facts.finishReasons).toEqual(['tool_calls'])
  })

  it('matches a marker split across fragments', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'answer <thin' } }] }))
    expect(wire.facts().contentMarkers).toEqual([])
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'king>so far' } }] }))
    expect(wire.facts().contentMarkers).toEqual(['thinking-tag'])
  })

  it('keeps raw reasoning markers apart from content markers', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({ choices: [{ delta: { reasoning: 'plan <thinking>' } }] }))
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'plain answer' } }] }))

    const facts = wire.facts()
    expect(facts.reasoningMarkers).toEqual(['thinking-tag'])
    expect(facts.contentMarkers).toEqual([])
  })

  it('stays bounded: extra field names fold together and no text is retained', () => {
    const wire = new WireObserver()
    for (let index = 0; index < 20; index += 1) {
      wire.observe(JSON.stringify({ choices: [{ delta: { [`field${index}`]: 'value' } }] }))
    }
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(4_096) } }] }))

    const facts = wire.facts()
    // Twelve named caps plus the fold bucket, never twenty distinct entries;
    // and `content` keeps its own bucket so marker checking never stops.
    expect(facts.fields).toHaveLength(14)
    expect(facts.fields.some(entry => entry.field === 'other')).toBe(true)
    expect(facts.fields.find(entry => entry.field === 'content')).toEqual({
      field: 'content',
      fragments: 1,
      chars: 4_096,
    })
    // The reported facts carry counts and families only, never the text itself.
    expect(JSON.stringify(facts)).not.toContain('xxxx')
  })

  it('leaves completeness false when the payload source never terminated', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }))
    expect(wire.facts().complete).toBe(false)
  })

  it('finds a marker at the start of one fragment longer than the retained tail', () => {
    // Codex reproduced this against the previous implementation: the fragment
    // was truncated to its last 48 characters before matching, so a marker in
    // the earlier part vanished and the attempt was misattributed.
    const wire = new WireObserver()
    wire.observe(JSON.stringify({
      choices: [{ delta: { content: `<thinking>${'x'.repeat(100)}` }, finish_reason: 'stop' }],
    }))
    wire.markComplete()

    const facts = wire.facts()
    expect(facts.contentMarkers).toEqual(['thinking-tag'])
    expect(facts.fields.find(entry => entry.field === 'content')).toEqual({
      field: 'content',
      fragments: 1,
      chars: 110,
    })
  })

  it('finds a marker in the middle of one fragment longer than the retained tail', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({
      choices: [{ delta: { content: `${'a'.repeat(80)}<thinking>${'b'.repeat(80)}` } }],
    }))
    expect(wire.facts().contentMarkers).toEqual(['thinking-tag'])
  })

  it('finds a marker that straddles two fragments when the second one is long', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'lead <thin' } }] }))
    expect(wire.facts().contentMarkers).toEqual([])
    // The marker completes at the second fragment's start, which is followed by
    // far more text than the retained tail.
    wire.observe(JSON.stringify({ choices: [{ delta: { content: `king>${'y'.repeat(200)}` } }] }))
    expect(wire.facts().contentMarkers).toEqual(['thinking-tag'])
  })

  it('applies the same full-fragment scan to the reasoning channel under both names', () => {
    const aliased = new WireObserver()
    aliased.observe(JSON.stringify({
      choices: [{ delta: { content: null, reasoning: `${'z'.repeat(90)}<thinking>${'z'.repeat(90)}` } }],
    }))
    expect(aliased.facts().reasoningMarkers).toEqual(['thinking-tag'])
    expect(aliased.facts().contentMarkers).toEqual([])

    const official = new WireObserver()
    official.observe(JSON.stringify({
      choices: [{ delta: { content: null, reasoning_content: `<thinking>${'z'.repeat(120)}` } }],
    }))
    expect(official.facts().reasoningMarkers).toEqual(['thinking-tag'])
    expect(official.facts().contentMarkers).toEqual([])
  })

  it('keeps a long fragment marker out of the other channel', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({
      choices: [{ delta: { content: `${'c'.repeat(60)}<thinking>`, reasoning: `${'r'.repeat(60)}</thinking>` } }],
    }))
    const facts = wire.facts()
    expect(facts.contentMarkers).toEqual(['thinking-tag'])
    expect(facts.reasoningMarkers).toEqual(['thinking-tag'])
  })

  it('leaves plain markers-free text unreported however it is split', () => {
    const wire = new WireObserver()
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'a'.repeat(120) } }] }))
    wire.observe(JSON.stringify({ choices: [{ delta: { content: 'b'.repeat(120) } }] }))
    wire.observe(JSON.stringify({ choices: [{ delta: { reasoning: 'c'.repeat(120) } }] }))
    const facts = wire.facts()
    expect(facts.contentMarkers).toEqual([])
    expect(facts.reasoningMarkers).toEqual([])
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
      { fields: [{ field: 'tool_calls', fragments: 2, chars: 0 }], toolCallIndexes: 1, finishReasons: ['tool_calls'] },
      { structuredToolCalls: 0, finishReason: 'tool-calls' },
    ))
    expect(anomaly?.findings).toContain('tool-calls-lost-locally')
    expect(anomaly?.findings).toContain('tool-calls-announced-not-assembled')
  })

  it('reports an announced tool call that never assembled', () => {
    const anomaly = attemptAnomaly(facts(
      { finishReasons: ['tool_calls'] },
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
      { fields: [{ field: 'tool_calls', fragments: 2, chars: 0 }], toolCallIndexes: 1, finishReasons: ['tool_calls'] },
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

describe('adapter path: what the endpoint sent versus what the translation produced', () => {
  it('attributes markers carried in raw content to the wire, not to the mapping', async () => {
    const reports: string[] = []
    const server = await mockServer([{ kind: 'sse', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      '{"choices":[{"delta":{"content":"Typecheck passed.\\n\\n<thinking>update"}}]}',
      `{"choices":[{"delta":{"content":" the docs.</thinking>\\n\\n${dsmlTag('parameter')}\\n${dsmlTag('invoke')}"}}]}`,
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      '[DONE]',
    ] }])
    const chunks = await collect(adapterOf(server.url, reports))

    expect(reports).toHaveLength(1)
    const report = reports[0]!
    // Both sides name the same families, so the mapping moved nothing.
    expect(report).toContain('findings=[content-markers-upstream]')
    expect(report).toMatch(/wire=\{fields=\[role\(n=1,chars=9\) content\(n=3,chars=\d+\)\]/)
    expect(report).toContain('contentMarkers=[thinking-tag,dsml,invoke-tag,parameter-tag]')
    expect(report).toContain('complete=true}')
    expect(report).toContain('textMarkers=[thinking-tag,dsml,invoke-tag,parameter-tag]')
    expect(report).toContain('structuredToolCalls=0')
    // Markup in text never becomes a call, and the diagnostic carries no text.
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
    expect(report).not.toContain('Typecheck')
    expect(report).not.toContain('SECRET-PROMPT-MARKER')
    expect(report).not.toContain('thinking>')
  })

  it('shows the reasoning alias on the wire beside the reasoning block it produced', async () => {
    const reports: string[] = []
    const server = await mockServer([{ kind: 'sse', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning":""}}]}',
      `{"choices":[{"delta":{"content":null,"reasoning":"plan ${dsmlTag('invoke')}"}}]}`,
      '{"choices":[{"delta":{"content":"<thinking>answer"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ] }])
    await collect(adapterOf(server.url, reports))

    expect(reports).toHaveLength(1)
    const report = reports[0]!
    // Before translation: the alias field itself is what carried the text.
    expect(report).toMatch(/wire=\{fields=\[role\(n=1,chars=9\) content\(n=3,chars=\d+\) reasoning\(n=2,chars=\d+\)\]/)
    expect(report).toContain('reasoningMarkers=[dsml,invoke-tag]')
    // After translation: the alias became a reasoning block, and only the
    // content-borne family reached the text block.
    expect(report).toContain('textMarkers=[thinking-tag]')
    expect(report).toContain('reasoningMarkers=[dsml,invoke-tag]')
    expect(report).toMatch(/reasoningChars=\d+/)
    expect(report).toContain('content-markers-upstream')
  })

  it('attributes a marker in a long single fragment to the wire, not to the mapping', async () => {
    // One content fragment far longer than the retained tail, marker first.
    // The earlier implementation truncated before matching, saw no raw marker,
    // and wrongly reported text-markers-without-raw-content.
    const reports: string[] = []
    const server = await mockServer([{ kind: 'sse', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      JSON.stringify({
        choices: [{ delta: { content: `<thinking>${'x'.repeat(200)}</thinking>` }, finish_reason: 'stop' }],
      }),
      '[DONE]',
    ] }])
    await collect(adapterOf(server.url, reports))

    expect(reports).toHaveLength(1)
    const report = reports[0]!
    expect(report).toContain('contentMarkers=[thinking-tag]')
    expect(report).toContain('textMarkers=[thinking-tag]')
    expect(report).toContain('content-markers-upstream')
    expect(report).not.toContain('text-markers-without-raw-content')
  })

  it('keeps a long-fragment reasoning marker from being blamed on the text mapping', async () => {
    const reports: string[] = []
    const server = await mockServer([{ kind: 'sse', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning":""}}]}',
      // The alias fragment is long and carries the marker in its middle.
      JSON.stringify({
        choices: [{ delta: { content: null, reasoning: `${'p'.repeat(90)}<thinking>${'q'.repeat(90)}` } }],
      }),
      JSON.stringify({ choices: [{ delta: { content: `${'t'.repeat(70)}<thinking>plain answer` } }] }),
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ] }])
    await collect(adapterOf(server.url, reports))

    expect(reports).toHaveLength(1)
    const report = reports[0]!
    // Both channels genuinely carried the family, so nothing was moved.
    expect(report).toContain('reasoningMarkers=[thinking-tag]')
    expect(report).toContain('contentMarkers=[thinking-tag]')
    expect(report).toContain('content-markers-upstream')
    expect(report).not.toContain('reasoning-mapped-into-text')
  })

  it('distinguishes a structured call the wire sent from the block it assembled', async () => {
    const reports: string[] = []
    const server = await mockServer([{ kind: 'sse', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
      '{"choices":[{"delta":{"content":null,"reasoning_content":"Check the weather."}}]}',
      '{"choices":[{"delta":{"content":"Looking it up."}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ] }])
    const chunks = await collect(adapterOf(server.url, reports))

    // A correctly assembled call is not an anomaly, so nothing is reported.
    expect(reports).toEqual([])
    expect(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(1)
  })

  it('reports an announced tool call the translation never assembled', async () => {
    const reports: string[] = []
    const server = await mockServer([{ kind: 'sse', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      '{"choices":[{"delta":{"content":"calling it now"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ] }])
    await collect(adapterOf(server.url, reports))

    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('findings=[tool-calls-announced-not-assembled]')
    expect(reports[0]).toContain('finish=[tool_calls]')
    expect(reports[0]).toContain('structuredToolCalls=0')
  })

  it('leaves the model stream unchanged when a sink throws', async () => {
    const events = [
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      '{"choices":[{"delta":{"content":"<thinking>answer"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ]
    const clean = await collect(adapterOf((await mockServer([{ kind: 'sse', events }])).url))
    const withBrokenSink = await collect(adapterOf(
      (await mockServer([{ kind: 'sse', events }])).url,
      undefined,
      () => { throw new Error('sink exploded') },
    ))

    // The failing diagnostic neither fails nor alters the attempt's chunks.
    expect(withBrokenSink).toEqual(clean)
    const finish = withBrokenSink.at(-1)
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports partial raw facts honestly when the stream fails mid-body', async () => {
    const reports: string[] = []
    const server = await mockServer([{ kind: 'close-early', events: [
      '{"choices":[{"delta":{"role":"assistant","content":null}}]}',
      '{"choices":[{"delta":{"content":"<thinking>truncated"}}]}',
    ] }])
    const adapter = adapterOf(server.url, reports)

    await expect(collect(adapter)).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(reports).toHaveLength(1)
    // The marker still shows on both sides, and completeness says the tally is partial.
    expect(reports[0]).toContain('complete=false')
    expect(reports[0]).toContain('wire-incomplete')
    expect(reports[0]).toContain('contentMarkers=[thinking-tag]')
  })
})
