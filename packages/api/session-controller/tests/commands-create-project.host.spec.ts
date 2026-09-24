/**
 * Focused host spec for the project a created Session joins: an explicit
 * create-time `cwd` already owned by a registered project is the whole
 * membership fact, and nothing on this path creates a project.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
// The package entry point resolves to this package's built `src/index.js` in a
// worktree that carries stale compiler residue, which would make the restart
// assertions below pass without ever running `adoptSessions`; the literal
// source path keeps them on the checked-in registry.
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace/src/index.ts'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { installSessionReadTestServices } from './test-remote.ts'

interface Fixture {
  readonly ctx: Context
  readonly controller: SessionCommandController
  readonly projects: () => readonly Workspace[]
  readonly cwdOf: (sessionId: SessionId) => string | undefined
}

interface FixtureOptions {
  /** Stub to provide in place of the real registry, for the failure branch a working registry cannot produce. */
  readonly registry?: object
  /** Durable medium to reuse; the previous run's pool makes this a real restart over stored records. */
  readonly pool?: MemoryMediaPool
  /** Headers the persistence peer reports; the fixture appends every Session it creates. */
  readonly sessions?: SessionHeader[]
}

/**
 * Boot a real Workspace registry over an in-memory storage domain beside a
 * Session store, then drive Session creation through the command controller.
 * @param defaultCwd - directory used when a create names no location.
 * @param standaloneRoot - private task root for standalone creates.
 * @param options - registry stub, shared durable medium, and reported headers.
 * @returns the wired context, controller, and read helpers.
 */
async function fixture(
  defaultCwd: string,
  standaloneRoot: string,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(options.pool ?? new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const sessions = options.sessions ?? []
  ctx.provide('sessionPersistence', {
    list: (): Promise<SessionPersistenceSnapshot[]> => Promise.resolve(sessions.map(header => ({
      header,
      revision: SessionPersistenceRevision(`rev-${header.id}`),
    }))),
    open: () => { throw new Error('event bodies must not be opened') },
    stat: () => { throw new Error('per-session stat must not be needed') },
  } as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  if (options.registry === undefined) await ctx.plugin(WorkspaceRegistry)
  else ctx.provide('workspaceRegistry', options.registry as never)

  // The real ApiSessionAgentController owns create/resume; this spec drives the
  // command controller's location and membership decisions, so only the Agent
  // resolution is stubbed — and it registers the Session for real, reporting
  // its header to the persistence peer so a later start indexes it again.
  const agents = {
    ensureSession: (sessionId: SessionId, cwd: string) => {
      const session = ctx.sessions.get(sessionId) ?? ctx.sessions.create(sessionId, { meta: { cwd } })
      if (!sessions.some(header => header.id === sessionId)) sessions.push(session.header)
      return Promise.resolve({ id: sessionId, session } as unknown as Agent)
    },
    presetForSession: () => undefined,
  } as unknown as ApiSessionAgentController

  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, defaultCwd, standaloneRoot),
    projects: () => ctx.workspaceRegistry.list(),
    cwdOf: sessionId => ctx.sessions.get(sessionId)?.header.cwd,
  }
}

let root = ''

async function makeDir(name: string): Promise<string> {
  root ||= await realpath(await mkdtemp(join(tmpdir(), 'dsh-create-project-')))
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
  root = ''
})

describe('Session creation and the project that owns the cwd', () => {
  it('joins the project owning an explicit cwd and leaves the Session cwd untouched', async () => {
    const projectDir = await makeDir('created-project')
    const alias = join(root, 'created-project-link')
    await symlink(projectDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const test = await fixture(await makeDir('created-default'), await makeDir('created-tasks'))
    const project = await test.ctx.workspaceRegistry.create(projectDir)

    const created = await test.controller.create({ cwd: projectDir })
    expect(test.projects()).toHaveLength(1)
    expect(test.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([created.sessionId])

    // Membership uses the canonical cwd; the stored header keeps the spelling
    // the caller supplied.
    const aliased = await test.controller.create({ cwd: alias })
    expect(test.cwdOf(aliased.sessionId)).toBe(alias)
    expect(test.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([aliased.sessionId, created.sessionId])

    await test.ctx.fiber.dispose()
  })

  it('adopts concurrent creates in one project without duplicating members', async () => {
    const projectDir = await makeDir('concurrent-project')
    const test = await fixture(await makeDir('concurrent-default'), await makeDir('concurrent-tasks'))
    const project = await test.ctx.workspaceRegistry.create(projectDir)

    const [first, second] = await Promise.all([
      test.controller.create({ cwd: projectDir }),
      test.controller.create({ cwd: projectDir }),
    ])

    const members = test.ctx.workspaceRegistry.get(project.id)!.sessionIds
    expect(members).toHaveLength(2)
    expect(new Set(members)).toEqual(new Set([first.sessionId, second.sessionId]))
    await test.ctx.fiber.dispose()
  })

  it('keeps an unowned cwd outside projects without creating one', async () => {
    const unowned = await makeDir('unowned-directory')
    const test = await fixture(await makeDir('unowned-default'), await makeDir('unowned-tasks'))

    const created = await test.controller.create({ cwd: unowned })

    expect(test.projects()).toEqual([])
    expect(test.cwdOf(created.sessionId)).toBe(unowned)
    await test.ctx.fiber.dispose()
  })

  it('keeps an unresolvable cwd outside projects instead of failing the create', async () => {
    const test = await fixture(await makeDir('missing-default'), await makeDir('missing-tasks'))
    const missing = join(root, 'never-created')

    const created = await test.controller.create({ cwd: missing })

    expect(test.projects()).toEqual([])
    expect(test.cwdOf(created.sessionId)).toBe(missing)
    await test.ctx.fiber.dispose()
  })

  it('never infers a project for a standalone Session, even at a project-owned task directory', async () => {
    const standaloneRoot = await makeDir('standalone-tasks')
    const test = await fixture(await makeDir('standalone-default'), standaloneRoot)
    const sessionId = SessionId('standalone-session')
    const taskDir = join(standaloneRoot, createHash('sha256').update(sessionId).digest('hex'))
    await mkdir(taskDir, { recursive: true })
    const project = await test.ctx.workspaceRegistry.create(taskDir)

    const created = await test.controller.create({ standalone: true, sessionId })

    expect(test.cwdOf(created.sessionId)).toBe(taskDir)
    expect(test.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([])
    await test.ctx.fiber.dispose()
  })

  it('leaves the default cwd unowned unless the caller named it', async () => {
    const defaultCwd = await makeDir('default-project')
    const test = await fixture(defaultCwd, await makeDir('default-tasks'))
    const project = await test.ctx.workspaceRegistry.create(defaultCwd)

    const created = await test.controller.create({})

    expect(test.cwdOf(created.sessionId)).toBe(defaultCwd)
    expect(test.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([])
    await test.ctx.fiber.dispose()
  })

  it('reports the created Session when the outside-project placement cannot be saved', async () => {
    const defaultCwd = await makeDir('unrecorded-default')
    const attempts: SessionId[] = []
    const test = await fixture(defaultCwd, await makeDir('unrecorded-tasks'), {
      registry: {
        get: () => undefined,
        list: () => [],
        moveSession: (sessionId: SessionId) => {
          attempts.push(sessionId)
          // The first write fails; the retry the failure asks for succeeds.
          return attempts.length === 1
            ? Promise.reject(new Error('storage write failed'))
            : Promise.resolve()
        },
      },
    })

    const failure = await test.controller.create({}).catch((error: unknown) => error)

    const reported = remoteErrorOf(failure)
    expect(reported?.code).toBe('session/membership-unrecorded')
    if (reported?.code !== 'session/membership-unrecorded') return
    // The Session exists with its stored cwd; only the placement is missing,
    // and the reported id is the handle that records it.
    expect(test.cwdOf(reported.details.sessionId)).toBe(defaultCwd)
    await test.ctx.workspaceRegistry.moveSession(reported.details.sessionId)
    expect(attempts).toEqual([reported.details.sessionId, reported.details.sessionId])
    await test.ctx.fiber.dispose()
  })

  it('keeps the Session outside projects when the inferred join is rejected', async () => {
    const projectDir = await makeDir('rejected-project')
    const attachSession = vi.fn(() => Promise.reject(new Error('workspace write failed')))
    const project = {
      id: WorkspaceId('workspace-rejecting'),
      path: projectDir,
      attachSession,
    } as unknown as Workspace
    const test = await fixture(await makeDir('rejected-default'), await makeDir('rejected-tasks'), {
      registry: {
        get: () => undefined,
        list: () => [project],
        resolveByPath: () => Promise.resolve(project),
      },
    })

    const created = await test.controller.create({ cwd: projectDir })

    // Publication precedes attachment: the Session exists and stays ungrouped,
    // and the registry's next start adopts it.
    expect(attachSession).toHaveBeenCalledExactlyOnceWith(created.sessionId)
    expect(test.cwdOf(created.sessionId)).toBe(projectDir)
    await test.ctx.fiber.dispose()
  })

  it('keeps a standalone Session outside the project that owns its task directory across a restart', async () => {
    const standaloneRoot = await makeDir('standalone-restart-tasks')
    const defaultCwd = await makeDir('standalone-restart-default')
    const sessionId = SessionId('standalone-restart-session')
    const taskDir = join(standaloneRoot, createHash('sha256').update(sessionId).digest('hex'))
    await mkdir(taskDir, { recursive: true })
    const sessions: SessionHeader[] = []
    const pool = new MemoryMediaPool()

    const first = await fixture(defaultCwd, standaloneRoot, { pool, sessions })
    const project = await first.ctx.workspaceRegistry.create(taskDir)
    const created = await first.controller.create({ standalone: true, sessionId })
    expect(first.cwdOf(created.sessionId)).toBe(taskDir)
    expect(first.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([])
    await first.ctx.fiber.dispose()

    // The second start re-indexes the persisted header and re-applies directory
    // membership; the create-time decision must survive it.
    const restarted = await fixture(defaultCwd, standaloneRoot, { pool, sessions })
    expect(restarted.projects().map(item => item.path)).toEqual([taskDir])
    expect(restarted.ctx.workspaceRegistry.list().flatMap(item => item.sessionIds)).toEqual([])
    await restarted.ctx.fiber.dispose()
  })

  it('keeps the default cwd outside the project that owns it across a restart', async () => {
    const defaultCwd = await makeDir('default-restart-project')
    const standaloneRoot = await makeDir('default-restart-tasks')
    const sessions: SessionHeader[] = []
    const pool = new MemoryMediaPool()

    const first = await fixture(defaultCwd, standaloneRoot, { pool, sessions })
    const project = await first.ctx.workspaceRegistry.create(defaultCwd)
    const created = await first.controller.create({})
    expect(first.cwdOf(created.sessionId)).toBe(defaultCwd)
    expect(first.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([])
    await first.ctx.fiber.dispose()

    const restarted = await fixture(defaultCwd, standaloneRoot, { pool, sessions })
    expect(restarted.projects().map(item => item.path)).toEqual([defaultCwd])
    expect(restarted.ctx.workspaceRegistry.list().flatMap(item => item.sessionIds)).toEqual([])
    await restarted.ctx.fiber.dispose()
  })

  it('groups a standalone Session when the user moves it into a project later', async () => {
    const standaloneRoot = await makeDir('standalone-move-tasks')
    const sessionId = SessionId('standalone-move-session')
    const taskDir = join(standaloneRoot, createHash('sha256').update(sessionId).digest('hex'))
    await mkdir(taskDir, { recursive: true })
    const test = await fixture(await makeDir('standalone-move-default'), standaloneRoot)
    const project = await test.ctx.workspaceRegistry.create(taskDir)

    const created = await test.controller.create({ standalone: true, sessionId })
    expect(test.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([])

    // The explicit placement overrides the create-time record, and the stored
    // header cwd is never rewritten by the move.
    await test.ctx.workspaceRegistry.moveSession(created.sessionId, project.id)
    expect(test.ctx.workspaceRegistry.get(project.id)!.sessionIds).toEqual([created.sessionId])
    expect(test.cwdOf(created.sessionId)).toBe(taskDir)
    await test.ctx.fiber.dispose()
  })
})
