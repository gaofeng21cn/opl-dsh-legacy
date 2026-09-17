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
 * - `LSEnvironment` pins `DSH_HOME` so an OPL build keeps its state separate
 *   from the default `~/.dsh` that other tools on this machine use.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import base from './electron-builder.config.mjs'

const iconPath = fileURLToPath(new URL('./opl/icon.icns', import.meta.url))
const { artifactBuildCompleted, ...rest } = base

/** Reverse-DNS identity of this product. */
const APP_ID = 'com.onepersonlab.dsh'

/** Product name shown in the Dock, the menu bar, and the installer. */
const PRODUCT_NAME = 'OPL DSH'

/** Harness home this product owns, unless the launcher already set one. */
const DSH_HOME = process.env.DSH_OPL_HOME?.trim() || join(homedir(), '.dsh-opl')

/** Notarize only when the release path asks for it. */
const NOTARIZE = process.env.DSH_OPL_NOTARIZE === '1'

export default {
  ...rest,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  artifactName: 'opl-dsh-${version}-${os}-${arch}.${ext}',
  mac: {
    ...base.mac,
    icon: iconPath,
    notarize: NOTARIZE,
    extendInfo: {
      LSEnvironment: {
        DSH_HOME,
      },
    },
  },
  publish: null,
}
