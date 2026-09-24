/**
 * Loopback transport that lets the Windows shell reach a Linux DSH Host
 * running inside a WSL2 distribution.
 *
 * The Host is the *server*: it binds an ephemeral port on the distribution's
 * loopback interface and publishes a versioned binding — endpoint plus a
 * per-launch bearer token — into a file the Windows side reads. That token is
 * the only credential, so this is a private local connection rather than an
 * open port: nothing outside the machine can reach it, the token is generated
 * fresh per launch, and the file is owner-readable only.
 *
 * Only three operations cross the boundary: read the binding, fetch a request,
 * and cancel a stream. The protocol is the same Fetch-shaped vocabulary the
 * byte pipes carry, so no second agent implementation exists.
 *
 * @module @deepseek-ai/dsh-desktop-host/wsl-serve
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, renameSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConnectionFetchHandler } from '@deepseek-ai/dsh-client-connection'

/** Host handlers used by the authenticated WSL transport. */
export interface DesktopHostCore {
  readonly api: ConnectionFetchHandler
  readonly assets: ConnectionFetchHandler
  readonly streams?: ConnectionFetchHandler
}

/** Readiness and update coordination supplied by the official Web profile. */
export interface WslWebHostControl {
  readonly ready: { readonly url: string; readonly injections: readonly unknown[] }
  updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean>
}

/**
 * Wire version of the WSL binding and its request envelopes.
 *
 * Both sides are shipped in one signed Desktop release, so a mismatch means a
 * partially updated installation rather than an ordinary version skew: the
 * Windows side refuses the binding instead of guessing at an older protocol.
 */
export const WSL_TRANSPORT_VERSION = 1 as const

/**
 * Environment variable naming an explicit Linux Harness home for this Host.
 *
 * The Windows launcher is the only writer, and it forwards this name through
 * `WSLENV`. Its value is a Linux path by definition, because only the
 * distribution can resolve it.
 */
export const WSL_HOME_ENV = 'DSH_DESKTOP_WSL_HOME'

/** Directory this product owns inside a distribution when nothing overrides it. */
export const WSL_DEFAULT_HOME_DIR = '.dsh-opl'

/** Maximum request body the loopback transport accepts, in bytes. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** A binding published for the Windows-side launcher. */
export interface WslTransportBinding {
  readonly version: typeof WSL_TRANSPORT_VERSION
  /** Loopback endpoint the Windows side posts to. */
  readonly endpoint: string
  /** Per-launch bearer token; the only credential this connection has. */
  readonly token: string
  /** Linux Host process id, for lifecycle diagnostics on either side. */
  readonly pid: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Validate a binding read by the Windows-side launcher.
 *
 * The endpoint must be loopback: a binding naming any other interface would
 * accept a connection from outside the machine, which is not what this
 * transport promises.
 * @param value - parsed binding file contents.
 * @returns the validated binding.
 * @throws when the file is not a usable binding for this version.
 */
export function parseWslTransportBinding(value: unknown): WslTransportBinding {
  if (!isRecord(value) || value.version !== WSL_TRANSPORT_VERSION
    || typeof value.endpoint !== 'string' || typeof value.token !== 'string'
    || typeof value.pid !== 'number') {
    throw new Error('dsh desktop: invalid WSL transport binding')
  }
  const endpoint = new URL(value.endpoint)
  if (endpoint.protocol !== 'http:' || !isLoopbackHost(endpoint.hostname)) {
    throw new Error(`dsh desktop: WSL transport endpoint ${JSON.stringify(value.endpoint)} is not loopback`)
  }
  if (value.token === '') throw new Error('dsh desktop: WSL transport binding has an empty token')
  return {
    version: WSL_TRANSPORT_VERSION,
    endpoint: value.endpoint,
    token: value.token,
    pid: value.pid,
  }
}

/** Whether one hostname names the machine's own loopback interface. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** Read one binding file written by a Linux Host. */
function readBinding(filename: string): WslTransportBinding {
  return parseWslTransportBinding(JSON.parse(readFileSync(filename, 'utf8')) as unknown)
}

/** Compare a supplied bearer header against the launch token without leaking timing. */
function authorized(supplied: string, token: string): boolean {
  const left = Buffer.from(supplied)
  const right = Buffer.from(`Bearer ${token}`)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Read a request body up to the transport limit. */
async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > MAX_REQUEST_BYTES) return undefined
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

/**
 * Serve one composed Host over the distribution's loopback interface.
 *
 * @param core - composed Host handlers shared with the byte-pipe transport.
 * @param bindingFile - path the Windows side reads the endpoint and token from.
 * @param control - Official Web profile readiness and update coordination.
 * @returns stop function that closes the listener and removes the binding.
 * @throws when the binding file cannot be published.
 */
export async function serveWslTransport(
  core: DesktopHostCore,
  bindingFile: string,
  control?: WslWebHostControl,
): Promise<() => Promise<void>> {
  const token = randomBytes(32).toString('hex')
  const streams = new Set<AbortController>()
  const server = createServer((request, response) => { void handle(request, response) })

  const reply = (response: ServerResponse, status: number, value: unknown): void => {
    if (response.writableEnded) return
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request.headers.authorization ?? '', token)) { reply(response, 403, { error: 'unauthorized' }); return }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'POST' && control !== undefined && url.pathname === '/ready') {
      reply(response, 200, control.ready)
      return
    }
    if (request.method === 'POST' && control !== undefined && url.pathname === '/update-tasks') {
      const action = url.searchParams.get('action')
      if (action !== 'inspect' && action !== 'lock' && action !== 'unlock') { reply(response, 400, { error: 'invalid task action' }); return }
      try { reply(response, 200, { active: await control.updateTasks(action) }) }
      catch (error) { reply(response, 500, { error: error instanceof Error ? error.message : 'task control failed' }) }
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/fetch') { reply(response, 404, { error: 'not found' }); return }
    let envelope: unknown
    try {
      const body = await readBody(request)
      if (body === undefined) { reply(response, 413, { error: 'request too large' }); return }
      envelope = JSON.parse(body.toString('utf8')) as unknown
    } catch {
      reply(response, 400, { error: 'body is not JSON' })
      return
    }
    if (!isRecord(envelope) || typeof envelope.url !== 'string' || typeof envelope.method !== 'string'
      || !Array.isArray(envelope.headers)) {
      reply(response, 400, { error: 'invalid fetch envelope' })
      return
    }
    const abort = new AbortController()
    streams.add(abort)
    const closed = (): void => { abort.abort() }
    response.on('close', closed)
    try {
      const target = new URL(envelope.url)
      // Only the application's own custom protocol and loopback HTTP reach a
      // Host handler; anything else would turn this socket into an open proxy.
      if (target.protocol !== 'dsh-app:' && !(target.protocol === 'http:' && isLoopbackHost(target.hostname))) {
        reply(response, 403, { error: 'fetch target must be an application URL' })
        return
      }
      const init: RequestInit & { readonly duplex?: 'half' } = {
        method: envelope.method,
        headers: new Headers(envelope.headers.map(([name, value]) => [String(name), String(value)] as [string, string])),
        signal: abort.signal,
        ...(typeof envelope.bodyBase64 === 'string'
          ? { body: Buffer.from(envelope.bodyBase64, 'base64'), duplex: 'half' as const }
          : {}),
      }
      const fetchRequest = new Request(target, init)
      const handler = target.pathname === '/.dsh/remote-stream' && core.streams !== undefined
        ? core.streams
        : target.pathname.startsWith('/api/') ? core.api : core.assets
      const fetched = await handler.fetch(fetchRequest)
      reply(response, 200, {
        status: fetched.status,
        headers: [...fetched.headers.entries()],
        bodyBase64: fetched.body === null ? null : Buffer.from(await fetched.arrayBuffer()).toString('base64'),
      })
    } catch (error) {
      if (abort.signal.aborted) { reply(response, 499, { error: 'client closed the request' }); return }
      reply(response, 500, { error: error instanceof Error ? error.message : 'host request failed' })
    } finally {
      streams.delete(abort)
      response.off('close', closed)
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('dsh desktop: WSL transport did not bind')
  mkdirSync(dirname(bindingFile), { recursive: true, mode: 0o700 })
  try {
    const temp = `${bindingFile}.${String(process.pid)}.tmp`
    const binding: WslTransportBinding = {
      version: WSL_TRANSPORT_VERSION,
      endpoint: `http://127.0.0.1:${String(address.port)}/fetch`,
      token,
      pid: process.pid,
    }
    // The token is the whole credential, so the file is owner-only and written
    // through a rename so the Windows side never observes a partial binding.
    writeFileSync(temp, `${JSON.stringify(binding)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, bindingFile)
  } catch (error) {
    server.close()
    throw error
  }
  return async () => {
    for (const controller of streams) controller.abort()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
    try {
      if (readBinding(bindingFile).token === token) unlinkSync(bindingFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
