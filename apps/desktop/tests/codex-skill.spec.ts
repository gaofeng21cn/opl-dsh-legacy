import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexSkillInstaller } from '../src/codex-skill.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(fs.renameSync).mockReset()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dsh-codex-install-')))
  roots.push(root)
  const skillSource = join(root, 'source')
  fs.cpSync(fileURLToPath(new URL('../../../.agents/skills/opl-dsh-workflow', import.meta.url)), skillSource, { recursive: true })
  const paths = {
    codexHome: join(root, 'codex'), skillSource,
    controlCli: fileURLToPath(new URL('../opl/opl-dsh-control.mjs', import.meta.url)),
    executable: process.execPath, dshHome: join(root, 'dsh'),
    startCommand: '/usr/bin/open', startArgs: ['-a', '/Applications/OPL DSH.app'],
  }
  const directory = join(paths.codexHome, 'skills', 'opl-dsh-workflow')
  return { root, paths, directory, installer: createCodexSkillInstaller(paths) }
}

it('installs a portable skill, updates resources and paths, and preserves custom configuration', async () => {
  const f = fixture()
  expect((await f.installer.status()).state).toBe('missing')
  expect(fs.existsSync(f.directory)).toBe(false)
  expect(await f.installer.install({ autoStart: true })).toMatchObject({ state: 'current', autoStart: true })
  const configPath = join(f.directory, 'coordinator.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  expect(config).toMatchObject({ controlCli: join(f.directory, 'scripts/control.mjs'), electronNode: true, ledgerPerThread: true })
  expect(config).not.toHaveProperty('targetThreadId')
  config.timeoutMs = 42000
  config.startCommand = '/custom/launcher'
  config.startArgs = ['custom']
  fs.writeFileSync(configPath, JSON.stringify(config))
  fs.appendFileSync(join(f.paths.skillSource, 'SKILL.md'), '\nUpdated instructions.\n')
  const updated = createCodexSkillInstaller({ ...f.paths, executable: '/new/application/executable' })
  expect((await updated.status()).state).toBe('update')
  expect((await updated.install({ autoStart: true })).state).toBe('current')
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ timeoutMs: 42000, node: '/new/application/executable', startCommand: '/custom/launcher', startArgs: ['custom'] })
  expect((await updated.install({ autoStart: false })).autoStart).toBe(false)
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty('startCommand')
  expect((await updated.install({ autoStart: true })).autoStart).toBe(true)
})

it.each(['SKILL.md', 'scripts/control.mjs', 'extra.txt'])('refuses to overwrite user changes in %s', async (file) => {
  const f = fixture()
  await f.installer.install({ autoStart: true })
  fs.writeFileSync(join(f.directory, file), 'user content')
  expect((await f.installer.status()).state).toBe('modified')
  await expect(f.installer.install({ autoStart: false })).rejects.toThrow('safely updated')
  expect(fs.readFileSync(join(f.directory, file), 'utf8')).toBe('user content')
})

it('leaves unmanaged directories and symbolic links untouched', async () => {
  const f = fixture()
  fs.mkdirSync(f.directory, { recursive: true })
  fs.writeFileSync(join(f.directory, 'SKILL.md'), 'my skill')
  expect((await f.installer.status()).state).toBe('unmanaged')
  await expect(f.installer.install({ autoStart: true })).rejects.toThrow()
  fs.rmSync(f.directory, { recursive: true })
  fs.symlinkSync(f.paths.skillSource, f.directory, 'dir')
  expect((await f.installer.status()).state).toBe('unmanaged')
  await expect(f.installer.install({ autoStart: true })).rejects.toThrow()
})

it('rejects a redirected configuration without reading or changing the target', async () => {
  const f = fixture()
  await f.installer.install({ autoStart: true })
  const outside = join(f.root, 'private.json')
  fs.writeFileSync(outside, '{"secret":"untouched"}')
  fs.unlinkSync(join(f.directory, 'coordinator.json'))
  fs.symlinkSync(outside, join(f.directory, 'coordinator.json'))
  expect((await f.installer.status()).state).toBe('unmanaged')
  await expect(f.installer.install({ autoStart: true })).rejects.toThrow()
  expect(fs.readFileSync(outside, 'utf8')).toBe('{"secret":"untouched"}')
})

it('restores the old installation if publishing the staged directory fails', async () => {
  const f = fixture()
  await f.installer.install({ autoStart: true })
  const previous = fs.readFileSync(join(f.directory, 'coordinator.json'), 'utf8')
  const { renameSync: rename } = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
    if (String(source).includes('.opl-dsh-stage-')) throw new Error('simulated rename failure')
    return rename(source, target)
  })
  await expect(f.installer.install({ autoStart: false })).rejects.toThrow('simulated')
  expect(fs.readFileSync(join(f.directory, 'coordinator.json'), 'utf8')).toBe(previous)
  expect((await f.installer.status()).state).toBe('current')
})

it('reports missing bundle resources without installing partial files', async () => {
  const f = fixture()
  fs.unlinkSync(join(f.paths.skillSource, 'scripts/dispatch.mjs'))
  expect((await f.installer.status()).state).toBe('unavailable')
  await expect(f.installer.install({ autoStart: true })).rejects.toThrow()
  expect(fs.existsSync(f.directory)).toBe(false)
})

it('dispatches from the installed directory through its bundled CLI and current Codex thread', async () => {
  const f = fixture()
  const registrations: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      const rpc = JSON.parse(body)
      const q = rpc.args.request
      if (rpc.method === 'register') registrations.push(q)
      const value = rpc.method === 'create' ? { sessionId: q.sessionId }
        : rpc.method === 'permissions' ? { sessionId: q.sessionId, preset: 'workspace-write', running: false, turn: null }
          : rpc.method === 'projections' ? { values: { inbox: { 'next-turn': [], 'next-step': [] } } }
            : rpc.method === 'tasks' ? [] : rpc.method === 'register' ? { task: { ...q, state: 'accepted' } } : { accepted: true }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, value }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test endpoint')
    const binding = join(f.paths.dshHome, 'profiles', 'desktop')
    fs.mkdirSync(binding, { recursive: true })
    fs.writeFileSync(join(binding, 'control.json'), JSON.stringify({ version: 1, endpoint: `http://127.0.0.1:${address.port}/rpc`, token: 'test-only' }))
    await f.installer.install({ autoStart: false })
    fs.writeFileSync(join(f.root, 'prompt.txt'), 'Bounded test task')
    fs.writeFileSync(join(f.root, 'acceptance.txt'), 'Return a receipt')
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [join(f.directory, 'scripts/dispatch.mjs'), 'dispatch', '--task', 'installed', '--operation', 'first',
        '--prompt-file', join(f.root, 'prompt.txt'), '--acceptance-file', join(f.root, 'acceptance.txt')], {
        cwd: f.root, env: { ...process.env, CODEX_THREAD_ID: 'real-test-thread' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout, stderr }))
    })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ accepted: true, promptSent: true })
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({ target: { kind: 'codex-thread', threadId: 'real-test-thread' } })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}, 15_000)
