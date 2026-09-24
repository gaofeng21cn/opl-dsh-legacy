import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import { startControlBridge } from '../../desktop-host/src/control-bridge.ts'

/** The control binding a running bridge publishes. */
interface ControlBinding {
  readonly endpoint: string
  readonly token: string
}

/** Read the binding a bridge published, with the fields this spec uses typed. */
function readBinding(file: string): ControlBinding {
  return JSON.parse(readFileSync(file, 'utf8')) as ControlBinding
}

/** One authenticated control call against a running bridge. */
async function rpc(
  binding: ControlBinding,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(binding.endpoint, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

it('authenticates localhost control, rejects browser origins and unlisted APIs, and removes the binding on stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-'))
  const file = join(dir, 'control.json')
  const invoke = vi.fn(async () => ({ items: [] }))
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    const body = JSON.stringify({ namespace: 'session', method: 'list', args: { _request: {} } })
    expect((await fetch(binding.endpoint, { method: 'POST', body })).status).toBe(403)
    const headers = { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' }
    expect((await fetch(binding.endpoint, { method: 'POST', headers: { ...headers, origin: 'http://evil.test' }, body })).status).toBe(403)
    expect((await fetch(binding.endpoint, { method: 'POST', headers, body: JSON.stringify({ namespace: 'oplGatewayAccount', method: 'signOut', args: {} }) })).status).toBe(403)
    expect(await (await fetch(binding.endpoint, { method: 'POST', headers, body })).json()).toEqual({ ok: true, value: { items: [] } })
    expect(invoke).toHaveBeenCalledTimes(1)
  } finally { await stop(); expect(existsSync(file)).toBe(false); rmSync(dir, { recursive: true, force: true }) }
})

it('allows the event-driven session wait through the method allowlist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-wait-'))
  const file = join(dir, 'control.json')
  const invoke = vi.fn(async () => ({ turn: 2, outcome: { kind: 'completed' } }))
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    const result = await rpc(binding, {
      namespace: 'session',
      method: 'wait',
      args: { request: { sessionId: 's1' } },
    })
    expect(result).toEqual({ status: 200, json: { ok: true, value: { turn: 2, outcome: { kind: 'completed' } } } })
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'session',
      method: 'wait',
      args: { request: { sessionId: 's1' } },
    }))
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})

it('allows the permission read and switch and carries a refusal code back to the caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-permissions-'))
  const file = join(dir, 'control.json')
  const invoke = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'selectPermissions') {
      // The structural marker a RemoteError publishes; the bridge must report
      // the code so a control client can act on a refusal instead of parsing prose.
      throw Object.assign(new Error('refused while running'), {
        isDSHRemoteError: true,
        code: 'session/permissions-busy',
        details: { sessionId: 's1', preset: 'danger-full-access', currentPreset: 'workspace-write' },
      })
    }
    return { sessionId: 's1', preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }
  })
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    const read = await rpc(binding, { namespace: 'session', method: 'permissions', args: { request: { sessionId: 's1' } } })
    expect(read.status).toBe(200)
    expect(read.json).toMatchObject({ ok: true, value: { preset: 'workspace-write' } })
    const refused = await rpc(binding, {
      namespace: 'session', method: 'selectPermissions', args: { request: { sessionId: 's1', preset: 'danger-full-access' } },
    })
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({
      ok: false,
      code: 'session/permissions-busy',
      details: { sessionId: 's1', preset: 'danger-full-access' },
    })
    // The allowlist stays explicit: a Session method outside it never reaches the gateway.
    const unlisted = await rpc(binding, { namespace: 'session', method: 'fork', args: { request: { sessionId: 's1' } } })
    expect(unlisted.status).toBe(403)
    expect(invoke).toHaveBeenCalledTimes(2)
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})

it('allows only the project list and move, reports a refused move, and keeps the rest of the namespace closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-workspace-'))
  const file = join(dir, 'control.json')
  const baseline = { type: 'baseline', value: { items: [{ id: 'w1', path: '/repo', sessionIds: [] }], archivedSessionIds: [] } }
  const stream = vi.fn(() => (async function* () { yield baseline })())
  const invoke = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'moveSession') {
      // The business refusal a move to an unknown project produces.
      throw Object.assign(new Error('cannot reorder unknown workspace \'w-missing\''), {
        isDSHRemoteError: true,
        code: 'workspace/move-invalid',
        details: { workspaceId: 'w-missing' },
      })
    }
    return { moved: true }
  })
  const stop = await startControlBridge({ invoke, stream } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    const listed = await rpc(binding, { namespace: 'workspace', method: 'follow', args: {} })
    expect(listed.status).toBe(200)
    expect(listed.json).toEqual({ ok: true, value: baseline })
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'workspace', method: 'follow' }))
    expect(invoke).not.toHaveBeenCalled()

    const moved = await rpc(binding, {
      namespace: 'workspace',
      method: 'moveSession',
      args: { request: { sessionId: 's1', workspaceId: 'w-missing' } },
    })
    expect(moved.status).toBe(400)
    expect(moved.json).toMatchObject({ ok: false, code: 'workspace/move-invalid', details: { workspaceId: 'w-missing' } })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      namespace: 'workspace',
      method: 'moveSession',
      args: { request: { sessionId: 's1', workspaceId: 'w-missing' } },
    }))

    // The allowlist names two methods, not the namespace: the remaining
    // Workspace commands never reach the gateway.
    for (const method of ['create', 'delete', 'rename', 'insertBefore', 'archiveSession']) {
      const refused = await rpc(binding, { namespace: 'workspace', method, args: { request: {} } })
      expect(refused).toEqual({ status: 403, json: { error: 'method not allowed' } })
    }
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(1)
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})

it('reports a caller deadline as a timeout rather than as the cancelled call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-timeout-'))
  const file = join(dir, 'control.json')
  // Never settles: the bridge's own deadline must produce the answer.
  const invoke = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('aborted by the call signal')) }, { once: true })
  }))
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    const result = await rpc(binding, {
      namespace: 'session',
      method: 'wait',
      args: { request: { sessionId: 's1' } },
      timeoutMs: 30,
    })
    expect(result.status).toBe(504)
    expect(result.json).toMatchObject({ ok: false, code: 'timeout' })
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})

it('rejects an unusable deadline instead of silently substituting its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-badtimeout-'))
  const file = join(dir, 'control.json')
  const invoke = vi.fn(async () => ({}))
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    for (const timeoutMs of [0, -1, 1.5, 24 * 60 * 60 * 1000 + 1, 'soon']) {
      const result = await rpc(binding, { namespace: 'session', method: 'list', args: {}, timeoutMs })
      expect(result.status).toBe(400)
    }
    expect(invoke).not.toHaveBeenCalled()
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})

it('allows the queue steer mutation through the allowlist and carries its refusal code back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opl-control-queue-'))
  const file = join(dir, 'control.json')
  const invoke = vi.fn(async () => {
    // The business refusal a steer gets once the current turn stops accepting it.
    throw Object.assign(new Error('current turn no longer accepts steering'), {
      isDSHRemoteError: true,
      code: 'session/steer-unavailable',
      details: { itemId: 'q-42' },
    })
  })
  const stop = await startControlBridge({ invoke } as unknown as TypertGateway, file)
  const binding = readBinding(file)
  try {
    const refused = await rpc(binding, {
      namespace: 'session',
      method: 'updateQueue',
      args: { request: { sessionId: 's1', itemId: 'q-42', action: { kind: 'steer' } } },
    })
    expect(refused.status).toBe(400)
    expect(refused.json).toMatchObject({
      ok: false,
      code: 'session/steer-unavailable',
      details: { itemId: 'q-42' },
    })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      namespace: 'session',
      method: 'updateQueue',
      args: { request: { sessionId: 's1', itemId: 'q-42', action: { kind: 'steer' } } },
    }))
  } finally { await stop(); rmSync(dir, { recursive: true, force: true }) }
})
