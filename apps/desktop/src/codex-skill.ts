/** Install only the bundled coordinator into the local Codex skill directory. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse } from 'node:path'
import type { CodexSkillBridge, CodexSkillStatus } from '@one-person-lab/dsh-client-ui-settings-codex/types'

const MANIFEST = '.opl-dsh-install.json'
const CONFIG = 'coordinator.json'
const OWNER = 'opl-dsh-codex-skill'
const bundledFiles = ['SKILL.md', 'references/setup.md', 'scripts/dispatch.mjs']
type Data = Record<string, unknown>
interface Manifest { owner: string; version: 1; files: Record<string, string>; defaults: Data }

/** Paths supplied only by the owning Electron process. */
export interface CodexSkillPaths {
  readonly codexHome: string
  readonly skillSource: string
  readonly controlCli: string
  readonly executable: string
  readonly dshHome: string
  readonly startCommand: string
  readonly startArgs: readonly string[]
}

function object(value: unknown): value is Data { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function json(file: string): unknown { return JSON.parse(readFileSync(file, 'utf8')) }
function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

// Inspect every existing ancestor, including broken links. Never follow a
// redirected skill/config directory while reading ownership or writing files.
function assertNativePath(path: string): void {
  if (!isAbsolute(path)) throw new Error('Codex home must be absolute')
  let cursor = parse(path).root
  for (const part of path.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part)
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links are not managed by the skill installer') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

function inventory(directory: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(files, inventory(directory, relative))
    else if (entry.isFile()) {
      if (relative !== MANIFEST && relative !== CONFIG) files[relative] = hash(readFileSync(join(directory, relative)))
    } else throw new Error('Unsupported file in skill directory')
  }
  return files
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function sameFiles(left: Record<string, string>, right: Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([file, digest]) => right[file] === digest)
}

/** Local synchronous transaction; IPC calls cannot interleave its filesystem steps. */
export function createCodexSkillInstaller(paths: CodexSkillPaths): CodexSkillBridge {
  const directory = join(paths.codexHome, 'skills', 'opl-dsh-workflow')
  const defaults: Data = {
    node: paths.executable, electronNode: true,
    controlCli: join(directory, 'scripts', 'control.mjs'),
    dshHome: paths.dshHome, ledgerDir: join(paths.codexHome, 'opl-dsh', 'ledger'),
    ledgerPerThread: true, pathMode: 'native',
    startCommand: paths.startCommand, startArgs: [...paths.startArgs],
  }
  const payload = (): Record<string, Buffer> => {
    const files = Object.fromEntries(bundledFiles.map(file => [file, readFileSync(join(paths.skillSource, file))]))
    return { ...files, 'scripts/control.mjs': readFileSync(paths.controlCli) }
  }
  const inspect = (): { status: CodexSkillStatus; manifest?: Manifest; config?: Data } => {
    const base = { directory, autoStart: true }
    let source: Record<string, Buffer>
    try { source = payload() } catch { return { status: { ...base, state: 'unavailable' } } }
    try { assertNativePath(directory) } catch { return { status: { ...base, state: 'unmanaged' } } }
    if (!existsSync(directory)) return { status: { ...base, state: 'missing' } }
    try {
      if (!lstatSync(directory).isDirectory()) return { status: { ...base, state: 'unmanaged' } }
      assertNativePath(join(directory, MANIFEST))
      const manifest = json(join(directory, MANIFEST))
      if (!object(manifest) || manifest.owner !== OWNER || manifest.version !== 1 || !object(manifest.files) || !object(manifest.defaults)
        || !Object.values(manifest.files).every(value => typeof value === 'string')) return { status: { ...base, state: 'unmanaged' } }
      assertNativePath(join(directory, CONFIG))
      const config = json(join(directory, CONFIG))
      if (!object(config)) return { status: { ...base, state: 'modified' } }
      const typed: Manifest = {
        owner: OWNER, version: 1, defaults: manifest.defaults,
        files: Object.fromEntries(Object.entries(manifest.files).map(([key, value]) => [key, String(value)])),
      }
      const autoStart = typeof config.startCommand === 'string'
      const installed = inventory(directory)
      if (!sameFiles(installed, typed.files)) return { status: { ...base, autoStart, state: 'modified' } }
      const desired = Object.fromEntries(Object.entries(source).map(([file, bytes]) => [file, hash(bytes)]))
      const state = sameFiles(installed, desired) && same(defaults, typed.defaults) ? 'current' : 'update'
      return { status: { ...base, autoStart, state }, manifest: typed, config }
    } catch { return { status: { ...base, state: 'unmanaged' } } }
  }
  return {
    async status() { return inspect().status },
    async install(options) {
      if (!object(options) || typeof options.autoStart !== 'boolean' || Object.keys(options).some(key => key !== 'autoStart')) throw new Error('Invalid skill installation options')
      const before = inspect()
      if (!['missing', 'current', 'update'].includes(before.status.state)) throw new Error('Skill directory cannot be safely updated')
      const source = payload()
      const config: Data = { ...defaults, ...before.config }
      // Refresh paths managed by an earlier install; keep explicit user overrides.
      for (const [key, value] of Object.entries(defaults)) {
        if (!before.config || same(before.config[key], before.manifest?.defaults[key])) config[key] = value
      }
      if (!options.autoStart) { delete config.startCommand; delete config.startArgs; delete config.startCwd }
      else if (typeof config.startCommand !== 'string') { config.startCommand = paths.startCommand; config.startArgs = [...paths.startArgs] }
      assertNativePath(directory)
      const parent = dirname(directory)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      const stage = join(parent, `.opl-dsh-stage-${randomUUID()}`)
      const backup = join(parent, `.opl-dsh-backup-${randomUUID()}`)
      let backedUp = false
      try {
        mkdirSync(stage, { mode: 0o700 })
        for (const [file, bytes] of Object.entries(source)) {
          mkdirSync(dirname(join(stage, file)), { recursive: true, mode: 0o700 })
          writeFileSync(join(stage, file), bytes, { mode: 0o600, flag: 'wx' })
        }
        writeFileSync(join(stage, CONFIG), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        const manifest: Manifest = { owner: OWNER, version: 1, files: inventory(stage), defaults }
        writeFileSync(join(stage, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        if (existsSync(directory)) { renameSync(directory, backup); backedUp = true }
        try { renameSync(stage, directory) } catch (error) {
          if (backedUp) { renameSync(backup, directory); backedUp = false }
          throw error
        }
      } finally { rmSync(stage, { recursive: true, force: true }) }
      if (backedUp) rmSync(backup, { recursive: true, force: true })
      return inspect().status
    },
  }
}
