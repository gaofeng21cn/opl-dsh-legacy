# Agent Note: Native Agent shell selection

Status: implemented

English | [中文](2026-09-22-native-agent-git-bash.zh.md)

## Problem

Native Windows agents need Bash command syntax without moving their sessions or tools into WSL. Selecting only an integrated terminal does not change model-facing tools or subprocess execution.

## Decision

The shipped boot captures the shell choice and optional Git for Windows path once. The host executor and all four presets consume that startup selection. The settings card saves related fields atomically, validates executable identity, and states that shell changes require a full restart. Execution budgets remain live. Windows continues to default to PowerShell; POSIX hosts continue to use Bash.

Git Bash in a confined Windows mode is brokered rather than assumed. The one-shot bash executor bounds the launch parameters it owns — the working directory must resolve inside the mode's granted roots after MSYS/Windows spellings, `..` traversal, drive switches, UNC prefixes, and reparse points are unified into one comparison key, with HOME pinned to the workspace and out-of-bound shell startup variables tombstoned — and then runs the real backend against the real executable. The capability probe proves two dimensions: the MSYS runtime starts under the restricted token, and the mode's write boundary holds as a pair (an in-workspace write follows the mode — created under `workspace-write`, denied under `read-only` — while a write outside every writable root is denied). A dimension that stays unproven refuses the launch with `SANDBOX_UNAVAILABLE` before spawn rather than downgrading to an unconfined run.

Path normalization follows the mounts Git for Windows actually defines: `/c/…` is a drive, `/tmp/…` the user temp directory, `//server/share/…` a UNC share, and every other absolute MSYS path sits under the installation root behind `/`. `/mnt/…` and `/cygdrive/…` are refused as Windows Subsystem for Linux and Cygwin drive spellings Git Bash does not mount, rather than being guessed at as drives. On current hosts the restricted token cannot initialize MSYS's per-user shared mapping, so Git Bash runs only under explicitly approved `danger-full-access`. The persistent PTY terminal keeps a static refusal, because its session shell exists before any capability probe could authorize it. MSYS creates those per-user objects with security descriptors naming the user SID, which the restricted token's write check never matches, and adding the user SID to the restricting list would equally authorize every ambient write; the modes bound file writes only, so reads, process launches, and network access stay with the approval layer and the host's own rights.

## Alternatives considered

Hot-switching only the executor would leave model tools and later-mounted presets using incompatible command languages. Starting WSL through System32 bash would change filesystem and process ownership. Automatically falling back to PowerShell would execute Bash text in the wrong parser. Adding the user SID or retrying unconfined would weaken permission enforcement. These alternatives are excluded.

## Consequences

Users may choose Git Bash for authorized full-access Native work, and retain PowerShell for read-only or workspace-write. Changing the selection does not move conversations or change permission mode. The standard settings document owns the shipped choice; custom settings-file deployments own their corresponding composition.

## Verification

Windows tests boot through the real Loader, file settings and subprocess provider; they exercise Unicode and space-containing paths, native Node/Git, exit output, cancellation, deadlines, immutable startup selection, and the persistent PTY backend. Confined tests assert pre-spawn refusal, unchanged permission mode, guard-before-probe ordering, junction escape, foreign-mount and traversal workdir refusal, and the process-tree cleanup of approved runs. Broker unit tests pin the MSYS/Windows path unification (drives, UNC, device prefixes, `/tmp`, the installation root, and the refused `/mnt`/`/cygdrive` spellings), the launch guard, and the static PTY refusal; executor-level tests drive the real probe through a scripted subprocess seam and pin both proven dimensions, the in-boundary control, the leak and no-op write failures, and the missing-scratch-location refusal. Composition tests cover every shipped preset and POSIX gating, and assert no shipped row mounts the unconfined `dsh-bash-local` provider. Windows console hiding retains the existing subprocess implementation; visual popup behavior is not independently verified by these tests. The confined Git Bash execution path itself is not verified on this host — the probe fails at the MSYS runtime dimension — and the POSIX lanes own the bwrap/Landlock/Seatbelt suites.
