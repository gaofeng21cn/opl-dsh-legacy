/** Opt-in local fingerprints for tracing reasoning through consecutive requests. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { WireRequest } from './types.ts'

/** Hash UTF-16 code units so an SSE split inside a surrogate pair is lossless. */
function digest(text: string): string {
  return createHash('sha256').update(text, 'utf16le').digest('hex')
}
function fingerprint(text: string) {
  return { chars: text.length, sha256: digest(text) }
}
function summary(rows: unknown[]) {
  return { count: rows.length, sha256: digest(JSON.stringify(rows)), omitted: Math.max(0, rows.length - 128), tail: rows.slice(-128) }
}
function counter() {
  const hash = createHash('sha256')
  let chars = 0
  let fragments = 0
  return {
    add(text: string) { chars += text.length; fragments += 1; hash.update(text, 'utf16le') },
    facts() { return { chars, fragments, sha256: hash.copy().digest('hex') } },
  }
}

/**
 * One attempt's metadata, never message text or credentials.
 * Only an absolute DSH_REASONING_TRACE_DIR enables file writes. Files use
 * random exclusive names; permissions inherit the directory ACL on Windows.
 */
export class ReasoningTrace {
  private readonly id = randomUUID()
  private readonly startedAt = new Date().toISOString()
  private readonly fields = { reasoning_content: counter(), reasoning: counter(), reasoning_text: counter() }
  private readonly selected = counter()
  private readonly translated = counter()
  private readonly toolIds: string[] = []
  private requestFacts: unknown
  private responseFacts: unknown
  private complete = false
  private finish: string = 'unsettled'
  private parseErrors = 0

  private constructor(private readonly directory: string) {}

  /** Contain collection and filesystem failures without affecting generation. */
  safely(action: () => void): void {
    try { action() } catch (_diagnosticFailure) {
      // Optional diagnostics must not replace the provider's outcome.
    }
  }

  /** Create a collector only when explicitly configured with an absolute path. */
  static open(directory = process.env.DSH_REASONING_TRACE_DIR): ReasoningTrace | undefined {
    if (!directory || !isAbsolute(directory)) return undefined
    return new ReasoningTrace(directory)
  }

  /** Fingerprint projected history and serialized outgoing messages. */
  request(options: GenerateOptions, body: WireRequest): void {
    const input = options.messages.filter(m => m.role === 'assistant').map((m) => {
      const reasoning = m.content.filter(b => b.type === 'reasoning')
      return {
        reasoningPresent: reasoning.length > 0,
        reasoning: fingerprint(reasoning.map(b => b.text).join('')),
        tools: m.content.filter(b => b.type === 'tool-call').map(b => digest(b.id)),
      }
    })
    const output = body.messages.filter(m => m.role === 'assistant').map(m => ({
      reasoningPresent: m.reasoning_content !== undefined,
      reasoning: fingerprint(m.reasoning_content ?? ''),
      tools: (m.tool_calls ?? []).map(c => digest(c.id)),
    }))
    this.requestFacts = {
      session: options.sessionId === undefined ? undefined : digest(String(options.sessionId)),
      thinking: body.thinking?.type ?? 'unspecified',
      input: summary(input), output: summary(output),
    }
  }

  /** Record HTTP identity without copying response bodies or headers. */
  response(status: number, requestId: string | undefined): void {
    this.responseFacts = { status, requestIdHash: requestId === undefined ? undefined : digest(requestId) }
  }

  /** Observe allowlisted raw delta fields before translation, including empty fields. */
  payload(payload: string): void {
    if (payload === '[DONE]') { this.complete = true; return }
    let parsed: unknown
    try { parsed = JSON.parse(payload) } catch (_invalidJson) { this.parseErrors += 1; return }
    if (!parsed || typeof parsed !== 'object' || !('choices' in parsed) || !Array.isArray(parsed.choices)) return
    const first: unknown = parsed.choices[0]
    if (!first || typeof first !== 'object' || !('delta' in first)) return
    const delta = first.delta
    if (!delta || typeof delta !== 'object') return
    for (const key of ['reasoning_content', 'reasoning', 'reasoning_text'] as const) {
      const value: unknown = Reflect.get(delta, key)
      if (typeof value === 'string') this.fields[key].add(value)
    }
    for (const key of ['reasoning_content', 'reasoning'] as const) {
      const value: unknown = Reflect.get(delta, key)
      if (typeof value === 'string' && value.length > 0) { this.selected.add(value); break }
    }
  }

  /** Observe settled blocks; incomplete streams remain explicitly distinguishable. */
  chunk(chunk: StreamChunk): void {
    if (chunk.type === 'finish') this.finish = chunk.reason.kind
    if (chunk.type !== 'block-end') return
    if (chunk.block.type === 'reasoning') this.translated.add(chunk.block.text)
    if (chunk.block.type === 'tool-call' && this.toolIds.length < 128) this.toolIds.push(digest(chunk.block.id))
  }

  /** Write one report; callers contain failures from this optional sink. */
  close(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(this.directory, this.id + '.json'), JSON.stringify({
      version: 1, hashEncoding: 'utf16le', startedAt: this.startedAt, endedAt: new Date().toISOString(),
      request: this.requestFacts, response: this.responseFacts,
      wire: {
        fields: Object.fromEntries(Object.entries(this.fields).map(([k, v]) => [k, v.facts()])),
        selected: this.selected.facts(), complete: this.complete, parseErrors: this.parseErrors,
      },
      blocks: { reasoning: this.translated.facts(), tools: this.toolIds, finish: this.finish },
    }) + String.fromCharCode(10), { flag: 'wx', mode: 0o600 })
  }
}
