/**
 * Where this plugin keeps its state.
 *
 * Two homes because two sensitivity levels: the refresh token is a credential
 * and belongs in the seam; the account facts are not secret and belong in a
 * file. These cover both, including the case where the store refuses.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FACTS_FILENAME,
  FACTS_FRESH_MS,
  clearFacts,
  clearSession,
  readFacts,
  readSession,
  writeFacts,
  writeSession,
} from '../src/session-store.ts'
import type { GatewayAccountFacts } from '../src/types.ts'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opl-session-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/** A credentials seam storing records in memory, with an optional write refusal. */
function credentials(options: { refuseWrite?: boolean } = {}) {
  let record: { kind: 'grant'; payload: unknown } | undefined
  const seam = {
    readRecord: vi.fn(async () => record),
    modifyRecord: vi.fn(async (_key: string, mutate: (current: unknown) => Promise<{ kind: 'grant'; payload: unknown } | undefined>) => {
      if (options.refuseWrite === true) throw new Error('read-only source shadows the record')
      record = await mutate(record)
      return record
    }),
    deleteRecord: vi.fn(async () => { record = undefined }),
  }
  return { seam: seam as never, snapshot: () => record }
}

const FACTS: GatewayAccountFacts = {
  displayName: 'Person',
  email: 'person@example.test',
  status: 'active',
  balanceAmount: 12.5,
  balanceCurrency: 'USD',
  todayTokens: 1024,
  totalTokens: 4096,
  todayCost: 0.25,
  totalCost: 3,
  usageCurrency: 'USD',
  keyName: 'OPL DSH · machine',
}

describe('session storage', () => {
  it('round-trips a refresh token through the credentials seam', async () => {
    const { seam } = credentials()
    expect(await readSession(seam)).toBeUndefined()
    await writeSession(seam, 'refresh-token')
    expect(await readSession(seam)).toBe('refresh-token')
    await clearSession(seam)
    expect(await readSession(seam)).toBeUndefined()
  })

  it('ignores a record it did not write', async () => {
    // A record whose payload is not this plugin's shape reads as "no session"
    // rather than as a crash: another writer may share the seam.
    const { seam } = credentials()
    await writeSession(seam, 'a-real-token')
    const foreign = {
      readRecord: vi.fn(async () => ({ kind: 'grant', payload: { something: 'else' } })),
      modifyRecord: vi.fn(),
      deleteRecord: vi.fn(),
    } as never
    expect(await readSession(foreign)).toBeUndefined()
    expect(await readSession(seam)).toBe('a-real-token')
  })

  it('survives a store that cannot answer', async () => {
    const seam = {
      readRecord: vi.fn(async () => { throw new Error('unavailable') }),
      modifyRecord: vi.fn(),
      deleteRecord: vi.fn(),
    } as never
    expect(await readSession(seam)).toBeUndefined()
  })
})

describe('facts cache', () => {
  it('round-trips the account facts and reports them fresh', () => {
    const home = scratch()
    expect(readFacts(home)).toBeUndefined()
    writeFacts(home, FACTS, new Date().toISOString())
    const cached = readFacts(home)
    expect(cached?.facts).toEqual(FACTS)
    expect(cached?.stale).toBe(false)
  })

  it('reports an old observation as stale rather than current', () => {
    const home = scratch()
    writeFacts(home, FACTS, new Date(Date.now() - FACTS_FRESH_MS - 60_000).toISOString())
    expect(readFacts(home)?.stale).toBe(true)
  })

  it('never stores the key itself', () => {
    const home = scratch()
    writeFacts(home, FACTS, new Date().toISOString())
    // The cache is not a secret store: it must not carry a token or key field
    // however the caller's object happens to be shaped.
    const raw = readFileSync(join(home, FACTS_FILENAME), 'utf8')
    const stored = JSON.parse(raw)
    expect(Object.keys(stored).sort()).toEqual(['facts', 'observedAt', 'version'])
    expect(Object.keys(stored.facts).sort()).toEqual([
      'balanceAmount', 'balanceCurrency', 'displayName', 'email', 'keyName',
      'status', 'todayCost', 'todayTokens', 'totalCost', 'totalTokens', 'usageCurrency',
    ])
    expect(raw).not.toMatch(/sk-/)
  })

  it('ignores a damaged or unknown-version file', () => {
    const home = scratch()
    writeFileSync(join(home, FACTS_FILENAME), 'not json')
    expect(readFacts(home)).toBeUndefined()
    writeFileSync(join(home, FACTS_FILENAME), JSON.stringify({ version: 2, observedAt: 'x', facts: {} }))
    expect(readFacts(home)).toBeUndefined()
    writeFileSync(join(home, FACTS_FILENAME), JSON.stringify({ version: 1, observedAt: 7, facts: {} }))
    expect(readFacts(home)).toBeUndefined()
  })

  it('clears the cache', () => {
    const home = scratch()
    writeFacts(home, FACTS, new Date().toISOString())
    clearFacts(home)
    expect(readFacts(home)).toBeUndefined()
  })
})
