# OPL DSH

English | [中文](README.zh.md)

An OPL-maintained fork of DeepSeek Harness: this repository carries the OPL Gateway integration, desktop packaging, and custom DSH plugins that are released as OPL DSH.

> Unofficial distribution. Not affiliated with, endorsed by, or supported by DeepSeek. The `upstream` remote is used to synchronize the DeepSeek Harness base; this fork maintains its own plugins, packaging, fixes, releases, and issue tracking.

<a id="run"></a>

## Download and install

Download `opl-dsh-<version>-mac-arm64.dmg` from [Releases](https://github.com/gaofeng21cn/opl-dsh/releases), open it, and drag **OPL DSH** into Applications.

- Signed and notarized by Apple, so the first launch needs no extra step.
- Apple Silicon (arm64), macOS 13 or later.
- Requires an OPL Gateway account. Nothing else to install.

## Getting started

1. Open **OPL DSH** and go to **Settings → OPL Gateway**.
2. Sign in with your OPL Gateway account.
3. Back in a session, pick **DeepSeek-V4.1-Flash** in the model picker.

The same page shows your account, balance, today's and total tokens and cost, and the inference endpoint in use.

Already signed in to OPL Gateway in the OPL app on this Mac? This app reuses that account, so step 2 is already done.

## Your data

Sessions, settings, and credentials live in `~/.dsh-opl`. Signing in stores a session token so the app can renew itself; your password is never stored. Model requests go straight to OPL Gateway (by default `https://gateway.medopl.com/v1`).

## Known limitations

- macOS (Apple Silicon) only for now.
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

| Variable | Default | Effect |
| --- | --- | --- |
| `DSH_OPL_HOME` | `~/.dsh-opl` | Harness home for sessions, settings, and credentials |
| `DSH_OPL_NOTARIZE` | unset | Set to `1` to notarize the disk image during packaging |
| `OPL_GATEWAY_STATE_ROOT` | auto-detected | OPL app state directory, read only to reuse an existing sign-in |

### What this repository adds

| Addition | Location |
| --- | --- |
| OPL Gateway provider route | `packages/llm/llm-opl-gateway` |
| OPL Gateway account page | `packages/client/ui-settings-opl-gateway` |
| OPL packaging identity and installer | `apps/desktop/electron-builder.opl.mjs`, `apps/desktop/opl/` |
| Downstream npm scope support in the release gates | `scripts/package-scope.ts` |

The gateway plugin talks to the OPL Gateway HTTP API directly and does not shell out. `opl connect gateway …` is not required at runtime, so the app works on a machine with no OPL installation; when the OPL app has already signed in, its recorded account and bound key are reused so no second sign-in is needed.

### Platform fixes maintained by this fork

1. **Editing menu** (`apps/desktop/src/menus.ts`). The upstream shell replaces Electron's default menu without an `editMenu` role, which leaves the standard macOS editing shortcuts and the input context menu unhandled.
2. **System certificate trust** (`apps/desktop/src/host-process.ts`). The bundled Node trusts only its own roots, so behind a TLS-inspecting proxy or a private CA every outbound request fails while curl and browsers work. The host therefore passes `--use-system-ca`.

These fixes are part of this fork's maintenance scope and do not depend on upstream accepting external pull requests.

### Staying in sync with upstream

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream master
git rebase upstream/master main
```

The fork keeps its changes reviewable and reapplies them after each upstream sync. Upstream moves fast and has announced breaking changes, so after each rebase re-run:

```sh
npx vitest run packages/llm/llm-opl-gateway packages/client/ui-settings-opl-gateway apps/desktop
```

and one real session: pick `OPL Gateway / DeepSeek-V4.1-Flash` and get a reply.

## License

Upstream code is MIT, see [LICENSE](LICENSE). Packages added here are MIT as well.
