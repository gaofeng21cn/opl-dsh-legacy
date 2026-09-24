# Agent Note: Windows ordinary subprocess targets own a hidden console

Status: implemented

English | [中文](2026-09-22-windows-ordinary-target-hidden-console.zh.md)

## Problem

Every tool call in a packaged Windows Desktop opened a blank terminal window over the user's foreground for the whole duration of the command. A top-level-window watcher on the affected machine recorded a new `CASCADIA_HOSTING_WINDOW_CLASS` window of 1199x616 pixels, `visible=false` at creation, `visible=true` milliseconds later, and destroyed when the command exited: once per ordinary command, again per cancelled command, so a two-second command showed the window for about two seconds. Source and development runs never showed it.

The launch chain is the whole cause. The Electron shell spawns the dsh Host with `windowsHide`; the Host spawns the Windows Job runner as `process.execPath` with `windowsHide`; the runner creates the ordinary target through `CreateProcessW(..., CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, ...)`. In a packaged application `process.execPath` is the Electron binary — a GUI-subsystem image — and Windows documents `CREATE_NO_WINDOW` as ignored for an application that is not a console application, so neither the Host nor the runner holds a console. A console-subsystem target (`bash.exe`, `git.exe`, `node.exe`, `pwsh.exe`) created with no console to inherit therefore receives a fresh console allocation, and Windows hands that allocation to the default terminal application, which renders it as a window. The assumption that a target inherits the runner's hidden console holds only where the runner image is itself a console application, which is the source and development form (`node.exe`) and not the packaged one.

## Decision

`spawnCurrentTokenJobProcess()` passes `CREATE_NO_WINDOW` alongside `CREATE_SUSPENDED` and `CREATE_UNICODE_ENVIRONMENT`, so every ordinary Windows target owns a hidden console and its descendants inherit that console instead of asking Windows for one. `abi.ts` owns the constant next to the other `CreateProcess` flags.

The runner keeps `windowsHide: true`: it is what hides a console-subsystem runner image, and it is not what a packaged GUI runner needs. The [Desktop execution environments](../architecture/2026-09-22-desktop-execution-environments.md) record's claim that hiding the runner keeps tool calls off the user's foreground is corrected here to the creation flag.

The restricted-token path keeps its flags unchanged. `spawnInheritedJobProcess()` (`CreateProcessAsUserW`, the Windows ACL sandbox child) still creates no console of its own, because `CREATE_NO_WINDOW` under a `WRITE_RESTRICTED` token dies with `STATUS_DLL_INIT_FAILED`. Nothing about the sandbox, its SID lists, or its refusal of Git Bash in a confined mode changes; the ordinary target's new hidden console is inherited, not requested, by the confined child.

## Alternatives considered

**Spawn the runner as the bundled Node.js runtime executable.** A console-subsystem runner would own a hidden console that its ordinary *and* confined children inherit, closing the restricted-token window too. It was not taken here because it changes which executable performs every packaged tool call, along with that runner's resolution and native-module loading, to fix a defect that the creation flag already removes from the reported path.

**`CREATE_NEW_CONSOLE`.** It exists to create a console window, which is the symptom.

**`DETACHED_PROCESS` on the target.** A detached process has no console, so every console-subsystem grandchild allocates its own window: the same defect one level down.

**`AllocConsole()` in the runner followed by `ShowWindow(SW_HIDE)`.** The window exists before it can be hidden, and that first appearance is the disturbance being fixed; hiding it afterwards also makes the outcome depend on scheduling.

**`CREATE_NO_WINDOW` in `spawnInheritedJobProcess()`.** The confined child dies during DLL initialization (`STATUS_DLL_INIT_FAILED`), which the sandbox README records as measured.

## Consequences

The packaged Desktop no longer opens a console window for an ordinary Windows command, and `git.exe`, `node.exe`, `pwsh.exe`, and any other console-subsystem descendant inherit the target's hidden console rather than allocating one. Stdio dispositions, exit codes, argv quoting, Unicode and space-bearing paths, Job-owned process-tree cancellation, and the ConPTY terminal path are untouched: the flag decides console allocation only, and Node's `windowsHide` already applies the same flag wherever the harness spawns a console-subsystem child directly.

A target can no longer present a console of its own. Nothing in the harness relies on that: model commands are background children with redirected stdio, and a terminal the user opens is a ConPTY session on the terminal seam, not an ordinary spawn.

Two Windows console sources remain, both measured rather than assumed away. A confined restricted-token child still allocates a window, because it cannot request a hidden console and its parent — the windows-acl runner, another GUI-subsystem Electron image — has none to pass on; that path stays as it is until a runner image owns a console. The win32 sandbox rung's functional probe spawns its runner through `spawnSync` outside this boundary, so an override chain that probes that rung can still allocate a window; the product chain never probes it.

## Testing

`packages/subprocess/win32-process/tests/ordinary-process.spec.ts` pins the exact ordinary creation flags, including `CREATE_NO_WINDOW`, in the same assertion that pins Job assignment and resume order; it fails when the flag is removed.

Real window observation used the packaged topology on Windows 11: a detached GUI Electron parent (no console) → `LocalSubprocessRuntime.spawn()` → `probeWindowsJob()` → Job runner → `bash.exe`. On the pre-fix source the watcher recorded a visible Windows Terminal window for a foreground command and for a cancelled command; with the flag it recorded no console window for a foreground command, a cancelled command, or a persistent ConPTY terminal, while reporting the command's exit code, output, cancellation, and terminal echo. A `cmd /c echo` under a read-only restricted token still showed the window, which is the residual above.
