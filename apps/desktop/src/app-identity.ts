/**
 * The Windows AppUserModelID this application must publish for its own toast
 * notifications.
 *
 * Windows attributes a toast to an application through an AppUserModelID, and
 * the NSIS installer registers that identity on the Start Menu and desktop
 * shortcuts it creates from electron-builder's `appId`. The running
 * application therefore has to use the same value, which packaging injects into
 * the packaged manifest as `dshAppId` through `extraMetadata`. An explicit
 * `DSH_DESKTOP_APP_ID` wins so an unpackaged development run can name an
 * identity it controls; without either, the shell leaves the platform's
 * implicit identity alone rather than inventing one.
 *
 * @module dsh-desktop/app-identity
 */

/** Manifest field electron-builder fills with the packaged build's `appId`. */
export const DESKTOP_APP_ID_FIELD = 'dshAppId'

/** Longest accepted identity, in code units. */
const APP_ID_LENGTH = 128

/** Reverse-DNS spelling of an application identity. */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

/**
 * Read the packaged identity out of an application manifest.
 * @param manifest - parsed `package.json` content, or undefined when absent.
 * @returns the identity, or undefined when the manifest carries none.
 */
export function parseDesktopAppId(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const fields = manifest as Record<string, unknown>
  const value = fields.dshDesktopAppId ?? fields[DESKTOP_APP_ID_FIELD]
  if (typeof value !== 'string' || value === '' || value.length > APP_ID_LENGTH) return undefined
  return APP_ID_PATTERN.test(value) ? value : undefined
}

/**
 * Resolve the identity this process must publish.
 * @param options - packaged state, process environment, and parsed manifest.
 * @returns the identity, or undefined when neither source names a usable one.
 */
export function resolveDesktopAppId(options: {
  readonly packaged: boolean
  readonly environment: NodeJS.ProcessEnv
  readonly manifest: unknown
}): string | undefined {
  const override = options.environment.DSH_DESKTOP_APP_ID
  if (override !== undefined && override !== '') {
    return APP_ID_PATTERN.test(override) && override.length <= APP_ID_LENGTH ? override : undefined
  }
  return options.packaged ? parseDesktopAppId(options.manifest) : undefined
}
