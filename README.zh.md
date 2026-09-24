# OPL DSH

[English](README.md) | 中文

OPL 维护的 DeepSeek Harness fork：本仓库持续维护 OPL Gateway 接入、桌面打包和自定义 DSH 插件，并从这里发布 OPL DSH。

> 非官方发行版，与 DeepSeek 无隶属、背书或支持关系。`upstream` 远端只用于同步 DeepSeek Harness 基线；本 fork 自己维护插件、打包配置、本地修复、发布和问题跟踪。

<a id="run"></a>

## 下载与安装

从 [Releases](https://github.com/gaofeng21cn/opl-dsh/releases) 下载 macOS 的 `opl-dsh-<版本>-mac-arm64.dmg` 或 Windows 的 `opl-dsh-<版本>-win-x64-setup.exe`。macOS 打开镜像后把 **OPL DSH** 拖进「应用程序」；Windows 直接运行安装程序。

- 已签名并通过 Apple 公证，首次打开无需额外步骤。
- 支持 Apple Silicon（arm64），要求 macOS 13 或更高。
- Windows 10 或 11 x64。安装程序未签名，首次打开时 SmartScreen 会提示。
- 需要一个 OPL Gateway 账号，无需安装其他软件。

## 开始使用

1. 打开 **OPL DSH**，进入 **设置 → OPL Gateway**。
2. 用 OPL Gateway 账号登录。
3. 回到会话，在模型选择器里选择 **DeepSeek-V4.1-Flash**。

同一页面会显示账号、余额、今日与累计 Token 及费用，以及当前使用的推理地址。

如果本机已在 OPL App 中登录过 OPL Gateway，本应用会直接沿用那份账号，第 2 步已完成。

## 你的数据

macOS 的会话、设置与凭据保存在 `~/.dsh-opl`，Windows 保存在 `%APPDATA%\\@deepseek-ai\\dsh-desktop\\dsh-home`；可用 `DSH_OPL_HOME` 在任一平台迁移该目录。登录只保存用于自动续期的会话令牌，不保存密码。模型请求直接发往 OPL Gateway（默认 `https://gateway.medopl.com/v1`）。

## 已知限制

- Windows 版本未配置代码签名证书，首次打开时 SmartScreen 会提示一次。
- 若账号需要交互式验证（人机校验或两步验证），请先在该流程中完成；本应用只处理邮箱与密码。

## 面向开发者

<a id="run-from-source"></a>

### 构建 macOS 应用

需要 macOS、Node.js ≥ 22.19、pnpm，以及一枚 Developer ID 证书（对外分发时还需要公证凭据）。

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

产物在 `apps/desktop/.desktop-build/targets/mac-arm64/artifacts/`，文件名为 `opl-dsh-<版本>-mac-arm64.dmg`。加上 `DSH_OPL_NOTARIZE=1` 可在打包过程中完成公证。

用 `apps/desktop/opl/install-macos.sh` 安装本地构建。它要求目标位置为空：`ditto` 会向已存在的 bundle 合并，留下签名未覆盖的资源，macOS 随后报 `a sealed resource is missing or invalid`。

### 构建 Windows 应用

需要 Windows 10 或 11 x64、Node.js >= 22.19、pnpm、Python，以及用于编译原生模块的 Visual C++ Build Tools。

```sh
pnpm install
pnpm run typecheck
pnpm exec vitest run apps/desktop packages/llm/llm-opl-gateway \
  packages/client/ui-settings-opl-gateway packages/util/home-paths

DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
pnpm run package:opl:desktop:win:x64:unsigned
```

产物位于 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`，包括未签名 NSIS 安装程序和便携版可执行文件。`pnpm run package:opl:desktop:win:x64:dir:unsigned` 只生成 `win-unpacked/` 目录，适合快速启动调试。用 `apps/desktop/opl/install-windows.ps1` 安装本地构建。

### 在 Windows shell 中调用 DeepSeek

仓库提供与桌面应用共用 OPL Gateway 配置的无头入口：

```powershell
.\\scripts\\opl-dsh.cmd "list the files in the current workspace"
```

它使用 `opl-headless` profile 并以 JSON 输出最终回答；传入 `--session-id <session-id>` 可继续已有会话。默认 Harness home 为 `%APPDATA%\\@deepseek-ai\\dsh-desktop\\dsh-home`，可设置 `DSH_OPL_HOME` 将状态移到其他位置。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_OPL_HOME` | `~/.dsh-opl` | 会话、设置与凭据所在的 Harness home；必须使用可移植路径（例如 `~/.dsh-opl`） |
| `DSH_OPL_NOTARIZE` | 未设置 | 设为 `1` 时在打包过程中公证磁盘映像 |
| `OPL_GATEWAY_STATE_ROOT` | 自动探测 | OPL App 状态目录，仅在沿用既有登录时读取 |
| `DSH_DESKTOP_BUILDER_CONFIG` | `electron-builder.config.mjs` | 打包脚本使用的 electron-builder 配置 |

### 本仓库增加了什么

| 增量 | 位置 |
| --- | --- |
| OPL Gateway 提供方路由 | `packages/llm/llm-opl-gateway` |
| OPL Gateway 账号页 | `packages/client/ui-settings-opl-gateway` |
| OPL 打包身份与安装脚本 | `apps/desktop/electron-builder.opl.mjs`、`apps/desktop/opl/` |
| Windows x64 打包与安装 | `apps/desktop/opl/install-windows.ps1`、`apps/desktop/opl/verify-opl-package.mjs` |
| 发布门禁对下游 npm scope 的支持 | `scripts/package-scope.ts` |

网关插件直接对接 OPL Gateway 的 HTTP API，不调用命令行，因此运行时不需要 `opl connect gateway …`，在没有安装 OPL 的机器上也能使用。它只会申请或复用 OPL Gateway `DeepSeek` 分组中的 key；OPL App 的 `Codex` 或 `AGI` 分组 key 不会被接受。

### 本 fork 维护的两处平台修复

1. **编辑菜单**（`apps/desktop/src/menus.ts`）。上游桌面壳替换 Electron 默认菜单时没有带上 `editMenu` role，导致 macOS 标准编辑快捷键与输入框右键菜单都无人处理。
2. **系统证书信任**（`apps/desktop/src/host-process.ts`）。内置 Node 只信任自带根证书，因此在 TLS 检查代理或私有 CA 环境下，应用内所有出站请求都会失败，而 curl 与浏览器正常。宿主进程因此传入 `--use-system-ca`。

这两处改动属于本 fork 的维护范围，不依赖上游是否接受外部 PR。

### 与上游保持同步

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream master
git rebase upstream/master main
```

本 fork 会在每次同步上游后重新检查自有插件、打包配置和本地修复。上游迭代很快并已声明会有破坏性变更，因此每次 rebase 后重跑：

```sh
npx vitest run packages/llm/llm-opl-gateway packages/client/ui-settings-opl-gateway apps/desktop
```

并做一次真实会话：选到 `OPL Gateway / DeepSeek-V4.1-Flash` 并收到回复。

## 许可

上游代码为 MIT，见 [LICENSE](LICENSE)。本仓库新增的包同样以 MIT 发布。
