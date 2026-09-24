import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WINDOWS_DSH_HOME,
  WSL_PAYLOAD_DIR,
  verifyOplWindowsApplication,
  verifyOplWindowsInstaller,
  verifyOplWslPayload,
} from '../opl/verify-opl-package.mjs'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'opl-windows-package-'))
  roots.push(root)
  return root
}

/**
 * Write the smallest byte sequence that still is a PE image: the DOS stub, the
 * `e_lfanew` offset, and the PE signature it points at.
 */
function writeExecutable(path: string, padding = 4096): void {
  const image = Buffer.alloc(padding)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(0x40, 0x3c)
  image.write('PE\u0000\u0000', 0x40, 'latin1')
  writeFileSync(path, image)
}

/** Write a minimal but valid Linux x86-64 ELF header. */
function writeLinuxExecutable(path: string, machine = 62, elfClass = 2): void {
  const image = Buffer.alloc(64)
  image.write('\u007fELF', 0, 'latin1')
  image[4] = elfClass
  image[5] = 1
  image.writeUInt16LE(machine, 18)
  writeFileSync(path, image)
}

/**
 * Build the smallest asar archive the release guard can read.
 *
 * The guard reads the header pickle directly, so the archive is assembled here
 * rather than through a packer: a fabricated tree is what lets the packaging
 * checks be exercised without a real electron-builder run.
 */
function makeAsar(entries: Readonly<Record<string, string>>): Buffer {
  const files: Record<string, unknown> = {}
  const contents: Buffer[] = []
  let offset = 0
  for (const [path, text] of Object.entries(entries)) {
    const parts = path.split('/')
    let node = files
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} }
      node = (node[part] as { files: Record<string, unknown> }).files
    }
    const data = Buffer.from(text, 'utf8')
    node[parts.at(-1) as string] = { size: data.length, offset: String(offset) }
    contents.push(data)
    offset += data.length
  }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(8 + json.length, 4)
  header.writeUInt32LE(json.length + 4, 8)
  header.writeUInt32LE(json.length, 12)
  return Buffer.concat([header, json, ...contents])
}

/** Gateway packages the release guard requires inside the archive. */
const GATEWAY_ENTRIES: Readonly<Record<string, string>> = {
  'dsh/node_modules/@one-person-lab/dsh-llm-opl-gateway/lib/index.js': 'export default {}\n',
  'dsh/node_modules/@one-person-lab/dsh-client-ui-settings-opl-gateway/lib/client.js': 'export default {}\n',
}

/** Complete archive contents a passing Windows application needs. */
function passingArchiveEntries(): Record<string, string> {
  return {
    'lib/main.js': 'export const loaded = true\n',
    'dsh/desktop-runtime.json': JSON.stringify({
      sharedPackages: [
        { name: '@one-person-lab/dsh-llm-opl-gateway' },
        { name: '@one-person-lab/dsh-client-ui-settings-opl-gateway' },
      ],
    }),
    'dsh/node_modules/@one-person-lab/dsh-llm-opl-gateway/package.json': JSON.stringify({
      name: '@one-person-lab/dsh-llm-opl-gateway',
    }),
    'dsh/node_modules/@one-person-lab/dsh-client-ui-settings-opl-gateway/package.json': JSON.stringify({
      name: '@one-person-lab/dsh-client-ui-settings-opl-gateway',
    }),
    'dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml': [
      '- id: search',
      '- id: ui-settings-opl-gateway',
      '- id: llm-opl-gateway',
      '',
    ].join('\n'),
    ...GATEWAY_ENTRIES,
  }
}

/** Write the Linux PTY addon `node-pty` loads from the payload at runtime. */
function writePtyAddon(payload: string): void {
  const dir = join(payload, 'dsh', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pty.node'), 'addon\n')
}

/**
 * Build one complete Windows application tree the release guard accepts.
 * @param root - empty directory to populate.
 * @returns the `win-unpacked` directory the guard verifies.
 */
function writeWindowsApplication(root: string): string {
  const resources = join(root, 'resources')
  mkdirSync(join(resources, 'runtime', 'bin'), { recursive: true })
  mkdirSync(join(resources, 'runtime', 'pnpm'), { recursive: true })
  writeFileSync(join(resources, 'app.asar'), makeAsar(passingArchiveEntries()))
  writeFileSync(join(resources, 'runtime', 'versions.json'), '{"node":"24.17.0"}\n')
  writeFileSync(join(resources, 'runtime', 'bin', 'node.cmd'), '@echo off\n')
  writeExecutable(join(root, 'OPL DSH.exe'))

  const payload = join(resources, WSL_PAYLOAD_DIR)
  mkdirSync(join(payload, 'runtime', 'node'), { recursive: true })
  mkdirSync(join(payload, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'), { recursive: true })
  writeFileSync(join(payload, 'wsl-runtime.json'), JSON.stringify({
    schemaVersion: 1, node: '24.17.0', platform: 'linux', arch: 'x64',
  }))
  writeLinuxExecutable(join(payload, 'runtime', 'node', 'node'))
  writeFileSync(
    join(payload, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host' }),
  )
  writeFileSync(
    join(payload, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
    'export {}\n',
  )
  writePtyAddon(payload)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('Windows artifact naming', () => {
  it('accepts the installer and portable names this product emits', () => {
    const root = scratch()
    const setup = join(root, 'opl-dsh-0.1.6-alpha.1-win-x64-setup.exe')
    const portable = join(root, 'opl-dsh-0.1.6-alpha.1-win-x64-portable.exe')
    const bare = join(root, 'opl-dsh-0.1.6-alpha.1-win-x64.exe')
    for (const path of [setup, portable, bare]) writeExecutable(path)
    expect(verifyOplWindowsInstaller(setup)).toMatchObject({ kind: 'setup', bytes: 4096 })
    expect(verifyOplWindowsInstaller(portable).kind).toBe('portable')
    expect(verifyOplWindowsInstaller(bare).kind).toBe('executable')
  })

  it('rejects a name that dropped the version or the target architecture', () => {
    const root = scratch()
    for (const name of ['opl-dsh-win-x64-setup.exe', 'opl-dsh-0.1.6-alpha.1-setup.exe', 'opl-dsh-0.1.6-alpha.1-win-arm64-setup.exe']) {
      const path = join(root, name)
      writeExecutable(path)
      expect(() => verifyOplWindowsInstaller(path)).toThrow(/version and the win-x64 target/u)
    }
  })

  it('rejects a truncated download and a file that is not a Windows image', () => {
    const root = scratch()
    const truncated = join(root, 'opl-dsh-0.1.6-alpha.1-win-x64-setup.exe')
    writeExecutable(truncated, 512)
    expect(() => verifyOplWindowsInstaller(truncated)).toThrow(/truncated/u)

    const notExecutable = join(root, 'opl-dsh-0.1.6-alpha.1-win-x64-portable.exe')
    writeFileSync(notExecutable, Buffer.alloc(4096, 0x0a))
    expect(() => verifyOplWindowsInstaller(notExecutable)).toThrow(/not a Windows executable/u)

    const noPEHeader = join(root, 'opl-dsh-0.1.6-alpha.1-win-x64.exe')
    const image = Buffer.alloc(4096)
    image.write('MZ', 0, 'latin1')
    writeFileSync(noPEHeader, image)
    expect(() => verifyOplWindowsInstaller(noPEHeader)).toThrow(/no PE header/u)
  })
})

describe('Windows application directory', () => {
  it('reports the runtime home and refuses a tree with no application archive', () => {
    const root = scratch()
    expect(WINDOWS_DSH_HOME).toBe('user-data')
    expect(() => verifyOplWindowsApplication(root)).toThrow(/app\.asar is missing/u)

    const withArchive = scratch()
    mkdirSync(join(withArchive, 'resources'), { recursive: true })
    writeFileSync(join(withArchive, 'resources', 'app.asar'), 'not an archive')
    // The archive is present but unreadable, so the guard must still refuse the
    // tree rather than reporting it as verified.
    expect(() => verifyOplWindowsApplication(withArchive)).toThrow(/not a readable application archive/u)
  })

  it('accepts a complete tree and reports the WSL2 payload it carries', () => {
    const verified = verifyOplWindowsApplication(writeWindowsApplication(scratch()))
    expect(verified.home).toBe('user-data')
    expect(verified.executable).toBe('OPL DSH.exe')
    expect(verified.wslNode).toBe('runtime/node/node')
  })

  it('refuses a package that advertises WSL2 without its Linux Node.js', () => {
    // The environment selection is persistent, so a package missing this file
    // would fail only after the user restarted into it.
    const root = writeWindowsApplication(scratch())
    rmSync(join(root, 'resources', WSL_PAYLOAD_DIR, 'runtime'), { recursive: true, force: true })
    expect(() => verifyOplWindowsApplication(root)).toThrow(/no Linux Node\.js executable/u)
  })

  it('refuses a package that advertises WSL2 without its Host entry', () => {
    const root = writeWindowsApplication(scratch())
    rmSync(
      join(root, 'resources', WSL_PAYLOAD_DIR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'),
      { recursive: true, force: true },
    )
    expect(() => verifyOplWindowsApplication(root)).toThrow(/no Host entry/u)
  })

  it('refuses a package that carries no Linux payload at all', () => {
    const root = writeWindowsApplication(scratch())
    rmSync(join(root, 'resources', WSL_PAYLOAD_DIR), { recursive: true, force: true })
    expect(() => verifyOplWindowsApplication(root)).toThrow(/carries no WSL2 Linux payload/u)
  })
})

describe('WSL2 Linux payload', () => {
  /** Build a payload directory carrying the given manifest and node image. */
  function writePayload(options: {
    manifest?: string
    node?: (path: string) => void
    hostManifest?: string
    hostEntry?: boolean
    ptyAddon?: boolean
  } = {}): string {
    const payload = scratch()
    mkdirSync(join(payload, 'runtime', 'node'), { recursive: true })
    mkdirSync(join(payload, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'), { recursive: true })
    writeFileSync(join(payload, 'wsl-runtime.json'), options.manifest ?? JSON.stringify({
      schemaVersion: 1, node: '24.17.0', platform: 'linux', arch: 'x64',
    }))
    ;(options.node ?? ((path: string) => { writeLinuxExecutable(path) }))(join(payload, 'runtime', 'node', 'node'))
    writeFileSync(
      join(payload, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'),
      options.hostManifest ?? JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host' }),
    )
    if (options.hostEntry !== false) {
      writeFileSync(
        join(payload, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
        'export {}\n',
      )
    }
    if (options.ptyAddon !== false) writePtyAddon(payload)
    return payload
  }

  it('accepts a Linux x64 Node.js executable with the private Host entry', () => {
    expect(verifyOplWslPayload(writePayload())).toEqual({ node: 'runtime/node/node', version: '24.17.0' })
  })

  it('refuses a payload whose Node.js is a Windows executable', () => {
    // Shipping the Windows runtime as the Linux payload is the mistake this
    // guard exists to catch: the distribution cannot execute it.
    const payload = writePayload({ node: (path) => { writeExecutable(path) } })
    expect(() => verifyOplWslPayload(payload)).toThrow(/is not a Linux executable/u)
  })

  it('refuses a payload whose Node.js is not x64', () => {
    // e_machine 0x3e is EM_X86_64's 32-bit sibling; a class-1 image is 32-bit ELF.
    const otherMachine = writePayload({ node: (path) => { writeLinuxExecutable(path, 3) } })
    expect(() => verifyOplWslPayload(otherMachine)).toThrow(/is not a Linux x64 executable/u)
    const thirtyTwoBit = writePayload({ node: (path) => { writeLinuxExecutable(path, 62, 1) } })
    expect(() => verifyOplWslPayload(thirtyTwoBit)).toThrow(/is not a Linux x64 executable/u)
  })

  it('refuses a payload with no manifest, or one describing another platform', () => {
    const missing = writePayload()
    rmSync(join(missing, 'wsl-runtime.json'), { force: true })
    expect(() => verifyOplWslPayload(missing)).toThrow(/carries no WSL2 Linux payload/u)

    const windowsManifest = writePayload({
      manifest: JSON.stringify({ schemaVersion: 1, node: '24.17.0', platform: 'win32', arch: 'x64' }),
    })
    expect(() => verifyOplWslPayload(windowsManifest)).toThrow(/not a supported payload manifest/u)
  })

  it('refuses a payload that mislabels or omits the private Host package', () => {
    const mislabelled = writePayload({ hostManifest: JSON.stringify({ name: 'something-else' }) })
    expect(() => verifyOplWslPayload(mislabelled)).toThrow(/mislabels @deepseek-ai\/dsh-desktop-host/u)

    const noEntry = writePayload({ hostEntry: false })
    expect(() => verifyOplWslPayload(noEntry)).toThrow(/no Host entry/u)
  })

  it('refuses a payload whose native addons were kept for the packaging host', () => {
    // Copying the Linux tree with the Windows platform in hand drops
    // `prebuilds/linux-x64`, which starts the Host and then fails on the first
    // terminal it opens.
    const payload = writePayload({ ptyAddon: false })
    expect(() => verifyOplWslPayload(payload)).toThrow(/no Linux PTY addon/u)
  })
})
