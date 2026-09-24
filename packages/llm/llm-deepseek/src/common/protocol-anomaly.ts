/**
 * Observe the raw chat-completions wire and classify one settled attempt.
 *
 * A chat-completions endpoint may stream a turn whose control syntax never
 * became a structured field: the CoT arrives inside `delta.content` wrapped in
 * `<thinking>` delimiters, or a whole tool invocation arrives there as
 * `<｜DSML｜invoke>`-style markup with no `delta.tool_calls` at all. The harness
 * cannot act on either — tool syntax in text is never executed — so such a turn
 * reads as an answer that merely quotes markup.
 *
 * Evidence for that question has two sides, and they are not interchangeable.
 * A settled stream records what the *translation* produced; it cannot show what
 * the raw payloads carried, because `translate` is what turns `delta.content`
 * and `delta.reasoning*` into blocks. {@link WireObserver} therefore reads each
 * parsed payload on the way in, and {@link attemptAnomaly} compares it against
 * the produced blocks. Both sides record only field names, fragment counts,
 * character counts, marker families, and finish reasons: no prompt, reasoning
 * text, delimiter text, or credential is retained, and no raw SSE is stored.
 * @module dsh-llm-deepseek/protocol-anomaly
 */

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
  // `openai-completions` declares this delimiter for thinking in text; a
  // DeepSeek-family gateway may emit it while still reporting a text delta.
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
 * Longest trailing text kept per channel so a marker split across fragments is
 * still recognized. The longest marker this module knows is under 20
 * characters; the ceiling leaves room for interleaved whitespace and bounds
 * retained text to one short tail per channel regardless of response size.
 */
const MARKER_TAIL_CHARS = 48

/** Distinct delta fields one attempt tallies before the rest fold into `other`. */
const MAX_TRACKED_FIELDS = 12

/** Distinct raw `finish_reason` values one attempt keeps. */
const MAX_FINISH_REASONS = 8

/** Distinct `tool_calls[].index` values one attempt counts. */
const MAX_TOOL_CALL_INDEXES = 64

/** Tally bucket for delta fields beyond {@link MAX_TRACKED_FIELDS}. */
const OTHER_FIELD = 'other'

/** Delta field names that carry a reasoning channel, in precedence order. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning'] as const

/** Delta field name that carries visible text. */
const CONTENT_FIELD = 'content'

/**
 * Fields that always get their own bucket. The cap exists to bound a
 * misbehaving endpoint's vocabulary, and folding one of these into `other`
 * would silently stop the marker and tool-call checks that are the whole point
 * of observing the wire.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'role',
  CONTENT_FIELD,
  ...REASONING_FIELDS,
  'tool_calls',
])

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

/** One message's own `choices` array, as far as this observer reads it. */
interface ObservedChunk {
  choices?: readonly {
    /** Incremental content of one streamed choice; unknown fields are tallied by name. */
    delta?: Record<string, unknown>
    /** Present only on a choice's terminal chunk. */
    finish_reason?: unknown
  }[]
}

/** One delta field's bounded tally: how many fragments carried it and how many characters. */
export interface WireFieldTally {
  /** Delta field name, or `other` once {@link MAX_TRACKED_FIELDS} names are exceeded. */
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
 * sentinel from one that failed mid-stream, where every count below is a
 * partial tally rather than the turn's whole output.
 */
export interface WireFacts {
  /** Delta fields seen, each with its fragment and character counts. */
  readonly fields: readonly WireFieldTally[]
  /** Distinct `tool_calls[].index` values seen across all fragments. */
  readonly toolCallIndexes: number
  /** Marker families in raw `content`, matched across fragment boundaries. */
  readonly contentMarkers: readonly string[]
  /** Marker families in the raw reasoning channel, under either name. */
  readonly reasoningMarkers: readonly string[]
  /** Raw `finish_reason` values as sent, de-duplicated in arrival order. */
  readonly finishReasons: readonly string[]
  /** Whether the payload source reached its terminal sentinel. */
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
  /** `finish_reason` mapped to its harness kind, or `none` when the stream sent none. */
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
   * Raw `content` carried a marker family. The local mapping is faithful on
   * this axis — text blocks are produced only from `delta.content` — so the
   * turn's control syntax entered as visible content upstream of this adapter.
   * Present even when the stream failed before producing a comparable block,
   * where `wire-incomplete` marks the raw tally as partial.
   */
  | 'content-markers-upstream'
  /** Visible text carried a marker family that no raw `content` fragment matched. */
  | 'text-markers-without-raw-content'
  /**
   * The raw reasoning channel carried a marker family, and the produced text
   * carried that same family while the produced reasoning did not — the only
   * shape that shows the reasoning/text mapping moved control syntax.
   */
  | 'reasoning-mapped-into-text'
  /** The mirror case: raw `content` carried a family the produced reasoning did. */
  | 'content-mapped-into-reasoning'
  /** The wire streamed `tool_calls` fragments that assembled into no tool call. */
  | 'tool-calls-lost-locally'
  /** `finish_reason` announced tool calls and no structured call assembled. */
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

/**
 * Read each parsed chat-completions payload's raw field facts.
 *
 * The observer keeps only names, counts, and one short tail per channel, so its
 * memory is independent of response size. `observe` is fed every payload the
 * adapter receives, before `translate` maps any of them, which is what makes
 * the comparison in {@link attemptAnomaly} evidence about the wire rather than
 * about the translation.
 */
export class WireObserver {
  private readonly fields = new Map<string, { fragments: number; chars: number; tail: string; markers: Set<string> }>()
  private readonly finishReasons = new Set<string>()
  private readonly toolCallIndexes = new Set<number>()
  private terminal = false

  /**
   * Record one parsed payload's field facts.
   * @param payload - one SSE `data` value, already known not to be the terminal sentinel.
   */
  observe(payload: string): void {
    let chunk: ObservedChunk
    try {
      chunk = JSON.parse(payload) as ObservedChunk
    } catch {
      // A malformed payload aborts the stream in `translate` with
      // `MALFORMED_RESPONSE`; the diagnostic adds nothing by reporting it here.
      return
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      for (const [field, value] of Object.entries(delta ?? {})) {
        const tally = this.tally(field)
        // Presence is counted for every occurrence, including a `null` some
        // gateways send for an unused field; only a string contributes length.
        tally.fragments += 1
        if (typeof value !== 'string') continue
        tally.chars += value.length
        if (field !== CONTENT_FIELD && !(REASONING_FIELDS as readonly string[]).includes(field)) continue
        const boundary = tally.tail
        // Scan this fragment in full. Matching only the truncated tail would
        // miss any marker in the earlier part of a fragment longer than the
        // tail, which then reads as text no raw content ever carried.
        for (const family of controlMarkerFamilies(value)) tally.markers.add(family)
        // A marker straddling the boundary holds at most a marker's length on
        // either side, so a short window of each catches it without rebuilding
        // the whole fragment into a temporary string.
        const junction = boundary.slice(-(MARKER_TAIL_CHARS - 1)) + value.slice(0, MARKER_TAIL_CHARS - 1)
        for (const family of controlMarkerFamilies(junction)) tally.markers.add(family)
        // Retain only the bounded end for the next fragment's boundary.
        tally.tail = value.length >= MARKER_TAIL_CHARS
          ? value.slice(-MARKER_TAIL_CHARS)
          : boundary.slice(-(MARKER_TAIL_CHARS - value.length)) + value
      }
      for (const call of Array.isArray(delta?.['tool_calls']) ? delta['tool_calls'] as { index?: unknown }[] : []) {
        if (typeof call?.index !== 'number') continue
        if (this.toolCallIndexes.size >= MAX_TOOL_CALL_INDEXES) break
        this.toolCallIndexes.add(call.index)
      }
      if (typeof choice.finish_reason === 'string' && this.finishReasons.size < MAX_FINISH_REASONS) {
        this.finishReasons.add(choice.finish_reason)
      }
    }
  }

  /** Mark that the payload source reached its terminal sentinel. */
  markComplete(): void {
    this.terminal = true
  }

  /**
   * Snapshot the observed facts.
   * @returns the bounded tally of raw fields, markers, and finish reasons.
   */
  facts(): WireFacts {
    return Object.freeze({
      fields: [...this.fields].map(([field, tally]) => ({
        field,
        fragments: tally.fragments,
        chars: tally.chars,
      })),
      toolCallIndexes: this.toolCallIndexes.size,
      contentMarkers: orderMarkerFamilies(this.fields.get(CONTENT_FIELD)?.markers ?? []),
      reasoningMarkers: orderMarkerFamilies(
        REASONING_FIELDS.flatMap(field => [...this.fields.get(field)?.markers ?? []]),
      ),
      finishReasons: [...this.finishReasons],
      complete: this.terminal,
    })
  }

  /** Return the bucket for one delta field, folding unrecognized extras past the cap. */
  private tally(field: string): { fragments: number; chars: number; tail: string; markers: Set<string> } {
    const existing = this.fields.get(field)
    if (existing !== undefined) return existing
    const created = { fragments: 0, chars: 0, tail: '', markers: new Set<string>() }
    if (RESERVED_FIELDS.has(field) || this.fields.size < MAX_TRACKED_FIELDS) {
      this.fields.set(field, created)
      return created
    }
    const folded = this.fields.get(OTHER_FIELD) ?? created
    if (!this.fields.has(OTHER_FIELD)) this.fields.set(OTHER_FIELD, folded)
    return folded
  }
}

/**
 * Classify one settled attempt, or nothing when neither side shows an anomaly.
 *
 * The comparison separates the cases that a translation-only view conflates:
 * markers in raw `content` and in produced text mean the syntax entered as
 * visible content before this adapter; a family in raw reasoning that appears
 * in produced text but not in produced reasoning is the mapping defect; and
 * `tool_calls` fragments or a `tool-calls` finish with no assembled call is a
 * local loss. Markers inside reasoning alone are recorded as context, never as
 * a defect, because a model may legitimately write that syntax in its own CoT.
 * @param facts - raw wire facts and produced block facts for one attempt.
 * @returns the findings with their facts, or undefined for an attempt worth no report.
 */
export function attemptAnomaly(facts: AttemptFacts): AttemptAnomaly | undefined {
  const { wire, blocks } = facts
  const wireToolCallFragments = wire.fields.find(entry => entry.field === 'tool_calls')?.fragments ?? 0
  const findings: ProtocolAnomalyFinding[] = []
  if (!wire.complete) findings.push('wire-incomplete')
  // Raw content carrying control syntax is the anomaly itself, whether or not
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
  if (wireToolCallFragments > 0 && blocks.structuredToolCalls === 0) findings.push('tool-calls-lost-locally')
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
