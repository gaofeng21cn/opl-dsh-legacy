/**
 * Desktop profile a Linux Host composes inside a WSL2 distribution.
 *
 * The profile directory belongs to the application rather than to the Harness
 * home's initializer, so nothing creates it automatically: on Windows the
 * shell's project manager writes the manifest and installs the plugin set,
 * while a distribution has no package-manager step of its own. Every bundle the
 * manifest names resolves from the packaged runtime tree, so the manifest is
 * the whole profile the Linux Host needs before it can compose.
 *
 * @module @deepseek-ai/dsh-desktop-host/desktop-profile
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bundles every Desktop execution environment composes, in composition order. */
export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/** Package name recorded in a generated Desktop profile manifest. */
export const DESKTOP_PROFILE_NAME = '@deepseek-ai/dsh-desktop-runtime'

/**
 * Create the Desktop profile manifest when its directory has none.
 *
 * An existing manifest is left untouched: it can carry a plugin set or state
 * this environment did not create, and rewriting it would discard that.
 * @param projectDir - absolute profile directory inside the distribution.
 * @returns the manifest path that exists after the call.
 * @throws when the directory or manifest cannot be created.
 */
export function ensureDesktopProfile(projectDir: string): string {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = join(projectDir, 'package.json')
  if (existsSync(manifest)) return manifest
  writeFileSync(manifest, `${JSON.stringify({
    name: DESKTOP_PROFILE_NAME,
    private: true,
    version: '0.0.0',
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }, undefined, 2)}\n`, { mode: 0o600 })
  return manifest
}
