/**
 * The shipped shell composition: the base bundle gates both shell stacks by
 * platform on its own rows (`disabled: !!js process.platform`), so exactly
 * one shell stack mounts per host and no separate platform layer exists —
 * the launcher applies nothing beyond the bundle layers. The spec composes
 * the REAL shipped bundle layers (dsh-base + dsh-web-app resolved from the
 * app installation anchor) through the boot's patch algorithm and pins the
 * effective per-platform roster, the preset-level gates that keep tool-bash
 * out of win32 sessions and tool-pwsh out of POSIX sessions, and the
 * cold-start resolution closure for the pwsh rows' bare plugin names.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, initProfile, loadProfile, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'

/**
 * The effective disabled state of one row on one platform: a `!!js` expression
 * evaluates with a platform-scoped `process` so both outcomes pin on any host.
 */
function disabledOn(row: { disabled?: unknown }, platform: 'win32' | 'linux', shell = 'powershell'): boolean {
  const value = row.disabled
  if (value !== null && typeof value === 'object' && '__jsExpr' in value) {
    return Boolean(evaluate({ process: { platform }, dshAgentShell: () => shell }, (value as { __jsExpr: string }).__jsExpr))
  }
  return value === true
}

describe('the shipped shell composition (real bundle layers)', () => {
  let home: string
  afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }) })
  // The app installation anchor, mirroring profile-boot.ts: the bundle layers
  // resolve from the REAL dsh-base/dsh-web-app packages through it, so this
  // suite composes the shipped patch files, not test fixtures.
  const anchor = fileURLToPath(new URL('../package.json', import.meta.url))

  it('composes the confined pwsh roster on win32 and the bash roster on POSIX from the same rows', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'web'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const profile = loadProfile('dsh', 'web', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(
      profile.layers.map(layer => layer.patches),
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    // One shared patch set, two rosters: the shell stacks gate themselves.
    for (const id of ['bash-sandbox', 'pwsh-sandbox', 'tool-bash', 'tool-pwsh']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }
    expect(disabledOn(byId.get('bash-sandbox')!, 'win32'), 'bash-sandbox on win32').toBe(true)
    expect(disabledOn(byId.get('bash-sandbox')!, 'linux'), 'bash-sandbox on linux').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'win32'), 'pwsh-sandbox on win32').toBe(false)
    expect(disabledOn(byId.get('pwsh-sandbox')!, 'linux'), 'pwsh-sandbox on linux').toBe(true)
    // Every win32 bash command runs through the sandbox-consuming executor, so
    // the Git Bash broker is the only launch site: no shipped row mounts the
    // unconfined `dsh-bash-local` provider.
    expect(byId.get('bash-sandbox')?.name).toBe('@deepseek-ai/dsh-bash-sandbox')
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-bash-local')).toEqual([])
    // Host shell-tool rows are disabled on every platform; sessions mount
    // their own rows instead.
    expect(byId.get('tool-bash')?.disabled).toBe(true)
    expect(byId.get('tool-pwsh')?.disabled).toBe(true)
    // The permission surface never moves: the sandbox/policy rows, the
    // permission switcher, fs-sandbox, and the approval service stay enabled
    // exactly as on POSIX — the confined pwsh executor is what changes.
    for (const id of ['permission', 'ui-permission', 'sandbox', 'sandbox-policy', 'fs-sandbox', 'approval']) {
      expect(byId.get(id)?.disabled, `row ${id}`).not.toBe(true)
    }
    // The launcher's cold-start module fallback BFS-links the apps/cli
    // dependency closure into the profile's node_modules, so every bare
    // plugin name in the base patch must resolve from there.
    const cliManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of ['@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-pwsh']) {
      expect(cliManifest.dependencies?.[name], `cold-start closure must reach ${name}`).toBeDefined()
    }
    for (const id of ['bash-sandbox', 'pwsh-sandbox']) {
      expect(disabledOn(byId.get(id)!, 'win32', 'git-bash')).toBe(id === 'pwsh-sandbox')
    }
    expect(warnings).toEqual([])
  })

  it('base-only profiles carry both stacks with the same platform gating', () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-windows-home-'))
    initProfile(join(home, PROFILES_DIR, 'base-only'), ['@deepseek-ai/dsh-base'])
    const profile = loadProfile('dsh', 'base-only', anchor, home)
    const warnings: string[] = []
    const rows = composeEntries(
      profile.layers.map(layer => layer.patches),
      message => warnings.push(message),
    )
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const id of ['bash-sandbox', 'tool-bash', 'pwsh-sandbox', 'tool-pwsh']) {
      expect(byId.has(id), `row ${id}`).toBe(true)
    }
    // No web overlay: the tool rows keep their own gating too.
    expect(disabledOn(byId.get('tool-bash')!, 'win32'), 'tool-bash on win32').toBe(true)
    expect(disabledOn(byId.get('tool-bash')!, 'linux'), 'tool-bash on linux').toBe(false)
    expect(disabledOn(byId.get('tool-pwsh')!, 'win32'), 'tool-pwsh on win32').toBe(false)
    expect(disabledOn(byId.get('tool-pwsh')!, 'linux'), 'tool-pwsh on linux').toBe(true)
    for (const id of ['bash-sandbox', 'pwsh-sandbox']) {
      expect(disabledOn(byId.get(id)!, 'win32', 'git-bash')).toBe(id === 'pwsh-sandbox')
    }
    expect(warnings).toEqual([])
  })
})

describe('shipped agent presets gate both shell tools by platform', () => {
  const webBundle = fileURLToPath(new URL('../../../packages/bundle/web-app/', import.meta.url))
  const webManifest = JSON.parse(readFileSync(join(webBundle, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string[] } } }
  const presetRows = composeEntries([bundlePatchPaths(webBundle, webManifest.dsh.bundle).flatMap(file =>
    yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema }) as import('@deepseek-ai/cordis-plugin-include').PatchOptions[])])

  const definitions = presetRows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset').map(row => row.config as import('@deepseek-ai/dsh-agent-preset-registry').PresetDefinition)

  it.each(['standard', 'ptc', 'cordis'])('preset %s gates its shell tool rows by platform', (preset) => {
    const entries: unknown = definitions.find(row => row.id === preset)!.plugins
    if (!Array.isArray(entries)) throw new TypeError(`preset ${preset} must parse to an entry array`)
    for (const [id, win32] of [['tool-bash', true], ['tool-pwsh', false]] as const) {
      const row = entries.find((entry): entry is Record<string, unknown> => (
        typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === id
      ))
      if (row === undefined) throw new TypeError(`preset ${preset} must mount ${id}`)
      expect(row.disabled).toMatchObject({ __jsExpr: expect.any(String) as string })
      // A platform-scoped context pins both outcomes on every host.
      const expression = (row.disabled as { __jsExpr: string }).__jsExpr
      expect(Boolean(evaluate({ process: { platform: 'win32' }, dshAgentShell: () => 'powershell' }, expression)), `${id} on win32`).toBe(win32)
      expect(disabledOn(row, 'win32', 'git-bash'), id + ' with Git Bash').toBe(!win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(!win32)
    }
  })

  it('minimal mounts no shell tool row and gates its persistent shell stack by platform', () => {
    const entries: unknown = definitions.find(row => row.id === 'minimal')!.plugins
    if (!Array.isArray(entries)) throw new TypeError('minimal preset must parse to an entry array')
    for (const id of ['tool-bash', 'tool-pwsh']) {
      expect(entries.some(entry => (
        typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === id
      )), `${id} must be absent from minimal`).toBe(false)
    }
    const group = entries.find((entry): entry is Record<string, unknown> => (
      typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === 'persistent-shell'
    ))
    if (group === undefined) throw new TypeError('minimal preset must mount persistent-shell')
    const rows = group.config as unknown[]
    if (!Array.isArray(rows)) throw new TypeError('persistent-shell must carry a row list')
    const byId = new Map(rows
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map(entry => [entry.id, entry]))
    // The bash stack (terminal-bash + persistent-bash) mounts on POSIX only; the
    // pwsh twin (terminal-bash with shellDialect pwsh + persistent-pwsh) mounts on
    // win32 only — exactly one persistent shell per host.
    for (const id of ['terminal-bash', 'persistent-bash']) {
      expect(disabledOn(byId.get(id)!, 'win32'), `${id} on win32`).toBe(true)
      expect(disabledOn(byId.get(id)!, 'linux'), `${id} on linux`).toBe(false)
    }
    for (const id of ['terminal-pwsh', 'persistent-pwsh']) {
      expect(disabledOn(byId.get(id)!, 'win32'), `${id} on win32`).toBe(false)
      expect(disabledOn(byId.get(id)!, 'linux'), `${id} on linux`).toBe(true)
    }
    for (const id of ['terminal-bash', 'persistent-bash', 'terminal-pwsh', 'persistent-pwsh']) {
      expect(disabledOn(byId.get(id)!, 'win32', 'git-bash')).toBe(id.endsWith('pwsh'))
    }
    expect(byId.get('terminal-pwsh')?.config).toMatchObject({ shellDialect: 'pwsh' })
    const bashConfig = byId.get('terminal-bash')?.config as { shellPath: { __jsExpr: string } }
    expect(bashConfig.shellPath).toMatchObject({ __jsExpr: expect.any(String) as string })
    expect(evaluate({ process: { platform: 'win32' }, dshGitBashPath: () => 'D:/工具/Git/bin/bash.exe' },
      bashConfig.shellPath.__jsExpr)).toBe('D:/工具/Git/bin/bash.exe')
    expect(evaluate({ process: { platform: 'linux' } }, bashConfig.shellPath.__jsExpr)).toBeUndefined()

  })
})
