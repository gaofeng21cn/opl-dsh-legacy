/**
 * OPL packaging configuration for the macOS and Windows desktop builds.
 *
 * This file is the downstream half of the packaging story: it overrides the
 * release identity and the settings a locally-signed build needs, and leaves
 * `electron-builder.config.mjs` (upstream) untouched so rebasing on a new
 * upstream tag stays small. The upstream configuration already owns the
 * per-platform mechanics — the NSIS include script, the Windows signing hook,
 * and the `win-x64` target — so this file only supplies OPL's identity, its
 * icons, and its artifact names on top of them.
 *
 * Differences from the upstream config:
 * - Release identity is OPL's own: `OPL DSH` under `com.onepersonlab.dsh`, so a
 *   signed artifact never claims to be an official DeepSeek Harness release.
 * - `DSH_OPL_HOME` is the portable home the macOS bundle pins with
 *   `LSEnvironment`. Windows has no launch-environment mechanism, so the same
 *   product home is resolved at runtime instead of at packaging time; see
 *   `src/dsh-home.ts`. The portable-path requirement therefore applies to the
 *   macOS bundle only.
 * - Notarization is opt-in (`DSH_OPL_NOTARIZE=1` with an
 *   `APPLE_KEYCHAIN_PROFILE`): a local build is installed directly and is never
 *   quarantined, while a distributed build must be notarized.
 * - Windows ships an NSIS installer and a portable executable. A Windows build
 *   without a code-signing certificate must be requested with
 *   `DSH_DESKTOP_UNSIGNED=1`; the upstream configuration refuses to emit an
 *   unsigned artifact otherwise, and this file does not weaken that rule.
 * - `afterPack` rejects a bundle that kept an absolute home or dropped the OPL
 *   Gateway plugin halves, so a packaging regression fails the build instead
 *   of reaching a download page.
 */

import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'
import {
  verifyOplAppBundle,
  verifyOplDiskImage,
  verifyOplWindowsApplication,
  verifyOplWindowsInstaller,
} from './opl/verify-opl-package.mjs'

const macIconPath = fileURLToPath(new URL('./opl/icon.icns', import.meta.url))
const windowsIconPath = fileURLToPath(new URL('./opl/icon.ico', import.meta.url))
const baseConfig = createElectronBuilderConfig(
  process.env, process.platform, process.arch, undefined, undefined, true,
)

/** Reverse-DNS identity of this product. */
const APP_ID = 'com.onepersonlab.dsh'

/** Product name shown in the Dock, the menu bar, and the installer. */
const PRODUCT_NAME = 'OPL DSH'

/**
 * Platform this invocation is packaging. Our own wrapper scripts set the target
 * platform explicitly; a direct `electron-builder --mac`/`--win` run falls back
 * to the build host, which is what electron-builder itself assumes.
 */
const TARGET_PLATFORM = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform

/** Harness home this product owns, as a path the installed macOS app expands for its user. */
const CONFIGURED_HOME = process.env.DSH_OPL_HOME?.trim()
const MACOS_DSH_HOME = CONFIGURED_HOME === undefined || CONFIGURED_HOME === '' ? '~/.dsh-opl' : CONFIGURED_HOME

// The macOS bundle can only carry a portable home: `LSEnvironment` is expanded
// by the launcher, so an absolute path would bake the build machine's user name
// into every download. The same variable is an ordinary runtime override on
// Windows, where an absolute path is legitimate.
if (TARGET_PLATFORM === 'darwin' && isAbsolute(MACOS_DSH_HOME)) {
  throw new Error(`packaging: DSH_OPL_HOME must stay portable (received ${MACOS_DSH_HOME}; use a path such as ~/.dsh-opl)`)
}

/** Notarize only when the release path asks for it. */
const NOTARIZE = process.env.DSH_OPL_NOTARIZE === '1'

/** `notarytool` keychain profile recorded once by `notarytool store-credentials`. */
const KEYCHAIN_PROFILE = process.env.APPLE_KEYCHAIN_PROFILE?.trim()

if (NOTARIZE && (KEYCHAIN_PROFILE === undefined || KEYCHAIN_PROFILE === '')) {
  throw new Error('packaging: DSH_OPL_NOTARIZE=1 requires APPLE_KEYCHAIN_PROFILE')
}

/**
 * Name one artifact with the version, the target OS, and the architecture.
 *
 * `${os}` is electron-builder's own placeholder and expands to `mac`, `win`, or
 * `linux`, so the Windows installer reads
 * `opl-dsh-<version>-win-x64-setup.exe`.
 */
const ARTIFACT_NAME = 'opl-dsh-${version}-${os}-${arch}.${ext}'

export default {
  ...baseConfig,
  appId: APP_ID,
  productName: PRODUCT_NAME,
  artifactName: ARTIFACT_NAME,
  // The base configuration recorded the release identity it was evaluated with,
  // which is not this product's; the shell publishes whichever identity the
  // packaged manifest names.
  extraMetadata: { ...baseConfig.extraMetadata, dshDesktopAppId: APP_ID, dshAppId: APP_ID },
  extraResources: [...baseConfig.extraResources, { from: 'opl/opl-dsh-control.mjs', to: 'control/opl-dsh-control.mjs' }],
  extraFiles: [{ from: 'opl/opl-dsh-control.cmd', to: 'opl-dsh-control.cmd' }],
  mac: {
    ...baseConfig.mac,
    icon: macIconPath,
    // Notarization runs through the disk-image hook below rather than through
    // electron-builder's own flag: that flag takes only a boolean and reads
    // Apple credentials from the environment, while the hook goes through
    // `@electron/notarize`, which accepts this machine's `notarytool` keychain
    // profile. Submitting the disk image also notarizes the application inside
    // it, so one submission covers the download and the bundle it carries.
    notarize: false,
    extendInfo: {
      ...baseConfig.mac.extendInfo,
      LSEnvironment: {
        DSH_HOME: MACOS_DSH_HOME,
      },
    },
  },
  win: {
    ...baseConfig.win,
    icon: windowsIconPath,
    // `nsis` is the installable release; `portable` is the single-file build a
    // reviewer can run without touching the registry. A `--dir` package adds the
    // unpacked tree for scripted checks on top of these.
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
  nsis: {
    ...baseConfig.nsis,
    artifactName: 'opl-dsh-${version}-${os}-${arch}-setup.${ext}',
    shortcutName: PRODUCT_NAME,
    // A per-user installation needs no administrator prompt, which matters most
    // for the unsigned build a reviewer installs by hand.
    perMachine: false,
    // Sessions, settings, and credentials live under the user-data directory.
    // Uninstalling must not destroy them, so reinstalling keeps the account.
    deleteAppDataOnUninstall: false,
  },
  portable: {
    artifactName: 'opl-dsh-${version}-${os}-${arch}-portable.${ext}',
  },
  afterPack: async context => {
    await baseConfig.afterPack?.(context)
    if (context.electronPlatformName === 'darwin') {
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      const verified = verifyOplAppBundle(appPath, { expectedDshHome: MACOS_DSH_HOME })
      process.stdout.write(`OPL packaging: verified ${appPath} (DSH_HOME=${verified.dshHome}, ${verified.packages.length} gateway packages)\n`)
      return
    }
    if (context.electronPlatformName === 'win32') {
      const verified = verifyOplWindowsApplication(context.appOutDir)
      process.stdout.write(`OPL packaging: verified ${context.appOutDir} (home=${verified.home}, ${verified.packages.length} gateway packages)\n`)
    }
  },
  // Staple the ticket to the disk image when the release path asks for it, then
  // verify the exact bytes a user downloads either way.
  artifactBuildCompleted: async artifact => {
    if (NOTARIZE && artifact.file.endsWith('.dmg')) await baseConfig.artifactBuildCompleted(artifact)
    if (artifact.file.endsWith('.dmg')) {
      const verified = verifyOplDiskImage(artifact.file, { expectedDshHome: MACOS_DSH_HOME })
      process.stdout.write(`OPL packaging: verified ${artifact.file} (DSH_HOME=${verified.dshHome}, ${verified.packages.length} gateway packages)\n`)
      return
    }
    // The unpacked application was already inspected in `afterPack`; this checks
    // the bytes actually shipped — a valid executable whose name still carries
    // the version and the target architecture.
    if (artifact.file.endsWith('.exe')) {
      const verified = verifyOplWindowsInstaller(artifact.file)
      process.stdout.write(`OPL packaging: verified ${artifact.file} (${verified.kind}, ${String(verified.bytes)} bytes)\n`)
    }
  },
  publish: null,
}
