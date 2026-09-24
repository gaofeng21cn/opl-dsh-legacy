/**
 * Session permission over the Remote face: a create-time preset, the effective
 * permission read, and an explicit switch.
 *
 * The service under it is the real permission preset service over the real
 * session log, so "persisted" and "restart-recovered" mean the events the
 * deployment actually writes: `permission/preset`, `sandbox/mode`, and
 * `approval/policy`. The shell and approval seams are provided as the two
 * facts the service reads (a deployment default each), because this spec is
 * about the permission contract rather than about shell execution.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import PermissionPresetService, { type PresetSpec } from '@deepseek-ai/dsh-permission-presets'
// Side-effect type imports: the permission knob SessionEventMap entries merge.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const owned = new Set<Context>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/** The preset table the shipped base composition installs. */
const PRESETS: Record<string, PresetSpec> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

/**
 * A Host with the real permission service, plus a controller whose Agent seam
 * is a stub.
 *
 * `ensureSession` creates the Session in the store so `session/created` fires
 * exactly as the loop's publish does, which is what pins a fresh Session's
 * initial permission.
 * @returns the context, the controller, and the ensured-Session spy.
 */
async function harness(): Promise<{
  ctx: Context
  controller: SessionCommandController
  ensured: SessionId[]
}> {
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  // The loop's own boundary fold: the permission read reports the turn it
  // observes, and that turn comes from this projection in production too.
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  ctx.provide('approval', { config: { policy: 'ask' } } as never)
  await ctx.plugin(PermissionPresetService, { presets: PRESETS })
  // Membership is out of scope here; the create path still records the
  // outside-project placement through this seam.
  ctx.provide('workspaceRegistry', { moveSession: () => Promise.resolve() } as never)
  const ensured: SessionId[] = []
  const agents = {
    ensureSession: (sessionId: SessionId, cwd: string) => {
      ensured.push(sessionId)
      const session = ctx.sessions.get(sessionId) ?? ctx.sessions.create(sessionId, { meta: { cwd } })
      return Promise.resolve({ id: sessionId, session } as Agent)
    },
    presetForSession: () => undefined,
  } as unknown as ApiSessionAgentController
  return { ctx, controller: new SessionCommandController(ctx, agents, '/default'), ensured }
}

/** Register an Agent so the controller observes the Session as attached. */
async function attach(ctx: Context, session: Session, status: 'idle' | 'running'): Promise<void> {
  await ctx.agents.register({ id: session.id, session, status, ctx } as Agent)
}

/** The folded permission state the service itself reads. */
function folded(ctx: Context, session: Session): unknown {
  return ctx.sessionProjections.stateOf(session, 'permissions')
}

describe('session permission over the Remote face', () => {
  it('installs an explicitly requested preset before the Session can run', async () => {
    const { ctx, controller } = await harness()
    const created = await controller.create({ standalone: true, permissionPreset: 'danger-full-access' })
    expect(created.permissions).toMatchObject({
      sessionId: created.sessionId,
      preset: 'danger-full-access',
      sandbox: 'danger-full-access',
      approval: 'never',
      defaultPreset: 'workspace-write',
      available: ['read-only', 'workspace-write', 'danger-full-access'],
    })
    const session = ctx.sessions.get(created.sessionId) as Session
    expect(folded(ctx, session)).toMatchObject({
      preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never',
    })
    // The live Agent is the driver holding the Session; it is idle because no
    // prompt has been sent, which is the state the caller verifies before it.
    expect(created.permissions?.running).toBe(false)
    expect(created.permissions?.turn).toBeNull()
  })

  it('keeps the deployment default when creation names no preset', async () => {
    const { controller } = await harness()
    const created = await controller.create({ standalone: true })
    expect(created.permissions).toMatchObject({
      preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask',
    })
  })

  it('rejects an unknown preset before anything is created', async () => {
    const { ctx, controller, ensured } = await harness()
    await expect(controller.create({ standalone: true, permissionPreset: 'root' }))
      .rejects.toMatchObject({
        code: 'session/permissions-unknown-preset',
        details: { preset: 'root', available: ['read-only', 'workspace-write', 'danger-full-access'] },
      })
    expect(ensured).toEqual([])
    expect(ctx.sessions.list()).toEqual([])
  })

  it('reads the effective permission of one Session and refuses an unattached one', async () => {
    const { ctx, controller } = await harness()
    const created = await controller.create({ standalone: true, permissionPreset: 'read-only' })
    const session = ctx.sessions.get(created.sessionId) as Session
    await attach(ctx, session, 'idle')
    expect(controller.permissions({ sessionId: session.id })).toMatchObject({
      sessionId: session.id, preset: 'read-only', sandbox: 'read-only', approval: 'ask', running: false,
    })
    expect(() => controller.permissions({ sessionId: SessionId('session-absent') }))
      .toThrow(expect.objectContaining({ code: 'session/not-found' }))
  })

  it('switches one Session without touching another Session or the default', async () => {
    const { ctx, controller } = await harness()
    const changed = await controller.create({ standalone: true, permissionPreset: 'read-only' })
    const untouched = await controller.create({ standalone: true, permissionPreset: 'workspace-write' })
    const changedSession = ctx.sessions.get(changed.sessionId) as Session
    const untouchedSession = ctx.sessions.get(untouched.sessionId) as Session
    await attach(ctx, changedSession, 'idle')
    await attach(ctx, untouchedSession, 'idle')

    const switched = controller.selectPermissions({ sessionId: changed.sessionId, preset: 'danger-full-access' })
    expect(switched).toMatchObject({
      appliesFrom: 'next-confined-call',
      permissions: { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
    })
    expect(controller.permissions({ sessionId: untouched.sessionId })).toMatchObject({
      preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask',
    })
    expect(ctx.get('permissionPresets')?.defaultPreset).toBe('workspace-write')
  })

  it('refuses a widening switch while the Session is running and changes nothing', async () => {
    const { ctx, controller } = await harness()
    const created = await controller.create({ standalone: true, permissionPreset: 'workspace-write' })
    const session = ctx.sessions.get(created.sessionId) as Session
    await attach(ctx, session, 'running')
    session.append('turn/start', { turn: 4 })

    expect(() => controller.selectPermissions({ sessionId: created.sessionId, preset: 'danger-full-access' }))
      .toThrow(expect.objectContaining({
        code: 'session/permissions-busy',
        details: { sessionId: created.sessionId, preset: 'danger-full-access', currentPreset: 'workspace-write', turn: 4 },
      }))
    // The refusal is inert: the effective knobs and the log are unchanged, and
    // the running turn was not cancelled on the caller's behalf.
    expect(controller.permissions({ sessionId: created.sessionId })).toMatchObject({
      preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', running: true, turn: 4,
    })
  })

  it('narrows a running Session but refuses to widen a pending approval away', async () => {
    const { ctx, controller } = await harness()
    const created = await controller.create({ standalone: true, permissionPreset: 'danger-full-access' })
    const session = ctx.sessions.get(created.sessionId) as Session
    await attach(ctx, session, 'running')
    session.append('turn/start', { turn: 2 })

    // Narrowing only ever removes reach, so it stays available mid-turn.
    expect(controller.selectPermissions({ sessionId: created.sessionId, preset: 'read-only' }))
      .toMatchObject({ permissions: { preset: 'read-only', sandbox: 'read-only', approval: 'ask' } })
    // `ask` also widens over `never`: dropping the approval prompt for the
    // remaining tool calls of an active turn is not a narrowing.
    expect(() => controller.selectPermissions({ sessionId: created.sessionId, preset: 'danger-full-access' }))
      .toThrow(expect.objectContaining({ code: 'session/permissions-busy' }))
  })

  it('recovers a switched preset by replaying the log in a fresh Host', async () => {
    const first = await harness()
    const created = await first.controller.create({ standalone: true, permissionPreset: 'read-only' })
    const source = first.ctx.sessions.get(created.sessionId) as Session
    await attach(first.ctx, source, 'idle')
    first.controller.selectPermissions({ sessionId: created.sessionId, preset: 'danger-full-access' })
    const recorded = source.snapshotEvents()
      .filter(event => event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy')
    // Creation pins the deployment default, then installs the requested
    // preset, then the switch moves both knobs: every step is a durable event.
    expect(recorded.map(event => event.type)).toEqual([
      'permission/preset', 'sandbox/mode', 'approval/policy',
      'permission/preset', 'sandbox/mode',
      'permission/preset', 'sandbox/mode', 'approval/policy',
    ])
    expect(recorded.at(-3)?.data).toEqual({ preset: 'danger-full-access' })

    // A fresh Host folds the same durable events; that fold is the whole
    // recovery path, because the Session log is the only permission store.
    const second = await harness()
    const replayed = second.ctx.sessions.create(SessionId('session-replayed'), { meta: { cwd: '/workspace' } })
    for (const event of recorded) {
      replayed.append(event.type, event.data)
    }
    expect(second.ctx.get('permissionPresets')?.permissionsOf(replayed)).toMatchObject({
      preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never',
    })
  })
})
