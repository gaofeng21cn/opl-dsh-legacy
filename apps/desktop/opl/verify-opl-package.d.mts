/** Release guard for the packed OPL DSH application, asserted by the Desktop release tests. */

/** Portable default the app expands for the signed-in user. */
export const DEFAULT_DSH_HOME: '~/.dsh-opl'

/** Home a Windows installation resolves at runtime, recorded as a build receipt label. */
export const WINDOWS_DSH_HOME: 'user-data'

/** Directory inside a Windows package's resources that carries the Linux payload. */
export const WSL_PAYLOAD_DIR: 'wsl'

/**
 * Verify the Linux payload a Windows package carries for WSL2.
 * @param payloadRoot - `resources/wsl` directory of one packed application.
 * @returns Verified payload facts for the build receipt.
 */
export function verifyOplWslPayload(
  payloadRoot: string,
): { readonly node: string, readonly version: string }

/**
 * Verify the launch configuration and bundled gateway plugin of one packed application.
 * @param appPath - Path to `OPL DSH.app`.
 * @param options - Packaging-time expected home override.
 * @returns Verified facts for the build receipt.
 */
export function verifyOplAppBundle(
  appPath: string,
  options?: { readonly expectedDshHome?: string },
): { readonly dshHome: string, readonly packages: string[] }

/**
 * Verify the application directory electron-builder produced for Windows.
 * @param appOutDir - `win-unpacked` directory electron-builder populated.
 * @param options - Launcher base name override.
 * @returns Verified facts for the build receipt.
 */
export function verifyOplWindowsApplication(
  appOutDir: string,
  options?: { readonly productFilename?: string },
): { readonly home: string, readonly executable: string, readonly packages: string[], readonly wslNode: string }

/**
 * Assert one file is a Windows executable whose name keeps its release identity.
 * @param file - Path to one `.exe` electron-builder emitted.
 * @returns The artifact kind and its size.
 */
export function verifyOplWindowsInstaller(file: string): { readonly kind: string, readonly bytes: number }

/**
 * Verify the application carried by one disk image.
 * @param imagePath - Path to the `.dmg`.
 * @param options - Packaging-time expected home override.
 * @returns Verified facts for the build receipt.
 */
export function verifyOplDiskImage(
  imagePath: string,
  options?: { readonly expectedDshHome?: string },
): { readonly dshHome: string, readonly packages: string[] }
