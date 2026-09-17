/**
 * Which npm scopes this workspace's tooling treats as its own packages.
 *
 * Upstream has exactly one answer — everything here is `@deepseek-ai/*` — and
 * encodes it as a literal in the gates that walk the workspace: the release
 * families, the workspace constraint check, the desktop package closure, and
 * the client bundle purity plugin. This repository adds packages of its own
 * under a scope it can actually publish to, so those gates need one shared
 * answer instead of a scattered literal.
 *
 * The distinction matters in both directions:
 * - A gate that decides "is this a workspace package?" must recognize BOTH
 *   scopes. Missing the downstream scope silently drops our packages from a
 *   closure (the desktop runtime would boot without the plugin and fail at
 *   runtime instead of at build time).
 * - A gate that decides "does this package follow the upstream release
 *   identity?" must keep tracking only the upstream scope, so our own packages
 *   are not dragged into upstream's version and publication policy.
 *
 * @module scripts/package-scope
 */

/** The scope upstream publishes under. */
export const UPSTREAM_SCOPE = '@deepseek-ai/'

/** The scope this downstream repository publishes under. */
export const DOWNSTREAM_SCOPE = '@one-person-lab/'

/** Source home recorded in this repository's own package manifests. */
export const DOWNSTREAM_REPOSITORY_URL = 'git+https://github.com/gaofeng21cn/opl-dsh.git'

/**
 * Whether a package name belongs to upstream.
 * @param name - package name, or undefined for a manifest without one.
 * @returns whether the name is an upstream package.
 */
export function isUpstreamPackageName(name: string | undefined): name is string {
  return name?.startsWith(UPSTREAM_SCOPE) === true
}

/**
 * Whether a package name belongs to this downstream repository.
 * @param name - package name, or undefined for a manifest without one.
 * @returns whether the name is a downstream package.
 */
export function isDownstreamPackageName(name: string | undefined): name is string {
  return name?.startsWith(DOWNSTREAM_SCOPE) === true
}

/**
 * Whether a package name is one this workspace owns, under either scope.
 * @param name - package name, or undefined for a manifest without one.
 * @returns whether the name is a workspace-owned package.
 */
export function isWorkspacePackageName(name: string | undefined): name is string {
  return isUpstreamPackageName(name) || isDownstreamPackageName(name)
}

/**
 * Whether a package name is a `dsh-*` companion under either scope.
 *
 * The launcher's companions — `dsh-llm`, `dsh-client-ui-settings-models`, and
 * the rest — share its release version and its packaging rules. This
 * deliberately excludes the launcher itself (`…/dsh`), because the launcher is
 * the family's root rather than one of its companions.
 * @param name - package name, or undefined for a manifest without one.
 * @returns whether the name is a dsh companion package.
 */
export function isDshCompanionPackageName(name: string | undefined): name is string {
  if (!isWorkspacePackageName(name)) return false
  const unscoped = name.slice(name.indexOf('/') + 1)
  return unscoped.startsWith('dsh-')
}
