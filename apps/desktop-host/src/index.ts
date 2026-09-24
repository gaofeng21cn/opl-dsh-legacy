/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { startControlBridge } from './control-bridge.ts'
import { ensureDesktopProfile } from './desktop-profile.ts'
import { serveWslTransport, WSL_DEFAULT_HOME_DIR, WSL_HOME_ENV } from './wsl-serve.ts'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Route the Web client's NDJSON stream requests through the official DSH gateway. */
function remoteStreamHandler(ctx: Awaited<ReturnType<typeof runProfile>>['ctx']): import('@deepseek-ai/dsh-client-connection').ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request): Promise<Response> {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const gateway = ctx.get('typertGateway')
      if (gateway === undefined) return new Response('gateway unavailable', { status: 503 })
      let body: unknown
      try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
      if (!isRecord(body) || typeof body.endpoint !== 'string') return new Response('invalid stream request', { status: 400 })
      const endpoint = body.endpoint
      const abort = new AbortController()
      const cancel = (): void => { abort.abort(request.signal.reason) }
      request.signal.addEventListener('abort', cancel, { once: true })
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const values = await gateway.wireStream.open(
              endpoint,
              body.payload,
              (async function* (): AsyncIterable<unknown> {})(),
              undefined,
              abort.signal,
            )
            for await (const value of values) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
            controller.close()
          } catch (error) { controller.error(error) }
          finally { request.signal.removeEventListener('abort', cancel) }
        },
        cancel(reason) { abort.abort(reason); request.signal.removeEventListener('abort', cancel) },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
    },
  }
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  if (process.argv[3] === '--serve-wsl') {
    const bindingFile = process.argv[4]
    if (bindingFile === undefined) throw new Error('desktop WSL: binding file is required')
    await serveDesktopHostOverWsl(runtimeDir, bindingFile)
    return
  }
  const projectDir = process.argv[3] as string
  installOfficeEngineResolution(runtimeDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--port', '19387'],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: { updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl> } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  await installControlBridge(ctx, projectDir)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

/** Install the optional local control endpoint on the running official profile. */
async function installControlBridge(ctx: Awaited<ReturnType<typeof runProfile>>['ctx'], projectDir: string): Promise<void> {
  if (process.env.DSH_DESKTOP_CONTROL === '0') return
  try {
    const gateway = ctx.get('typertGateway')
    if (gateway === undefined) throw new Error('desktop WSL: typert gateway is unavailable')
    const stop = await startControlBridge(gateway, join(projectDir, 'control.json'))
    ctx.effect(() => stop, 'desktop: authenticated local control')
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/**
 * Run the official Desktop Web profile inside the selected Linux distribution.
 * @param runtimeDir - Linux package tree bundled with the Windows application.
 * @param bindingFile - Owner-only handshake file read by the Windows shell.
 * @returns Completion of profile startup; its Web server owns the process lifetime.
 */
export async function serveDesktopHostOverWsl(runtimeDir: string, bindingFile: string): Promise<void> {
  const configured = process.env[WSL_HOME_ENV]?.trim()
  if (configured && !isAbsolute(configured)) throw new Error(`${WSL_HOME_ENV} must be an absolute Linux path`)
  process.env.DSH_HOME = configured || join(homedir(), WSL_DEFAULT_HOME_DIR)
  const projectDir = join(process.env.DSH_HOME, 'profiles', 'desktop')
  ensureDesktopProfile(projectDir)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'desktop',
    resolvedProfile: { profile, installAnchor }, patchFiles: [], args: ['--no-open', '--port', '0'] })
  await installControlBridge(ctx, projectDir)
  const updateTasks = installDesktopUpdateTaskControl(ctx)
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  const api = ctx.connection.createSharedFetchHandler('/api')
  const streams = remoteStreamHandler(ctx)
  const stop = await serveWslTransport({ api, assets: api, streams }, bindingFile, {
    ready: { url, injections: ctx.webServer.collectIndexInjections() }, updateTasks,
  }).catch(async (error: unknown) => { await ctx.fiber.dispose(); throw error })
  ctx.effect(() => stop, 'desktop: WSL readiness and update control')
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
