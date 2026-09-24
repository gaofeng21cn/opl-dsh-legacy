/** Execution-environment vocabulary, path translation, and state isolation. */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXECUTION_ENVIRONMENT,
  assertDistroName,
  describePathReach,
  environmentStateName,
  environmentStateRoot,
  executionEnvironmentFromEnv,
  executionEnvironmentId,
  parseWslUncPath,
  pathKind,
  pathPerformanceNotice,
  resolveExecutionEnvironment,
  shareState,
  translatePath,
  windowsPathToWsl,
  wslPathToWindows,
  wslUncPath,
} from '../src/execution-environment.ts'

const native = { kind: 'windows-native' } as const
const ubuntu = { kind: 'wsl2', distro: 'Ubuntu' } as const

describe('environment selection', () => {
  it('defaults to Windows Native when nothing is configured', () => {
    expect(DEFAULT_EXECUTION_ENVIRONMENT).toBe('windows-native')
    expect(resolveExecutionEnvironment(undefined, undefined)).toEqual({ kind: 'windows-native' })
    expect(resolveExecutionEnvironment('', '')).toEqual({ kind: 'windows-native' })
  })

  it('requires a distribution for a WSL2 selection', () => {
    expect(resolveExecutionEnvironment('wsl2', 'Ubuntu')).toEqual({ kind: 'wsl2', distro: 'Ubuntu' })
    expect(() => resolveExecutionEnvironment('wsl2', undefined)).toThrow(/requires a distribution/u)
    expect(() => resolveExecutionEnvironment('wsl2', '')).toThrow(/requires a distribution/u)
  })

  it('rejects an unknown environment rather than falling back', () => {
    expect(() => resolveExecutionEnvironment('docker', undefined)).toThrow(/unknown execution environment/u)
  })

  it('validates a distribution name before it can reach a command line', () => {
    expect(assertDistroName('Ubuntu-24.04')).toBe('Ubuntu-24.04')
    for (const bad of ['', '-oops', 'a b', 'a/b', 'a"b', 'a\\b', 'a\nb']) {
      expect(() => assertDistroName(bad)).toThrow(/not a usable WSL distribution name/u)
    }
  })

  it('reads the environment from process variables', () => {
    expect(executionEnvironmentFromEnv({})).toEqual({ kind: 'windows-native' })
    expect(executionEnvironmentFromEnv({
      DSH_DESKTOP_ENVIRONMENT: 'wsl2',
      DSH_DESKTOP_WSL_DISTRO: 'Ubuntu',
    })).toEqual({ kind: 'wsl2', distro: 'Ubuntu' })
    expect(() => executionEnvironmentFromEnv({ DSH_DESKTOP_ENVIRONMENT: 'wsl2' })).toThrow(/requires a distribution/u)
  })

  it('identifies environments so their state stays apart', () => {
    expect(executionEnvironmentId(native)).toBe('windows-native')
    expect(executionEnvironmentId(ubuntu)).toBe('wsl2:Ubuntu')
    expect(shareState(ubuntu, { kind: 'wsl2', distro: 'Ubuntu' })).toBe(true)
    expect(shareState(ubuntu, { kind: 'wsl2', distro: 'Debian' })).toBe(false)
    expect(shareState(native, ubuntu)).toBe(false)
  })
})

describe('path spelling', () => {
  it('classifies every form a user can choose', () => {
    expect(pathKind('C:\\work')).toBe('windows-drive')
    expect(pathKind('c:/work')).toBe('windows-drive')
    expect(pathKind('\\\\wsl$\\Ubuntu\\home\\me')).toBe('wsl-unc')
    expect(pathKind('\\\\wsl.localhost\\Ubuntu\\home')).toBe('wsl-unc')
    expect(pathKind('\\\\server\\share')).toBe('unc')
    expect(pathKind('/home/me/work')).toBe('posix')
    expect(pathKind('/mnt/c/work')).toBe('posix')
    expect(pathKind('relative/path')).toBe('relative')
    expect(pathKind('')).toBe('relative')
  })

  it('reads a distribution and inner path from a WSL UNC path', () => {
    expect(parseWslUncPath('\\\\wsl$\\Ubuntu\\home\\me\\work')).toEqual({
      distro: 'Ubuntu', posixPath: '/home/me/work',
    })
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home')).toEqual({ distro: 'Ubuntu', posixPath: '/home' })
    // The share root names the distribution's own root directory.
    expect(parseWslUncPath('\\\\wsl$\\Ubuntu')).toEqual({ distro: 'Ubuntu', posixPath: '/' })
    expect(parseWslUncPath('C:\\work')).toBeUndefined()
    expect(parseWslUncPath('\\\\wsl$\\bad name\\x')).toBeUndefined()
  })

  it('builds a UNC path that reaches inside a distribution', () => {
    expect(wslUncPath('Ubuntu', '/home/me/work')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\work')
    expect(wslUncPath('Ubuntu', '/')).toBe('\\\\wsl$\\Ubuntu')
    expect(() => wslUncPath('bad name', '/x')).toThrow(/not a usable/u)
  })
})

describe('drive-mount translation', () => {
  it('maps both directions between a drive path and its mount', () => {
    expect(windowsPathToWsl('C:\\work\\a')).toBe('/mnt/c/work/a')
    expect(windowsPathToWsl('d:/work')).toBe('/mnt/d/work')
    expect(windowsPathToWsl('/home/me')).toBeUndefined()
    expect(wslPathToWindows('/mnt/c/work/a')).toBe('C:\\work\\a')
    expect(wslPathToWindows('/mnt/c')).toBe('C:\\')
    expect(wslPathToWindows('/home/me')).toBeUndefined()
  })

  it('translates a chosen path into the WSL2 syntax', () => {
    expect(translatePath('C:\\work\\a', ubuntu)).toBe('/mnt/c/work/a')
    expect(translatePath('/home/me/work', ubuntu)).toBe('/home/me/work')
    expect(translatePath('\\\\wsl$\\Ubuntu\\home\\me', ubuntu)).toBe('/home/me')
    expect(translatePath('relative\\path', ubuntu)).toBe('relative\\path')
  })

  it('translates a chosen path into the Windows syntax', () => {
    expect(translatePath('/mnt/c/work', native)).toBe('C:\\work')
    expect(translatePath('C:\\work\\a', native)).toBe('C:\\work\\a')
    expect(translatePath('\\\\wsl$\\Ubuntu\\home\\me', native)).toBe('\\\\wsl$\\Ubuntu\\home\\me')
    // A POSIX path outside a drive mount is only reachable through a
    // distribution, which is not knowable here, so it passes through.
    expect(translatePath('/home/me', native)).toBe('/home/me')
  })

  it('refuses a UNC path naming a distribution other than the selected one', () => {
    expect(() => translatePath('\\\\wsl$\\Debian\\home\\me', ubuntu)).toThrow(/names WSL distribution "Debian"/u)
  })
})

describe('reachability and performance', () => {
  it('reports a drive-mount path as reachable but slow from WSL2', () => {
    expect(describePathReach('C:\\work', ubuntu)).toEqual({ reachable: true, reason: 'drive-mount' })
    expect(pathPerformanceNotice('C:\\work', ubuntu)).toBe('windows-drive-mount')
    expect(pathPerformanceNotice('/mnt/c/work', ubuntu)).toBe('windows-drive-mount')
    expect(pathPerformanceNotice('/home/me', ubuntu)).toBeUndefined()
    expect(pathPerformanceNotice('C:\\work', native)).toBeUndefined()
  })

  it('reports a Linux-native path as reachable without a caution', () => {
    expect(describePathReach('/home/me', ubuntu)).toEqual({ reachable: true, reason: 'native' })
  })

  it('reports an ordinary UNC share as unreachable from WSL2', () => {
    expect(describePathReach('\\\\server\\share', ubuntu)).toEqual({ reachable: false, reason: 'unc-unreachable' })
  })

  it('reports a foreign distribution as unreachable from the selected one', () => {
    expect(describePathReach('\\\\wsl$\\Debian\\home', ubuntu)).toEqual({ reachable: false, reason: 'cross-distro' })
  })

  it('reports a relative path as unusable for either environment', () => {
    expect(describePathReach('relative', ubuntu)).toEqual({ reachable: false, reason: 'relative' })
    expect(describePathReach('relative', native)).toEqual({ reachable: false, reason: 'relative' })
  })
})

describe('runtime-state isolation', () => {
  it('leaves the Windows Native home unchanged', () => {
    expect(environmentStateRoot('C:\\home', native)).toBe('C:\\home')
    expect(environmentStateName(native)).toBe('windows-native')
  })

  it('gives each distribution its own state root', () => {
    expect(environmentStateRoot('/home/me/.dsh', ubuntu)).toBe('/home/me/.dsh/environments/wsl2-Ubuntu')
    expect(environmentStateName(ubuntu)).toBe('wsl2-Ubuntu')
    expect(environmentStateName({ kind: 'wsl2', distro: 'Debian' })).toBe('wsl2-Debian')
  })

  it('keeps Windows path syntax when the home is a Windows path', () => {
    expect(environmentStateRoot('C:\\home', ubuntu)).toBe('C:\\home\\environments\\wsl2-Ubuntu')
  })
})
