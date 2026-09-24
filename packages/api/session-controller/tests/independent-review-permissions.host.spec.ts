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

import { afterEach, expect, it } from 'vitest'
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

it('refuses create adoption as a route around running permission guard',async()=>{
  const { ctx,controller }=await harness();const created=await controller.create({ cwd:'/workspace',permissionPreset:'workspace-write' })
  const session=ctx.sessions.get(created.sessionId) as Session;await attach(ctx,session,'running');session.append('turn/start',{ turn:1 })
  await expect(controller.create({ sessionId:session.id,cwd:'/workspace',permissionPreset:'danger-full-access' })).rejects.toMatchObject({ code:'session/permissions-busy' })
})
