/** Scoped OPL signing through an existing macOS keychain; private keys never leave it. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withMacOSSigningKeychain } from '../scripts/macos-signing-keychain.mjs'
import { verifyMacOSRuntimeCode } from '../scripts/verify-macos-signature.mjs'
import { resolveMacOSSigningEnvironment } from '../scripts/desktop-release-environment.mjs'

/**
 * Validate existing-keychain signing before packaging, or use the standard P12 route.
 * @param {NodeJS.ProcessEnv} environment Release environment.
 * @param {(environment: NodeJS.ProcessEnv) => Promise<void>} action Packaging work.
 * @returns {Promise<void>} Resolves after packaging and probe cleanup.
 */
export async function withOplSigningKeychain(environment, action) {
  if (environment.CSC_LINK) return withMacOSSigningKeychain(environment, action)
  const keychain = environment.CSC_KEYCHAIN?.trim()
    || execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' }).trim().replace(/^"|"$/gu, '')
  const expected = resolveMacOSSigningEnvironment(environment)
  const directory = mkdtempSync(join(tmpdir(), 'opl-dsh-signing-'))
  const probe = join(directory, 'probe')
  try {
    execFileSync('/bin/cp', ['/usr/bin/true', probe])
    execFileSync('/usr/bin/codesign', ['--force', '--sign', `Developer ID Application: ${expected.signingIdentity}`, '--keychain', keychain, '--timestamp', '--options', 'runtime', probe], { stdio: 'pipe', timeout: 120_000 })
    verifyMacOSRuntimeCode(probe, expected)
    await action({ ...environment, CSC_KEYCHAIN: keychain, DSH_DESKTOP_MACOS_SIGNING_PROBE: probe })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
