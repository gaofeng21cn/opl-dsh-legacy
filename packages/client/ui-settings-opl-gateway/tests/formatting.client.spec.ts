import { describe, expect, it } from 'vitest'
import { observedAge, observedLabel } from '../src/client/OplGatewaySection.tsx'

const OBSERVED = '2026-09-17T05:15:35.533Z'
const OBSERVED_MS = Date.parse(OBSERVED)

describe('observation age', () => {
  it('reports the age, which is the fact a reader actually needs', () => {
    expect(observedAge(OBSERVED, OBSERVED_MS)).toBe('刚刚')
    expect(observedAge(OBSERVED, OBSERVED_MS + 60_000)).toBe('1 分钟前')
    expect(observedAge(OBSERVED, OBSERVED_MS + 20 * 60_000)).toBe('20 分钟前')
    expect(observedAge(OBSERVED, OBSERVED_MS + 3 * 3_600_000)).toBe('3 小时前')
    expect(observedAge(OBSERVED, OBSERVED_MS + 2 * 86_400_000)).toBe('2 天前')
  })

  it('never reports a negative age for a clock that runs slightly ahead', () => {
    expect(observedAge(OBSERVED, OBSERVED_MS - 30_000)).toBe('刚刚')
  })

  it('keeps unparsable text rather than inventing an age', () => {
    expect(observedAge('not a timestamp')).toBe('not a timestamp')
  })
})

describe('observation label', () => {
  it('renders an instant in the reader\u2019s own timezone, not as raw ISO', () => {
    const label = observedLabel(OBSERVED)
    // The machine's offset decides the clock time; the instant must not be
    // shown as UTC text the reader has to convert by hand.
    expect(label).not.toContain('T')
    expect(label).not.toContain('Z')
    expect(label).toMatch(/2026/)
    expect(label).toMatch(/\d{2}:\d{2}/)
  })

  it('keeps unparsable text rather than inventing a time', () => {
    expect(observedLabel('not a timestamp')).toBe('not a timestamp')
  })
})
