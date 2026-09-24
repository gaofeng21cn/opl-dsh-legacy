/** Native Windows Agent shell integration with the real Loader and process provider. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { boot, readAgentShellStartup } from '@deepseek-ai/dsh-app-boot'
import type { ShellExecutor, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { resolveGitBash, probeGitBash, candidateGitBashPaths } from '@deepseek-ai/dsh-shell'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'

/** Foreground projection of the unified shell execution handle. */
async function run(executor: ShellExecutor, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await executor.execute(spec)).result()
}

/** Start a command without an executor deadline. */
function start(executor: ShellExecutor, spec: ShellExecSpec): Promise<ShellExecution> {
  return executor.execute({ ...spec, onExpiry: 'none' })
}

const roots: string[] = []
const contexts: Context[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-shell-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('reads one shell section and rejects invalid persisted choices', () => {
  const root = temporary()
  expect(readAgentShellStartup(root).agentShell).toBe('powershell')
  writeFileSync(join(root, 'settings.yaml'), 'shell:\n  agentShell: git-bash\n  gitBashPath: C:/工具/Git/bin/bash.exe\n')
  expect(readAgentShellStartup(root)).toEqual({ agentShell: 'git-bash', gitBashPath: 'C:/工具/Git/bin/bash.exe' })
  writeFileSync(join(root, 'settings.yaml'), 'shell:\n  agentShell: wsl\n')
  expect(() => readAgentShellStartup(root)).toThrow('shell.agentShell')
  writeFileSync(join(root, 'settings.yaml'), 'shell: { agentShell: null }')
  expect(() => readAgentShellStartup(root)).toThrow('shell.agentShell')
})

// Real source-plane classes are exposed to a Loader-imported ESM fixture.
async function loadNative(home: string): Promise<Context> {
  vi.stubEnv('DSH_HOME', home)
  writeFileSync(join(home, 'providers.mjs'), [
    'export const name = "native-shell-providers"',
    'export async function apply(ctx, config) {',
    ' const providers = ctx.get("nativeShellProviders")',
    ' await ctx.plugin(providers.subprocess)',
    '}',
  ].join('\n'))
  writeFileSync(join(home, 'executor.mjs'), [
    'export const name = "native-shell-executor"',
    'export function apply(ctx, config) { return ctx.plugin(ctx.get("nativeShellProviders")[config.kind]) }',
  ].join('\n'))
  writeFileSync(join(home, 'cordis.yml'), [
    '- id: providers', '  name: ./providers.mjs', '  config: { home: ' + JSON.stringify(home) + ' }',
    '- id: bash', '  name: ./executor.mjs', "  disabled: !!js dshAgentShell() !== 'git-bash'", '  config: { kind: bash }',
    '- id: pwsh', '  name: ./executor.mjs', "  disabled: !!js dshAgentShell() !== 'powershell'", '  config: { kind: pwsh }',
  ].join('\n'))
  const ctx = await boot('git-bash-test', join(home, 'cordis.yml'), undefined, (ctx) => {
    ctx.provide('nativeShellProviders', {
      subprocess: LocalSubprocessRuntime, bash: LocalBashExecutor, pwsh: PwshLocalExecutor,
    })
  })
  contexts.push(ctx)
  return ctx
}

describe.skipIf(process.platform !== 'win32')('Native Git Bash', () => {
  it('rejects WSL and relative executables and recognizes Git for Windows', () => {
    expect(() => probeGitBash('bash')).toThrow('absolute')
    expect(() => probeGitBash('/bin/bash')).toThrow('absolute')
    expect(() => probeGitBash('C:/Windows/System32/bash.exe')).toThrow('Subsystem')
    expect(() => probeGitBash(process.execPath)).toThrow('no Git for Windows installation')
    expect(resolveGitBash({}).version).toContain('GNU bash')
    expect(candidateGitBashPaths({ Path: 'D:/Custom/bin' })).toContain('D:\\Custom\\bin\\bash.exe')
  })

  it('boots stored settings, runs native tools and retains the startup shell until restart', async () => {
    const home = temporary()
    const cwd = join(home, '中文 workspace')
    mkdirSync(cwd)
    const git = resolveGitBash({}).path
    writeFileSync(join(home, 'settings.yaml'), 'shell:\n  agentShell: git-bash\n  gitBashPath: ' + JSON.stringify(git) + '\n')
    const ctx = await loadNative(home)
    expect(ctx.shell).toBeInstanceOf(LocalBashExecutor)
    const bash = ctx.shell as LocalBashExecutor
    const pathEnv = dirname(process.execPath) + ';C:/Program Files/Git/cmd;' + (process.env.PATH ?? process.env.Path ?? '')
    const result = await run(bash, bash.resolve({
      workdir: cwd,
      command: "printf 'hello 中文' > '带 空格.txt'; cat '带 空格.txt'; printf '\\n'; node -p 'process.platform'; git --version; printf 'stderr-test' >&2; exit 7",
      env: { PATH: pathEnv },
    }))
    expect(result.exitCode).toBe(7)
    expect(result.stdout.text).toContain('hello 中文')
    expect(result.stdout.text).toContain('win32')
    expect(result.stdout.text).toMatch(/git version/)
    expect(result.stderr.text).toBe('stderr-test')
    expect(readFileSync(join(cwd, '带 空格.txt'), 'utf8')).toBe('hello 中文')
    expect(ctx.get('dshAgentShell')?.()).toBe('git-bash')
    expect(ctx.get('dshGitBashPath')?.()).toBe(git)
    expect(bash.bashPath).toBe(git)
    expect((await run(bash, bash.resolve({ command: "printf '%s' bash-still-active" }))).stdout.text).toBe('bash-still-active')
    writeFileSync(join(home, 'settings.yaml'), 'shell:\n  agentShell: powershell\n  gitBashPath: C:/not-installed/bash.exe\n')
    await ctx.fiber.dispose()
    const restarted = await loadNative(home)
    expect(restarted.shell).toBeInstanceOf(PwshLocalExecutor)
    expect(restarted.get('dshAgentShell')?.()).toBe('powershell')
  }, 30_000)

  it('keeps PowerShell by default and rejects an unavailable Git Bash', async () => {
    const home = temporary()
    const ctx = await loadNative(home)
    expect(ctx.shell).toBeInstanceOf(PwshLocalExecutor)
    expect(() => probeGitBash('C:/missing/bash.exe')).toThrow('readable executable')
    expect(ctx.get('dshAgentShell')?.()).toBe('powershell')
  })

  it('settles deadlines and cancellation through the managed process provider', async () => {
    const home = temporary()
    writeFileSync(join(home, 'settings.yaml'), 'shell:\n  agentShell: git-bash\n')
    const ctx = await loadNative(home)
    const timeout = await run(ctx.shell, ctx.shell.resolve({ command: 'sleep 30', timeoutMs: 300 }))
    expect(timeout.timedOut).toBe(true)
    const abort = new AbortController()
    const running = run(ctx.shell, ctx.shell.resolve({ command: 'sleep 30', signal: abort.signal }))
    setTimeout(() => { abort.abort(new Error('test cancellation')) }, 300)
    expect((await running).aborted).toBe(true)
  }, 20_000)
  it('runs the minimal preset PTY backend with persistent Bash state on Windows', async () => {
    const root = temporary()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: root })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(terminalBash, { shellPath: resolveGitBash({}).path, idleSilenceMs: 100, handoffGraceMs: 100, timeoutMs: 5_000 })
    const id = SessionId('git-bash-pty-test')
    const scope = ctx.plugin(() => {})
    const agent: Agent = {
      id, options: {}, session: Session.create(id), inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    const created = await ctx.terminals.spawn(agent, { type: 'shell', cwd: root })
    const first = await ctx.terminals.startSend(agent, created.sessionId, { text: 'export DSH_PTY_CHECK=retained', submit: true }).done
    expect(first.waitReason).not.toBe('timeout')
    const second = await ctx.terminals.startSend(agent, created.sessionId, { text: 'printf "STATE=%s" "$DSH_PTY_CHECK"', submit: true }).done
    expect(second.viewport).toContain('STATE=retained')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 20_000)

  it('refuses a persistent Git Bash terminal under restricted modes before allocating it', async () => {
    const root = temporary()
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(terminalBash, { shellPath: resolveGitBash({}).path, idleSilenceMs: 100, handoffGraceMs: 100, timeoutMs: 5_000 })
      const id = SessionId(`git-bash-pty-${mode}`)
      const scope = ctx.plugin(() => {})
      const agent: Agent = {
        id, options: {}, session: Session.create(id), inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
        send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(agent)
      // The session shell has no capability probe, so the refusal is static and
      // precedes every PTY allocation: nothing to clean up, no unconfined run.
      await expect(ctx.terminals.spawn(agent, { type: 'shell', cwd: root }))
        .rejects.toThrow('Use PowerShell for read-only/workspace-write')
      expect(ctx.terminals.list(agent)).toEqual([])
      expect(ctx.terminals.hasOwnerActivity(agent)).toBe(false)
    }
  }, 20_000)

  it('refuses restricted Git Bash before starting any command; explicit full access still works', async () => {
    const root = temporary()
    const workspace = join(root, '中文 workspace')
    mkdirSync(workspace)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSandboxProvider, {})
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxBashExecutor, {})
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const spec = ctx.shell.resolve({ workdir: workspace, command: 'printf escaped > ../outside.txt',
        sandboxPolicy: { mode, workspaceRoot: workspace } })
      await expect(run(ctx.shell, spec)).rejects.toThrow('Use PowerShell for read-only/workspace-write')
      await expect(start(ctx.shell, spec)).rejects.toThrow('permissions were not changed')
      expect(existsSync(join(root, 'outside.txt'))).toBe(false)
    }
    const allowed = await run(ctx.shell, ctx.shell.resolve({ workdir: workspace, command: 'printf ok > allowed.txt',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace } }))
    expect(allowed.exitCode, allowed.stderr.text).toBe(0)
    expect(readFileSync(join(workspace, 'allowed.txt'), 'utf8')).toBe('ok')
    expect(ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  }, 30_000)
})
