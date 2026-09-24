/**
 * Git Bash broker tests for the sandbox bash executor. The win32 boundary, the
 * launch guard, and the capability probe are driven through the executor's
 * `internals` and the subprocess seam, so every launch decision, the guarded
 * spec, and each probe dimension are pinned deterministically on any host; the
 * real backend against the real Git Bash is exercised in
 * `apps/cli/tests/git-bash-restricted.spec.ts`.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ShellProcess, ShellExecSpec, ShellExecution, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { GIT_BASH_PROBE_DIMENSIONS, isWithinWindowsPathKey, msysPathToWindows, windowsPathKey } from '@deepseek-ai/dsh-shell'
import type { GitBashProbeReport } from '@deepseek-ai/dsh-shell'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SANDBOX_UNAVAILABLE, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { SandboxInternals } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

async function run(executor: SandboxBashExecutor, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await executor.execute(spec)).result()
}

function start(executor: SandboxBashExecutor, spec: ShellExecSpec): Promise<ShellExecution> {
  return executor.execute({ ...spec, onExpiry: 'none' })
}

// POSIX fixtures use the MSYS /tmp mount spelling when simulating Windows.
const fixtureTempRoot = process.platform === 'win32' ? tmpdir() : '/tmp'
const spillDir = mkdtempSync(join(fixtureTempRoot, 'dsh-git-bash-broker-spec-'))
/** Real directories stand in for the execution-world workspace on any host. */
const scratch: string[] = []

function temporary(): string {
  const dir = mkdtempSync(join(fixtureTempRoot, 'dsh-broker-ws-'))
  scratch.push(dir)
  return dir
}

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Every dimension proven: the report of a host that can host confined Git Bash. */
const PROVEN: GitBashProbeReport = { proven: GIT_BASH_PROBE_DIMENSIONS }
/** Only the MSYS runtime proven: writes outside the granted roots are not denied. */
const PARTIAL: GitBashProbeReport = { proven: ['msys-runtime-startup'] }

const EMPTY_READER: SubprocessOutputReader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }

/** One reader over a fixed stderr text. */
function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

/** One recorded provider wrap and the subprocess spawns the executor made. */
interface Recorder {
  wraps: Array<{ argv: string[]; policy: SandboxPolicy }>
  spawns: SubprocessSpawnSpec[]
}

/** A subprocess handle whose outcome the test chooses; no real process is started. */
function fakeHandle(exitCode: number | null, stderr = ''): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: EMPTY_READER, stderr: reader(stderr) },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  }
}

async function setup(options: {
  mode?: SandboxMode
  workspaceRoot: string
  internals?: SandboxInternals
}): Promise<{ ctx: Context; bash: SandboxBashExecutor; recorder: Recorder }> {
  const recorder: Recorder = { wraps: [], spawns: [] }
  class FakeSandboxProvider extends SandboxProvider {
    async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      recorder.wraps.push({ argv: [...argv], policy })
      return {
        argv: [...argv],
        enforcement: 'partial',
        denialSignatures: ['access is denied'],
        runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
      }
    }
  }
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, {
    ...options.mode === undefined ? {} : { mode: options.mode },
    workspaceRoot: options.workspaceRoot,
  })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200 })
  const bash = ctx.shell as SandboxBashExecutor
  bash.internals = options.internals ?? {}
  return { ctx, bash, recorder }
}

/** Record every spawn the executor makes and settle it with `exitCode`. */
function recordSpawns(ctx: Context, recorder: Recorder, exitCode = 0): void {
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    recorder.spawns.push(spec)
    return fakeHandle(exitCode)
  })
}

describe('the Git Bash broker launch path on win32', () => {
  it('runs the guarded spec once the probe proves every dimension', async () => {
    const workspace = temporary()
    const probe = vi.fn(async (): Promise<GitBashProbeReport> => PROVEN)
    const { ctx, bash, recorder } = await setup({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      internals: { platform: 'win32', probeGitBash: probe, tempRoot: fixtureTempRoot },
    })
    recordSpawns(ctx, recorder)
    try {
      const result = await run(bash, bash.resolve({ command: 'printf ok', workdir: workspace }))
      expect(probe).toHaveBeenCalledTimes(1)
      expect(recorder.wraps.map(call => call.argv)).toEqual([[bash.bashPath, '-c', 'printf ok']])
      expect(recorder.wraps[0]?.policy).toMatchObject({ mode: 'workspace-write', workspaceRoot: workspace })
      expect(recorder.spawns).toHaveLength(1)
      expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'partial' })
      // HOME is pinned inside the boundary and the out-of-bound startup-file
      // variables are tombstoned, so neither an inherited `~` nor an inherited
      // startup file reaches the command outside the workspace.
      expect(recorder.spawns[0]?.env).toMatchObject({ BASH_ENV: undefined, ENV: undefined, CDPATH: undefined })
      expect(recorder.spawns[0]?.env?.HOME).toMatch(/^\//u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses an unproven host without wrapping or starting anything', async () => {
    const workspace = temporary()
    const { ctx, bash, recorder } = await setup({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      internals: { platform: 'win32', probeGitBash: async () => PARTIAL, tempRoot: fixtureTempRoot },
    })
    recordSpawns(ctx, recorder)
    try {
      for (const onExpiry of ['kill', 'none'] as const) {
        await expect(bash.execute(bash.resolve({ command: 'printf escaped > ../outside.txt', workdir: workspace, onExpiry })))
          .rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
      }
      await expect(run(bash, bash.resolve({ command: 'true', workdir: workspace })))
        .rejects.toThrow(/write-denial-outside-roots/u)
      expect(recorder.wraps).toEqual([])
      expect(recorder.spawns).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a launch directory outside the granted roots before probing', async () => {
    const workspace = temporary()
    const probe = vi.fn(async (): Promise<GitBashProbeReport> => PROVEN)
    const { ctx, bash, recorder } = await setup({
      mode: 'read-only',
      workspaceRoot: workspace,
      internals: { platform: 'win32', probeGitBash: probe, tempRoot: fixtureTempRoot },
    })
    recordSpawns(ctx, recorder)
    try {
      const outside = join(workspace, '..', 'outside')
      await expect(run(bash, bash.resolve({ command: 'true', workdir: outside })))
        .rejects.toThrow(/outside the granted roots/u)
      await expect(start(bash, bash.resolve({ command: 'true', workdir: outside })))
        .rejects.toMatchObject({ code: SANDBOX_UNAVAILABLE })
      expect(probe).not.toHaveBeenCalled()
      expect(recorder.wraps).toEqual([])
      expect(recorder.spawns).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('publishes a background process through the same guarded launch', async () => {
    const workspace = temporary()
    const { ctx, bash, recorder } = await setup({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      internals: { platform: 'win32', probeGitBash: async () => PROVEN, tempRoot: fixtureTempRoot },
    })
    recordSpawns(ctx, recorder)
    try {
      const proc: ShellProcess = await start(bash, bash.resolve({ command: 'sleep 1', workdir: workspace }))
      await proc.done
      expect(proc.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'partial' })
      expect(recorder.spawns[0]?.env?.HOME).toMatch(/^\//u)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('proves one host once per executable, mode, and workspace', async () => {
    const workspace = temporary()
    const probe = vi.fn(async (): Promise<GitBashProbeReport> => PROVEN)
    const { ctx, bash, recorder } = await setup({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      internals: { platform: 'win32', probeGitBash: probe, tempRoot: fixtureTempRoot },
    })
    recordSpawns(ctx, recorder)
    try {
      await run(bash, bash.resolve({ command: 'true', workdir: workspace }))
      await run(bash, bash.resolve({ command: 'true', workdir: workspace }))
      // A different mode is a different proof.
      await run(bash, bash.resolve({
        command: 'true',
        workdir: workspace,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: workspace },
      }))
      expect(probe.mock.calls.length).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves a non-win32 platform untouched', async () => {
    const workspace = temporary()
    const probe = vi.fn(async (): Promise<GitBashProbeReport> => PROVEN)
    const { ctx, bash, recorder } = await setup({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      internals: { platform: 'linux', probeGitBash: probe },
    })
    recordSpawns(ctx, recorder)
    try {
      await run(bash, bash.resolve({ command: 'true', workdir: workspace }))
      expect(probe).not.toHaveBeenCalled()
      expect(recorder.wraps.map(call => call.argv)).toEqual([[bash.bashPath, '-c', 'true']])
      // No HOME overlay and no tombstones: the platform backend owns the boundary.
      expect(recorder.spawns[0]?.env?.HOME).toBeUndefined()
      expect(recorder.spawns[0]?.env?.CDPATH).toBeUndefined()
      expect(Object.hasOwn(recorder.spawns[0]?.env ?? {}, 'BASH_ENV')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the Git Bash capability probe', () => {
  /** One scripted probe host: what its three confined stages observe. */
  interface ProbeScript {
    /** The first confined run: `bash -c 'exit 0'` under the restricted token. */
    startup: { exitCode: number | null; stderr?: string }
    /** The in-boundary control stage; defaults to the mode's own expectation. */
    inside?: { exitCode: number | null; create?: boolean }
    /** The out-of-boundary denial stage. */
    write: { exitCode: number | null; leak?: boolean; throw?: string }
    /** The policy mode the probe holds under; defaults to `workspace-write`. */
    mode?: 'read-only' | 'workspace-write'
    /** Replaces the candidate scratch bases, e.g. to leave the probe none outside the granted roots. */
    scratchRoots?: readonly string[]
  }

  /** The host path one scripted stage's MSYS-spelled target names. */
  function hostTarget(msysPath: string): string {
    return process.platform === 'win32' ? (msysPathToWindows(msysPath, { tempRoot: fixtureTempRoot }) ?? msysPath) : msysPath
  }

  /** Drive the REAL probe through a scripted subprocess seam. */
  async function probe(script: ProbeScript): Promise<{
    outcome: { exitCode: number | null } | { error: string }
    spawns: SubprocessSpawnSpec[]
    workspace: string
    /** The stages' targets in the host filesystem's own spelling. */
    insideTarget: string
    outsideTarget: string
  }> {
    const workspace = temporary()
    const mode = script.mode ?? 'workspace-write'
    const { ctx, bash, recorder } = await setup({
      mode,
      workspaceRoot: workspace,
      internals: {
        platform: 'win32',
        tempRoot: fixtureTempRoot,
        ...script.scratchRoots === undefined ? {} : { probeScratchRoots: script.scratchRoots },
      },
    })
    let invocation = 0
    let insideTarget = ''
    let outsideTarget = ''
    const inside = script.inside ?? (mode === 'workspace-write' ? { exitCode: 0, create: true } : { exitCode: 1, create: false })
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      recorder.spawns.push(spec)
      invocation += 1
      if (invocation === 1) return fakeHandle(script.startup.exitCode, script.startup.stderr ?? '')
      if (invocation === 2) {
        // The probe names each target in the MSYS spelling Git Bash resolves;
        // the scripted outcome must act on that very file, so the host path is
        // derived with the broker's own MSYS-to-Windows placement.
        insideTarget = hostTarget(spec.argv.at(-1) ?? '')
        if (inside.create === true) writeFileSync(insideTarget, 'probe')
        return fakeHandle(inside.exitCode)
      }
      if (invocation === 3) {
        outsideTarget = hostTarget(spec.argv.at(-1) ?? '')
        if (script.write.throw !== undefined) throw new Error(script.write.throw)
        if (script.write.leak === true) writeFileSync(outsideTarget, 'probe')
        return fakeHandle(script.write.exitCode)
      }
      return fakeHandle(0)
    })
    try {
      const result = await run(bash, bash.resolve({ command: 'true', workdir: workspace }))
        .then(outcome => ({ exitCode: outcome.exitCode }))
        .catch((error: unknown) => ({ error: String(error) }))
      return { outcome: result, spawns: recorder.spawns, workspace, insideTarget, outsideTarget }
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('proves both dimensions when the runtime starts and the mode boundary holds', async () => {
    const run = await probe({ startup: { exitCode: 0 }, write: { exitCode: 1 } })
    // Both dimensions proven: the real command runs through the wrap.
    expect(run.outcome).toEqual({ exitCode: 0 })
    expect(run.spawns).toHaveLength(4)
    expect(run.spawns[1]?.argv.slice(1)).toEqual(['-c', 'printf probe > "$1"', 'dsh-git-bash-probe', run.spawns[1]?.argv.at(-1)])
    // The control write lands inside the workspace; the denial write is aimed
    // outside the workspace AND outside its granted temp roots.
    const workspaceKey = windowsPathKey(run.workspace)
    expect(isWithinWindowsPathKey(workspaceKey, windowsPathKey(run.insideTarget))).toBe(true)
    expect(isWithinWindowsPathKey(workspaceKey, windowsPathKey(run.outsideTarget))).toBe(false)
    expect(isWithinWindowsPathKey(windowsPathKey(tmpdir()), windowsPathKey(run.outsideTarget))).toBe(false)
    // Every probe directory is deleted, so a probe cannot become a standing artifact.
    expect(existsSync(run.insideTarget)).toBe(false)
    expect(existsSync(run.outsideTarget)).toBe(false)
  })

  it('proves read-only when both the workspace write and the outside write are denied', async () => {
    const run = await probe({ mode: 'read-only', startup: { exitCode: 0 }, write: { exitCode: 1 } })
    expect(run.outcome).toEqual({ exitCode: 0 })
    expect(existsSync(run.insideTarget)).toBe(false)
  })

  it('reports the MSYS startup failure as the unproven dimension', async () => {
    const run = await probe({
      startup: { exitCode: 1, stderr: 'fatal error - CreateFileMapping, Win32 error 5.  Terminating.\n' },
      write: { exitCode: 1 },
    })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('CreateFileMapping') as string })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('msys-runtime-startup') as string })
    // The boundary stages are never reached when the runtime cannot start.
    expect(run.spawns).toHaveLength(1)
  })

  it('reports a runner failure as its own diagnostic', async () => {
    const run = await probe({ startup: { exitCode: 127, stderr: 'windows-acl-run: token creation failed\n' }, write: { exitCode: 1 } })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('windows-acl-run: token creation failed') as string })
  })

  it('fails closed when the confined write leaks outside the granted roots', async () => {
    const run = await probe({ startup: { exitCode: 0 }, write: { exitCode: 1, leak: true } })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('outside every writable root') as string })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('write-denial-outside-roots') as string })
    // The probe's own leak is deleted, so it cannot become a standing artifact.
    expect(existsSync(run.outsideTarget)).toBe(false)
  })

  it('fails closed when the write reports success without creating the file', async () => {
    const run = await probe({ startup: { exitCode: 0 }, write: { exitCode: 0 } })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('without creating it') as string })
  })

  it('refuses to prove the boundary when the mode denies its own workspace write', async () => {
    const run = await probe({
      startup: { exitCode: 0 },
      inside: { exitCode: 1, create: false },
      write: { exitCode: 1 },
    })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('could not write inside the granted workspace root') as string })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('write-denial-outside-roots') as string })
    // A backend that denies everything never gets to be called confined.
    expect(run.spawns).toHaveLength(2)
  })

  it('refuses to prove read-only that still allows an in-workspace write', async () => {
    const run = await probe({
      mode: 'read-only',
      startup: { exitCode: 0 },
      inside: { exitCode: 0, create: true },
      write: { exitCode: 1 },
    })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('inside the workspace under read-only') as string })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('write-denial-outside-roots') as string })
  })

  it('keeps the dimension unproven when no base outside the granted roots exists', async () => {
    // With no host-writable candidate outside the granted roots, no denial
    // observation can establish the write boundary.
    const run = await probe({ startup: { exitCode: 0 }, write: { exitCode: 1 }, scratchRoots: [] })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('no scratch directory outside every writable root') as string })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('write-denial-outside-roots') as string })
    expect(run.spawns).toHaveLength(1)
  })

  it('reports a provider or spawn failure instead of propagating it', async () => {
    const run = await probe({ startup: { exitCode: 0 }, write: { exitCode: 1, throw: 'runner executable is missing' } })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('runner executable is missing') as string })
    expect(run.outcome).toMatchObject({ error: expect.stringContaining('could not run') as string })
  })
})
