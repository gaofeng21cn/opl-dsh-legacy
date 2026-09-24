# OPL DSH

[English](README.md) | 中文

OPL 维护的 macOS 与 Windows 桌面版 DeepSeek Harness：用 OPL Gateway 账号登录，即可开始使用 DeepSeek 模型。

> 非官方发行版，与 DeepSeek 无隶属、背书或支持关系。基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

<a id="run"></a>

## 下载与安装

从 [Releases](https://github.com/gaofeng21cn/opl-dsh/releases) 下载 macOS 用的 `opl-dsh-<版本>-mac-arm64.dmg`，或 Windows 用的 `opl-dsh-<版本>-win-x64-setup.exe`。macOS 上打开映像并把 **OPL DSH** 拖进「应用程序」；Windows 上直接运行安装包。

- macOS：已签名并通过 Apple 公证，支持 Apple Silicon（arm64），要求 macOS 13 或更高，首次打开无需额外步骤。
- Windows：要求 x64 的 Windows 10 或 11。安装包**未做代码签名**，首次启动时 SmartScreen 会给出警告；选择「更多信息」，再选择「仍要运行」。
- 需要一个 OPL Gateway 账号，无需安装其他软件。

## 开始使用

1. 打开 **OPL DSH**，进入 **设置 → OPL Gateway**。
2. 用 OPL Gateway 账号登录。
3. 回到会话，在模型选择器里选择 **DeepSeek-V4.1-Flash**。

同一页面会显示账号、余额、今日与累计 Token 及费用，以及当前使用的推理地址。

如果本机已在 OPL App 中登录过 OPL Gateway，本应用会直接沿用那份账号，第 2 步已完成。

## 你的数据

会话、设置与凭据在 macOS 上保存在 `~/.dsh-opl`，在 Windows 上保存在 `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home`；两个平台都可用 `DSH_OPL_HOME` 改变该位置。登录只保存用于自动续期的会话令牌，不保存密码。模型请求直接发往 OPL Gateway（默认 `https://gateway.medopl.com/v1`）。

## 已知限制

- Windows 发行包未附带代码签名证书，首次启动前 SmartScreen 会警告一次。
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

需要 x64 的 Windows 10 或 11、Node.js ≥ 22.19、pnpm、Python，以及用于编译原生模块的 Visual C++ 生成工具。

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

这些测试之前不需要预装任何 Harness profile。唯一会读取 profile 的测试 `apps/desktop/tests/profile-mcp.spec.ts` 会自己在临时目录里建一个一次性 profile；它需要安装提供的是桌面 profile 的两个 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）能从 `dsh` 安装锚点解析出来，这一点由 `pnpm install` 保证。

该构建与 macOS 构建走同样的步骤，只是在 DMG 之前停下：准备 win-x64 运行时、打包桌面应用，然后交给 electron-builder。产物在 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`，文件名为 `opl-dsh-<版本>-win-x64-setup.exe`（NSIS 安装包）与 `opl-dsh-<版本>-win-x64-portable.exe`（免安装单文件）。改为 `pnpm run package:opl:desktop:win:x64:dir:unsigned` 则停在解包目录 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/`，这是开发中启动构建产物最快的方式。

用 `apps/desktop/opl/install-windows.ps1` 安装本地构建。它会运行安装包；若该构建没有产生安装包，则改为复制解包目录，随后通过 `apps/desktop/opl/verify-opl-package.mjs` 复检落在磁盘上的内容。

若不安装任何东西就运行构建产物，可直接启动 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/OPL DSH.exe`。若要在开发循环中就地重建桌面壳，`pnpm --dir apps/desktop run dev` 会用工作区代码启动同一个应用。

### 从 Windows 命令行调用 DeepSeek

仓库提供了一个和桌面应用共用 OPL Gateway 配置的 headless 入口。完成一次构建后，在仓库根目录运行：

```powershell
.\scripts\opl-dsh.cmd "list the files in the current workspace"
```

它会使用 `opl-headless` profile、当前目录作为默认工作区，并以 JSON 输出最终结果，适合被 Codex、脚本或其他自动化客户端调用。`--session-id` 等参数会原样传给 headless profile，因此可以继续已有会话：

```powershell
.\scripts\opl-dsh.cmd --session-id <session-id> "continue the previous task"
```

默认 Harness home 是 `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home`；设置 `DSH_OPL_HOME` 可以把会话、项目索引和登录状态放到其他位置。入口要求已经准备好桌面 runtime 和 CLI 构建产物（`pnpm run build`、`pnpm --filter @deepseek-ai/dsh-desktop run prepare:package`）。

该流程不需要代码签名证书，产物也刻意保持未签名：除非提供证书输入或明确要求未签名构建，Windows 打包会拒绝产出产物。若要签名，请设置 `DSH_DESKTOP_WINDOWS_CER_FILE`、`DSH_DESKTOP_WINDOWS_SIGNTOOL`、`DSH_DESKTOP_WINDOWS_KEY_CONTAINER` 与 `DSH_DESKTOP_WINDOWS_TOKEN_PIN` 并去掉 `--unsigned`；各项要求见 [apps/desktop/README.zh.md](apps/desktop/README.zh.md)。

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_OPL_HOME` | macOS 为 `~/.dsh-opl`，Windows 为 `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home` | 会话、设置与凭据所在的 Harness home |
| `DSH_OPL_NOTARIZE` | 未设置 | 设为 `1` 时在打包过程中公证磁盘映像 |
| `OPL_GATEWAY_STATE_ROOT` | 自动探测 | OPL App 状态目录，仅在沿用既有登录时读取 |
| `DSH_DESKTOP_BUILDER_CONFIG` | `electron-builder.config.mjs` | 打包命令使用的 electron-builder 配置；OPL 打包脚本会传入 `electron-builder.opl.mjs` |

### 本仓库增加了什么

| 增量 | 位置 |
| --- | --- |
| OPL Gateway 提供方路由 | `packages/llm/llm-opl-gateway` |
| OPL Gateway 账号页 | `packages/client/ui-settings-opl-gateway` |
| OPL 打包身份与安装脚本 | `apps/desktop/electron-builder.opl.mjs`、`apps/desktop/opl/` |
| Windows x64 打包与安装 | `apps/desktop/opl/install-windows.ps1`、`apps/desktop/opl/verify-opl-package.mjs` |
| 发布门禁对下游 npm scope 的支持 | `scripts/package-scope.ts` |

网关插件直接对接 OPL Gateway 的 HTTP API，不调用命令行，因此运行时不需要 `opl connect gateway …`，在没有安装 OPL 的机器上也能使用；若 OPL App 已登录过，则沿用它记录的账号与已绑定的密钥，无需再次登录。

### 本仓库携带的两处平台修复

1. **编辑菜单**（`apps/desktop/src/menus.ts`）。上游桌面壳替换 Electron 默认菜单时没有带上 `editMenu` role，导致 macOS 标准编辑快捷键与输入框右键菜单都无人处理。
2. **系统证书信任**（`apps/desktop/src/host-process.ts`）。内置 Node 只信任自带根证书，因此在 TLS 检查代理或私有 CA 环境下，应用内所有出站请求都会失败，而 curl 与浏览器正常。宿主进程因此传入 `--use-system-ca`。

两处均已上报上游：[编辑菜单](https://github.com/deepseek-ai/deepseek-harness/discussions/6937)、[证书信任](https://github.com/deepseek-ai/deepseek-harness/discussions/6938)。上游不接受外部 PR（见 [CONTRIBUTING](CONTRIBUTING.zh.md)），因此暂由本仓库携带。

### 与上游保持同步

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream master
git rebase upstream/master main
```

增量刻意保持小而集中：新增内容放在新文件里，对上游文件的改动（如 `packages/bundle/web-app/cordis.patch.yml`）保持逐行最小差异，且不重排既有键序。上游迭代很快并已声明会有破坏性变更，因此每次 rebase 后重跑：

```sh
npx vitest run packages/llm/llm-opl-gateway packages/client/ui-settings-opl-gateway apps/desktop
```

并做一次真实会话：选到 `OPL Gateway / DeepSeek-V4.1-Flash` 并收到回复。

## 许可

上游代码为 MIT，见 [LICENSE](LICENSE)。本仓库新增的包同样以 MIT 发布。
