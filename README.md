# OPL DSH

English | [中文](README.zh.md)

An OPL-maintained desktop app for DeepSeek Harness on macOS and Windows: sign in with your OPL Gateway account and start using DeepSeek models.

> Unofficial distribution. Not affiliated with, endorsed by, or supported by DeepSeek. Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

<a id="run"></a>

## Download and install

Download `opl-dsh-<version>-mac-arm64.dmg` for macOS, or `opl-dsh-<version>-win-x64-setup.exe` for Windows, from [Releases](https://github.com/gaofeng21cn/opl-dsh/releases). On macOS, open the image and drag **OPL DSH** into Applications; on Windows, run the installer.

- macOS: signed and notarized by Apple, Apple Silicon (arm64), macOS 13 or later, so the first launch needs no extra step.
- Windows: Windows 10 or 11 on x64. The installer is **not code-signed**, so SmartScreen warns on the first launch; choose "More info" and then "Run anyway".
- Requires an OPL Gateway account. Nothing else to install.

## Getting started

1. Open **OPL DSH** and go to **Settings → OPL Gateway**.
2. Sign in with your OPL Gateway account.
3. Back in a session, pick **DeepSeek-V4.1-Flash** in the model picker.

The same page shows your account, balance, today's and total tokens and cost, and the inference endpoint in use.

Already signed in to OPL Gateway in the OPL app on this Mac? This app reuses that account, so step 2 is already done.

## Your data

Sessions, settings, and credentials live in `~/.dsh-opl` on macOS, and in `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home` on Windows; `DSH_OPL_HOME` moves that home on either platform. Signing in stores a session token so the app can renew itself; your password is never stored. Model requests go straight to OPL Gateway (by default `https://gateway.medopl.com/v1`).

## Known limitations

- Windows packages are distributed without a code-signing certificate, so SmartScreen warns once before the first launch.
- If your account requires an interactive verification step (CAPTCHA or two-factor), complete it in that flow first; this app only handles email and password.

## For developers

<a id="run-from-source"></a>

### Build the macOS app

You need macOS, Node.js ≥ 22.19, pnpm, and a Developer ID certificate (plus notarization credentials to distribute).

```sh
pnpm install

# Prepare the runtime and package set (builds the whole repository; takes a while)
DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name, without the "Developer ID Application:" prefix>' \
DSH_DESKTOP_MACOS_TEAM_ID='<10-character Team ID>' \
APPLE_KEYCHAIN_PROFILE='<notarytool profile>' \
DSH_DESKTOP_AUTO_UPDATE_ENV=production \
pnpm --filter @deepseek-ai/dsh-desktop run prepare:package

# Produce .app / .dmg / .zip
cd apps/desktop
DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<as above>' \
DSH_DESKTOP_MACOS_TEAM_ID='<as above>' \
APPLE_KEYCHAIN_PROFILE='<notarytool profile>' \
DOWNLOAD_TEST_ORIGIN=https://download.deepseek.com \
pnpm exec electron-builder --config electron-builder.opl.mjs --mac --arm64 --publish never
```

Artifacts land in `apps/desktop/.desktop-build/targets/mac-arm64/artifacts/` as `opl-dsh-<version>-mac-arm64.dmg`. Add `DSH_OPL_NOTARIZE=1` to notarize as part of the build.

Install a local build with `apps/desktop/opl/install-macos.sh`. It requires an empty destination: `ditto` merges into an existing bundle and leaves resources the signature does not cover, which macOS then reports as `a sealed resource is missing or invalid`.

### Build the Windows app

You need Windows 10 or 11 on x64, Node.js ≥ 22.19, pnpm, Python, and the Visual C++ Build Tools that native modules compile against.

```sh
pnpm install

# Type-check the workspace and run the packages a Windows build can change.
# `.github/workflows/windows-desktop.yml` runs exactly these two commands.
pnpm run typecheck
pnpm exec vitest run apps/desktop packages/llm/llm-opl-gateway \
  packages/client/ui-settings-opl-gateway packages/util/home-paths

# Package the desktop shell and the win-x64 runtime, then emit an unsigned
# NSIS installer and a portable executable.
DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
pnpm run package:opl:desktop:win:x64:unsigned
```

No Harness profile has to be installed before those tests. The one test that reads a profile, `apps/desktop/tests/profile-mcp.spec.ts`, builds its own throwaway profile in a temp directory; what it needs from the install is the desktop profile's two bundles (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`) resolvable through the `dsh` installation anchor, which `pnpm install` provides.

The build takes the same steps as the macOS one and stops short of the DMG: it prepares the win-x64 runtime, packs the desktop application, and then hands both to electron-builder. Artifacts land in `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/` as `opl-dsh-<version>-win-x64-setup.exe` (NSIS) and `opl-dsh-<version>-win-x64-portable.exe` (single file, no installation). `pnpm run package:opl:desktop:win:x64:dir:unsigned` stops at the unpacked `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/` tree instead, which is the fastest way to launch a build under development.

Install a local build with `apps/desktop/opl/install-windows.ps1`. It runs the installer, or copies the unpacked tree when the build produced no installer, and then re-checks what landed on disk through `apps/desktop/opl/verify-opl-package.mjs`.

To run a build without installing anything, launch `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/OPL DSH.exe` directly. For a development loop that rebuilds the shell in place, `pnpm --dir apps/desktop run dev` starts the same application against the working tree.

### Call DeepSeek from a Windows shell

The repository includes a headless entry that shares the OPL Gateway configuration with the desktop app. After building the runtime, run this from the repository root:

```powershell
.\scripts\opl-dsh.cmd "list the files in the current workspace"
```

It uses the `opl-headless` profile, treats the current directory as the default workspace, and emits the final answer as JSON for Codex, scripts, or another automation client. Arguments such as `--session-id` are forwarded to the headless profile so an existing session can be continued:

```powershell
.\scripts\opl-dsh.cmd --session-id <session-id> "continue the previous task"
```

The default Harness home is `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home`; set `DSH_OPL_HOME` to keep sessions, project indexes, and sign-in state elsewhere. The wrapper expects the desktop runtime and CLI artifacts to be prepared (`pnpm run build`, then `pnpm --filter @deepseek-ai/dsh-desktop run prepare:package`).

No code-signing certificate is needed, and the resulting package is unsigned on purpose: Windows packaging refuses to emit an artifact unless it either receives the certificate inputs or is explicitly asked for an unsigned build. To sign instead, set `DSH_DESKTOP_WINDOWS_CER_FILE`, `DSH_DESKTOP_WINDOWS_SIGNTOOL`, `DSH_DESKTOP_WINDOWS_KEY_CONTAINER`, and `DSH_DESKTOP_WINDOWS_TOKEN_PIN` and drop `--unsigned`; [apps/desktop/README.md](apps/desktop/README.md) states what each one must contain.

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `DSH_OPL_HOME` | `~/.dsh-opl` on macOS, `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home` on Windows | Harness home for sessions, settings, and credentials |
| `DSH_OPL_NOTARIZE` | unset | Set to `1` to notarize the disk image during packaging |
| `OPL_GATEWAY_STATE_ROOT` | auto-detected | OPL app state directory, read only to reuse an existing sign-in |
| `DSH_DESKTOP_BUILDER_CONFIG` | `electron-builder.config.mjs` | electron-builder configuration a packaging command uses; the OPL package scripts pass `electron-builder.opl.mjs` |

### What this repository adds

| Addition | Location |
| --- | --- |
| OPL Gateway provider route | `packages/llm/llm-opl-gateway` |
| OPL Gateway account page | `packages/client/ui-settings-opl-gateway` |
| OPL packaging identity and installer | `apps/desktop/electron-builder.opl.mjs`, `apps/desktop/opl/` |
| Windows x64 packaging and installation | `apps/desktop/opl/install-windows.ps1`, `apps/desktop/opl/verify-opl-package.mjs` |
| Downstream npm scope support in the release gates | `scripts/package-scope.ts` |

The gateway plugin talks to the OPL Gateway HTTP API directly and does not shell out. `opl connect gateway …` is not required at runtime, so the app works on a machine with no OPL installation; when the OPL app has already signed in, its recorded account and bound key are reused so no second sign-in is needed.

### Two platform fixes carried here

1. **Editing menu** (`apps/desktop/src/menus.ts`). The upstream shell replaces Electron's default menu without an `editMenu` role, which leaves the standard macOS editing shortcuts and the input context menu unhandled.
2. **System certificate trust** (`apps/desktop/src/host-process.ts`). The bundled Node trusts only its own roots, so behind a TLS-inspecting proxy or a private CA every outbound request fails while curl and browsers work. The host therefore passes `--use-system-ca`.

Both are reported upstream: [editing menu](https://github.com/deepseek-ai/deepseek-harness/discussions/6937), [certificate trust](https://github.com/deepseek-ai/deepseek-harness/discussions/6938). Upstream does not accept external pull requests ([CONTRIBUTING](CONTRIBUTING.md)), so this repository carries them for now.

### Staying in sync with upstream

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream master
git rebase upstream/master main
```

The delta stays small on purpose: additions live in new files, and edits to upstream files (such as `packages/bundle/web-app/cordis.patch.yml`) keep minimal line-level differences without reordering existing keys. Upstream moves fast and has announced breaking changes, so after each rebase re-run:

```sh
npx vitest run packages/llm/llm-opl-gateway packages/client/ui-settings-opl-gateway apps/desktop
```

and one real session: pick `OPL Gateway / DeepSeek-V4.1-Flash` and get a reply.

## License

Upstream code is MIT, see [LICENSE](LICENSE). Packages added here are MIT as well.
