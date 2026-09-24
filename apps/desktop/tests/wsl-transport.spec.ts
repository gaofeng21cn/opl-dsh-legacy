/**
 * WSL transport: binding validation, authentication, and the launcher lifecycle.
 *
 * The end-to-end cases start a real loopback server and a real client over it,
 * because the properties that matter here — a token actually gates access, a
 * version mismatch is refused, an in-flight request is cancelled — are
 * concurrency and wire facts rather than units.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'
import { serveWslTransport, isLoopbackHost, parseWslTransportBinding, WSL_TRANSPORT_VERSION } from '../../desktop-host/src/wsl-serve.ts'
import { WslDesktopHost, readWslBinding } from '../src/wsl-host.ts'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-wsl-transport-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The narrow slice of a composed Host the transport actually dispatches to. */
function core(handler: ConnectionFetchHandler, dispose = async (): Promise<void> => {}) {
  return {
    ctx: new Context(),
    api: handler,
    assets: handler,
    streams: handler,
    gateway: {} as never,
    dshVersion: '1.0.0',
    dispose,
  }
}

/** An API handler answering every request with a fixed body. */
function echoHandler(body: string, onRequest?: (request: Request) => void): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request) {
      onRequest?.(request)
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  }
}

/** The binding a running transport published. */
interface PublishedBinding {
  readonly endpoint: string
  readonly token: string
}

/** Read the binding a transport published, with the fields this spec uses typed. */
function published(file: string): PublishedBinding {
  return JSON.parse(readFileSync(file, 'utf8')) as PublishedBinding
}

/** One transport answer, decoded from the base64 envelope. */
interface TransportAnswer {
  readonly status: number
  readonly bodyBase64?: string | null
  readonly error?: string
}

/** Read one transport answer's JSON body. */
async function answer(response: Response): Promise<TransportAnswer> {
  return await response.json() as TransportAnswer
}

describe('binding validation', () => {
  it('accepts a well-formed loopback binding', () => {
    expect(parseWslTransportBinding({
      version: WSL_TRANSPORT_VERSION, endpoint: 'http://127.0.0.1:41234/fetch', token: 'abc', pid: 7,
    })).toEqual({ version: WSL_TRANSPORT_VERSION, endpoint: 'http://127.0.0.1:41234/fetch', token: 'abc', pid: 7 })
  })

  it('refuses a non-loopback endpoint and an empty token', () => {
    const base = { version: WSL_TRANSPORT_VERSION, token: 'abc', pid: 7 }
    expect(() => parseWslTransportBinding({ ...base, endpoint: 'http://10.0.0.5:1234/fetch' })).toThrow(/not loopback/u)
    expect(() => parseWslTransportBinding({ ...base, endpoint: 'https://127.0.0.1:1234/fetch' })).toThrow(/not loopback/u)
    expect(() => parseWslTransportBinding({ ...base, endpoint: 'http://127.0.0.1:1/fetch', token: '' })).toThrow(/empty token/u)
    expect(() => parseWslTransportBinding({ ...base, version: 99, endpoint: 'http://127.0.0.1:1/fetch' })).toThrow(/invalid WSL transport binding/u)
  })

  it('recognizes every loopback spelling', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['0.0.0.0', '10.0.0.5', 'example.test']) expect(isLoopbackHost(host)).toBe(false)
  })

  it('reports a version mismatch distinctly from an unusable binding', () => {
    expect(readWslBinding(join(scratch(), 'missing.json'))).toBeUndefined()
    const file = join(scratch(), 'binding.json')
    writeFileSync(file, JSON.stringify({ version: 99, endpoint: 'http://127.0.0.1:1/fetch', token: 't', pid: 1 }))
    // A version skew is a partially updated installation, not a file still
    // being written, so it is reported instead of retried.
    expect(() => readWslBinding(file)).toThrow(/transport version/u)
    writeFileSync(file, 'not json')
    expect(readWslBinding(file)).toBeUndefined()
  })
})

describe('loopback transport end to end', () => {
  it('serves one authenticated request and refuses an unauthenticated one', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const seen: string[] = []
    const stop = await serveWslTransport(core(echoHandler('hello from linux', (request) => { seen.push(request.url) })), bindingFile)
    try {
      const binding = published(bindingFile)
      const authorized = await fetch(binding.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'dsh-app://app/api/x', method: 'GET', headers: [] }),
      })
      expect(await answer(authorized)).toMatchObject({ status: 200, bodyBase64: Buffer.from('hello from linux').toString('base64') })
      expect(seen).toEqual(['dsh-app://app/api/x'])

      const denied = await fetch(binding.endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'dsh-app://app/api/x', method: 'GET', headers: [] }),
      })
      expect(denied.status).toBe(403)
    } finally { await stop() }
  })

  it('publishes an owner-only binding and removes it on stop', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const stop = await serveWslTransport(core(echoHandler('x')), bindingFile)
    const raw: unknown = JSON.parse(readFileSync(bindingFile, 'utf8'))
    expect(raw).toMatchObject({ version: WSL_TRANSPORT_VERSION })
    expect(typeof (raw as { pid: unknown }).pid).toBe('number')
    await stop()
    expect(() => readFileSync(bindingFile, 'utf8')).toThrow()
  })

  it('rejects a malformed envelope, an oversized body, and an off-origin target', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const stop = await serveWslTransport(core(echoHandler('x')), bindingFile)
    try {
      const binding = published(bindingFile)
      const headers = { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }
      const post = (body: string) => fetch(binding.endpoint, { method: 'POST', headers, body })
      expect((await post('not json')).status).toBe(400)
      expect((await answer(await post(JSON.stringify({ url: 1 })))).error).toBe('invalid fetch envelope')
      expect((await answer(await post(JSON.stringify({ url: 'http://evil.test/x', method: 'GET', headers: [] })))).error)
        .toBe('fetch target must be an application URL')
      expect((await fetch(binding.endpoint, { method: 'GET', headers })).status).toBe(404)
    } finally { await stop() }
  })

  it('surfaces a Host handler failure as a transport error', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const failing: ConnectionFetchHandler = {
      requestBodyMode: () => 'buffered',
      fetch: async () => { throw new Error('host handler exploded') },
    }
    const stop = await serveWslTransport(core(failing), bindingFile)
    try {
      const binding = published(bindingFile)
      const response = await fetch(binding.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'dsh-app://app/api/x', method: 'GET', headers: [] }),
      })
      expect((await answer(response)).error).toBe('host handler exploded')
    } finally { await stop() }
  })
})

describe('Windows-side launcher', () => {
  /** One fake launcher child that exits when killed. */
  function fakeChild(overrides: Record<string, unknown> = {}) {
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stderr: null,
    }, overrides)
    child.kill = vi.fn(() => {
      child.exitCode = 0
      child.emit('close', 0)
      return true
    })
    return child
  }

  /** Start a real transport, then a launcher pointed at its binding file. */
  async function connectedHost() {
    const bindingFile = join(scratch(), 'wsl.json')
    const stop = await serveWslTransport(core(echoHandler('round trip', (request) => {
      expect(request.headers.get('x-probe')).toBe('yes')
    })), bindingFile)
    const spawn = vi.fn(() => fakeChild())
    const host = new WslDesktopHost(['wsl.exe', '--distribution', 'Ubuntu'], bindingFile, {}, { spawn: spawn as never })
    return { host, stop, spawn }
  }

  it('performs the handshake and forwards a request with its headers', async () => {
    const { host, stop, spawn } = await connectedHost()
    try {
      const binding = await host.start()
      expect(binding.version).toBe(WSL_TRANSPORT_VERSION)
      expect(host.hostPid).toBe(process.pid)
      const response = await host.fetch(new Request('dsh-app://app/api/x', { headers: { 'x-probe': 'yes' } }))
      expect(await response.text()).toBe('round trip')
      // The launcher is started once, not once per request: this is what makes
      // the connection long-lived rather than a per-call wsl.exe wrapper.
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith('wsl.exe', ['--distribution', 'Ubuntu'], expect.objectContaining({ windowsHide: true }))
    } finally { await host.stop(); await stop() }
  })

  it('reports a version mismatch rather than using an unreadable transport', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    writeFileSync(bindingFile, JSON.stringify({ version: 99, endpoint: 'http://127.0.0.1:1/fetch', token: 't', pid: 1 }))
    const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, {
      spawn: (() => fakeChild()) as never,
      readBinding: filename => readWslBinding(filename),
      delay: async () => {},
    })
    await expect(host.start()).rejects.toThrow(/transport version/u)
  })

  it('reports a launch failure when the child exits before publishing a binding', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, {
      spawn: (() => fakeChild({ exitCode: 1 })) as never,
      delay: async () => {},
    })
    await expect(host.start()).rejects.toMatchObject({ kind: 'launch-failed' })
  })

  it('reports a handshake timeout with its own failure kind', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, {
      spawn: (() => fakeChild()) as never,
      readBinding: () => undefined,
      delay: async () => {},
      readyTimeoutMs: 1,
    })
    await expect(host.start()).rejects.toMatchObject({ kind: 'handshake-timeout' })
  })

  it('refuses a launch that produces no invocation', async () => {
    const host = new WslDesktopHost([], join(scratch(), 'wsl.json'))
    await expect(host.start()).rejects.toMatchObject({ kind: 'launch-failed' })
  })

  it('cancels an in-flight request and reports a rejected token', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const stop = await serveWslTransport(core(echoHandler('ok')), bindingFile)
    try {
      const rogue = new WslDesktopHost(['wsl.exe'], bindingFile, {}, {
        spawn: (() => fakeChild()) as never,
        // Present the real endpoint with a token the Host never issued.
        readBinding: () => ({
          version: WSL_TRANSPORT_VERSION,
          endpoint: published(bindingFile).endpoint,
          token: 'forged',
          pid: 1,
        }),
      })
      await expect(rogue.fetch(new Request('dsh-app://app/api/x'))).rejects.toMatchObject({ kind: 'unauthenticated' })
      // Cancelling an unknown stream is a no-op, not a failure.
      expect(() => { rogue.cancel(999) }).not.toThrow()
      await rogue.stop()
    } finally { await stop() }
  })

  it('reports a binding whose endpoint never accepts a connection', async () => {
    // A published binding is not proof of reachability: WSL2 relays Windows
    // loopback connections and that relay lags the distribution's own bind, so
    // the launcher must not report readiness until the endpoint answers.
    const bindingFile = join(scratch(), 'wsl.json')
    writeFileSync(bindingFile, JSON.stringify({
      version: WSL_TRANSPORT_VERSION,
      // Nothing listens on this port.
      endpoint: 'http://127.0.0.1:1/fetch',
      token: 't',
      pid: 1,
    }))
    const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, {
      spawn: (() => fakeChild()) as never,
      delay: async () => {},
      readyTimeoutMs: 1,
    })
    await expect(host.start()).rejects.toMatchObject({ kind: 'handshake-timeout' })
    await host.stop()
  })

  it('treats an unauthorized answer as proof the endpoint is reachable', async () => {
    // The readiness probe sends no credentials, so the Host answers 403. That
    // completes the round trip, which is the only question the probe asks.
    const bindingFile = join(scratch(), 'wsl.json')
    const stop = await serveWslTransport(core(echoHandler('reachable')), bindingFile)
    try {
      const endpoint = published(bindingFile).endpoint
      const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, {
        spawn: (() => fakeChild()) as never,
        readBinding: () => ({ version: WSL_TRANSPORT_VERSION, endpoint, token: 'forged', pid: 1 }),
      })
      // start() resolves; only the request itself carries the rejected token.
      await expect(host.start()).resolves.toMatchObject({ version: WSL_TRANSPORT_VERSION })
      await expect(host.fetch(new Request('dsh-app://app/api/x'))).rejects.toMatchObject({ kind: 'unauthenticated' })
      await host.stop()
    } finally { await stop() }
  })

  it('stops the launcher and reports a transport that dies mid-request', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    // A real transport so the readiness wait sees a reachable endpoint; it is
    // stopped mid-session to stage the Host dying under a live request.
    const stop = await serveWslTransport(core(echoHandler('alive')), bindingFile)
    const child = fakeChild()
    const failure = vi.fn()
    const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, { spawn: (() => child) as never }, failure)
    try {
      await host.start()
      await stop()
      await expect(host.fetch(new Request('dsh-app://app/api/x'))).rejects.toMatchObject({ kind: 'transport-closed' })
    } finally {
      // A Host that dies during the session reports the failure to the shell.
      child.exitCode = 1
      child.emit('close', 1)
      await host.stop()
    }
    expect(failure).toHaveBeenCalled()
    // stop() after the child already exited must not signal a dead process.
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('signals the launcher on stop while it is still running', async () => {
    const bindingFile = join(scratch(), 'wsl.json')
    const stop = await serveWslTransport(core(echoHandler('alive')), bindingFile)
    const child = fakeChild()
    const host = new WslDesktopHost(['wsl.exe'], bindingFile, {}, { spawn: (() => child) as never })
    try {
      await host.start()
      await host.stop()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally { await stop() }
  })
})

it('exposes official Web readiness and task admission through the authenticated WSL connection', async () => {
  const bindingFile = join(scratch(), 'ready.json')
  const updateTasks = vi.fn(async (action: string) => action === 'lock')
  const stop = await serveWslTransport(core(echoHandler('ok')), bindingFile, {
    ready: { url: 'http://127.0.0.1:19387/?token=test', injections: [{ type: 'script', content: 'boot' }] },
    updateTasks,
  })
  try {
    const binding = published(bindingFile)
    const headers = { authorization: `Bearer ${binding.token}` }
    expect(await (await fetch(new URL('/ready', binding.endpoint), { method: 'POST', headers })).json()).toEqual({
      url: 'http://127.0.0.1:19387/?token=test', injections: [{ type: 'script', content: 'boot' }],
    })
    expect(await (await fetch(new URL('/update-tasks?action=lock', binding.endpoint), { method: 'POST', headers })).json()).toEqual({ active: true })
    expect(updateTasks).toHaveBeenCalledExactlyOnceWith('lock')
    expect((await fetch(new URL('/ready', binding.endpoint), { method: 'POST' })).status).toBe(403)
  } finally { await stop() }
})
