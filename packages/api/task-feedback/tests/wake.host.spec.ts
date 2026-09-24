/**
 * The wake transport's bounded process runner and its argument arrays.
 *
 * Every case runs a real child process (the Node executable under test), so the
 * argv array, the deadline, spawn failure, and cancellation are observed rather
 * than simulated. No Codex binary and no network take part.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexProbeCommand,
  codexQueueCommand,
  codexQueueWakeAdapter,
  runBounded,
  type WakeExecutionConfig,
} from '../src/wake.ts'
import type { WakeDelivery } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** The native launch config, parameterized only by the executable under test. */
function nativeConfig(executable: string): WakeExecutionConfig {
  return { execution: 'native', executable, distro: '', timeoutMs: 5_000 }
}

const delivery: WakeDelivery = { deliveryId: 'task@completed', threadId: 'thread-1', message: 'line one\nline two' }

describe('wake argument arrays', () => {
  it('builds the native queue argv with no shell quoting', () => {
    expect(codexQueueCommand(nativeConfig('/opt/codex/bin/codex'), delivery)).toEqual({
      command: '/opt/codex/bin/codex',
      args: ['queue', '--thread', 'thread-1', '--message', 'line one\nline two'],
    })
  })

  it('builds the WSL queue argv from the configured distribution and executable', () => {
    expect(codexQueueCommand({
      execution: 'wsl', executable: '/home/reviewer/.local/bin/codex', distro: 'Review-Distro', timeoutMs: 5_000,
    }, delivery)).toEqual({
      command: 'wsl',
      args: ['-d', 'Review-Distro', '--', '/home/reviewer/.local/bin/codex', 'queue', '--thread', 'thread-1', '--message', 'line one\nline two'],
    })
  })

  it('probes through the same execution entry', () => {
    expect(codexProbeCommand(nativeConfig('/opt/codex/bin/codex')).args).toEqual(['--version'])
    expect(codexProbeCommand({
      execution: 'wsl', executable: '/home/reviewer/.local/bin/codex', distro: 'Review-Distro', timeoutMs: 5_000,
    }).args).toEqual(['-d', 'Review-Distro', '--', '/home/reviewer/.local/bin/codex', '--version'])
  })
})

describe('bounded process runner', () => {
  it('reports a successful exit', async () => {
    expect(await runBounded(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5_000, signal: undefined }))
      .toEqual({ outcome: 'exited', code: 0, detail: 'exited 0' })
  })

  it('reports a non-zero exit without throwing', async () => {
    expect(await runBounded(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 5_000, signal: undefined }))
      .toEqual({ outcome: 'exited', code: 7, detail: 'exited 7' })
  })

  it('reports a process that cannot start', async () => {
    const result = await runBounded('definitely-not-an-executable-xyz', [], { timeoutMs: 5_000, signal: undefined })
    expect(result.outcome).toBe('failed')
    expect(result.detail).toContain('could not start')
  })

  it('kills a process that outlives its deadline', async () => {
    const result = await runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 50, signal: undefined })
    expect(result.outcome).toBe('timed-out')
    expect(result.detail).toContain('no exit within 50 ms')
  })

  it('kills a process when the parent signal aborts', async () => {
    const controller = new AbortController()
    const pending = runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 5_000, signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ outcome: 'cancelled', code: null, detail: 'cancelled' })
  })

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await runBounded(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5_000, signal: controller.signal }))
      .toEqual({ outcome: 'cancelled', code: null, detail: 'cancelled before start' })
  })

  it('passes an argument containing shell metacharacters as one argv entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wake-argv-'))
    roots.push(dir)
    const file = join(dir, 'argv.json')
    const hostile = '; echo PWNED'
    const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.argv))`
    const result = await runBounded(process.execPath, ['-e', script, hostile], { timeoutMs: 5_000, signal: undefined })
    expect(result.outcome).toBe('exited')
    const argv = JSON.parse(await readFile(file, 'utf8')) as string[]
    // No shell split the hostile text: it survives as exactly one argv entry.
    expect(argv.at(-1)).toBe(hostile)
  })
})

describe('codex queue adapter', () => {
  it('refuses delivery and reports not-connected when the executable cannot start', async () => {
    const adapter = codexQueueWakeAdapter(nativeConfig('definitely-not-an-executable-xyz'))
    expect(await adapter.send(delivery)).toMatchObject({ accepted: false })
    const probe = await adapter.probe()
    expect(probe.started).toBe(false)
    expect(probe.detail).toContain('could not start')
  })

  it('probes a real executable and reports only that it started', async () => {
    const adapter = codexQueueWakeAdapter(nativeConfig(process.execPath))
    // `node --version` exits 0, so the probe reports the process fact rather
    // than a configured constant — and it claims nothing about a target thread
    // or a delivery channel, which it never touched.
    const probe = await adapter.probe()
    expect(probe.started).toBe(true)
    expect(probe.detail).toContain('does not prove the target thread')
  })
})
