import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPL_DSH_HOME_DIR_NAME,
  WINDOWS_DSH_HOME_DIR_NAME,
  desktopDshHomeDisplay,
  resolveDesktopDshHome,
  type DesktopDshHomeInput,
} from '../src/dsh-home.ts'

const WINDOWS_USER_DATA = 'C:\\Users\\Example\\AppData\\Roaming\\OPL DSH'
const WINDOWS_HOME = 'C:\\Users\\Example'
const POSIX_HOME = '/Users/example'

/** The shape of every absolute Windows path: a drive letter and a backslash. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\\/

/**
 * Build the injected facts for one platform.
 *
 * Each platform gets a home directory spelled with its own separators, so no
 * expectation in this suite depends on the host that runs it.
 */
function input(overrides: Partial<DesktopDshHomeInput> = {}): DesktopDshHomeInput {
  const platform = overrides.platform ?? 'win32'
  return {
    platform,
    env: {},
    userDataPath: WINDOWS_USER_DATA,
    homeDirectory: platform === 'win32' ? WINDOWS_HOME : POSIX_HOME,
    ...overrides,
  }
}

describe('Windows Harness home', () => {
  it('sits below the Electron user-data directory Windows gives the application', () => {
    // Windows has no bundle-level launch environment, so this default is the
    // whole mechanism by which the product keeps its own home.
    expect(resolveDesktopDshHome(input()))
      .toBe(win32.resolve(win32.join(WINDOWS_USER_DATA, WINDOWS_DSH_HOME_DIR_NAME)))
  })

  it('never falls back to the POSIX layout', () => {
    const home = resolveDesktopDshHome(input())
    expect(home).not.toContain(OPL_DSH_HOME_DIR_NAME)
    expect(home).not.toContain('/Users/')
    // Asserted with the Windows rules, not the host's: `isAbsolute` from
    // `node:path` would reject every drive-lettered path on a POSIX host.
    expect(win32.isAbsolute(home)).toBe(true)
    expect(home).toMatch(WINDOWS_ABSOLUTE)
  })

  it('keeps a profile directory that contains spaces intact', () => {
    // A Windows account name may contain spaces, and the home is passed to a
    // child process as one argument rather than through a shell.
    const home = resolveDesktopDshHome(input({ userDataPath: 'C:\\Users\\Example User\\AppData\\Roaming\\OPL DSH' }))
    expect(home).toBe(win32.resolve(win32.join('C:\\Users\\Example User\\AppData\\Roaming\\OPL DSH', WINDOWS_DSH_HOME_DIR_NAME)))
    expect(home).toContain('Example User')
  })

  it('resolves an override and the user-data default to different directories', () => {
    const configured = resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: 'D:\\opl\\home' } }))
    expect(configured).toBe('D:\\opl\\home')
    expect(configured).not.toBe(resolveDesktopDshHome(input()))
  })
})

describe('Windows path rules on any build host', () => {
  // These cases are the reason the platform API is an input rather than a read
  // of `process.platform`: the answers below must be identical on Linux, macOS,
  // and Windows, so a Windows diagnosis stays valid wherever it is produced.

  it('keeps a drive-lettered backslash override absolute and normalizes it', () => {
    const home = resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: 'D:\\opl\\desktop\\.\\home\\..\\state' } }))
    expect(home).toBe('D:\\opl\\desktop\\state')
    expect(home).toMatch(WINDOWS_ABSOLUTE)
  })

  it('collapses a trailing separator in a drive-lettered override', () => {
    expect(resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: 'D:\\opl\\home\\\\' } })))
      .toBe('D:\\opl\\home')
  })

  it('expands a tilde against the Windows profile, not the build host profile', () => {
    const home = resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: '~/.dsh-opl' } }))
    expect(home).toBe(win32.join(WINDOWS_HOME, OPL_DSH_HOME_DIR_NAME))
    expect(home).not.toContain(POSIX_HOME)
  })

  it('treats a backslash tilde exactly like a forward-slash one on Windows', () => {
    expect(resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: '~\\.dsh-opl' } })))
      .toBe(resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: '~/.dsh-opl' } })))
  })

  it('leaves a UNC override alone instead of inventing a drive letter', () => {
    expect(resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: '\\\\server\\share\\opl-home' } })))
      .toBe('\\\\server\\share\\opl-home')
  })

  it('still applies POSIX rules when the named platform is POSIX', () => {
    expect(resolveDesktopDshHome(input({ platform: 'darwin', env: { DSH_OPL_HOME: '~/opl-home' } })))
      .toBe(posix.join(POSIX_HOME, 'opl-home'))
  })
})

describe('POSIX Harness home', () => {
  it('keeps the portable home the macOS bundle pins through LSEnvironment', () => {
    expect(resolveDesktopDshHome(input({ platform: 'darwin' })))
      .toBe(posix.resolve(posix.join(POSIX_HOME, OPL_DSH_HOME_DIR_NAME)))
  })

  it('uses the same layout on Linux', () => {
    expect(resolveDesktopDshHome(input({ platform: 'linux', homeDirectory: '/home/example' })))
      .toBe(posix.resolve(posix.join('/home/example', OPL_DSH_HOME_DIR_NAME)))
  })
})

describe('override precedence', () => {
  it('prefers DSH_OPL_HOME over DSH_HOME and both over the platform default', () => {
    const both = resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: 'D:\\opl\\home', DSH_HOME: 'D:\\harness\\home' } }))
    const harnessOnly = resolveDesktopDshHome(input({ env: { DSH_HOME: 'D:\\harness\\home' } }))
    expect(both).toBe('D:\\opl\\home')
    expect(harnessOnly).toBe('D:\\harness\\home')
    expect(both).not.toBe(resolveDesktopDshHome(input()))
  })

  it('treats a blank or whitespace-only override as unset', () => {
    // A blank variable must never resolve the home to the working directory.
    expect(resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: '', DSH_HOME: '   ' } })))
      .toBe(resolveDesktopDshHome(input()))
  })

  it('expands a tilde override against the named platform home', () => {
    const expanded = resolveDesktopDshHome(input({ env: { DSH_OPL_HOME: '~/.dsh-opl' } }))
    expect(win32.isAbsolute(expanded)).toBe(true)
    // Basename with the Windows rules: the host's `basename` does not split on
    // a backslash, so it would return the whole path on a POSIX machine.
    expect(win32.basename(expanded)).toBe(OPL_DSH_HOME_DIR_NAME)
  })
})

describe('home display', () => {
  it('shortens a POSIX home below the profile and leaves anything else alone', () => {
    expect(desktopDshHomeDisplay(posix.join(POSIX_HOME, OPL_DSH_HOME_DIR_NAME), input({ platform: 'darwin' })))
      .toBe(`~/${OPL_DSH_HOME_DIR_NAME}`)
    expect(desktopDshHomeDisplay('/opt/opl-home', input({ platform: 'darwin' }))).toBe('/opt/opl-home')
  })

  it('shortens a Windows home below the profile even when its case differs', () => {
    // Windows treats `Example` and `example` as one profile directory, so a path
    // a child process re-spelled must still shorten instead of printing in full.
    const expected = `~${win32.sep}AppData${win32.sep}Roaming${win32.sep}OPL DSH${win32.sep}${WINDOWS_DSH_HOME_DIR_NAME}`
    expect(desktopDshHomeDisplay(win32.join(WINDOWS_USER_DATA, WINDOWS_DSH_HOME_DIR_NAME), input()))
      .toBe(expected)
    expect(desktopDshHomeDisplay(win32.join('c:\\users\\example\\AppData\\Roaming\\OPL DSH', WINDOWS_DSH_HOME_DIR_NAME), input()))
      .toBe(expected)
    expect(desktopDshHomeDisplay(win32.join('D:\\opl', WINDOWS_DSH_HOME_DIR_NAME), input()))
      .toBe(win32.join('D:\\opl', WINDOWS_DSH_HOME_DIR_NAME))
  })
})
