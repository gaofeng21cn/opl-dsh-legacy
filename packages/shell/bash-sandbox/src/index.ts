/**
 * Sandbox-consuming bash executor. It wraps the exact local bash argv through
 * `ctx.sandbox`, inherits local process mechanics, and reports the selected
 * mode, enforcement, and denial facts. Positive runner-executable evidence
 * identifies a broken confinement runner: foreground calls throw
 * `SANDBOX_UNAVAILABLE`, while background processes carry `runnerFailed`;
 * other provider rejections retain stage-neutral local-executor semantics. The
 * tool owns approval and passes a complete per-call policy.
 *
 * On Windows the executor is the Git Bash broker's launch site: before any
 * confined command, the broker
 * ({@link @deepseek-ai/dsh-shell!guardGitBashLaunch}) bounds the launch
 * parameters it owns, and a probe runs the real backend against the real Git
 * Bash to prove the MSYS runtime starts confined and the mode's write boundary
 * holds — an in-workspace write follows the mode and an out-of-boundary write
 * is denied
 * ({@link @deepseek-ai/dsh-shell!decideGitBashConfinement}). While a dimension
 * stays unproven the launch is refused with `SANDBOX_UNAVAILABLE` — never
 * downgraded to an unconfined run — and the caller's only wider path is an
 * explicitly approved `danger-full-access` call.
 * @module @deepseek-ai/dsh-bash-sandbox
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { SandboxUnavailableError, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { brokerAbsolutePath, decideGitBashConfinement, gitForWindowsRoot, guardGitBashLaunch, isWithinWindowsPathKey, windowsPathKey, windowsPathToMsys } from '@deepseek-ai/dsh-shell'
import type { GitBashMounts, GitBashProbeDimension, GitBashProbeReport } from '@deepseek-ai/dsh-shell'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './helpers.ts'

/**
 * Plugin config: the local executor's knobs, verbatim. The sandbox policy —
 * the default mode and fallback `workspace-write` root — is NOT here: it lives
 * on `ctx.sandboxPolicy` (`@deepseek-ai/dsh-sandbox-policy`), which resolves
 * each calling session's mode and cwd for every enforcing capability. The runner
 * choice is likewise the `ctx.sandbox` provider's config, not this executor's.
 */
export type Config = LocalConfig

/**
 * The Git Bash capability probe's budget. A security invariant rather than a
 * deployment knob: the proof gates every confined launch, so its bound stays
 * fixed instead of moving with a caller's own timeout.
 */
const GIT_BASH_PROBE_TIMEOUT_MS = 10_000

/**
 * The `$0` entry the probe passes before its own positional arguments: `bash -c`
 * consumes it as the shell name, so the probe's first argument stays `$1` and no
 * probe path is ever re-parsed as shell text.
 */
const GIT_BASH_PROBE_ARGV0 = 'dsh-git-bash-probe'

/**
 * The probe's own directory prefix. The process id keeps concurrently running
 * hosts' probe directories distinguishable, so a test can assert that a launch
 * never reached the probe without racing another worker.
 */
const PROBE_DIRECTORY_PREFIX = `dsh-git-bash-probe-${process.pid}-`

/**
 * The probe's write command: it creates exactly `$1` through the confined
 * shell, so whether that file exists afterwards is the evidence the mode's
 * boundary holds. The target is a positional argument, never shell text.
 */
const PROBE_WRITE_COMMAND = 'printf probe > "$1"'

/** Test hooks mirroring the sibling executors' `internals` seam. */
export interface SandboxInternals {
  /** Replaces `process.platform` for the Git Bash broker (exercise the win32 boundary from any host). */
  platform?: NodeJS.Platform
  /** Replaces the Git Bash capability probe: the launch decision without running one. */
  probeGitBash?: (policy: SandboxPolicy) => Promise<GitBashProbeReport>
  /** Replaces the filesystem canonicalizer the launch guard resolves reparse points with. */
  canonicalizePath?: (path: string) => string
  /** Replaces the MSYS `/tmp` mount target the launch guard places paths under. */
  tempRoot?: string
  /**
   * Replaces the candidate bases the capability probe searches for its
   * out-of-boundary scratch directory, most preferred first (pin the choice,
   * or leave the probe no usable base).
   */
  probeScratchRoots?: readonly string[]
}

/**
 * Registers as `ctx.shell` in place of the local executor and requires a
 * `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
 * unchanged. Tool calls pass the calling session's resolved policy; direct
 * calls fall back to deployment policy. `result.sandbox` reports the mode and
 * enforcement actually used.
 */
export class SandboxBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  // No own Config: the sandbox default (mode + workspaceRoot) is owned by
  // ctx.sandboxPolicy, so this executor inherits LocalBashExecutor's Config
  // verbatim (the config catalog walks the inherited static).

  /** Test hook (mirrors the sandbox provider's and bash-local's `internals`). */
  internals: SandboxInternals = {}

  private readonly mode: SandboxMode
  /**
   * Per-process confinement facts retained until settlement. Providers may
   * vary enforcement and diagnostic dialect between overlapping calls, so a
   * shared latest-wrap value would classify a process against the wrong facts.
   * Unconfined processes have no entry.
   */
  private readonly processFacts = new Map<ShellProcess, {
    mode: ConfinedSandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
    runnerProgram: string | undefined
    workdir: string
  }>()

  /**
   * One Git Bash capability proof per (executable, mode, workspace): the
   * verdict is a host fact established by running the backend, so it is
   * resolved once and reused. A refused dimension is cached too — the proof is
   * deterministic, and re-probing per command would pay the runner spawn again
   * for the same answer.
   */
  private readonly gitBashProbes = new Map<string, Promise<GitBashProbeReport>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // The default mode is the capability fact used for schema advertisement;
    // actual tool executions carry their resolved per-call policy.
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  override get sandboxMode(): SandboxMode {
    return this.mode
  }

  /**
   * Stamp a complete per-call policy onto the spec. Tool calls supply the
   * calling session's resolved mode and root; lower-level callers fall back to
   * the deployment policy.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      return SandboxBashExecutor.decorateResult(
        await super.execute(spec),
        result => ({ ...result, sandbox: { mode, denied: false } }),
      )
    }
    // The launch guard is a synchronous decision over caller-owned parameters,
    // so it resolves before the execution deadline starts and the guarded spec
    // is the one this foreground run spawns.
    const guarded = this.guardedSpec(spec, { ...policy, mode })
    let confined: ConfinedArgv | undefined
    const ex = await this.executeArgv(guarded, async (signal) => {
      const prepared = await this.confine(guarded, { ...policy, mode }, signal)
      signal.throwIfAborted()
      confined = prepared
      return prepared.argv
    }, (process) => {
      const facts = confined as ConfinedArgv
      this.processFacts.set(process, {
        mode,
        enforcement: facts.enforcement,
        denialSignatures: facts.denialSignatures,
        runnerFailureRules: facts.runnerFailureRules,
        runnerProgram: facts.argv[0],
        workdir: guarded.workdir,
      })
    })
    return SandboxBashExecutor.decorateResult(ex, (result) => {
      if (confined === undefined) return { ...result, sandbox: { mode, denied: false } }
      const { enforcement, denialSignatures, runnerFailureRules } = confined
      // Runner failure outranks denial because the command did not run. Carry
      // the matched fatal line, not an informational line that preceded it.
      const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, runnerFailureRules)
      if (runnerFailure !== undefined) {
        throw new SandboxUnavailableError(mode, runnerFailure.detail)
      }
      return { ...result, sandbox: { mode, denied: classifyDenial(result, denialSignatures), enforcement } }
    }, (error) => {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], guarded.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    })
  }

  /**
   * Decorate the handle's foreground projection in place, memoized once. The
   * handle keeps its identity (never wrapped in a second object) because the
   * per-process facts and `onProcessDone` key on the exact instance.
   */
  private static decorateResult(
    ex: ShellExecution,
    map: (result: ShellRunResult) => ShellRunResult,
    mapError?: (error: unknown) => never,
  ): ShellExecution {
    const base = ex.result.bind(ex)
    let decorated: Promise<ShellRunResult> | undefined
    ex.result = () => {
      decorated ??= base().then(map, mapError)
      return decorated
    }
    return ex
  }

  /**
   * Stamp per-process sandbox facts before `done` settles. Full-access processes
   * have no facts; signal deaths are not denials.
   */
  protected override onProcessDone(proc: ShellProcess, stderr: string, providerRejected: boolean, providerError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      // A provider rejection exposes no public failure stage. Attribute it to
      // the confinement runner only when the error independently names argv[0].
      // Otherwise settled runner failure outranks denial-like diagnostics.
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = {
        mode: facts.mode,
        denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      }
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError)
  }

  /**
   * Bound the launch parameters the Git Bash broker owns, before any process
   * starts: the launch directory must resolve inside the mode's granted roots
   * (normalized from either world's spelling), and the environment overlay pins
   * HOME inside the workspace while tombstoning the out-of-bound startup-file
   * variables. Off win32 nothing is constrained — the platform backend confines
   * bash itself.
   * @param spec - resolved execution spec about to be wrapped.
   * @param policy - resolved confined execution policy.
   * @returns the guarded spec (normalized workdir, environment overlay), or the caller's spec unchanged.
   * @throws SandboxUnavailableError when the launch parameters leave the boundary.
   */
  private guardedSpec(spec: ShellExecSpec, policy: SandboxPolicy): ShellExecSpec {
    const platform = this.internals.platform ?? process.platform
    if (platform !== 'win32') return spec
    const guard = guardGitBashLaunch({
      platform,
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      workdir: spec.workdir,
      grantedRoots: writableRoots(policy),
      ...this.gitBashMounts(),
      ...this.internals.canonicalizePath === undefined ? {} : { canonicalize: this.internals.canonicalizePath },
    })
    if (!guard.ok) throw new SandboxUnavailableError(policy.mode, guard.detail)
    return { ...spec, workdir: guard.workdir, env: { ...spec.env, ...guard.env } }
  }

  /**
   * Wrap one bash invocation via the `ctx.sandbox` provider. Provider errors
   * propagate unchanged; the returned argv is handed directly to the local
   * executor's subprocess path.
   *
   * The argv comes from {@link LocalBashExecutor.argv}, so confinement wraps
   * exactly the executable the executor would have spawned unconfined — the
   * Git for Windows bash on a Windows Native host, the POSIX bash elsewhere.
   * On Windows the broker's probed capability gates the wrap: a dimension that
   * stays unproven refuses the launch instead of running unconfined.
   * @param spec - the guarded resolved execution spec whose bash argv is confined.
   * @param policy - resolved confined execution policy.
   * @param signal - cancellation of confinement preparation.
   * @returns the provider's exact argv and settlement-classification facts.
   * @throws SandboxUnavailableError when the host has not proven Git Bash confinement.
   */
  private async confine(spec: ShellExecSpec, policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    const platform = this.internals.platform ?? process.platform
    const decision = decideGitBashConfinement({
      mode: policy.mode,
      platform,
      ...platform !== 'win32' ? {} : { probe: await this.gitBashProbe(policy) },
    })
    if (decision.kind === 'refused') throw new SandboxUnavailableError(policy.mode, decision.detail)
    return this.ctx.sandbox.confine(this.argv(spec), policy, signal)
  }

  /**
   * This host's Git Bash capability proof, resolved once per (executable, mode,
   * workspace) and shared by overlapping calls.
   * @param policy - the resolved confined policy the proof must hold under.
   * @returns the probe report; a configured test hook answers the same cached resolution.
   */
  private gitBashProbe(policy: SandboxPolicy): Promise<GitBashProbeReport> {
    const key = JSON.stringify([this.bashPath, policy.mode, policy.workspaceRoot])
    const cached = this.gitBashProbes.get(key)
    if (cached !== undefined) return cached
    const pending = this.internals.probeGitBash?.(policy) ?? this.runGitBashProbe(policy)
    this.gitBashProbes.set(key, pending)
    return pending
  }

  /**
   * Prove the confined Git Bash dimensions by running the real executable
   * through the real backend. `msys-runtime-startup` is the MSYS runtime
   * initializing under the restricted token at all; `write-denial-outside-roots`
   * is the mode's write boundary holding, proven as a pair: a write INSIDE the
   * workspace must follow the mode (created under `workspace-write`, denied
   * under `read-only`) and a write outside every writable root must be denied.
   * The in-boundary control is what separates an enforced boundary from a
   * backend that denies everything or a probe command that never runs. A
   * dimension that does not hold is reported with its observed evidence, and
   * every probe directory is deleted before returning.
   * @param policy - the resolved confined policy to probe under.
   * @returns the proven dimensions and the first unproven dimension's evidence.
   */
  private async runGitBashProbe(policy: SandboxPolicy): Promise<GitBashProbeReport> {
    const proven: GitBashProbeDimension[] = []
    const startup = await this.ctx.sandbox.confine([this.bashPath, '-c', 'exit 0'], policy)
    const startResult = await this.runProbeCommand('exit 0', policy, startup.argv)
    if (startResult.exitCode !== 0) {
      const runnerFailure = classifyRunnerFailure(startResult.exitCode, startResult.stderr, startup.runnerFailureRules)
      return { proven, evidence: runnerFailure?.detail ?? lastStderrLine(startResult.stderr) }
    }
    proven.push('msys-runtime-startup')
    const outsideRoot = this.createDenialProbeRoot(policy)
    if (outsideRoot === undefined) {
      return {
        proven,
        evidence: 'the probe found no scratch directory outside every writable root of this mode, so a write the '
          + 'mode must deny cannot be observed; the write-denial dimension stays unproven',
      }
    }
    const insideRoot = this.createControlProbeRoot(policy)
    try {
      const inside = insideRoot === undefined ? undefined : join(insideRoot, 'inside-probe.txt')
      if (inside !== undefined) {
        const control = await this.runWriteProbe(policy, inside)
        const created = existsSync(inside)
        if (policy.mode === 'workspace-write' && (!created || control.exitCode !== 0)) {
          return {
            proven,
            evidence: `the confined Git Bash could not write inside the granted workspace root: ${describeProbeWrite(control, created)}`,
          }
        }
        if (policy.mode === 'read-only' && created) {
          return { proven, evidence: `the confined Git Bash wrote ${inside} inside the workspace under read-only` }
        }
        // A read-only control that never ran proves nothing about the denial,
        // exactly like the out-of-boundary write below.
        if (policy.mode === 'read-only' && control.exitCode === null) return { proven, evidence: control.stderr }
      } else if (policy.mode === 'workspace-write') {
        return {
          proven,
          evidence: `the probe could not create a control directory inside the workspace root ${JSON.stringify(policy.workspaceRoot)}`,
        }
      }
      const outside = join(outsideRoot, 'outside-probe.txt')
      const denial = await this.runWriteProbe(policy, outside)
      if (existsSync(outside)) {
        return { proven, evidence: `the confined Git Bash wrote ${outside} outside every writable root of this mode` }
      }
      // Denial needs positive evidence: the write must have RUN and failed. A
      // probe that never started, or one that reported success without creating
      // the file, proves nothing about the boundary.
      if (denial.exitCode === null) return { proven, evidence: denial.stderr }
      if (denial.exitCode === 0) {
        return { proven, evidence: `the confined Git Bash reported success writing ${outside} without creating it` }
      }
      proven.push('write-denial-outside-roots')
      return { proven }
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true })
      if (insideRoot !== undefined) rmSync(insideRoot, { recursive: true, force: true })
    }
  }

  /**
   * The scratch directory the probe's denial write targets. It must sit outside
   * every root the mode may write — the policy's {@link writableRoots}
   * (workspace plus platform temp areas), not just the workspace — because the
   * dimension means "a write the mode does not grant is denied": a target
   * inside a granted temp area would make a correctly confined host report a
   * leak. A candidate base is used only when the HARNESS can create and write a
   * directory there unconfined, which is what makes the confined denial
   * evidence about confinement rather than about the location.
   * @param policy - the resolved confined policy the probe holds under.
   * @returns the scratch directory, or undefined when no candidate works (the
   *   dimension then stays unproven).
   */
  private createDenialProbeRoot(policy: SandboxPolicy): string | undefined {
    const mounts = this.gitBashMounts()
    const granted = [policy.workspaceRoot, ...writableRoots(policy)]
      .map(root => brokerAbsolutePath(root, mounts))
      .filter((root): root is string => root !== undefined)
      .map(root => windowsPathKey(root))
    for (const candidate of this.internals.probeScratchRoots ?? denialProbeBaseCandidates(policy)) {
      const placed = placeScratchBase(candidate, mounts)
      if (placed === undefined) continue
      const key = windowsPathKey(placed)
      // A filesystem root is never a probe base: it is normally unwritable and
      // leaving probe directories there would be an unwarranted side effect.
      if (windowsPathKey(dirname(placed)) === key) continue
      if (granted.some(root => isWithinWindowsPathKey(root, key))) continue
      const scratch = createWritableScratch(placed)
      if (scratch !== undefined) return scratch
    }
    return undefined
  }

  /**
   * A scratch directory inside the policy's workspace for the probe's
   * in-boundary control write. Undefined when the harness itself cannot create
   * one: that leaves a `workspace-write` probe unproven (the harness cannot
   * write to the workspace the mode promises), while a `read-only` probe
   * proceeds without the optional control.
   */
  private createControlProbeRoot(policy: SandboxPolicy): string | undefined {
    const workspace = hostAddressablePath(policy.workspaceRoot, this.gitBashMounts())
    try {
      return mkdtempSync(join(workspace, PROBE_DIRECTORY_PREFIX))
    } catch {
      // A missing or unwritable workspace cannot host the control directory;
      // the caller decides whether that leaves the dimension unproven.
      return undefined
    }
  }

  /** Run the probe's write command against one absolute Windows target through the real wrap. */
  private async runWriteProbe(
    policy: SandboxPolicy,
    target: string,
  ): Promise<{ exitCode: number | null; stderr: string }> {
    const command = PROBE_WRITE_COMMAND
    const wrapped = await this.ctx.sandbox.confine([this.bashPath, '-c', command], policy)
    return this.runProbeCommand(command, policy, wrapped.argv, [windowsPathToMsys(target)])
  }

  /**
   * The MSYS mount targets the probe places paths under, matching the ones the
   * launch guard uses for the same launch.
   */
  private gitBashMounts(): GitBashMounts {
    const installationRoot = gitForWindowsRoot(this.bashPath)
    return {
      ...installationRoot === undefined ? {} : { installationRoot },
      ...this.internals.tempRoot === undefined ? {} : { tempRoot: this.internals.tempRoot },
    }
  }

  /**
   * Run one probe command under an already-resolved wrap, with the probe's own
   * fixed budget. A provider or executor failure is evidence about the host, not
   * a caller-visible error, so it settles as a failed probe.
   * @param command - the bash command the probe runs.
   * @param policy - the resolved confined policy supplying the probe's cwd.
   * @param wrappedArgv - the provider's confined argv for this probe command.
   * @param args - positional arguments appended to the wrapped argv.
   * @returns the probe's exit code and stderr, or a synthetic failure.
   */
  private async runProbeCommand(
    command: string,
    policy: SandboxPolicy,
    wrappedArgv: readonly string[],
    args: readonly string[] = [],
  ): Promise<{ exitCode: number | null; stderr: string }> {
    const probeSpec: ShellExecSpec = {
      command,
      workdir: policy.workspaceRoot,
      timeoutMs: GIT_BASH_PROBE_TIMEOUT_MS,
      onExpiry: 'kill',
      stdoutMaxBytes: 4_096,
      sandboxPolicy: undefined,
    }
    try {
      const execution = await this.executeArgv(probeSpec, [...wrappedArgv, GIT_BASH_PROBE_ARGV0, ...args])
      const result = await execution.result()
      if (result.timedOut || result.aborted) return { exitCode: null, stderr: 'the capability probe was interrupted before it completed' }
      return { exitCode: result.exitCode, stderr: result.stderr.text }
    } catch (error) {
      return { exitCode: null, stderr: `the capability probe could not run: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/** The last non-empty stderr line, the MSYS runtime's own failure diagnostic. */
function lastStderrLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/u).filter(line => line.trim().length > 0)
  return lines.at(-1) ?? 'the confined Git Bash exited non-zero without a diagnostic'
}

/**
 * Candidate bases for the probe's out-of-boundary scratch directory, most
 * preferred first: the user profile, the workspace's parent, and the temp
 * root's parent. A base inside any granted root is skipped by the caller, so
 * the list only needs to offer the locations a host normally allows the
 * harness to create a directory in.
 */
function denialProbeBaseCandidates(policy: SandboxPolicy): readonly string[] {
  return [...new Set([homedir(), dirname(policy.workspaceRoot), dirname(tmpdir())])]
}

/**
 * The path the HOST can create directories under for one policy path: the
 * broker's Windows/MSYS placement on win32, and the spelling as given on a
 * POSIX host — including a host where the win32 platform is injected for the
 * boundary under test, whose filesystem still addresses POSIX paths.
 */
function hostAddressablePath(path: string, mounts: GitBashMounts): string {
  if (process.platform !== 'win32') return path
  return brokerAbsolutePath(path, mounts) ?? path
}

/**
 * Place one candidate base so it can be compared against the granted roots and
 * created on disk: through the broker on win32, and as the host spells it
 * everywhere else (the comparison then applies the win32 key to both sides).
 */
function placeScratchBase(base: string, mounts: GitBashMounts): string | undefined {
  if (process.platform !== 'win32') return isAbsolute(base) ? base : undefined
  return brokerAbsolutePath(base, mounts)
}

/**
 * Create and prove a scratch directory under one base: `mkdtemp` proves the
 * harness may create it, and a written-then-removed marker proves it is
 * writable to the harness, so a confined write denied there is evidence about
 * the sandbox rather than about the location.
 * @param base - the placed candidate base.
 * @returns the scratch directory, or undefined when the base is missing or
 *   unwritable (the caller tries the next candidate).
 */
function createWritableScratch(base: string): string | undefined {
  let dir: string
  try {
    dir = mkdtempSync(join(base, PROBE_DIRECTORY_PREFIX))
  } catch {
    // A missing base or one the harness may not write is not usable; there is
    // nothing to clean up.
    return undefined
  }
  try {
    const marker = join(dir, 'writable-marker')
    writeFileSync(marker, 'probe')
    rmSync(marker)
    return dir
  } catch {
    // The directory exists but the harness cannot write in it, so a confined
    // denial there would not be evidence about confinement; discard it.
    rmSync(dir, { recursive: true, force: true })
    return undefined
  }
}

/** One probe write's observable outcome, for the unproven dimension's evidence. */
function describeProbeWrite(result: { exitCode: number | null; stderr: string }, created: boolean): string {
  const exit = result.exitCode === null ? 'it did not finish' : `exit code ${String(result.exitCode)}`
  const file = created ? 'the file exists' : 'the file was not created'
  const detail = result.stderr.trim().length === 0 ? '' : `: ${lastStderrLine(result.stderr)}`
  return `${exit} and ${file}${detail}`
}

export default SandboxBashExecutor
