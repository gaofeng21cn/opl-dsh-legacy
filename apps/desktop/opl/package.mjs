/** Build the OPL distribution with local signing and GitHub-managed updates. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { packageTarget, parseDesktopPackageInvocation } from '../scripts/package-target.ts'
import { desktopBuildCommitEnvironment, readDesktopBuildCommit } from '../scripts/desktop-build-commit.mjs'
import { resolveMacOSSigningEnvironment, resolveMacOSNotarizationEnvironment, resolveNpmRegistry } from '../scripts/desktop-release-environment.mjs'
import { requireDesktopToolchain } from '../scripts/desktop-toolchain-preflight.ts'
import { createPackagingRun } from '../scripts/packaging-run.mjs'
import { packagingErrorDetails } from '../scripts/packaging-step.mjs'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const invocation = parseDesktopPackageInvocation([
  ...process.argv.slice(2), '--config', 'electron-builder.opl.mjs',
])
if (invocation.requestedBuildVersion !== undefined) throw new Error('OPL packages use the committed package version')
const environment = { ...process.env, DSH_DESKTOP_APP_ID: 'com.onepersonlab.dsh' }
resolveNpmRegistry(environment)
if (invocation.target.platform === 'darwin') {
  resolveMacOSSigningEnvironment(environment)
  resolveMacOSNotarizationEnvironment(environment)
  environment.DSH_OPL_NOTARIZE = '1'
} else if (!invocation.unsigned) {
  throw new Error('OPL Windows releases currently require --unsigned')
}
await requireDesktopToolchain(invocation.target.platform, environment)
if (invocation.check) {
  console.log('OPL packaging configuration and toolchain are valid; signing was not attempted')
} else {
  const packaged = readDesktopBuildCommit(repoRoot)
  if (packaged.dirty) throw new Error('Commit OPL release inputs before packaging')
  Object.assign(environment, desktopBuildCommitEnvironment(packaged))
  const version = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).version
  const secrets = Object.entries(environment).filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD|APPLE_ID/iu.test(key))
    .map(([, value]) => value ?? '')
  const run = createPackagingRun(join(appRoot, '.desktop-build', 'packaging-runs'), {
    target: invocation.target.name, version, productVersion: version, ...packaged,
    unsigned: invocation.unsigned, directory: invocation.directory, prepareOnly: invocation.prepareOnly,
  }, { parallel: invocation.target.platform === 'darwin', secrets })
  process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = run.directory
  environment.DSH_DESKTOP_PACKAGING_RUN_DIR = run.directory
  let success = false
  try {
    await packageTarget(invocation, environment, run)
    success = true
  } catch (error) {
    console.error(packagingErrorDetails(error, secrets))
    process.exitCode = 1
  } finally {
    run.finish(success)
    console.log(`OPL packaging record: ${run.directory}`)
  }
}
