/** Compare native Messages wire facts with translated blocks without recording content. */

/** One recognized control-marker family and the syntax that identifies it. */
interface ControlMarkerFamily {
  /** Stable name reported in diagnostics. */
  readonly family: string
  /** Syntax the family matches anywhere in a channel's text. */
  readonly pattern: RegExp
}

/**
 * Control syntax a model may emit inside visible text instead of a structured
 * field. The set is a fixed protocol vocabulary: adding an entry changes what
 * operators see, never what the harness executes.
 */
const CONTROL_MARKER_FAMILIES: readonly ControlMarkerFamily[] = [
  { family: 'thinking-tag', pattern: /<\s*\/?\s*think(?:ing)?\s*>/i },
  // The wrapper itself, reported even when the tag name inside it is unknown.
  { family: 'dsml', pattern: /[｜|]\s*DSML\s*[｜|]/i },
  { family: 'invoke-tag', pattern: markerTag('invoke') },
  { family: 'parameter-tag', pattern: markerTag('parameter') },
  { family: 'tool-calls-tag', pattern: markerTag('tool_calls?|function_calls?|calls') },
]

/**
 * Build the pattern for one wire tag name.
 *
 * The observed markup inserts the DSML wrapper between the slash and the tag
 * name (`</｜DSML｜parameter>`), while other endpoints emit the bare form
 * (`</parameter>`), so the wrapper is optional inside the pattern rather than a
 * separate family.
 * @param names - alternation of wire tag names this family covers.
 * @returns the pattern matching either spelling.
 */
function markerTag(names: string): RegExp {
  return new RegExp(`<\\s*\\/?\\s*(?:[｜|]\\s*DSML\\s*[｜|]\\s*)?(?:${names})\\b`, 'i')
}

/**
 * Longest trailing text kept per open block so a marker split across fragments is
 * still recognized. The longest marker this module knows is under 20
 * characters; the ceiling leaves room for interleaved whitespace and bounds
 * retained text to one short tail per open block regardless of response size.
 */
const MARKER_TAIL_CHARS = 48

/**
 * Marker families present in one text.
 * @param text - text from one settled block, or a bounded roll-up of raw fragments.
 * @returns the stable family names found, in declaration order and without duplicates.
 */
export function controlMarkerFamilies(text: string): string[] {
  return CONTROL_MARKER_FAMILIES
    .filter(entry => entry.pattern.test(text))
    .map(entry => entry.family)
}

/**
 * Order marker families by the module's declaration order.
 * @param families - families collected in arbitrary arrival order.
 * @returns the same names, de-duplicated and in declaration order.
 */
function orderMarkerFamilies(families: Iterable<string>): string[] {
  const present = new Set(families)
  return CONTROL_MARKER_FAMILIES.map(entry => entry.family).filter(family => present.has(family))
}

/** One delta field's bounded tally: how many fragments carried it and how many characters. */
export interface WireFieldTally {
  /** Native Messages field name. */
  readonly field: string
  /** Number of fragments that carried this field. */
  readonly fragments: number
  /** Total characters across those fragments; non-string values contribute nothing. */
  readonly chars: number
}

/**
 * Raw wire facts observed before translation.
 *
 * `complete` distinguishes an attempt whose payload source reached its terminal
 * message_stop event from one that failed mid-stream, where every count below is a
 * partial tally rather than the turn's whole output.
 */
export interface WireFacts {
  /** Delta fields seen, each with its fragment and character counts. */
  readonly fields: readonly WireFieldTally[]
  /** Distinct `tool_use` block indexes seen across all fragments. */
  readonly toolCallIndexes: number
  /** Marker families in raw text blocks, matched across fragment boundaries. */
  readonly contentMarkers: readonly string[]
  /** Marker families in the raw reasoning channel, from thinking blocks. */
  readonly reasoningMarkers: readonly string[]
  /** Raw `stop_reason` values as sent, de-duplicated in arrival order. */
  readonly finishReasons: readonly string[]
  /** Whether the payload source reached its `message_stop` event. */
  readonly complete: boolean
}

/** What the translation produced from those raw payloads. */
export interface BlockFacts {
  /** Character count of the visible text blocks. */
  readonly textChars: number
  /** Character count of the reasoning blocks. */
  readonly reasoningChars: number
  /** Marker families in visible text, where a reader of blocks sees plain prose. */
  readonly textMarkers: readonly string[]
  /** Marker families in reasoning blocks. */
  readonly reasoningMarkers: readonly string[]
  /** Structured tool-call blocks the attempt assembled. */
  readonly structuredToolCalls: number
  /** `stop_reason` mapped to its harness kind, or `none` when the stream sent none. */
  readonly finishReason: string
}

/** One settled attempt, before and after translation. */
export interface AttemptFacts {
  /** Raw wire facts, observed before `translate`. */
  readonly wire: WireFacts
  /** Block facts, observed after `translate`. */
  readonly blocks: BlockFacts
  /** Provider-issued request identifier, when the response carried one. */
  readonly requestId?: string
}

/** One graded conclusion about where control syntax or a tool call went. */
export type ProtocolAnomalyFinding =
  /**
   * Raw Messages text carried a marker family. The local mapping is faithful on
   * this axis — text blocks are produced only from Messages text blocks — so the
   * turn's control syntax entered as visible content upstream of this adapter.
   * Present even when the stream failed before producing a comparable block,
   * where `wire-incomplete` marks the raw tally as partial.
   */
  | 'content-markers-upstream'
  /** Visible text carried a marker family that no raw text fragment matched. */
  | 'text-markers-without-raw-content'
  /**
   * The raw reasoning channel carried a marker family, and the produced text
   * carried that same family while the produced reasoning did not — the only
   * shape that shows the reasoning/text mapping moved control syntax.
   */
  | 'reasoning-mapped-into-text'
  /** The mirror case: raw text blocks carried a family the produced reasoning did. */
  | 'content-mapped-into-reasoning'
  /** The wire started native tool-use blocks that assembled into no tool call. */
  | 'tool-calls-lost-locally'
  /** `stop_reason` announced tool calls and no structured call assembled. */
  | 'tool-calls-announced-not-assembled'
  /**
   * The raw reasoning channel carried a marker family. Recorded as context only:
   * a model may legitimately write this syntax inside its own CoT, so this
   * alone is not a defect.
   */
  | 'markers-in-reasoning'
  /** The payload source failed mid-stream, so every raw count here is partial. */
  | 'wire-incomplete'

/** A reportable attempt: its findings plus the two-sided facts behind them. */
export interface AttemptAnomaly {
  /** Findings in declaration order; at least one always triggers the report. */
  readonly findings: readonly ProtocolAnomalyFinding[]
  /** The facts the findings were derived from. */
  readonly facts: AttemptFacts
}

/** Findings that make an attempt worth reporting; the rest are context. */
const TRIGGERING_FINDINGS: ReadonlySet<ProtocolAnomalyFinding> = new Set<ProtocolAnomalyFinding>([
  'content-markers-upstream',
  'text-markers-without-raw-content',
  'reasoning-mapped-into-text',
  'content-mapped-into-reasoning',
  'tool-calls-lost-locally',
  'tool-calls-announced-not-assembled',
])

/** Parse only object-shaped wire facts; translation owns validation failures. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Read bounded native Messages field facts before translation. */
export class WireObserver {
  private readonly fields = new Map<string, { fragments: number; chars: number }>()
  private readonly tails = new Map<number, string>()
  private readonly contentMarkers = new Set<string>()
  private readonly reasoningMarkers = new Set<string>()
  private readonly finishReasons = new Set<string>()
  private readonly toolCallIndexes = new Set<number>()
  private terminal = false

  /** Record one decoded native Messages event without retaining content.
   * @param event - parsed SSE data before provider translation.
   */
  observe(event: Record<string, unknown>): void {
    const index = typeof event.index === 'number' ? event.index : -1
    if (event.type === 'message_stop') this.markComplete()
    if (event.type === 'content_block_stop') this.tails.delete(index)
    if (event.type === 'message_delta') {
      const reason = record(event.delta)?.stop_reason
      if (typeof reason === 'string' && this.finishReasons.size < 8) this.finishReasons.add(reason)
    }
    if (event.type === 'content_block_start') {
      this.tails.delete(index)
      const block = record(event.content_block)
      if (block?.type === 'text') this.text(index, 'text', block.text, this.contentMarkers)
      if (block?.type === 'thinking') this.text(index, 'thinking', block.thinking, this.reasoningMarkers)
      if (block?.type === 'tool_use') {
        this.tally('tool_use', undefined)
        if (this.toolCallIndexes.size < 64) this.toolCallIndexes.add(index)
      }
    }
    if (event.type === 'content_block_delta') {
      const delta = record(event.delta)
      if (delta?.type === 'text_delta') this.text(index, 'text', delta.text, this.contentMarkers)
      if (delta?.type === 'thinking_delta') this.text(index, 'thinking', delta.thinking, this.reasoningMarkers)
      if (delta?.type === 'input_json_delta') this.tally('partial_json', delta.partial_json)
      if (delta?.type === 'signature_delta') this.tally('signature', delta.signature)
    }
  }

  /** Mark that the payload source reached its terminal event. */
  markComplete(): void { this.terminal = true }

  /** Snapshot the bounded raw facts.
   * @returns field counts, marker families, block counts, and stop reasons.
   */
  facts(): WireFacts {
    return {
      fields: [...this.fields].map(([field, tally]) => ({ field, ...tally })),
      toolCallIndexes: this.toolCallIndexes.size,
      contentMarkers: orderMarkerFamilies(this.contentMarkers),
      reasoningMarkers: orderMarkerFamilies(this.reasoningMarkers),
      finishReasons: [...this.finishReasons],
      complete: this.terminal,
    }
  }

  private tally(field: string, value: unknown): void {
    const tally = this.fields.get(field) ?? { fragments: 0, chars: 0 }
    tally.fragments += 1
    if (typeof value === 'string') tally.chars += value.length
    this.fields.set(field, tally)
  }

  private text(index: number, field: string, value: unknown, markers: Set<string>): void {
    this.tally(field, value)
    if (typeof value !== 'string') return
    const previous = this.tails.get(index) ?? ''
    for (const family of controlMarkerFamilies(value)) markers.add(family)
    const junction = previous + value.slice(0, MARKER_TAIL_CHARS)
    for (const family of controlMarkerFamilies(junction)) markers.add(family)
    // Native translation rejects unclosed duplicate indexes; this bound also
    // contains malformed streams before their validation failure propagates.
    if (this.tails.has(index) || this.tails.size < 64) {
      this.tails.set(index, value.length >= MARKER_TAIL_CHARS
        ? value.slice(-MARKER_TAIL_CHARS) : (previous + value).slice(-MARKER_TAIL_CHARS))
    }
  }
}

/**
 * Classify one settled attempt, or nothing when neither side shows an anomaly.
 *
 * The comparison separates the cases that a translation-only view conflates:
 * markers in raw text and in produced text mean the syntax entered as
 * visible content before this adapter; a family in raw reasoning that appears
 * in produced text but not in produced reasoning is the mapping defect; and
 * native tool-use blocks or a `tool-calls` finish with no assembled call is a
 * local loss. Markers inside reasoning alone are recorded as context, never as
 * a defect, because a model may legitimately write that syntax in its own CoT.
 * @param facts - raw wire facts and produced block facts for one attempt.
 * @returns the findings with their facts, or undefined for an attempt worth no report.
 */
export function attemptAnomaly(facts: AttemptFacts): AttemptAnomaly | undefined {
  const { wire, blocks } = facts
  const findings: ProtocolAnomalyFinding[] = []
  if (!wire.complete) findings.push('wire-incomplete')
  // Raw text carrying control syntax is the anomaly itself, whether or not
  // the translation got far enough to produce a text block for comparison.
  if (wire.contentMarkers.length > 0) findings.push('content-markers-upstream')
  if (wire.contentMarkers.length === 0 && blocks.textMarkers.length > 0) {
    findings.push('text-markers-without-raw-content')
  }
  if (wire.reasoningMarkers.length > 0) findings.push('markers-in-reasoning')
  const fromReasoning = blocks.textMarkers.filter(
    family => !wire.contentMarkers.includes(family) && wire.reasoningMarkers.includes(family),
  )
  if (fromReasoning.length > 0) findings.push('reasoning-mapped-into-text')
  const fromContent = blocks.reasoningMarkers.filter(
    family => !wire.reasoningMarkers.includes(family) && wire.contentMarkers.includes(family),
  )
  if (fromContent.length > 0) findings.push('content-mapped-into-reasoning')
  if (wire.toolCallIndexes > 0 && blocks.structuredToolCalls === 0) findings.push('tool-calls-lost-locally')
  if (blocks.finishReason === 'tool-calls' && blocks.structuredToolCalls === 0) {
    findings.push('tool-calls-announced-not-assembled')
  }
  if (!findings.some(finding => TRIGGERING_FINDINGS.has(finding))) return undefined
  return { findings, facts }
}

/** Render one field tally as `name(n=fragments,chars=chars)`. */
function renderField(entry: WireFieldTally): string {
  return `${entry.field}(n=${entry.fragments},chars=${entry.chars})`
}

/** Render one family list, or `none`. */
function renderFamilies(families: readonly string[]): string {
  return `[${families.join(',') || 'none'}]`
}

/**
 * Render one anomaly as a single line holding both sides of the comparison.
 *
 * Every part is a finding name, a field name, a count, a family name, or an
 * identifier, so the line is safe to log and to quote in an incident record
 * without capturing raw SSE.
 * @param kind - the provider route's protocol, so the reader knows which wire produced it.
 * @param anomaly - the report returned by {@link attemptAnomaly}.
 * @returns a one-line, sanitized description of the wire and the produced blocks.
 */
export function describeAttemptAnomaly(kind: string, anomaly: AttemptAnomaly): string {
  const { wire, blocks, requestId } = anomaly.facts
  const wireFields = wire.fields.map(renderField).join(' ') || 'none'
  return [
    `protocol=${kind}`,
    `findings=${renderFamilies(anomaly.findings)}`,
    `wire={fields=[${wireFields}] toolCallIndexes=${wire.toolCallIndexes}`
    + ` contentMarkers=${renderFamilies(wire.contentMarkers)}`
    + ` reasoningMarkers=${renderFamilies(wire.reasoningMarkers)}`
    + ` finish=${renderFamilies(wire.finishReasons)} complete=${String(wire.complete)}}`,
    `blocks={textChars=${blocks.textChars} reasoningChars=${blocks.reasoningChars}`
    + ` textMarkers=${renderFamilies(blocks.textMarkers)}`
    + ` reasoningMarkers=${renderFamilies(blocks.reasoningMarkers)}`
    + ` structuredToolCalls=${blocks.structuredToolCalls} finish=${blocks.finishReason}}`,
    `requestId=${requestId ?? 'none'}`,
  ].join(' ')
}
