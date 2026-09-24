/**
 * Git Bash broker unit tests: the launch decision, the MSYS/Windows path
 * unification, and the launch-parameter guard. Every case drives win32 path
 * semantics through the injected platform, so the boundary is pinned on any
 * host; the real backend and the real Git Bash are exercised in
 * `apps/cli/tests/git-bash-restricted.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  GIT_BASH_PROBE_DIMENSIONS,
  assertGitBashConfinement,
  brokerAbsolutePath,
  decideGitBashConfinement,
  guardGitBashLaunch,
  isWithinWindowsPathKey,
  msysPathToWindows,
  windowsPathKey,
  windowsPathToMsys,
} from '@deepseek-ai/dsh-shell'
import type { GitBashLaunchGuardRequest } from '@deepseek-ai/dsh-shell'

const MOUNTS = { installationRoot: 'C:\\Program Files\\Git', tempRoot: 'C:\\Temp' } as const
const WORKSPACE = 'C:\\work\\ws'

/** A guard request with the test's overrides applied. */
function guard(overrides: Partial<GitBashLaunchGuardRequest> = {}): ReturnType<typeof guardGitBashLaunch> {
  return guardGitBashLaunch({
    platform: 'win32',
    mode: 'workspace-write',
    workspaceRoot: WORKSPACE,
    workdir: `${WORKSPACE}\\sub`,
    ...MOUNTS,
    ...overrides,
  })
}

describe('the Windows/MSYS path unification', () => {
  it('places an absolute path from either world into one Windows spelling', () => {
    expect(brokerAbsolutePath('C:\\work\\ws\\sub', MOUNTS)).toBe('C:\\work\\ws\\sub')
    expect(brokerAbsolutePath('c:/work/ws/', MOUNTS)).toBe('C:\\work\\ws')
    expect(brokerAbsolutePath('/c/work/ws/sub', MOUNTS)).toBe('C:\\work\\ws\\sub')
    expect(brokerAbsolutePath('/C/work/ws', MOUNTS)).toBe('C:\\work\\ws')
    expect(brokerAbsolutePath('/c', MOUNTS)).toBe('C:\\')
  })

  it('collapses traversal, UNC, device, and mount spellings', () => {
    expect(brokerAbsolutePath('/c/work/ws/../outside', MOUNTS)).toBe('C:\\work\\outside')
    expect(brokerAbsolutePath('C:\\work\\ws\\..\\..\\Windows', MOUNTS)).toBe('C:\\Windows')
    expect(brokerAbsolutePath('\\\\server\\share\\x', MOUNTS)).toBe('\\\\server\\share\\x')
    expect(brokerAbsolutePath('//server/share/x', MOUNTS)).toBe('\\\\server\\share\\x')
    expect(brokerAbsolutePath('\\\\?\\C:\\work\\ws', MOUNTS)).toBe('C:\\work\\ws')
    expect(brokerAbsolutePath('\\\\?\\UNC\\server\\share\\x', MOUNTS)).toBe('\\\\server\\share\\x')
    expect(brokerAbsolutePath('/tmp/probe', MOUNTS)).toBe('C:\\Temp\\probe')
    expect(brokerAbsolutePath('/usr/bin', MOUNTS)).toBe('C:\\Program Files\\Git\\usr\\bin')
  })

  it('refuses paths that name no placeable directory', () => {
    // Drive-relative, bare relative, device namespace, and an MSYS path with no known `/` mount.
    expect(brokerAbsolutePath('C:work', MOUNTS)).toBeUndefined()
    expect(brokerAbsolutePath('work\\ws', MOUNTS)).toBeUndefined()
    expect(brokerAbsolutePath('  ', MOUNTS)).toBeUndefined()
    expect(brokerAbsolutePath('\\\\.\\pipe\\dsh', MOUNTS)).toBeUndefined()
    expect(msysPathToWindows('/usr/bin')).toBeUndefined()
  })

  it('refuses the WSL and Cygwin drive mounts Git Bash does not define', () => {
    // `/c` is the Git Bash drive mount; `/mnt/c` (WSL) and `/cygdrive/c`
    // (Cygwin) resolve under the MSYS root at best, so they are never
    // translated into a drive the workdir comparison could admit.
    for (const path of ['/mnt/c/work/ws', '/mnt/c', '/cygdrive/c/work/ws', '/cygdrive/c', '/MNT/c', '/CygDrive/c']) {
      expect(brokerAbsolutePath(path, MOUNTS), path).toBeUndefined()
      expect(msysPathToWindows(path, MOUNTS), path).toBeUndefined()
    }
    // The rule is prefix-exact: a real MSYS root entry that merely starts with
    // the same letters stays placeable under the installation root.
    expect(brokerAbsolutePath('/mntx/c', MOUNTS)).toBe('C:\\Program Files\\Git\\mntx\\c')
    expect(brokerAbsolutePath('/cygdrivex/c', MOUNTS)).toBe('C:\\Program Files\\Git\\cygdrivex\\c')
  })

  it('spells a Windows path the way Git Bash resolves it', () => {
    expect(windowsPathToMsys('C:\\work\\ws')).toBe('/c/work/ws')
    expect(windowsPathToMsys('C:\\')).toBe('/c')
    expect(windowsPathToMsys('D:/data/x')).toBe('/d/data/x')
    expect(windowsPathToMsys('\\\\server\\share\\x')).toBe('//server/share/x')
    expect(windowsPathToMsys('\\\\?\\C:\\work\\ws')).toBe('/c/work/ws')
  })

  it('compares boundaries case-insensitively with folded separators', () => {
    const root = windowsPathKey('C:\\Work\\WS\\')
    expect(root).toBe('c:\\work\\ws')
    expect(isWithinWindowsPathKey(root, windowsPathKey('c:/work/ws'))).toBe(true)
    expect(isWithinWindowsPathKey(root, windowsPathKey('C:\\WORK\\WS\\sub'))).toBe(true)
    // A sibling whose name merely extends the root is not inside it.
    expect(isWithinWindowsPathKey(root, windowsPathKey('C:\\work\\ws2'))).toBe(false)
    expect(isWithinWindowsPathKey(root, windowsPathKey('C:\\work'))).toBe(false)
    expect(isWithinWindowsPathKey(windowsPathKey('C:\\'), windowsPathKey('C:\\anything'))).toBe(true)
  })
})

describe('the Git Bash launch guard', () => {
  it('admits a workdir inside the workspace and pins the inherited defaults', () => {
    const result = guard()
    expect(result).toMatchObject({ ok: true, workdir: 'C:\\work\\ws\\sub' })
    expect(result.ok && result.env).toMatchObject({
      HOME: '/c/work/ws',
      BASH_ENV: undefined,
      ENV: undefined,
      CDPATH: undefined,
    })
  })

  it('admits an MSYS-spelled workdir inside the workspace and normalizes it', () => {
    expect(guard({ workdir: '/c/work/ws/sub' })).toMatchObject({ ok: true, workdir: 'C:\\work\\ws\\sub' })
  })

  it('refuses a workdir outside the workspace and its granted temp roots', () => {
    for (const workdir of ['C:\\work\\outside', '/c/work/outside', 'C:\\Windows', 'D:\\work\\ws']) {
      const result = guard({ workdir })
      expect(result.ok, workdir).toBe(false)
      expect(result.ok ? '' : result.detail, workdir).toContain('outside the granted roots')
      expect(result.ok ? '' : result.detail, workdir).toContain('was not started')
    }
  })

  it('refuses traversal, drive switching, and unplaceable spellings', () => {
    expect(guard({ workdir: '/c/work/ws/../../outside' })).toMatchObject({ ok: false })
    expect(guard({ workdir: 'C:work' })).toMatchObject({ ok: false })
    expect(guard({ workdir: 'relative/dir' })).toMatchObject({ ok: false })
    const result = guard({ workdir: 'relative/dir' })
    expect(result.ok ? '' : result.detail).toContain('not an absolute Windows or MSYS path')
  })

  it('names the foreign drive mount when one is refused', () => {
    const result = guard({ workdir: '/mnt/c/work/ws' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.detail).toContain('/mnt/<drive>')
    expect(result.ok ? '' : result.detail).toContain('/cygdrive/<drive>')
    expect(result.ok ? '' : result.detail).toContain('was not started')
  })

  it('refuses an unplaceable workspace root', () => {
    const result = guard({ workspaceRoot: 'relative/ws' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.detail).toContain('workspace root')
  })

  it('grants the mode temp roots under workspace-write only', () => {
    const granted = ['C:\\Temp', 'C:\\Users\\me\\AppData\\Local\\Temp']
    expect(guard({ mode: 'workspace-write', workdir: 'C:\\Temp\\probe', grantedRoots: granted })).toMatchObject({ ok: true })
    expect(guard({ mode: 'workspace-write', workdir: '/tmp/probe', grantedRoots: granted })).toMatchObject({ ok: true })
    expect(guard({ mode: 'read-only', workdir: 'C:\\Temp\\probe', grantedRoots: granted })).toMatchObject({ ok: false })
    expect(guard({ mode: 'read-only' })).toMatchObject({ ok: true })
  })

  it('treats a reparse point that leaves the workspace as outside it', () => {
    // A junction inside the workspace whose target is elsewhere resolves outside
    // the boundary; the canonicalizer stands in for the filesystem here and is
    // the real realpath contract in production.
    const canonicalize = (path: string): string => (path === 'C:\\work\\ws\\link' ? 'C:\\outside\\target' : path)
    const escaped = guard({ workdir: 'C:\\work\\ws\\link', canonicalize })
    expect(escaped.ok).toBe(false)
    expect(escaped.ok ? '' : escaped.detail).toContain('outside the granted roots')
    // A reparse point whose target stays inside remains admitted.
    const inside = guard({ workdir: 'C:\\work\\ws\\link', canonicalize: path => (path === 'C:\\work\\ws\\link' ? 'C:\\work\\ws\\real' : path) })
    expect(inside).toMatchObject({ ok: true, workdir: 'C:\\work\\ws\\real' })
  })

  it('constrains nothing off win32', () => {
    expect(guard({ platform: 'linux', workdir: '/etc' })).toEqual({ ok: true, workdir: '/etc', env: {} })
  })
})

describe('the Git Bash confinement decision', () => {
  const allProven = { proven: GIT_BASH_PROBE_DIMENSIONS }

  it('is direct off win32 and under danger-full-access', () => {
    expect(decideGitBashConfinement({ mode: 'workspace-write', platform: 'linux' })).toEqual({ kind: 'direct' })
    expect(decideGitBashConfinement({ mode: 'read-only', platform: 'darwin' })).toEqual({ kind: 'direct' })
    expect(decideGitBashConfinement({ mode: 'danger-full-access', platform: 'win32' })).toEqual({ kind: 'direct' })
  })

  it('refuses a confined launch while a dimension is unproven', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const unprobed = decideGitBashConfinement({ mode, platform: 'win32' })
      expect(unprobed).toMatchObject({ kind: 'refused', missing: GIT_BASH_PROBE_DIMENSIONS })
      const partial = decideGitBashConfinement({
        mode,
        platform: 'win32',
        probe: { proven: ['msys-runtime-startup'], evidence: 'fatal error - CreateFileMapping, Win32 error 5' },
      })
      expect(partial).toMatchObject({ kind: 'refused', missing: ['write-denial-outside-roots'] })
      expect(partial.kind === 'refused' ? partial.detail : '').toContain('CreateFileMapping')
      expect(partial.kind === 'refused' ? partial.detail : '').toContain('Use PowerShell for read-only/workspace-write')
      expect(partial.kind === 'refused' ? partial.detail : '').toContain('permissions were not changed')
    }
  })

  it('confines only a fully proven host', () => {
    expect(decideGitBashConfinement({ mode: 'workspace-write', platform: 'win32', probe: allProven })).toEqual({ kind: 'confined' })
    expect(decideGitBashConfinement({ mode: 'read-only', platform: 'win32', probe: allProven })).toEqual({ kind: 'confined' })
  })
})

describe('the static refusal for Git Bash shells with no capability probe', () => {
  it('refuses every confined mode on win32 and leaves the wider and POSIX paths alone', () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      expect(() => { assertGitBashConfinement(mode, 'win32') }).toThrow(/Use PowerShell for read-only\/workspace-write/u)
      expect(() => { assertGitBashConfinement(mode, 'win32') }).toThrow(/permissions were not changed/u)
      expect(() => { assertGitBashConfinement(mode, 'win32') }).toThrow(/cannot initialize MSYS/u)
    }
    // The persistent terminal's shell has no probe, so only the explicitly
    // approved wider mode and POSIX hosts (where the platform backend confines
    // bash itself) may start one.
    expect(() => { assertGitBashConfinement('danger-full-access', 'win32') }).not.toThrow()
    expect(() => { assertGitBashConfinement('workspace-write', 'linux') }).not.toThrow()
    expect(() => { assertGitBashConfinement('read-only', 'darwin') }).not.toThrow()
  })
})
