# OPL DSH

OPL 维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) fork：在上游代码之上持续维护 OPL Gateway 接入、桌面打包和自定义 DSH 插件，并从本仓库发布 OPL DSH。

> **非官方发行版。** 本项目与 DeepSeek 无隶属、合作或背书关系。「DeepSeek Harness」是深度求索公司的注册商标；本项目按官方的[品牌素材使用规范](BRAND_GUIDELINES.zh.md)使用缩写的 **DSH** 命名，构建产物使用 OPL 自己的标识（`OPL DSH` / `com.onepersonlab.dsh`）。上游代码以 MIT 许可发布，许可与版权声明保留在 [LICENSE](LICENSE)。

> **关于本文件。** 这是 OPL 自己维护的 fork。`upstream` 远端只用于同步 DeepSeek Harness 的最新代码；本仓库的插件、打包配置、发布产物和本地修复由 OPL 自己维护。上游原始 README 可在[上游仓库](https://github.com/deepseek-ai/deepseek-harness#readme)查看。

## 这是什么

一份可以直接构建出 macOS 桌面应用的上游源码树，加上 OPL 的增量：

| 增量 | 位置 | 作用 |
| --- | --- | --- |
| OPL Gateway 路由 | `packages/llm/llm-opl-gateway` | 把 OPL Gateway 作为一条提供方路由接入，模型选择器里显示为 `OPL Gateway / DeepSeek-V4.1-Flash` |
| OPL Gateway 账号页 | `packages/client/ui-settings-opl-gateway` | 设置里的「OPL Gateway」页：账号、余额、用量、密钥与推理地址 |
| 打包配置 | `apps/desktop/electron-builder.opl.mjs`、`apps/desktop/opl/` | OPL 的发布身份、图标与安装脚本 |
| 平台修复 | `apps/desktop/src/menus.ts`、`apps/desktop/src/host-process.ts` | 见下文「与上游的差异」 |
| scope 支持 | `scripts/package-scope.ts` | 让上游的发布与打包门禁认识下游 scope 的包 |

## 不是什么

- 不是官方发行版，也不代表 DeepSeek 的立场或质量承诺。
- 本项目独立维护自己的插件、构建、发布和版本节奏；上游代码仅作为同步基线。

## 与 OPL Gateway 的关系

账号归 **OPL Framework** 所有：登录、会话轮换、托管密钥的创建与绑定都由 `opl connect gateway …` 负责。本项目的插件是这份账号状态的**只读视图**加一个安全动作（本机尚无账号时登录），不重复实现协议，也不另建密钥——否则同一个账号会出现两把密钥和两个事实来源。

账号页的数据来自 OPL 自己的记录，所以**在 OPL 应用里登录过就够了**，不需要在这里重复登录；登录、退出与密钥变更都在 OPL 应用中完成。

## 构建 macOS 桌面版

需要 macOS、Node.js ≥ 22.19、pnpm，以及一枚 Developer ID 证书（对外分发时还需要公证凭据）。

```sh
pnpm install

# 准备运行时与包集合（会构建整个仓库，耗时较长）
DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<证书名，省略 "Developer ID Application:" 前缀>' \
DSH_DESKTOP_MACOS_TEAM_ID='<10 位 Team ID>' \
APPLE_KEYCHAIN_PROFILE='<notarytool profile>' \
DSH_DESKTOP_AUTO_UPDATE_ENV=production \
pnpm --filter @deepseek-ai/dsh-desktop run prepare:package

# 打包成 .app / .dmg / .zip
cd apps/desktop
DSH_DESKTOP_APP_ID=com.onepersonlab.dsh \
DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<同上>' \
DSH_DESKTOP_MACOS_TEAM_ID='<同上>' \
APPLE_KEYCHAIN_PROFILE='<notarytool profile>' \
DOWNLOAD_TEST_ORIGIN=https://download.deepseek.com \
pnpm exec electron-builder --config electron-builder.opl.mjs --mac --arm64 --publish never
```

产物在 `apps/desktop/.desktop-build/targets/mac-arm64/artifacts/`，命名为 `opl-dsh-<版本>-mac-arm64.dmg`。

### 安装到本机

```sh
apps/desktop/opl/install-macos.sh          # 默认 arm64
```

脚本会把应用装到 `/Applications/OPL DSH.app` 并校验签名。它要求目标目录是**全新的**：`ditto` 会向已存在的目录合并，留下签名未覆盖的资源，macOS 随后报 `a sealed resource is missing or invalid`。

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_OPL_HOME` | `~/.dsh-opl` | 本产物的 Harness home（会话、设置、凭据） |
| `DSH_OPL_NOTARIZE` | 未设置 | 设为 `1` 时启用公证；本地安装不需要（不会带隔离属性） |
| `OPL_APP_OPL_BIN` | 自动探测 | `opl` 可执行文件位置；GUI 启动时 `PATH` 很短，插件会在 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 中查找 |

## 本仓库维护的本地改动

除 OPL Gateway 和打包增量外，本项目还维护两处桌面端修复：

1. **桌面端编辑菜单**（`apps/desktop/src/menus.ts`）。上游桌面壳用自定义模板整体替换了 Electron 默认菜单，却没有 `editMenu` role，于是 macOS 上标准编辑快捷键全部无响应、输入框右键也没有菜单。这里补回平台编辑菜单与右键菜单。
2. **系统证书信任**（`apps/desktop/src/host-process.ts`）。内置 Node 默认只信任自带根证书，因此在 TLS 检查代理或私有 CA 环境下，应用内所有出站 HTTPS 都会失败，而同机的 curl 与浏览器正常。宿主进程因此加上 `--use-system-ca`。

这两处改动属于本 fork 的维护范围，不依赖上游是否接受外部 PR。

## 与上游同步

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git fetch upstream master
git rebase upstream/master main
```

上游更新只改变同步基线；本仓库会在变基后重新检查自有插件、打包配置和本地修复。上游处于快速迭代阶段并明确声明会有破坏性变更，因此每次同步后应重跑验收：

```sh
npx vitest run packages/llm/llm-opl-gateway packages/client/ui-settings-opl-gateway apps/desktop
```

以及一次真实会话：模型选择器里能选到 `OPL Gateway / DeepSeek-V4.1-Flash`，并能收到回复。

## 后续方向

`opl-dsh` 是 OPL 打包的 DSH 形态的统一出口，因此除 macOS 桌面版外，后续还可以从这里发布：

- 其他内嵌 OPL Gateway 的 DSH 形态（容器镜像、headless 发行版等）；
- OPL 维护的其他 DSH 插件。

插件包位于 `packages/` 下，与上游包共用同一套发布序列，因此新增插件只需按上游的包结构落位。

## 许可

上游代码为 MIT，见 [LICENSE](LICENSE)。本项目新增的包同样以 MIT 发布。
