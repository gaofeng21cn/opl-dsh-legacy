import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADOPTION_RECORD_FILENAME,
  adoptOplGatewayKey,
  keyFingerprint,
  readAdoptedFingerprint,
  writeAdoptedFingerprint,
} from '../src/adoption.ts'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opl-adopt-'))
  roots.push(root)
  return root
}

/** A gateway state directory whose bound client configuration carries one key. */
function gatewayState(key: string): string {
  const root = scratch()
  const config = join(scratch(), 'config.toml')
  mkdirSync(join(config, '..'), { recursive: true })
  writeFileSync(config, `[model_providers.gflab]\nexperimental_bearer_token = "${key}"\n`, { mode: 0o600 })
  writeFileSync(join(root, 'account.json'), JSON.stringify({
    surface_kind: 'opl_gateway_account_state.v1',
    key_group_id: '22',
    available_groups: [{ group_id: '22', label: 'DeepSeek' }],
    codex_binding: { config_path: config, provider_id: 'gflab' },
  }), { mode: 0o600 })
  return root
}

/** Credentials seam stub recording writes over one stored value. */
function credentials(stored?: string): CredentialProvider & {
  readonly writes: string[]
  stored?: string
  rejectWrites?: boolean
} {
  const seam = {
    writes: [] as string[],
    stored,
    rejectWrites: false,
    resolve: vi.fn(async () => (seam.stored === undefined ? undefined : { value: seam.stored, source: 'store' })),
    set: vi.fn(async (_ref: CredentialRef, value: string) => {
      if (seam.rejectWrites) throw new Error('read-only source shadows the reference')
      seam.stored = value
      seam.writes.push(value)
    }),
  }
  return seam as unknown as CredentialProvider & { readonly writes: string[]; stored?: string; rejectWrites?: boolean }
}

const REF = 'OPL_GATEWAY_DEEPSEEK_API_KEY' as CredentialRef

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('adoption record', () => {
  it('round-trips a fingerprint and ignores anything else', () => {
    const home = scratch()
    expect(readAdoptedFingerprint(home)).toBeUndefined()
    const fingerprint = createHash('sha256').update('sk-x').digest('hex')
    writeAdoptedFingerprint(home, fingerprint)
    expect(readAdoptedFingerprint(home)).toBe(fingerprint)
    writeFileSync(join(home, ADOPTION_RECORD_FILENAME), JSON.stringify({ fingerprint: 'not-a-digest' }))
    expect(readAdoptedFingerprint(home)).toBeUndefined()
    writeFileSync(join(home, ADOPTION_RECORD_FILENAME), 'not json')
    expect(readAdoptedFingerprint(home)).toBeUndefined()
  })
})

describe('adopting the account key', () => {
  it('does nothing without a signed-in OPL account', async () => {
    const seam = credentials()
    expect(await adoptOplGatewayKey({ credentials: seam, home: scratch(), ref: REF, stateDirectory: scratch() }))
      .toBe('no-account')
    expect(seam.writes).toEqual([])
  })

  it('fills an unset reference and records the fingerprint', async () => {
    const home = scratch()
    const seam = credentials()
    expect(await adoptOplGatewayKey({ credentials: seam, home, ref: REF, stateDirectory: gatewayState('sk-account') }))
      .toBe('adopted')
    expect(seam.stored).toBe('sk-account')
    expect(readAdoptedFingerprint(home)).toBe(keyFingerprint('sk-account'))
  })

  it('leaves a key the operator typed on the Models page alone', async () => {
    const home = scratch()
    writeAdoptedFingerprint(home, keyFingerprint('sk-previous-adoption'))
    const seam = credentials('sk-typed-by-operator')
    expect(await adoptOplGatewayKey({ credentials: seam, home, ref: REF, stateDirectory: gatewayState('sk-account') }))
      .toBe('kept-operator-key')
    expect(seam.stored).toBe('sk-typed-by-operator')
    expect(seam.writes).toEqual([])
  })

  it('refreshes its own earlier adoption when OPL rotates the key', async () => {
    const home = scratch()
    writeAdoptedFingerprint(home, keyFingerprint('sk-old'))
    const seam = credentials('sk-old')
    expect(await adoptOplGatewayKey({ credentials: seam, home, ref: REF, stateDirectory: gatewayState('sk-rotated') }))
      .toBe('refreshed')
    expect(seam.stored).toBe('sk-rotated')
    expect(readAdoptedFingerprint(home)).toBe(keyFingerprint('sk-rotated'))
  })

  it('reports no change when its own adoption is already current', async () => {
    const home = scratch()
    writeAdoptedFingerprint(home, keyFingerprint('sk-account'))
    const seam = credentials('sk-account')
    expect(await adoptOplGatewayKey({ credentials: seam, home, ref: REF, stateDirectory: gatewayState('sk-account') }))
      .toBe('unchanged')
    expect(seam.writes).toEqual([])
  })

  it('records the fingerprint when an equal key arrives unsigned', async () => {
    const home = scratch()
    const seam = credentials('sk-account')
    expect(await adoptOplGatewayKey({ credentials: seam, home, ref: REF, stateDirectory: gatewayState('sk-account') }))
      .toBe('unchanged')
    expect(readAdoptedFingerprint(home)).toBe(keyFingerprint('sk-account'))
  })

  it('reports an unwritable store without throwing', async () => {
    const seam = credentials()
    seam.rejectWrites = true
    expect(await adoptOplGatewayKey({ credentials: seam, home: scratch(), ref: REF, stateDirectory: gatewayState('sk-account') }))
      .toBe('unavailable')
    expect(seam.stored).toBeUndefined()
  })
})

describe('adoption record contents', () => {
  it('never stores the key itself', async () => {
    const home = scratch()
    const seam = credentials()
    await adoptOplGatewayKey({ credentials: seam, home, ref: REF, stateDirectory: gatewayState('sk-secret-value') })
    expect(readFileSync(join(home, ADOPTION_RECORD_FILENAME), 'utf8')).not.toContain('sk-secret-value')
  })
})
