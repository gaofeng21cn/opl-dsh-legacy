import { describe, expect, it } from 'vitest'
import { observedAge, observedLabel } from '../src/client/OplGatewaySection.tsx'
import { en, zh, type OplGatewayLocaleKey } from '../src/client/locales.ts'

const OBSERVED = '2026-09-17T05:15:35.533Z'
const OBSERVED_MS = Date.parse(OBSERVED)

/** Bind one dictionary the way the locale seat does, placeholders included. */
const translate = (dictionary: Record<string, string>) =>
  (key: OplGatewayLocaleKey, params?: Record<string, string | number>): string =>
    Object.entries(params ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      dictionary[key] as string,
    )

const enT = translate(en)
const zhT = translate(zh)

describe('observation age', () => {
  it('reports the age in the active language, which is the fact a reader needs', () => {
    expect(observedAge(OBSERVED, enT, OBSERVED_MS)).toBe(en['age.now'])
    expect(observedAge(OBSERVED, enT, OBSERVED_MS + 60_000)).toBe('1min ago')
    expect(observedAge(OBSERVED, enT, OBSERVED_MS + 20 * 60_000)).toBe('20min ago')
    expect(observedAge(OBSERVED, enT, OBSERVED_MS + 3 * 3_600_000)).toBe('3h ago')
    expect(observedAge(OBSERVED, enT, OBSERVED_MS + 2 * 86_400_000)).toBe('2d ago')
    // The same buckets read in Chinese through the same code path.
    expect(observedAge(OBSERVED, zhT, OBSERVED_MS)).toBe('刚刚')
    expect(observedAge(OBSERVED, zhT, OBSERVED_MS + 20 * 60_000)).toBe('20分钟前')
    expect(observedAge(OBSERVED, zhT, OBSERVED_MS + 2 * 86_400_000)).toBe('2天前')
  })

  it('never reports a negative age for a clock that runs slightly ahead', () => {
    expect(observedAge(OBSERVED, enT, OBSERVED_MS - 30_000)).toBe(en['age.now'])
  })

  it('keeps unparsable text rather than inventing an age', () => {
    expect(observedAge('not a timestamp', enT)).toBe('not a timestamp')
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
