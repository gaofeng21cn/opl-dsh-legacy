# OPL DSH

[English](README.md) | 中文

OPL 维护的 DeepSeek Harness fork：本仓库持续维护 OPL Gateway 接入、桌面打包和自定义 DSH 插件，并从这里发布 OPL DSH。

> 非官方发行版，与 DeepSeek 无隶属、背书或支持关系。`upstream` 远端只用于同步 DeepSeek Harness 基线；本 fork 自己维护插件、打包配置、本地修复、发布和问题跟踪。

<a id="run"></a>

## 下载与安装

从 [Releases](https://github.com/gaofeng21cn/opl-dsh/releases) 下载 `opl-dsh-<版本>-mac-arm64.dmg`，打开后把 **OPL DSH** 拖进「应用程序」。

- 已签名并通过 Apple 公证，首次打开无需额外步骤。
- 支持 Apple Silicon（arm64），要求 macOS 13 或更高。
- 需要一个 OPL Gateway 账号，无需安装其他软件。

## 开始使用

1. 打开 **OPL DSH**，进入 **设置 → OPL Gateway**。
2. 用 OPL Gateway 账号登录。
3. 回到会话，在模型选择器里选择 **DeepSeek-V4.1-Flash**。

同一页面会显示账号、余额、今日与累计 Token 及费用，以及当前使用的推理地址。

如果本机已在 OPL App 中登录过 OPL Gateway，本应用会直接沿用那份账号，第 2 步已完成。

## 你的数据

会话、设置与凭据保存在 `~/.dsh-opl`。登录只保存用于自动续期的会话令牌，不保存密码。模型请求直接发往 OPL Gateway（默认 `https://gateway.medopl.com/v1`）。

## 已知限制

- 目前只提供 macOS（Apple Silicon）版本。
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

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_OPL_HOME` | `~/.dsh-opl` | 会话、设置与凭据所在的 Harness home |
| `DSH_OPL_NOTARIZE` | 未设置 | 设为 `1` 时在打包过程中公证磁盘映像 |
| `OPL_GATEWAY_STATE_ROOT` | 自动探测 | OPL App 状态目录，仅在沿用既有登录时读取 |

### 本仓库增加了什么

| 增量 | 位置 |
| --- | --- |
| OPL Gateway 提供方路由 | `packages/llm/llm-opl-gateway` |
| OPL Gateway 账号页 | `packages/client/ui-settings-opl-gateway` |
| OPL 打包身份与安装脚本 | `apps/desktop/electron-builder.opl.mjs`、`apps/desktop/opl/` |
| 发布门禁对下游 npm scope 的支持 | `scripts/package-scope.ts` |

网关插件直接对接 OPL Gateway 的 HTTP API，不调用命令行，因此运行时不需要 `opl connect gateway …`，在没有安装 OPL 的机器上也能使用；若 OPL App 已登录过，则沿用它记录的账号与已绑定的密钥，无需再次登录。

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
