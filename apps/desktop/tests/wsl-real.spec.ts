/**
 * Real WSL2 transport smoke.
 *
 * This is the only test that exercises the WSL2 launch shape against an actual
 * distribution: `wsl.exe` starts a Linux Node process, the process publishes
 * its binding across the filesystem boundary, and the Windows side completes
 * the version handshake and fetches over the authenticated loopback
 * connection. Everything else about the transport is covered by injected
 * doubles in `wsl-transport.spec.ts`; the facts proven only here are that
 * `wsl.exe --exec` accepts the resolved invocation, that a Linux process can
 * publish a binding this side can read, and that Windows reaches a port the
 * distribution bound on its own loopback interface.
 *
 * The test self-skips whenever the machine cannot support it, so it never
 * stands in for a failure: no Windows, no `wsl.exe`, no installed distribution,
 * or no usable Linux Node all skip. The Linux process it starts is a
 * {@link LINUX_HOST_STUB} rather than the real Host, because the installed
 * dsh runtime for Linux is a packaging artifact this repository checkout does
 * not carry; the transport protocol it speaks is the shipped one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WslDesktopHost, WSL_TRANSPORT_VERSION } from '../src/wsl-host.ts'
import { listWslDistributions, probeWslDistribution, type WslDistribution } from '../src/wsl.ts'

/** The Linux-side Host stub: answers one authenticated `/fetch` per request. */
const LINUX_HOST_STUB = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
const [bindingFile, token] = process.argv.slice(2)
const server = createServer((request, response) => {
  if ((request.headers.authorization ?? '') !== 'Bearer ' + token) {
    response.writeHead(403); response.end('{"error":"unauthorized"}'); return
  }
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    const envelope = JSON.parse(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      status: 200,
      headers: [['content-type', 'application/json']],
      bodyBase64: Buffer.from(JSON.stringify({ host: 'linux', url: envelope.url, method: envelope.method })).toString('base64'),
    }))
  })
})
server.listen(0, '127.0.0.1', () => {
  writeFileSync(bindingFile, JSON.stringify({
    version: 1, endpoint: 'http://127.0.0.1:' + server.address().port + '/fetch', token, pid: process.pid,
  }) + '\\n')
})
`

/** One WSL invocation available on this machine, or the reason there is none. */
interface WslSmokeTarget {
  readonly distro: WslDistribution
  /** Absolute Linux path of the Node.js executable inside the distribution. */
  readonly node: string
}

/** Run one `wsl.exe` command inside a distribution and return its trimmed stdout. */
function wsl(args: readonly string[]): string {
  return execFileSync('wsl.exe', [...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
}

/**
 * Probe this machine for a usable WSL2 distribution and Linux Node.
 * @returns the target, or undefined when the machine cannot run the smoke.
 */
async function wslSmokeTarget(): Promise<WslSmokeTarget | undefined> {
  if (process.platform !== 'win32') return undefined
  let distributions: readonly WslDistribution[]
  try {
    distributions = await listWslDistributions()
  } catch {
    return undefined
  }
  for (const distro of distributions.filter(entry => entry.version === 2)) {
    const probe = await probeWslDistribution(distro.name)
    if (probe.problem !== undefined) continue
    try {
      // `--exec` does not load the login shell's PATH, so the absolute
      // interpreter path is resolved once here and passed explicitly, exactly
      // as the shipped Host invocation does.
      const node = wsl(['--distribution', distro.name, '--exec', 'sh', '-lc', 'command -v node'])
      if (node.startsWith('/')) return { distro, node }
    } catch {
      continue
    }
  }
  return undefined
}

const target = await wslSmokeTarget()

describe.skipIf(target === undefined)('real WSL2 transport', () => {
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('launches a Linux Host, reads its binding, and fetches over the loopback connection', async () => {
    const chosen = target as WslSmokeTarget
    const root = mkdtempSync(join(tmpdir(), 'desktop-wsl-real-'))
    roots.push(root)
    const script = join(root, 'host-stub.mjs')
    writeFileSync(script, LINUX_HOST_STUB)
    const bindingFile = join(root, 'binding.json')
    const token = 'real-wsl-smoke-token'
    // The distribution reaches Windows paths through /mnt/<drive>.
    const linux = (windowsPath: string): string =>
      `/mnt/${windowsPath.slice(0, 1).toLowerCase()}${windowsPath.slice(2).replaceAll('\\', '/')}`

    const host = new WslDesktopHost([
      'wsl.exe', '--distribution', chosen.distro.name, '--exec',
      chosen.node, linux(script), linux(bindingFile), token,
    ], bindingFile, {}, { readyTimeoutMs: 60_000 })
    try {
      const binding = await host.start()
      expect(binding.version).toBe(WSL_TRANSPORT_VERSION)
      // A Linux pid proves the binding came from inside the distribution.
      expect(binding.pid).toBeGreaterThan(0)

      const response = await host.fetch(new Request('dsh-app://app/api/sessions'))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ host: 'linux', url: 'dsh-app://app/api/sessions', method: 'GET' })
    } finally {
      await host.stop()
    }
  }, 120_000)

  it('refuses a forged token against the real Linux Host', async () => {
    const chosen = target as WslSmokeTarget
    const root = mkdtempSync(join(tmpdir(), 'desktop-wsl-real-token-'))
    roots.push(root)
    const script = join(root, 'host-stub.mjs')
    writeFileSync(script, LINUX_HOST_STUB)
    const bindingFile = join(root, 'binding.json')
    const linux = (windowsPath: string): string =>
      `/mnt/${windowsPath.slice(0, 1).toLowerCase()}${windowsPath.slice(2).replaceAll('\\', '/')}`

    const host = new WslDesktopHost([
      'wsl.exe', '--distribution', chosen.distro.name, '--exec',
      chosen.node, linux(script), linux(bindingFile), 'the-real-token',
    ], bindingFile, {}, {
      readBinding: (filename) => {
        // Present the real endpoint with a token the Linux Host never issued.
        try {
          const published: unknown = JSON.parse(readFileSync(filename, 'utf8'))
          return { ...(published as object), token: 'forged' } as never
        } catch {
          return undefined
        }
      },
      readyTimeoutMs: 60_000,
    })
    try {
      await expect(host.fetch(new Request('dsh-app://app/api/x'))).rejects.toMatchObject({ kind: 'unauthenticated' })
    } finally {
      await host.stop()
    }
  }, 120_000)
})
