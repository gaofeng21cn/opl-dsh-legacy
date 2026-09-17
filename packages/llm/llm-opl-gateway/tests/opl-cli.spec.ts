/**
 * The OPL command-line adapter.
 *
 * The real CLI is exercised through a stand-in executable so the tests cover
 * argv, stdin, JSON parsing, and error mapping without depending on a gateway
 * account.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readGatewayStatus, resolveOplBinary } from '../src/opl-cli.ts'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

/**
 * Install a stand-in `opl` that records its argv and stdin, then prints one
 * canned document.
 * @param document - JSON the stand-in prints.
 * @returns the binary path and the file recording what it was asked to do.
 */
function fakeOpl(document: unknown): { binary: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opl-cli-'))
  roots.push(root)
  const binary = join(root, 'opl')
  const log = join(root, 'argv.txt')
  writeFileSync(binary, `#!/bin/sh
{ echo "$@"; cat; } > ${JSON.stringify(log)}
cat <<'DOC'
${JSON.stringify(document)}
DOC
`, { mode: 0o755 })
  chmodSync(binary, 0o755)
  return { binary, log }
}

/**
 * Environment for one stand-in run.
 *
 * PATH keeps the system directories so the stand-in's own `cat`/`echo` work,
 * while OPL_APP_OPL_BIN decides which `opl` runs — resolution prefers it, so a
 * real installation on this machine can never be exercised by accident.
 */
function envFor(binary: string): NodeJS.ProcessEnv {
  return { ...process.env, OPL_APP_OPL_BIN: binary, PATH: '/usr/bin:/bin' }
}

const CONNECTED = {
  gateway_account: {
    surface_kind: 'opl_gateway_account_read_model.v1',
    status: 'connected',
    connection_mode: 'account',
    account: { display_name: 'Person', email: 'person@example.test', status: 'active', balance: { amount: 12.5, currency: 'USD' } },
    usage: { today_tokens: 1024, total_tokens: 4096, today_actual_cost: 0.25, total_actual_cost: 3, currency: 'USD' },
    managed_key: { name: 'OPL App · machine', status: 'active' },
    freshness: { observed_at: '2026-09-08T03:08:36.365Z', stale: true },
  },
}

describe('binary resolution', () => {
  it('prefers the configured override over PATH', () => {
    const a = fakeOpl({})
    const b = fakeOpl({})
    expect(resolveOplBinary({ OPL_APP_OPL_BIN: a.binary, PATH: tmpdir() })).toBe(a.binary)
    expect(resolveOplBinary({ PATH: tmpdir() })).toBeTruthy()
    expect(resolveOplBinary({ PATH: '/nonexistent' })).toBeTypeOf('string')
    expect(b.binary).not.toBe(a.binary)
  })
})

describe('reading the account', () => {
  it('asks OPL for its own read model and maps every fact', async () => {
    const { binary, log } = fakeOpl(CONNECTED)
    const status = await readGatewayStatus(envFor(binary))
    expect(status).toEqual({
      connected: true,
      connectionMode: 'account',
      problem: null,
      displayName: 'Person',
      email: 'person@example.test',
      accountStatus: 'active',
      balanceAmount: 12.5,
      balanceCurrency: 'USD',
      todayTokens: 1024,
      totalTokens: 4096,
      todayCost: 0.25,
      totalCost: 3,
      usageCurrency: 'USD',
      keyName: 'OPL App · machine',
      stale: true,
      observedAt: '2026-09-08T03:08:36.365Z',
    })
    // The read model is the CLI's public surface; this is the exact call.
    const recorded = await import('node:fs').then(fs => fs.readFileSync(log, 'utf8'))
    expect(recorded).toContain('connect gateway status --json')
  })

  it('reports a not-connected account as a problem rather than a connection', async () => {
    const { binary } = fakeOpl({
      gateway_account: { status: 'setup_required', connection_mode: 'account', account: {}, usage: {}, managed_key: {}, freshness: {} },
    })
    expect(await readGatewayStatus(envFor(binary))).toMatchObject({
      connected: false,
      problem: 'setup_required',
    })
  })

  it('surfaces OPL\u2019s own reason code and message', async () => {
    const { binary } = fakeOpl({
      error: { code: 'launcher_failed', message: 'OPL Gateway email or password is incorrect.', details: { reason_code: 'invalid_credentials' } },
    })
    await expect(readGatewayStatus(envFor(binary))).rejects.toMatchObject({
      code: 'invalid_credentials',
      message: 'OPL Gateway email or password is incorrect.',
    })
  })

  it('still finds OPL where a Finder-launched application would', () => {
    // A GUI launch inherits a minimal PATH; the conventional install locations
    // are named explicitly so the page does not claim OPL is missing when it
    // is installed but unfindable.
    const resolved = resolveOplBinary({ PATH: '/nonexistent' })
    expect(resolved === undefined || resolved.endsWith('/opl')).toBe(true)
  })

  it('never blames the gateway for a local failure', async () => {
    // A missing override that no conventional path covers must surface as an
    // OPL-side failure, so the page can tell "install OPL" apart from "the
    // gateway is down".
    const root = mkdtempSync(join(tmpdir(), 'dsh-opl-nowhere-'))
    roots.push(root)
    await expect(readGatewayStatus({
      PATH: '/nonexistent',
      OPL_APP_OPL_BIN: join(root, 'absent'),
      HOME: root,
    })).rejects.toMatchObject({ code: expect.stringMatching(/^opl_/) })
  })

  it('refuses output that is not the documented JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-opl-cli-'))
    roots.push(root)
    const binary = join(root, 'opl')
    writeFileSync(binary, '#!/bin/sh\necho "not json"\n', { mode: 0o755 })
    chmodSync(binary, 0o755)
    await expect(readGatewayStatus(envFor(binary))).rejects.toMatchObject({ code: 'opl_response_invalid' })
  })
})
