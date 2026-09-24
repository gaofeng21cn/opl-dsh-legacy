/** WSL2 discovery, selection, probing, and Host launch shape. */
import { describe, expect, it, vi } from 'vitest'
import {
  listWslDistributions,
  probeWslDistribution,
  resolveWslLaunchPlan,
  selectWslDistribution,
  wslHostInvocation,
  wslLauncherEnvironment,
  wslPayloadRoot,
  WSL_HOME_ENV,
  type WslDistribution,
} from '../src/wsl.ts'

const ubuntu: WslDistribution = { name: 'Ubuntu', version: 2, isDefault: true }
const legacy: WslDistribution = { name: 'Legacy', version: 1, isDefault: false }

describe('distribution discovery', () => {
  it('reports no distributions off Windows', async () => {
    const listInstalled = vi.fn(async () => [ubuntu])
    await expect(listWslDistributions({ platform: 'darwin', listInstalled })).resolves.toEqual([])
    expect(listInstalled).not.toHaveBeenCalled()
  })

  it('reads installed distributions through the platform seam', async () => {
    const listInstalled = vi.fn(async () => [ubuntu, legacy])
    await expect(listWslDistributions({ platform: 'win32', listInstalled })).resolves.toEqual([ubuntu, legacy])
  })
})

describe('distribution selection', () => {
  it('uses the persisted selection when it is still installed', () => {
    const debian: WslDistribution = { name: 'Debian', version: 2, isDefault: false }
    expect(selectWslDistribution([ubuntu, debian], 'Debian')).toEqual(debian)
  })

  it('falls back to the registry default when nothing is selected', () => {
    const debian: WslDistribution = { name: 'Debian', version: 2, isDefault: false }
    expect(selectWslDistribution([debian, ubuntu], undefined)).toEqual(ubuntu)
    expect(selectWslDistribution([debian], undefined)).toEqual(debian)
  })

  it('reports an empty installation and a vanished selection', () => {
    expect(() => selectWslDistribution([], undefined)).toThrow(/no WSL2 distribution is installed/u)
    expect(() => selectWslDistribution([ubuntu], 'Debian')).toThrow(/is not installed/u)
  })

  it('refuses a WSL1 distribution', () => {
    expect(() => selectWslDistribution([legacy], 'Legacy')).toThrow(/is not WSL2/u)
    // A WSL1 default is skipped in favor of an installed WSL2 distribution.
    expect(selectWslDistribution([legacy, ubuntu], undefined)).toEqual(ubuntu)
  })

  it('reports when nothing installed reports version 2', () => {
    expect(() => selectWslDistribution([{ ...legacy, isDefault: true }], undefined))
      .toThrow(/no installed WSL distribution reports version 2/u)
  })
})

describe('distribution probing', () => {
  it('accepts a distribution with a supported Linux Node', async () => {
    const run = vi.fn(async () => 'v22.19.0')
    await expect(probeWslDistribution('Ubuntu', { platform: 'win32', run }))
      .resolves.toEqual({ name: 'Ubuntu', nodeVersion: 'v22.19.0' })
    expect(run).toHaveBeenCalledWith('wsl.exe', ['--distribution', 'Ubuntu', '--exec', 'sh', '-lc', 'node --version'])
  })

  it('reports an unreachable distribution without throwing', async () => {
    const run = vi.fn(async () => undefined)
    await expect(probeWslDistribution('Ubuntu', { platform: 'win32', run }))
      .resolves.toEqual({ name: 'Ubuntu', problem: 'unreachable' })
  })

  it('reports a missing or too-old Node', async () => {
    await expect(probeWslDistribution('Ubuntu', { platform: 'win32', run: async () => 'sh: node: not found' }))
      .resolves.toEqual({ name: 'Ubuntu', problem: 'node-missing' })
    await expect(probeWslDistribution('Ubuntu', { platform: 'win32', run: async () => 'v20.11.0' }))
      .resolves.toEqual({ name: 'Ubuntu', nodeVersion: 'v20.11.0', problem: 'node-too-old' })
  })

  it('reports every distribution as unreachable off Windows', async () => {
    const run = vi.fn(async () => 'v22.19.0')
    await expect(probeWslDistribution('Ubuntu', { platform: 'darwin', run }))
      .resolves.toEqual({ name: 'Ubuntu', problem: 'unreachable' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('Host launch shape', () => {
  it('starts one long-lived Host rather than wrapping a tool call', () => {
    expect(wslHostInvocation('/opt/node/bin/node', '/opt/dsh/host.js', ['/home/me/.dsh', '--port', '0'], 'Ubuntu')).toEqual([
      'wsl.exe', '--distribution', 'Ubuntu', '--exec',
      '/opt/node/bin/node', '/opt/dsh/host.js', '/home/me/.dsh', '--port', '0',
    ])
  })

  it('rejects paths that would be read as options or are not Linux paths', () => {
    expect(() => wslHostInvocation('', '/opt/dsh/host.js', [], 'Ubuntu')).toThrow(/not a usable Linux Node.js executable path/u)
    expect(() => wslHostInvocation('/opt/node', '--help', [], 'Ubuntu')).toThrow(/not a usable Linux Host entry path/u)
    // A Windows path cannot be the entry inside a distribution.
    expect(() => wslHostInvocation('C:\\node.exe', '/opt/dsh/host.js', [], 'Ubuntu')).toThrow(/not a usable Linux Node.js executable path/u)
    expect(() => wslHostInvocation('/opt/node', '/opt/dsh/host.js', [], 'bad name')).toThrow(/not a usable WSL distribution name/u)
  })

  it('publishes no Windows state into the distribution by default', () => {
    // The Linux Host owns its Harness home, so nothing about this process — its
    // DSH_HOME, its credentials, its Windows paths — may reach it. WSLENV is
    // set rather than inherited, so an ambient Windows value cannot forward
    // arbitrary Windows state either.
    const launched = wslLauncherEnvironment({ DSH_HOME: 'C:\\Users\\me\\dsh-home', PATH: '/usr/bin' })
    expect(launched).toEqual({ DSH_HOME: 'C:\\Users\\me\\dsh-home', PATH: '/usr/bin', WSLENV: '' })
  })

  it('forwards an explicit Linux home and nothing else', () => {
    const launched = wslLauncherEnvironment({ DSH_HOME: 'C:\\Users\\me\\dsh-home' }, '/home/me/.dsh-opl')
    // DSH_HOME stays in the launcher's own environment: WSLENV does not name
    // it, so the distribution never sees the Windows value.
    expect(launched.WSLENV).toBe(WSL_HOME_ENV)
    expect(launched[WSL_HOME_ENV]).toBe('/home/me/.dsh-opl')
  })

  it('rejects a configured home that is not a Linux path', () => {
    expect(() => wslLauncherEnvironment({}, 'C:\\Users\\me\\dsh-home')).toThrow(/must be an absolute Linux path/u)
  })
})

describe('Host launch plan', () => {
  const ubuntu = { kind: 'wsl2', distro: 'Ubuntu' } as const

  it('translates every path the Linux Host reads or writes', () => {
    const plan = resolveWslLaunchPlan({
      environment: ubuntu,
      payloadRoot: 'C:\\Program Files\\OPL DSH\\resources\\wsl',
      bindingFile: 'C:\\Users\\me\\AppData\\Roaming\\dsh-home\\desktop\\wsl-transport.json',
    })
    expect(plan).toEqual({
      node: '/mnt/c/Program Files/OPL DSH/resources/wsl/runtime/node/node',
      hostEntry: '/mnt/c/Program Files/OPL DSH/resources/wsl/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
      runtimeDir: '/mnt/c/Program Files/OPL DSH/resources/wsl/dsh',
      bindingFile: '/mnt/c/Users/me/AppData/Roaming/dsh-home/desktop/wsl-transport.json',
      invocation: [
        'wsl.exe', '--distribution', 'Ubuntu', '--exec',
        '/mnt/c/Program Files/OPL DSH/resources/wsl/runtime/node/node',
        '/mnt/c/Program Files/OPL DSH/resources/wsl/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js',
        '/mnt/c/Program Files/OPL DSH/resources/wsl/dsh',
        '--serve-wsl',
        '/mnt/c/Users/me/AppData/Roaming/dsh-home/desktop/wsl-transport.json',
      ],
    })
  })

  it('maps a payload on any drive, not only the system drive', () => {
    const plan = resolveWslLaunchPlan({
      environment: ubuntu,
      payloadRoot: 'D:\\build\\resources\\wsl',
      bindingFile: 'D:\\state\\wsl-transport.json',
    })
    expect(plan.node).toBe('/mnt/d/build/resources/wsl/runtime/node/node')
    expect(plan.bindingFile).toBe('/mnt/d/state/wsl-transport.json')
  })

  it('leaves a payload that is already a Linux path alone', () => {
    const plan = resolveWslLaunchPlan({
      environment: ubuntu,
      payloadRoot: '/opt/opl/wsl',
      bindingFile: '/tmp/wsl-transport.json',
    })
    expect(plan.node).toBe('/opt/opl/wsl/runtime/node/node')
    expect(plan.bindingFile).toBe('/tmp/wsl-transport.json')
  })

  it('refuses a path that has no expression inside the distribution', () => {
    // A relative Windows path names nothing Linux can open, so the launch fails
    // instead of handing the Host a path it would resolve against its own cwd.
    expect(() => resolveWslLaunchPlan({
      environment: ubuntu,
      payloadRoot: 'resources\\wsl',
      bindingFile: 'C:\\state\\wsl-transport.json',
    })).toThrow(/has no path inside WSL distribution "Ubuntu"/u)
  })

  it('names the packaged payload root beside the Windows runtime', () => {
    expect(wslPayloadRoot('C:\\Program Files\\OPL DSH\\resources'))
      .toBe('C:\\Program Files\\OPL DSH\\resources\\wsl')
  })
})
