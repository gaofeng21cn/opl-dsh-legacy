/**
 * OPL packaging configuration for the macOS desktop build.
 *
 * This file is the downstream half of the packaging story: it overrides the
 * release identity and the settings a locally-signed build needs, and leaves
 * `electron-builder.config.mjs` (upstream) untouched so rebasing on a new
 * upstream tag stays small.
 *
 * Differences from the upstream config:
 * - Release identity is OPL's own: `OPL DSH` under `com.onepersonlab.dsh`, so a
 *   signed artifact never claims to be an official DeepSeek Harness release.
 * - Notarization is opt-in (`DSH_OPL_NOTARIZE=1` with an
 *   `APPLE_KEYCHAIN_PROFILE`): a local build is installed directly and is never
 *   quarantined, while a distributed build must be notarized.
 * - `LSEnvironment` pins `DSH_HOME` to the portable `~/.dsh-opl`: the harness
 *   expands `~` for the signed-in user at startup, so the bundle keeps its
 *   state separate from the default `~/.dsh` without carrying the build
 *   machine's home directory. `DSH_OPL_HOME` overrides the default, but only
 *   with a portable path.
 * - `afterPack` rejects a bundle that kept an absolute home or dropped the OPL
 *   Gateway plugin halves, so a packaging regression fails the build instead
 *   of reaching a download page.
 */

import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import base from './electron-builder.config.mjs'
import { verifyOplAppBundle, verifyOplDiskImage } from './opl/verify-opl-package.mjs'

const iconPath = fileURLToPath(new URL('./opl/icon.icns', import.meta.url))
const baseConfig = base

/** Reverse-DNS identity of this product. */
const APP_ID = 'com.onepersonlab.dsh'

/** Product name shown in the Dock, the menu bar, and the installer. */
const PRODUCT_NAME = 'OPL DSH'

/** Harness home this product owns, as a path the installed app expands for its user. */
const CONFIGURED_HOME = process.env.DSH_OPL_HOME?.trim()
const DSH_HOME = CONFIGURED_HOME === undefined || CONFIGURED_HOME === '' ? '~/.dsh-opl' : CONFIGURED_HOME

if (isAbsolute(DSH_HOME)) {
  throw new Error(`packaging: DSH_OPL_HOME must stay portable (received ${DSH_HOME}; use a path such as ~/.dsh-opl)`)
}

/** Notarize only when the release path asks for it. */
const NOTARIZE = process.env.DSH_OPL_NOTARIZE === '1'

/** `notarytool` keychain profile recorded once by `notarytool store-credentials`. */
const KEYCHAIN_PROFILE = process.env.APPLE_KEYCHAIN_PROFILE?.trim()

if (NOTARIZE && (KEYCHAIN_PROFILE === undefined || KEYCHAIN_PROFILE === '')) {
  throw new Error('packaging: DSH_OPL_NOTARIZE=1 requires APPLE_KEYCHAIN_PROFILE')
}

export default {
  ...baseConfig,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  artifactName: 'opl-dsh-${version}-${os}-${arch}.${ext}',
  mac: {
    ...baseConfig.mac,
    icon: iconPath,
    // Notarization runs through the disk-image hook below rather than through
    // electron-builder's own flag: that flag takes only a boolean and reads
    // Apple credentials from the environment, while the hook goes through
    // `@electron/notarize`, which accepts this machine's `notarytool` keychain
    // profile. Submitting the disk image also notarizes the application inside
    // it, so one submission covers the download and the bundle it carries.
    notarize: false,
    extendInfo: {
      LSEnvironment: {
        DSH_HOME,
      },
    },
  },
  afterPack: context => {
    if (context.electronPlatformName !== 'darwin') return
    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const verified = verifyOplAppBundle(appPath, { expectedDshHome: DSH_HOME })
    process.stdout.write(`OPL packaging: verified ${appPath} (DSH_HOME=${verified.dshHome}, ${verified.packages.length} gateway packages)\n`)
  },
  // Staple the ticket to the disk image when the release path asks for it, then
  // verify the exact bytes a user downloads either way.
  artifactBuildCompleted: async artifact => {
    if (NOTARIZE) await baseConfig.artifactBuildCompleted(artifact)
    if (!artifact.file.endsWith('.dmg')) return
    const verified = verifyOplDiskImage(artifact.file, { expectedDshHome: DSH_HOME })
    process.stdout.write(`OPL packaging: verified ${artifact.file} (DSH_HOME=${verified.dshHome}, ${verified.packages.length} gateway packages)\n`)
  },
  publish: null,
}
