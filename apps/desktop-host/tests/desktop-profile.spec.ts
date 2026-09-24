/**
 * Focused tests for the Desktop profile a Linux Host creates on first launch.
 *
 * A distribution has no package-manager step, so this manifest is the whole
 * profile the composed Host reads. Without it the WSL2 launch fails at
 * `failed to read profile manifest`, which is why creation is asserted here
 * rather than only through a real distribution.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_PROFILE_BUNDLES, ensureDesktopProfile } from '../src/desktop-profile.ts'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop profile creation', () => {
  it('writes the manifest naming every Desktop bundle into a missing directory', () => {
    const projectDir = join(scratch(), 'profiles', 'desktop')
    const manifest = ensureDesktopProfile(projectDir)
    expect(manifest).toBe(join(projectDir, 'package.json'))
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({
      private: true,
      dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
    })
  })

  it('keeps a manifest the distribution already has', () => {
    const projectDir = scratch()
    const manifest = join(projectDir, 'package.json')
    const existing = '{"name":"user-owned","dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base"]}}}\n'
    writeFileSync(manifest, existing)
    ensureDesktopProfile(projectDir)
    expect(readFileSync(manifest, 'utf8')).toBe(existing)
  })
})
