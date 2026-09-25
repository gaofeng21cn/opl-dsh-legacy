# Agent Note: OPL extensions for the official DSH desktop

Status: proposed

English | [中文](2026-09-25-opl-official-desktop-extensions.zh.md)

## Problem

OPL users need Gateway sign-in, reliable Codex coordination, and convenient installation. The current fork ships these alongside changes to the desktop shell, Session, Agent loop, permissions, Shell, and UI. Upstream updates consequently require merges across these components, full builds, and desktop signing. Maintaining a copy of the complete product costs more than maintaining its added capabilities.

The goal is to reduce ongoing maintenance while preserving existing work and data. The source baseline is tagged `opl-baseline-20260925`; the [difference inventory](../../../../.github/opl-extension-inventory.json) lists every changed path against the synchronized upstream. The baseline preserves existing features; it does not mean they already work with the official desktop. This proposal specifies migration order, not an already delivered installer.

## Proposal

### Product and maintenance ownership

OPL DSH becomes an enhancement suite for official DSH. The official product owns application signing, Electron, the bundled Host, the Agent loop, session formats, and desktop updates. OPL owns its plugins, Gateway integration, coordination protocol, and installation tools. Users receive one OPL DSH setup entry, one launch shortcut, and OPL settings inside the official application. The running application retains its official name and signature.

Initially publish one plugin bundle, `@one-person-lab/dsh-opl`, containing Host plugins and Client settings contributions, composed with official plugins through `dsh.bundle.patch`. Gateway, coordination, and preferences remain separate internal modules with switches, rather than many independently released packages. Setup tools and the Codex Skill ship with the same suite version. Names and commands below are proposed interfaces, not published download locations or available commands.

Use public services, configuration, and slots. Do not overwrite the official installation, install modified `@deepseek-ai/*` core copies into its profile, or duplicate Cordis or the Agent loop. Record features without suitable extension interfaces separately and preserve them in the baseline; unsupported features must not be reported as migrated.

### Disposition of every added capability

| Capability | Current implementation and coupling | Plugin treatment and verification |
| --- | --- | --- |
| Gateway account, balance, costs, and two key groups | `llm-opl-gateway`, `ui-settings-opl-gateway`; direct Gateway API access | Retain initially as a Host service and Client settings page. Require neither OPL App nor Framework; verify sign-in, restart, renewal, and sign-out with both independent keys. |
| Messages / OpenAI dual channel | Wrapper around official DeepSeek and pi-ai adapters; the fork exports extra pi-ai internals | Retain initially through official plugin configuration and public `LlmAdapter` interfaces; remove extra internal-export dependencies. Use `deepseek-flash` / `DeepSeek-V4.1-Flash`; switch before the first chunk only, never after output or cancellation. |
| Gateway search, local search, and accounting | Gateway search service, Responses search, Shell local path, and settings page | Retain as an optional module using official Web/Search services and storage. Verify source links, accounting, and local execution permissions; model discovery alone does not establish search support. |
| Codex task feedback, receipts, and recovery | `api/task-feedback` depends on fork Session request IDs, wait, permission, and recovery APIs | Refactor initially. An independent coordination service owns request deduplication, task state, and receipts, subscribing to official events and projections. Implement missing operations in an owned namespace instead of modifying Session controller. |
| Local control endpoint and CLI | `apps/desktop-host/src/control-bridge.ts` is mounted by the Host launcher | Extract into a Host plugin initially. Retain loopback authentication, method allowlists, and private connection records; verify versions through plugin health without private Electron IPC. |
| Codex Skill, automatic launch, and installation page | The dispatch helper supports automatic launch; filesystem installation remains in Electron main/preload | Retain the Skill and idempotent dispatch. Move installation into local setup; the plugin page reports state and opens local setup. A remote Host cannot write the local Codex directory. |
| Plain chat and tool-free preset | `chat.patch.yml` and preset registry mode protection | Use official custom presets and bundle configuration, explicitly denying tools. Verify separately from Sessions with no Workspace; a fabricated workspace is not equivalent semantics. |
| Independent Sessions, project moves, and directory membership | Changes span workspace entities, Session API, and client navigation | Adapt later. Prefer official equivalents; otherwise require an extension interface instead of copying workspace core. Preserve old membership in existing data. |
| Edit/resend, conversation rewind, and hidden branches | Changes span Agent loop, Session surface/API, Chat UI, and V5 | Do not directly port initially. Verify whether official fork/branch operations express the required behavior; record gaps when not equivalent instead of owning another loop and format. |
| Workspace file rewind | `session-rewind-files` journal is coupled to Session rewind | The journal can become an optional plugin, decoupled from conversation rewind. Verify external-write conflicts, permissions, executable modes, symlinks, and interrupted recovery before exposing restoration. |
| Custom permissions and automatic review | Permission read/change, deterministic rules, model review, and human escalation | Default to official permissions. Offer explicitly enabled approval extensions only after proving official hooks preserve ordering and denial semantics; disable unproven extensions and never widen permissions automatically. |
| Output language | `system-prompt.outputLanguage` and a settings card | Register an official system-prompt section with OPL-owned settings. Verify Chinese/English/default, next-request application, and reconstructable logs. |
| Compaction and context budgets | Added absolute thresholds, inputBudget, and step admission in compaction-basic | Prefer official capacities, output reservation, and modelPolicies. Retain model configuration without the extra algorithm initially; add a separate provider only if real long sessions establish the need. |
| Protocol diagnostics and reasoning trace | DeepSeekAdapter and LLM failure extensions, plus retry regression cases | Keep redacted status/error diagnostics around the route. Disable raw trace by default and do not require extra official failure fields. Record official adapter defects as compatibility issues. |
| Windows Git Bash, paths, and hidden consoles | Changes in app-boot, shell, subprocess, terminal, native-command, and SSH | Prefer official Shell and platform fixes; implement indispensable extras as an optional execution provider. Initial Linux/macOS work does not claim unverified Windows compatibility. |
| Windows WSL2 execution | Custom desktop Host lifecycle, WSL transport, IPC, and packaging payload | Exclude initially. A normal Host plugin cannot own Electron processes; use supported official remote/WSL entry points or a later external executor, retaining the old implementation for reference. |
| Notifications, tray, close policy, menus, and UI adjustments | Desktop main/preload, notifications, conversation width, IME, and related UI changes | Reuse official tray and quit behavior. Route coordination notifications through supported APIs or the local helper. Do not transplant shell styling without public interfaces or inject DOM patches. |
| Model + Harness combinations, including Grok Build | Discussed direction without a completed product implementation | Later optional Agent executor: bind harness, model, authRef, permissions, and working-directory policy. Verify Grok Build subtask start/resume/cancel/result references before changing the DSH main session. |
| OPL branding, packaging, CI, and release tooling | Fork DMG/NSIS, signing, notarization, runtime bundling, and scope support | Preserve in the baseline; the plugin route stops routinely rebuilding DSH. CI covers independent plugin builds, clean official runtimes, and setup lifecycle; official-only publishing workflows remain disabled. |
| Documentation, generators, type paths, and test support | Catalogs, Typert, downstream scopes, fixtures, configuration, and dependencies | Include in the complete inventory as support for the features above. Move only what independent plugin builds require, rather than the entire upstream documentation/build system. |

Initial exclusions are migration recommendations, not deletion authorization. This baseline preserves all existing source. The implemented [coordination record](../../implemented/process/2026-09-24-codex-dsh-coordination-skill.md), [conversation rewind](../../implemented/feature/2026-09-24-conversation-turn-rewind.md), and [file rewind](../../implemented/feature/2026-09-24-workspace-file-rewind.md) still describe the legacy product. This proposal changes only part of the future delivery mechanism and does not archive records with surviving implementations.

### One setup entry and user access

Users visit this repository's OPL DSH downloads, choose their OS, and run OPL DSH Setup. Start with Apple Silicon macOS, then Windows. Prefer a small signed setup tool and native dialogs rather than another Electron shell, persistent service, or account system.

1. Detect official DSH: verify application identity, version, architecture, and its actual profile. Reuse a supported installation. If absent, use only a verified official distribution URL and signature; without that evidence, show the official installation entry and preserve progress rather than substituting a community build or the fork.
2. Show installation targets and options: enable Gateway dual channels by default and make Codex coordination optional. Preserve an existing default model and offer an explicit option to make OPL Gateway the default. Manage only owned configuration in existing installations.
3. Install the prebuilt OPL bundle through official plugin management into the actual desktop profile. Require no source compilation, Git, or global pnpm. If the public CLI is the only automation route, supply or fetch a verified compatible Node and invoke the official CLI matching the application version. Do not rely on undocumented paths inside the application. Fix this mechanism only after testing the official installer artifact.
4. Enable and inspect the plugin: verify Gateway settings, both model routes, plugin version, and authenticated control health. Test whether official first-run onboarding accepts third-party providers; never fabricate an official account or API key to bypass onboarding.
5. Have the user sign in on the OPL Gateway page: the plugin creates or reuses machine-specific keys in the DeepSeek and Codex groups. Setup neither collects passwords nor copies OPL App's rotating refresh token or changes another client's key group.
6. Optionally install the Codex Skill: discover the actual Codex home, copy the shipped Skill/control helper/configuration, and preserve manual edits with backup and actionable conflict reporting. Automatic launch targets the verified official application, and each current Codex task gets a distinct dispatch ledger.
7. Create an OPL DSH shortcut and show completion: the shortcut opens official DSH. Reopening setup offers Open, Check, Update enhancements, Repair, and Remove enhancements. Report incomplete login, incompatible runtime, or required Skill reload accurately instead of equating copied files with readiness.

One-click means one product entry and one configuration flow; OS confirmations, Gateway sign-in, and explicit permission choices remain user actions. Setup does not control official automatic updates or require OPL App or OPL Framework. Verify any public route that opens OPL settings directly; without one, open the application normally and show Settings → OPL Gateway.

### Installation state and recovery

Treat the official application directory as read-only and update the official runtime separately from OPL plugins. OPL installation records contain application identity/version, target profile, suite version, owned settings, and file fingerprints, never passwords or API keys. DSH's credential store owns Gateway keys; setup configuration contains no token. Control endpoints listen only on loopback with current-user-readable connection records. Local installation ownership remains separate from remote execution Hosts.

Use official profile locks and plugin transactions. If tasks are running, let the user defer application or update after tasks end. Finish download/extraction before committing installation; after interruption, reconcile actual versions/configuration to avoid duplicate keys, tasks, or writes. Rollback restores only plugin versions and settings changed by that operation, not the entire official profile.

Removal uninstalls only the owned bundle, shortcuts, and unmodified owned Skill files. Preserve Sessions, user configuration, credentials, and manual edits by default. Gateway sign-out owns remote key revocation; uninstalling does not imply revocation. Update, repair, and uninstall all read back the official loaded state.

### Versions and maintenance

Give the suite an independent version. Each release binds official application version, DSH runtime version, OPL suite version, OS, and architecture. Initially support only verified exact combinations, without blanket compatibility exemptions for future versions. After official updates, use peer constraints and startup diagnostics to report compatibility; preserve the official application's usability while pausing incompatible OPL features and offering a matching release.

Release only OPL plugin packages, the Skill, and small setup tools. A compatibility manifest records official download evidence, artifact hashes, public entry points, and test results. Leave unknown download URLs unset. Dependencies must not resolve to modified upstream packages; publish only owned `@one-person-lab/*` packages. Two key groups do not introduce two Harnesses: official adapters still own model protocols.

CI installs the final tarball into a clean official runtime with no workspace links to this fork. Fork-local tests cannot replace this requirement. Regressions cover account state, dual channels, multi-step tools, coordination dispatch/resume/cancel/human waits/restarts, Skill update conflicts, and preservation on removal. Subsequent official-version checks exercise these integration points rather than merging the whole upstream repository for each commit.

### Existing users and source migration

Keep `~/.dsh-opl` separate from official data. Allow parallel evaluation before opt-in import. Translate compatible preferences through explicit field mappings and establish a DSH-owned login session rather than sharing rotating tokens between products. Scan and report session formats first; do not let official V4 open V5 automatically or disguise V5 by rewriting its header to V4.

Prioritize new Sessions and losslessly compatible history. Keep the legacy reader for V5 or provide read-only Markdown/JSON exports. Converting these into resumable Sessions requires a separate implementation and verification. Preserve old files and attachments and retain the old application until the new path works. Approved fork V5 remains a legacy feature, not a prerequisite for the new plugin route.

Preserve the baseline tag and history in the same GitHub repository. First validate a minimal official-runtime integration on a separate branch. After meeting the criteria below, turn `main` into a small plugin/setup source tree and stop treating the entire upstream repository as the mainline. Retain the fork for recovery only, with one active development/release mainline. Delete desktop packaging and copied core code only after their replacements are verified, not merely to complete a checklist.

### Delivery order

| Stage | Reviewable output | Completion criteria |
| --- | --- | --- |
| A: baseline and inventory | Clean mainline, recoverable tag, path inventory, this proposal | Existing work depends on neither dirty files nor a missing worktree; historical stashes have a preservation disposition. |
| B: minimal official-runtime proof | Independent OPL bundle and public-installation evidence | Unmodified official desktop displays Gateway; real dual channels and tool continuation work without core replacement. |
| C: coordination and setup | Extracted control plugin, Skill, local setup, launch shortcut | Start without OPL configuration, sign in, let Codex launch/dispatch, finish/read back, and resume after restart while preserving user edits. |
| D: migration and optional enhancements | Data migration guidance, explicit feature dispositions, optional executors | Each feature has an official equivalent, independent plugin, or disclosed unsupported status; user data remains recoverable. |
| E: maintenance cutover | Small mainline, suite Release, official-version compatibility checks | Stop routinely merging upstream or resigning official apps; verify install/update/repair/removal. |

## Alternatives considered

**Keep full fork DMGs as the default product.** This retains all features quickest but does not reduce upstream merges, core conflicts, platform packaging, or signing. Keep it only as a migration recovery path.

**Package the entire modified core as a super-plugin.** Users get the official shell while OPL still owns Session, loop, Shell, and equivalent desktop behavior, with greater runtime-identity risks. This does not meet the maintenance goal.

**Provide only a manual installation command.** Developers can use it, but users without Node/Git lack profile discovery, configuration protection, Skill installation, and recovery. Retain it as an advanced entry rather than the sole product entry.

**Create separate repositories and release pipelines for each enhancement.** There is no current need for independent versions; this increases dependency combinations and maintenance. One bundle with internal modules is sufficient initially.

## Acceptance criteria

- Run with the official signed application and released runtime; OPL installation does not alter application bytes, replace core packages with the fork, or introduce a second Cordis instance.
- Display `deepseek-flash` as `DeepSeek-V4.1-Flash`. Prove independent keys, Messages priority, Responses failover before the first chunk, and tools executing only once through real calls.
- From a closed official application, the Codex Skill establishes authenticated control and completes idempotent dispatch, resume, cancellation, human waits, and result reads. It neither enables an unconfigured reverse-wake bridge nor automatically approves DSH requests.
- Verify fresh/repeated installation, interrupted updates, official upgrades, moved applications, manually edited Skills, running tasks, and preservation on removal; require no OPL Framework.
- Official V4 never mistakenly writes V5 data; the legacy path remains recoverable. Every inventory capability is marked migrated, officially replaced, pending verification, or unsupported.
- Downloads and setup display only real available official versions and suites; describe this proposal as implemented only after release verification.

## Risks

At design time, official source establishes desktop plugin profiles and bundled package management, but the reported official download channel remains unverified and the latest upstream GitHub Release has no installer assets. This limits automatic download, not the plugin architecture; source tests cannot substitute for official installer verification.

The official product remains in preview and public interfaces may change. A version matrix and narrow compatibility work still require maintenance, but should cost substantially less than a full fork. If the minimal proof requires changing a private launcher, replacing core, or weakening permissions, stop that implementation path, report the concrete missing capability, and preserve the verified baseline.
