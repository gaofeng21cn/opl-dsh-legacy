/**
 * Restricted Git Bash through the real Windows backend, the real Git for
 * Windows executable, and the real process provider. These are the acceptance
 * tests for the broker: a confined Git Bash launch must be refused with the
 * unproven dimension and an actionable fallback (never downgraded to an
 * unconfined run), the launch-parameter guard must bound the working directory
 * across MSYS/Windows spellings and reparse points, and full-access Bash must
 * keep its existing behavior and shed every process it started.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SANDBOX_UNAVAILABLE } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecutor, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { resolveGitBash } from '@deepseek-ai/dsh-shell'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-bash-restricted-'))
  roots.push(root)
  return root
}

/**
 * Probe scratch directories THIS test process created, under either probe base
 * (the denial probe uses the user profile; the launch guard's control write
 * uses the workspace). The process-qualified prefix keeps the assertion from
 * racing a concurrently running probe in another suite.
 */
function probeDirectories(): string[] {
  const prefix = `dsh-git-bash-probe-${process.pid}-`
  return [tmpdir(), homedir()].flatMap((base) => {
    try {
      return readdirSync(base).filter(entry => entry.startsWith(prefix)).map(entry => join(base, entry))
    } catch {
      // A missing or unreadable base holds no probe directory of this process.
      return []
    }
  })
}

/**
 * Whether one Windows pid is still running (signal 0 opens the process).
 * Git Bash reports MSYS pids; the commands below publish `/proc/<pid>/winpid`
 * so this check tests the process the host and its job object actually own.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH (and Windows' equivalent) means the process is gone.
    return false
  }
}

/** Wait for one pid to disappear, so a kill is asserted after quiescence rather than during it. */
async function waitUntilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !isAlive(pid)
}

/** Await one shell call, returning its refusal message; a resolved call yields an empty message. */
async function refusalMessage(pending: Promise<unknown>): Promise<string> {
  try {
    await pending
    return ''
  } catch (error) {
    // Every refusal in this suite is a SandboxUnavailableError; a non-Error
    // rejection value is reported by its JSON form so the assertion text stays
    // deterministic instead of object-stringified.
    return error instanceof Error ? error.message : JSON.stringify(error)
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the real backend stack; the caller supplies the deployment default mode and workspace. */
async function boot(mode: 'read-only' | 'workspace-write', workspace: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, {})
  return ctx
}

describe.skipIf(process.platform !== 'win32')('Restricted Git Bash (real Windows backend)', () => {
  it('refuses a confined launch with the unproven dimension and never runs the command', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const probesBefore = new Set(probeDirectories())
    const ctx = await boot('workspace-write', workspace)
    for (const mode of ['workspace-write', 'read-only'] as const) {
      const spec = ctx.shell.resolve({
        workdir: workspace,
        command: 'printf escaped > ../outside.txt',
        sandboxPolicy: { mode, workspaceRoot: workspace },
      })
      const foreground = await run(ctx.shell, spec).catch((error: unknown) => error)
      expect(foreground).toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
      const message = foreground instanceof Error ? foreground.message : ''
      expect(message).toContain('Git Bash on Windows cannot run confined')
      expect(message).toContain('msys-runtime-startup')
      expect(message).toContain('Use PowerShell for read-only/workspace-write')
      expect(message).toContain('permissions were not changed')
      await expect(start(ctx.shell, spec)).rejects.toMatchObject({ code: SANDBOX_UNAVAILABLE })
    }
    // Fail closed before spawn: neither the command's outside write nor any
    // in-workspace file exists, and every probe scratch directory was removed.
    expect(existsSync(join(root, 'outside.txt'))).toBe(false)
    expect(readdirSync(workspace)).toEqual([])
    expect(probeDirectories().filter(entry => !probesBefore.has(entry))).toEqual([])
  }, 60_000)

  it('names the real MSYS failure the probe observed', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const ctx = await boot('workspace-write', workspace)
    const result = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir: workspace, command: 'true' })))
    // The MSYS runtime's own fatal line is the evidence a maintainer needs to
    // judge this host; the refusal carries it instead of a generic message.
    expect(result).toMatch(/CreateFileMapping|signal pipe/iu)
    expect(result).toContain('Win32 error 5')
  }, 60_000)

  it('refuses a launch directory outside the granted roots before probing', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const probesBefore = new Set(probeDirectories())
    const ctx = await boot('workspace-write', workspace)
    // The repository root is a real directory outside the workspace and outside
    // the mode's granted temp roots.
    const refusal = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir: process.cwd(), command: 'true' })))
    expect(refusal).toContain('outside the granted roots')
    expect(refusal).toContain('was not started')
    // The path guard runs first: no capability probe was needed for a request
    // that can never be served.
    expect(probeDirectories().filter(entry => !probesBefore.has(entry))).toEqual([])
  }, 60_000)

  it('refuses foreign drive mounts, traversal, and device spellings before probing', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const probesBefore = new Set(probeDirectories())
    const ctx = await boot('workspace-write', workspace)
    const workdirs = [
      '/mnt/c/Users',
      '/cygdrive/c/Users',
      // Traversal out of both the workspace and the mode's granted temp areas.
      `${process.cwd()}\\..`,
      '/c/Users/../Windows',
      '\\\\?\\C:\\Windows',
    ]
    for (const workdir of workdirs) {
      const refusal = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir, command: 'true' })))
      expect(refusal, workdir).toContain('was not started')
      expect(refusal, workdir).toContain('launch refused')
    }
    // Only the WSL/Cygwin spellings get the explicit foreign-mount rule; the
    // traversal and device spellings are refused as outside or unplaceable.
    const foreign = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir: '/mnt/c/Users', command: 'true' })))
    expect(foreign).toContain('/mnt/<drive>')
    expect(foreign).toContain('/cygdrive/<drive>')
    // The path guard runs first: none of these requests could be served, so no
    // capability probe and no confined process was started.
    expect(probeDirectories().filter(entry => !probesBefore.has(entry))).toEqual([])
  }, 60_000)

  it('treats a junction that leaves the workspace as outside the boundary', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const link = join(workspace, 'link')
    execFileSync('cmd', ['/c', 'mklink', '/J', link, process.cwd()], { stdio: 'ignore' })
    // The premise: the junction resolves to the repository root, which is
    // outside the workspace even though its spelling is inside it.
    expect(realpathSync.native(link)).toBe(realpathSync.native(process.cwd()))
    const ctx = await boot('workspace-write', workspace)
    const throughLink = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir: link, command: 'true' })))
    expect(throughLink).toContain('outside the granted roots')
    // The workspace itself stays admitted, so this is the reparse point's target
    // and not the spelling that decides the boundary.
    const inside = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir: workspace, command: 'true' })))
    expect(inside).not.toContain('outside the granted roots')
  }, 60_000)

  it('keeps the confined preset unavailable while an approved full-access call still runs', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const ctx = await boot('workspace-write', workspace)
    expect(ctx.shell.sandboxMode).toBe('workspace-write')
    // The deployment default refuses; nothing silently widens the policy.
    await expect(run(ctx.shell, ctx.shell.resolve({ workdir: workspace, command: 'printf a > inside.txt' })))
      .rejects.toMatchObject({ code: SANDBOX_UNAVAILABLE })
    expect(existsSync(join(workspace, 'inside.txt'))).toBe(false)
    // The explicit, caller-approved wider policy is the documented fallback and
    // behaves exactly like the unconfined local executor.
    const approved = await run(ctx.shell, ctx.shell.resolve({
      workdir: workspace,
      command: 'printf approved > inside.txt; printf outside > ../outside.txt',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    }))
    expect(approved.exitCode, approved.stderr.text).toBe(0)
    expect(approved.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf8')).toBe('approved')
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('outside')
    expect(ctx.shell.sandboxMode).toBe('workspace-write')
  }, 60_000)

  it('sheds a forked Bash descendant on timeout', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const pidFile = join(workspace, 'descendant.pid')
    const ctx = await boot('read-only', workspace)
    const result = await run(ctx.shell, ctx.shell.resolve({
      workdir: workspace,
      command: `sleep 300 & child=$!; { cat "/proc/$child/winpid" 2>/dev/null || printf '%s' "$child"; } > '${pidFile}'; wait`,
      timeoutMs: 2_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    }))
    expect(result.timedOut).toBe(true)
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(Number.isInteger(pid)).toBe(true)
    // The managed range owns the whole tree: the forked child dies with it.
    expect(await waitUntilGone(pid)).toBe(true)
  }, 60_000)

  it('sheds a forked Bash descendant on cancellation', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const pidFile = join(workspace, 'descendant.pid')
    const armed = join(workspace, 'armed.txt')
    const ctx = await boot('read-only', workspace)
    const controller = new AbortController()
    const pending = run(ctx.shell, ctx.shell.resolve({
      workdir: workspace,
      command: `sleep 300 & child=$!; { cat "/proc/$child/winpid" 2>/dev/null || printf '%s' "$child"; } > '${pidFile}'; printf armed > '${armed}'; wait`,
      signal: controller.signal,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    }))
    // Abort only after the command published its descendant pid, so the cancel
    // lands on a running tree rather than racing the launch.
    const deadline = Date.now() + 20_000
    while (!existsSync(armed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    expect(existsSync(armed)).toBe(true)
    controller.abort(new Error('test cancellation'))
    const result = await pending
    expect(result.aborted).toBe(true)
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(await waitUntilGone(pid)).toBe(true)
  }, 60_000)

  it('sheds a background Bash process and its descendants when killed', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const pidFile = join(workspace, 'descendant.pid')
    const ctx = await boot('read-only', workspace)
    const proc = await start(ctx.shell, ctx.shell.resolve({
      workdir: workspace,
      command: `sleep 300 & child=$!; { cat "/proc/$child/winpid" 2>/dev/null || printf '%s' "$child"; } > '${pidFile}'; wait`,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    }))
    const deadline = Date.now() + 20_000
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(await waitUntilGone(pid)).toBe(true)
  }, 60_000)

  it('launches the resolved Git for Windows executable through the broker', async () => {
    const root = temporary()
    const workspace = join(root, '中文 workspace')
    mkdirSync(workspace)
    const ctx = await boot('workspace-write', workspace)
    const gitBash = resolveGitBash({}).path
    const approved = await run(ctx.shell, ctx.shell.resolve({
      workdir: workspace,
      command: 'printf "%s" "$BASH_VERSION"; printf ok > "带 空格.txt"',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    }))
    expect(approved.exitCode, approved.stderr.text).toBe(0)
    expect(approved.stdout.text).toMatch(/^\d+\./u)
    expect(readFileSync(join(workspace, '带 空格.txt'), 'utf8')).toBe('ok')
    // Full access runs the very executable the confined launch would have used.
    expect(existsSync(gitBash)).toBe(true)
  }, 60_000)

  it('leaves no writer behind when a read-only refusal follows an approved run', async () => {
    const root = temporary()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const ctx = await boot('read-only', workspace)
    const approved = await run(ctx.shell, ctx.shell.resolve({
      workdir: workspace,
      command: 'printf seed > seed.txt',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workspace },
    }))
    expect(approved.exitCode).toBe(0)
    const refused = await refusalMessage(run(ctx.shell, ctx.shell.resolve({ workdir: workspace, command: 'printf x > refused.txt' })))
    expect(refused).toContain('cannot run confined')
    // The approved write stands; the refused one never happened.
    expect(readFileSync(join(workspace, 'seed.txt'), 'utf8')).toBe('seed')
    expect(existsSync(join(workspace, 'refused.txt'))).toBe(false)
  }, 60_000)
})
