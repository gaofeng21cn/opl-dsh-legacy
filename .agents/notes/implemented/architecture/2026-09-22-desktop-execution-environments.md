# Agent Note: Desktop execution environments and event-driven session waiting

Status: implemented

English | [中文](2026-09-22-desktop-execution-environments.zh.md)

## Problem

The Desktop ran its complete Harness only under the bundled Windows Node.js. Operators whose projects and toolchains live in WSL2 had to either keep their work on a Windows drive, where every file operation crosses the Linux/Windows boundary, or run a second, separate Harness inside the distribution and lose the GUI's single owner of sessions, approvals, and runtime state. Nothing let one Desktop own both.

Independently, a program driving the Desktop through its local control endpoint could learn that a prompt was admitted but not that it had finished. The only available evidence was `send`'s acknowledgement, so a caller had to poll durable records and infer completion from timing, and a caller in the same distribution as the Host had to cross Windows interop for every such call.

## Decision

**Execution environment is a launch-time selection with two transports over one Host composition.** The persisted selection in `$DSH_HOME/desktop/execution-environment.json` decides the environment a launch runs in, so choosing WSL2 and restarting starts the WSL2 Host. A process-environment override (`DSH_DESKTOP_ENVIRONMENT` with `DSH_DESKTOP_WSL_DISTRO`) wins over it as a deliberate per-launch choice. A selection that cannot be honored fails on the startup page; the shell never falls back to Windows Native, because that would run the user where their Linux sessions and plugins are not. Windows Native keeps the framed byte pipes; WSL2 runs the same installed dsh Host inside one distribution and reaches it over an authenticated loopback connection. Both transports dispatch to the same plugin tree, Remote gateway, asset router, and client assets assembled by one `composeDesktopHost`, so the choice selects a transport rather than an agent implementation.

**`wsl.exe` starts, probes, and manages; it never wraps a tool call.** The Linux Host starts once per launch and stays up. Wrapping each call would pay process-start cost per call, put each tool outside the Host's own sandbox, and split lifecycle ownership between two implementations.

**The WSL2 transport binds loopback and authenticates with a per-launch token.** The Host publishes a versioned binding — endpoint, bearer token, process id — through an owner-only file written via rename. The Windows side validates the version, refuses a non-loopback endpoint, and reports a handshake deadline, a rejected token, or a Host that dies mid-session as distinct failures. No second port is exposed and no second agent runs. Readiness is the endpoint accepting a connection, not the binding appearing: WSL2 relays Windows loopback connections into the distribution, and that relay lags the distribution's own bind by about a second, so a launcher that trusted the file alone would fail the first request after every launch.

**Runtime state is isolated per environment, and the WSL2 side lives inside the distribution.** Windows Native keeps the existing `$DSH_HOME` layout so existing installations are untouched. The WSL2 Host keeps its Harness home, profile, sessions, caches, and credentials inside the distribution (`~/.dsh-opl` unless `DSH_DESKTOP_WSL_HOME` overrides it). Two environments therefore never write one database, and a Windows-staged profile — whose native modules are Windows binaries Linux cannot load — is never handed to a Linux Host. Nothing from the Windows process environment crosses the boundary: `WSLENV` is set explicitly so an ambient Windows value cannot forward this process's `DSH_HOME` or its credentials. A profile directory the distribution does not have yet is created there with the bundles the packaged runtime already carries, because a distribution runs no package manager and the profile manifest is the whole profile the composed Host reads; a manifest that already exists is left untouched.

**Every path the Linux Host touches is translated before launch.** The packaged payload, profile, and binding file live on a Windows drive, which the distribution reaches through `/mnt/<drive>`; `resolveWslLaunchPlan` derives all of them from the Windows-side facts, and a path with no expression inside the distribution fails the launch instead of being handed to Linux. The binding file deliberately sits on the shared drive so the Linux writer and the Windows reader name one file. Drive paths map to `/mnt/<drive>`, `\\wsl$` UNC paths map to Linux paths, a path naming another distribution is refused, and a `/mnt/<drive>` project is permitted with an explicit performance notice rather than silently relocated.

**A Windows package carries the Linux payload its WSL2 environment runs.** `resources/wsl` holds a Linux Node.js executable, a dsh tree whose production install ran inside a distribution (so its native modules are Linux builds), and a manifest. `prepare:wsl` builds it, `package-target.ts` runs it for Windows targets, and electron-builder maps it into `extraResources`. Installing the tree on Windows and copying it would ship Windows `.node` binaries, which is why the install runs on Linux. That install needs three things the packaging host does not supply by default: the Linux Node's directory on `PATH`, because dependency lifecycle scripts invoke `node` by name and `wsl.exe --exec` starts no login shell; an `allowBuilds` entry for the packaged subprocess package under pnpm's canonical `file:` spec, which drops a leading `./`; and a copy filter judged for the distribution's platform, so `node-pty`'s Linux prebuild survives rather than the packaging host's. `verify-opl-package.mjs` then requires the Linux x64 ELF Node.js executable, the private Host entry, and that Linux PTY addon in every Windows application tree, so a package cannot advertise WSL2 without the files that make it work.

**Session waiting is event-driven and settles on durable facts.** `session.wait` subscribes to `session/event` and resolves on the awaited `turn/end` reason — `completed`, `failed`, or `cancelled` — or on a pending approval as `needs-input`. It never polls. A Session counts as still working only while an active driver can publish another fact: a turn is open, or the Agent's driver is `running`. Registration alone does not, because an Agent stays registered while idle after its last turn and opens no further turn unless new input wakes it — the state a parent reaches once its final child or subtask has finished, where waiting on registration left the caller with no event that could ever settle it. A driver reaching idle also releases its waiters, and a settled Session reports what it recorded. Waking input puts the driver in `running` before the turn opens, so `prompt` followed by `wait` still observes the prompt's own turn instead of the state that preceded it.

## Alternatives considered

**Run the whole Windows Desktop shell inside WSL2.** The Electron application, its window, and its installer are Windows artifacts; moving them would discard the existing installation, update, and signing story to gain a filesystem.

**Wrap every tool call in `wsl.exe`.** Rejected above: per-call process-start cost, a sandbox that does not belong to the owning Host, and two lifecycle owners.

**Mount the distribution's root as a `\\wsl$` share and run the Windows Host against it.** Every file operation would cross the same boundary the feature exists to avoid, and the Host's sandbox would confine Windows processes enforcing Windows ACLs over Linux files.

**Share one database between Windows Native and WSL2.** Two platform-dependent runtimes writing one append-only log would corrupt it rather than merely stale it. Isolation is the only option that keeps both recoverable.

**Poll durable records for completion.** Polling cannot distinguish a slow turn from a finished one without inventing a quiet period, and it scales with the number of waiters.

**Report `needs-input` for `user-questions` pauses too.** The `user-questions` seam is a live waterfall with no durable settlement event, so a wait would have to infer the answer from a surrounding tool result. Only approvals carry a durable bracket, so only approvals are reported; the gap is stated rather than papered over.

**Inject messages into an existing Codex desktop task.** No public interface exists for it. The stable DSH event stream is the interface a future resident coordinator can consume, and Codex automation stays a periodic inspection fallback.

## Consequences

Windows Native remains the default and every existing installation keeps its current behavior, data, and plugins. A switch is recorded and takes effect at the next restart; a running session keeps its environment, and the settings surface says so rather than implying a live change.

WSL2 requires an installed distribution, a Linux Node of at least the bundled major version, and the packaged Linux payload. A machine missing any of these fails the launch with the specific reason rather than falling back to Windows Native. Discovery reads the Windows registry, so a distribution installed for another Windows user is not offered.

Packaging a Windows release now requires a usable WSL2 distribution on the build machine, because the Linux tree's native modules must be installed by a Linux package manager. A build without one fails at `prepare:wsl` instead of emitting a package that cannot serve the environment it advertises. The Linux payload is built from the package set the same run just packed, so a payload is only as current as the workspace build that preceded it.

A project on a Windows drive remains usable from WSL2 but is materially slower, which is stated rather than prevented. Two environments on one machine keep separate sessions, so a session started under one is not visible under the other; this is the cost of keeping both recoverable. Because the WSL2 home and profile live inside the distribution, a Windows-side plugin installed through Desktop Plugins applies to Windows Native only.

`session.wait` reports `needs-input` only for approvals, holds one `session/event` subscription until it settles or its caller cancels, and a control call carries its own deadline so a long wait is not mistaken for a timeout. Requests still only flow outward to the Host, so the wait does not change what a caller may do.

Hidden console windows are set on every background Windows child the Desktop and the subprocess layer own: the dsh Host, the bundled pnpm transactions, the Windows Job runner, and the build helpers. A packaged shell runs its Host and its runner from the GUI-subsystem Electron image, which holds no console to pass on, so each ordinary target is created with `CREATE_NO_WINDOW` and owns a hidden console its descendants inherit ([ordinary target console](../bug-fix/2026-09-22-windows-ordinary-target-hidden-console.md)). The restricted-token children keep their owner's console, because `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` under a `WRITE_RESTRICTED` token fails with `STATUS_DLL_INIT_FAILED`, and a runner image without a console still leaves them allocating one. Explicitly opened terminals and PTYs are unaffected.

## Verification

- `apps/desktop/tests/execution-environment.spec.ts` covers selection validation, every path form and translation direction, cross-distribution refusal, the drive-mount notice, and state-root isolation.
- `apps/desktop/tests/wsl.spec.ts` covers registry discovery, distribution selection, probe outcomes, the Host launch shape, the launcher environment contract, and the exact translated launch plan.
- `apps/desktop/tests/wsl-transport.spec.ts` runs a real loopback server and client: authentication, token rejection, version refusal, handshake timeout, readiness, launch failure, cancellation, and stop.
- `apps/desktop/tests/execution-environment-store.spec.ts` covers persistence, defaults, and unreadable-file reporting.
- `apps/desktop/tests/main-startup.spec.ts` covers the restart regression: a persisted WSL2 selection starts the WSL2 Host with the translated invocation, the byte-pipe Host is never created, an explicit override still wins, a running WSL2 environment is reported as current, and an unhonorable selection fails visibly.
- `apps/desktop/tests/plugin-manager.spec.ts` covers the settings surface's in-use/next-launch split, unusable distributions, and the no-usable-distribution state.
- `apps/desktop/tests/wsl-real.spec.ts` runs the transport against an installed distribution when the machine has one, and self-skips otherwise: `wsl.exe` launches a Linux Node process, the process publishes a binding, and the Windows side handshakes and fetches over the authenticated loopback connection.
- `apps/desktop-host/tests/desktop-profile.spec.ts` covers the profile a first WSL2 launch creates: the manifest names every Desktop bundle, and an existing manifest is preserved.
- `apps/desktop/tests/opl-windows-package.spec.ts` covers the Windows payload: a complete tree passes, and a tree missing the Linux Node, the Host entry, the Linux PTY addon, or the whole payload is refused.
- `apps/desktop/tests/core-package-set.spec.ts` covers the `allowBuilds` key a generated project approves the packaged subprocess package's postinstall under.
- `apps/desktop/tests/windows-console.spec.ts` and `packages/subprocess/subprocess-local/tests/windows-job.spec.ts` assert the hidden-console contract at every background Windows spawn entry.
- `packages/api/session-controller/tests/wait.host.spec.ts` runs the wait against the real agent loop: all four outcomes, exact-turn waiting, already-settled Sessions, cancellation, a plugin-added reason variant failing closed, and the lifecycle regression — a parent whose last turn closed after its final child finished settles while its Agent is still registered, a running driver keeps the wait open, a driver going idle releases it, and unrelated lifecycle traffic is ignored.
- `apps/desktop/tests/control-bridge.spec.ts` covers the wait allowlist and the caller-deadline timeout.
