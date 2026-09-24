# OPL DSH

English | [中文](README.zh.md)

OPL 维护的 DeepSeek Harness fork：本仓库维护 OPL Gateway 接入、桌面打包、Windows/WSL 支持，以及 Codex 与 DSH 协作插件，并从这里发布 OPL DSH。

> 非官方发行版，与 DeepSeek 无隶属、背书或支持关系。`upstream` 远端只用于同步 DeepSeek Harness 基线；本 fork 自己维护插件、打包配置、本地修复、发布和问题跟踪。

<a id="run"></a>

## 下载与安装

从 [Releases](https://github.com/gaofeng21cn/opl-dsh/releases) 下载 macOS 的 `opl-dsh-<版本>-mac-arm64.dmg` 或 Windows 的 `opl-dsh-<版本>-win-x64-setup.exe`。macOS 打开镜像后把 **OPL DSH** 拖进「应用程序」；Windows 直接运行安装程序。

- 已签名并通过 Apple 公证，首次打开无需额外步骤。
- 支持 Apple Silicon（arm64），要求 macOS 13 或更高。
- Windows 10 或 11 x64。安装程序未配置代码签名，首次打开时 SmartScreen 会提示。
- 需要一个 OPL Gateway 账号，无需安装其他软件。

## 开始使用

1. 打开 **OPL DSH**，进入 **设置 → OPL Gateway**。
2. 用 OPL Gateway 账号登录。
3. 回到会话，在模型选择器中选择 **DeepSeek-V4.1-Flash**。

同一页面会显示账号、余额、今日与累计 Token 及费用，以及当前使用的推理地址。

如果本机已在 OPL App 中登录过 OPL Gateway，本应用会直接沿用账号登录状态，第 2 步已完成。

## 数据与密钥

macOS 的会话、设置与凭据保存在 `~/.dsh-opl`，Windows 保存在 `%APPDATA%\\@deepseek-ai\\dsh-desktop\\dsh-home`；可用 `DSH_OPL_HOME` 在任一平台迁移该目录。登录只保存用于自动续期的会话令牌，不保存密码。DSH 会为本机申请或复用 OPL Gateway **DeepSeek 分组**的独立 key；旧的 Codex/AGI 分组 key 不会被导入。模型请求默认发往 `https://gateway.medopl.com/v1`。

## 已知限制

- Windows 版本未配置代码签名证书，首次打开时 SmartScreen 会提示一次。
- 若账号需要交互式验证（人机校验或两步验证），请先完成验证；本应用只处理邮箱和密码。

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

You need Windows 10 or 11 on x64, Node.js >= 22.19, pnpm, Python, and the Visual C++ Build Tools that native modules compile against.

```sh
pnpm install
pnpm run typecheck
pnpm exec vitest run apps/desktop packages/llm/llm-opl-gateway \
  packages/client/ui-settings-opl-gateway packages/util/home-paths

DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
pnpm run package:opl:desktop:win:x64:unsigned
```

Artifacts land in `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/` as an unsigned NSIS installer and portable executable. `pnpm run package:opl:desktop:win:x64:dir:unsigned` stops at the unpacked `win-unpacked/` tree for a faster development launch. Install a local build with `apps/desktop/opl/install-windows.ps1`.

### Call DeepSeek from a Windows shell

The repository includes a headless entry that shares the OPL Gateway configuration with the desktop app:

```powershell
.\\scripts\\opl-dsh.cmd "list the files in the current workspace"
```

It uses the `opl-headless` profile and emits the final answer as JSON. Pass `--session-id <session-id>` to continue an existing session. The default Harness home is `%APPDATA%\\@deepseek-ai\\dsh-desktop\\dsh-home`; set `DSH_OPL_HOME` to keep state elsewhere.

| Variable | Default | Effect |
| --- | --- | --- |
| `DSH_OPL_HOME` | `~/.dsh-opl` | Harness home for sessions, settings, and credentials; must be a portable path such as `~/.dsh-opl` |
| `DSH_OPL_NOTARIZE` | unset | Set to `1` to notarize the disk image during packaging |
| `OPL_GATEWAY_STATE_ROOT` | auto-detected | OPL app state directory, read only to reuse an existing sign-in |
| `DSH_DESKTOP_BUILDER_CONFIG` | `electron-builder.config.mjs` | electron-builder configuration used by packaging scripts |

### What this repository adds

| Addition | Location |
| --- | --- |
| OPL Gateway provider route | `packages/llm/llm-opl-gateway` |
| OPL Gateway account page | `packages/client/ui-settings-opl-gateway` |
| OPL packaging identity and installer | `apps/desktop/electron-builder.opl.mjs`, `apps/desktop/opl/` |
| Windows x64 packaging and installation | `apps/desktop/opl/install-windows.ps1`, `apps/desktop/opl/verify-opl-package.mjs` |
| Downstream npm scope support in the release gates | `scripts/package-scope.ts` |

The gateway plugin talks to the OPL Gateway HTTP API directly and does not shell out. `opl connect gateway …` is not required at runtime, so the app works on a machine with no OPL installation. It requests and reuses only a key from the OPL Gateway `DeepSeek` group; a key from the OPL App's `Codex` or `AGI` group is not accepted.

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
