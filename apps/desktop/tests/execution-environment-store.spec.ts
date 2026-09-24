/** Persisted execution-environment selection: defaults, isolation, and recovery. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_SELECTION_FILENAME,
  clearStoredEnvironment,
  environmentSelectionPath,
  readStoredEnvironment,
  writeStoredEnvironment,
} from '../src/execution-environment-store.ts'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-env-store-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('stored execution environment', () => {
  it('defaults to Windows Native before anything is chosen', () => {
    expect(readStoredEnvironment(scratch())).toEqual({ kind: 'windows-native' })
  })

  it('round-trips each selection', () => {
    const root = scratch()
    writeStoredEnvironment(root, { kind: 'wsl2', distro: 'Ubuntu' })
    expect(readStoredEnvironment(root)).toEqual({ kind: 'wsl2', distro: 'Ubuntu' })
    expect(JSON.parse(readFileSync(environmentSelectionPath(root), 'utf8'))).toEqual({
      version: 1, environment: 'wsl2', distro: 'Ubuntu',
    })

    writeStoredEnvironment(root, { kind: 'windows-native' })
    expect(readStoredEnvironment(root)).toEqual({ kind: 'windows-native' })
    expect(JSON.parse(readFileSync(environmentSelectionPath(root), 'utf8'))).toEqual({
      version: 1, environment: 'windows-native',
    })
  })

  it('clears a selection back to the default', () => {
    const root = scratch()
    writeStoredEnvironment(root, { kind: 'wsl2', distro: 'Ubuntu' })
    clearStoredEnvironment(root)
    expect(readStoredEnvironment(root)).toEqual({ kind: 'windows-native' })
    // Clearing an absent selection is a no-op, not a failure.
    expect(() => { clearStoredEnvironment(root) }).not.toThrow()
  })

  it('validates a distribution name before writing it', () => {
    const root = scratch()
    expect(() => { writeStoredEnvironment(root, { kind: 'wsl2', distro: 'bad name' }) }).toThrow(/not a usable/u)
  })

  it('reports an unreadable or unsupported file instead of silently defaulting', () => {
    const root = scratch()
    const file = environmentSelectionPath(root)
    writeFileSync(file, 'not json')
    expect(() => readStoredEnvironment(root)).toThrow(/not readable JSON/u)

    writeFileSync(file, JSON.stringify({ version: 2, environment: 'wsl2', distro: 'Ubuntu' }))
    expect(() => readStoredEnvironment(root)).toThrow(/not a supported selection/u)

    writeFileSync(file, JSON.stringify({ version: 1, environment: 'docker' }))
    expect(() => readStoredEnvironment(root)).toThrow(/not a supported selection/u)
  })

  it('reports a selection naming no distribution', () => {
    const root = scratch()
    writeFileSync(environmentSelectionPath(root), JSON.stringify({ version: 1, environment: 'wsl2' }))
    expect(() => readStoredEnvironment(root)).toThrow(/requires a distribution/u)
  })

  it('names the selection file deterministically', () => {
    expect(ENVIRONMENT_SELECTION_FILENAME).toBe('execution-environment.json')
    expect(environmentSelectionPath('C:\\root')).toContain(ENVIRONMENT_SELECTION_FILENAME)
  })
})
