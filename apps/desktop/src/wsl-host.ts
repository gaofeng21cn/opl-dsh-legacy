/**
 * Windows-side launcher and client for a DSH Host running inside WSL2.
 *
 * This is the counterpart of {@link @deepseek-ai/dsh-desktop-host/wsl-serve}.
 * It starts the Host once — `wsl.exe` is used for launch, probing, and
 * lifecycle only, never to wrap a tool call — waits for the published binding,
 * performs a version handshake, and then forwards Fetch requests over the
 * authenticated loopback connection.
 *
 * The class exposes the same `fetch(request)` shape the byte-pipe transport
 * provides, so the Electron shell selects a transport without knowing which
 * one it holds.
 *
 * @module dsh-desktop/wsl-host
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** Wire version understood by this launcher; must match the Host's. */
export const WSL_TRANSPORT_VERSION = 1 as const

/** Default deadline for the Host to publish its binding, in milliseconds. */
const DEFAULT_READY_TIMEOUT_MS = 120_000

/** How often the binding file is re-read while waiting, in milliseconds. */
const BINDING_POLL_MS = 100

/** Injectable process and filesystem operations, so lifecycle is testable. */
export interface WslHostInternals {
  /** Spawn one child. */
  readonly spawn?: typeof spawn
  /** Read the binding file, returning undefined until it is complete. */
  readonly readBinding?: (filename: string) => WslTransportBinding | undefined
  /** Sleep between binding reads. */
  readonly delay?: (milliseconds: number) => Promise<void>
  /** Deadline for the Linux Host to publish its binding, in milliseconds. */
  readonly readyTimeoutMs?: number
}

/** A binding published by the Linux Host. */
export interface WslTransportBinding {
  readonly version: typeof WSL_TRANSPORT_VERSION
  readonly endpoint: string
  readonly token: string
  readonly pid: number
}

/** One Fetch envelope the loopback transport accepts. */
interface WslFetchEnvelope {
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly bodyBase64?: string
}

/** One answer the loopback transport returns. */
interface WslFetchAnswer {
  readonly status: number
  readonly headers: readonly [string, string][]
  readonly bodyBase64: string | null
}

/** Why a WSL Host launch failed, in a form the shell presents to the user. */
export type WslHostFailureKind =
  | 'launch-failed'
  | 'handshake-timeout'
  | 'version-mismatch'
  | 'unauthenticated'
  | 'transport-closed'

/** A WSL Host failure naming the stage that failed. */
export class WslHostError extends Error {
  /** @param kind - failing stage. @param message - operator-facing detail. @param options - optional cause. */
  constructor(
    readonly kind: WslHostFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WslHostError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether one promise settles within a deadline, without rejecting on error.
 * @param promise - settlement to observe.
 * @param milliseconds - maximum wait.
 * @returns true when the promise settled first.
 */
async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, milliseconds); timer.unref() }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Validate a binding read from the Linux Host.
 * @param value - parsed binding file contents.
 * @returns the validated binding.
 * @throws when the binding is unusable or comes from another version.
 */
export function parseWslBinding(value: unknown): WslTransportBinding {
  if (!isRecord(value) || typeof value.endpoint !== 'string' || typeof value.token !== 'string'
    || typeof value.pid !== 'number' || value.version !== WSL_TRANSPORT_VERSION) {
    const version = isRecord(value) ? value.version : undefined
    if (typeof version === 'number' && version !== WSL_TRANSPORT_VERSION) {
      throw new WslHostError(
        'version-mismatch',
        `dsh desktop: the WSL Host speaks transport version ${String(version)}, this shell speaks ${String(WSL_TRANSPORT_VERSION)}`,
      )
    }
    throw new WslHostError('handshake-timeout', 'dsh desktop: the WSL Host published an invalid binding')
  }
  const endpoint = new URL(value.endpoint)
  if (endpoint.protocol !== 'http:' || (endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost')) {
    throw new WslHostError('unauthenticated', `dsh desktop: the WSL Host endpoint ${JSON.stringify(value.endpoint)} is not loopback`)
  }
  return { version: WSL_TRANSPORT_VERSION, endpoint: value.endpoint, token: value.token, pid: value.pid }
}

/** Read one binding file, or undefined while it is absent or partial. */
export function readWslBinding(filename: string): WslTransportBinding | undefined {
  if (!existsSync(filename)) return undefined
  try {
    return parseWslBinding(JSON.parse(readFileSync(filename, 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof WslHostError && error.kind === 'version-mismatch') throw error
    // A half-written or malformed file is retried: the writer publishes
    // through a rename, so its presence with bad content means another writer
    // is mid-replace, not that the launch failed.
    return undefined
  }
}

/**
 * One Linux DSH Host reachable over the loopback transport.
 *
 * The connection is long-lived: it is established once per Desktop launch and
 * serves every request until the shell stops it.
 */
export class WslDesktopHost {
  private child: ChildProcess | undefined
  private exitPromise: Promise<void> | undefined
  private binding: WslTransportBinding | undefined
  private nextStreamId = 1
  private readonly pending = new Map<number, AbortController>()
  private closing: Promise<void> | undefined

  /**
   * @param invocation - complete `wsl.exe` argv, beginning with the executable.
   * @param bindingFile - path the Linux Host writes its endpoint and token to.
   * @param environment - environment for the launcher child.
   * @param internals - injectable process and filesystem operations.
   * @param onFailure - receives the first fatal transport failure.
   */
  constructor(
    private readonly invocation: readonly string[],
    private readonly bindingFile: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly internals: WslHostInternals = {},
    private readonly onFailure?: (error: Error) => void,
  ) {}

  /** The launch token, available only after a successful start. */
  get token(): string | undefined {
    return this.binding?.token
  }

  /** The Linux Host process id, for diagnostics. */
  get hostPid(): number | undefined {
    return this.binding?.pid
  }

  /**
   * Start the Linux Host and complete the version handshake.
   * @returns the validated binding.
   * @throws {WslHostError} when the launch, handshake, or version check fails.
   */
  async start(): Promise<WslTransportBinding> {
    if (this.binding !== undefined) return this.binding
    const [command, ...args] = this.invocation
    if (command === undefined) throw new WslHostError('launch-failed', 'dsh desktop: the WSL invocation is empty')
    const child = (this.internals.spawn ?? spawn)(command, args, {
      env: this.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The launcher is a background child: hiding it keeps it from opening a
      // console over the shell, exactly as the byte-pipe Host does.
      windowsHide: true,
    })
    this.child = child
    // The exit promise is created once, here: `close` fires at most once, and
    // both the handshake and stop() need to observe that same settlement.
    this.exitPromise = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
    child.once('error', (error) => { this.fail(new WslHostError('launch-failed', error.message, { cause: error })) })
    child.once('close', (code) => {
      this.fail(new WslHostError('transport-closed', `dsh desktop: the WSL Host stopped with ${String(code ?? 'no status')}`))
    })
    const binding = await this.awaitBinding(child)
    // A published binding does not prove the endpoint is reachable yet: WSL2
    // relays Windows loopback connections into the distribution, and that
    // relay lags the distribution's own bind by up to about a second. Without
    // this wait the first request after every launch fails with ECONNREFUSED.
    await this.awaitReachable(binding)
    this.binding = binding
    return binding
  }

  /** Return the official Web profile's authenticated URL and boot injections. */
  async ready(): Promise<{ readonly url: string; readonly injections: readonly unknown[] }> {
    const ready = await this.control('/ready')
    if (!isRecord(ready) || typeof ready.url !== 'string' || !Array.isArray(ready.injections)) {
      throw new WslHostError('transport-closed', 'the WSL Host did not publish Web readiness')
    }
    const url = new URL(ready.url)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new WslHostError('unauthenticated', 'the WSL Web endpoint is not loopback')
    }
    return { url: ready.url, injections: ready.injections }
  }

  /** Inspect or lock task admission before a Desktop update. */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const result = await this.control(`/update-tasks?action=${action}`)
    if (!isRecord(result) || typeof result.active !== 'boolean') throw new Error('desktop WSL: invalid task control response')
    return result.active
  }

  /** Inspect tasks and reminders through the authenticated Linux Host transport. */
  async inspectQuit(): Promise<{ activeTasks: boolean; scheduledTasks: boolean }> {
    const result = await this.control('/quit-inspection')
    if (!isRecord(result) || typeof result.activeTasks !== 'boolean' || typeof result.scheduledTasks !== 'boolean') {
      throw new Error('desktop WSL: invalid quit inspection response')
    }
    return { activeTasks: result.activeTasks, scheduledTasks: result.scheduledTasks }
  }

  private async control(path: string): Promise<unknown> {
    const binding = this.binding ?? await this.start()
    const response = await fetch(new URL(path, binding.endpoint), {
      method: 'POST', headers: { authorization: `Bearer ${binding.token}` }, signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new WslHostError('transport-closed', `desktop WSL control failed: HTTP ${String(response.status)}`)
    return response.json()
  }

  /**
   * Wait until the published endpoint accepts a connection from this side.
   *
   * Any HTTP answer proves reachability, including the unauthorized answer the
   * probe itself receives: the question is whether the connection completes,
   * not whether the request is authorized. Only a transport-level connection
   * failure is retried.
   */
  private async awaitReachable(binding: WslTransportBinding): Promise<void> {
    const delay = this.internals.delay
      ?? ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) }))
    const deadline = Date.now() + (this.internals.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    const exited = this.exitPromise ?? Promise.resolve()
    let lastError: unknown
    for (;;) {
      try {
        // Deliberately unauthorized: the Host answers 403, which completes the
        // round trip without performing any work.
        await fetch(binding.endpoint, { method: 'POST', body: '', signal: AbortSignal.timeout(5_000) })
        return
      } catch (error) {
        lastError = error
      }
      if (Date.now() >= deadline) {
        throw new WslHostError(
          'handshake-timeout',
          `dsh desktop: the WSL Host published ${binding.endpoint} but it did not accept a connection before the deadline`,
          { cause: lastError },
        )
      }
      await Promise.race([delay(BINDING_POLL_MS), exited])
    }
  }

  /** Wait for the Linux Host to publish a binding this shell can speak. */
  private async awaitBinding(child: ChildProcess): Promise<WslTransportBinding> {
    const read = this.internals.readBinding ?? readWslBinding
    const delay = this.internals.delay
      ?? ((milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) }))
    const deadline = Date.now() + (this.internals.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    let diagnostics = ''
    const exited = this.exitPromise ?? Promise.resolve()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { diagnostics += chunk })
    for (;;) {
      const binding = read(this.bindingFile)
      if (binding !== undefined) return binding
      if (child.exitCode !== null || child.signalCode !== null) {
        const suffix = diagnostics.trim() === '' ? '' : `: ${diagnostics.trim()}`
        throw new WslHostError('launch-failed', `dsh desktop: the WSL Host exited before publishing its binding${suffix}`)
      }
      if (Date.now() >= deadline) {
        throw new WslHostError('handshake-timeout', 'dsh desktop: the WSL Host did not publish its binding before the deadline')
      }
      // Race the poll interval against child exit, so a Host that dies during
      // the handshake is reported immediately rather than at the deadline.
      await Promise.race([delay(BINDING_POLL_MS), exited])
    }
  }

  /**
   * Forward one Fetch request over the loopback transport.
   * @param request - request the renderer issued against `dsh-app://app`.
   * @returns the Host's response, streamed back to the caller.
   */
  async fetch(request: Request): Promise<Response> {
    const binding = this.binding ?? await this.start()
    const abort = new AbortController()
    const streamId = this.nextStreamId++
    this.pending.set(streamId, abort)
    const abortListener = (): void => { abort.abort(request.signal.reason) }
    request.signal.addEventListener('abort', abortListener, { once: true })
    try {
      const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer())
      const envelope: WslFetchEnvelope = {
        url: request.url,
        method: request.method.toUpperCase(),
        headers: [...request.headers.entries()],
        ...body === undefined ? {} : { bodyBase64: body.toString('base64') },
      }
      const answer = await fetch(binding.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
        signal: abort.signal,
      })
      if (answer.status === 403) throw new WslHostError('unauthenticated', 'dsh desktop: the WSL Host rejected this shell\'s token')
      const parsed: unknown = await answer.json()
      if (!isRecord(parsed) || typeof parsed.status !== 'number' || !Array.isArray(parsed.headers)
        || !('bodyBase64' in parsed)) {
        throw new WslHostError('transport-closed', 'dsh desktop: the WSL Host returned an invalid answer')
      }
      const parsedAnswer = parsed as unknown as WslFetchAnswer
      const responseBody = typeof parsedAnswer.bodyBase64 === 'string'
        ? Buffer.from(parsedAnswer.bodyBase64, 'base64')
        : null
      return new Response(responseBody, {
        status: parsedAnswer.status,
        headers: new Headers(parsedAnswer.headers.map(header => [header[0], header[1]] as [string, string])),
      })
    } catch (error) {
      if (error instanceof WslHostError) throw error
      throw new WslHostError('transport-closed', error instanceof Error ? error.message : 'the WSL transport failed', { cause: error })
    } finally {
      this.pending.delete(streamId)
      request.signal.removeEventListener('abort', abortListener)
    }
  }

  /** Cancel one in-flight request. */
  cancel(streamId: number): void {
    this.pending.get(streamId)?.abort()
  }

  /**
   * Stop the Linux Host and await its exit.
   *
   * The child is signalled first because the Host owns its own teardown;
   * a Host that does not exit is killed so a stuck launch cannot keep the
   * shell open.
   */
  async stop(requireGraceful = false): Promise<void> {
    this.closing ??= (async () => {
      for (const controller of this.pending.values()) controller.abort()
      this.pending.clear()
      const child = this.child
      this.child = undefined
      const exited = this.exitPromise
      if (child === undefined || exited === undefined) return
      if (child.exitCode !== null || child.signalCode !== null) {
        await exited
        return
      }
      // Ask first: the Linux Host owns its own teardown, and a Host that
      // leaves the distribution cleanly must not be killed mid-cleanup.
      child.kill('SIGTERM')
      if (await settlesWithin(exited, 10_000)) {
        if (requireGraceful && child.exitCode !== 0) throw new Error('desktop WSL Host did not exit cleanly')
        return
      }
      child.kill('SIGKILL')
      if (!await settlesWithin(exited, 5_000)) throw new Error('desktop WSL Host did not exit after SIGKILL')
      if (requireGraceful) throw new Error('desktop WSL Host required forced termination')
    })()
    await this.closing
  }

  private fail(error: Error): void {
    for (const controller of this.pending.values()) controller.abort()
    this.pending.clear()
    try { this.onFailure?.(error) } catch (listenerError) {
      console.error('desktop WSL host failure listener failed', listenerError)
    }
  }
}
