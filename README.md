# OPL DSH

English | [中文](README.zh.md)

OPL 自维护的 DeepSeek Harness 桌面发行版，面向使用 OPL Gateway 和 Codex 的个人开发者。DSH 负责模型推理、工具执行、权限控制和会话管理；OPL 提供网关接入、桌面分发与协作扩展。

> 本项目是独立维护的 fork，与 DeepSeek 无隶属关系。上游来源：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。问题反馈与版本下载均由本仓库维护。

<a id="run"></a>

## 下载与开始使用

前往 [GitHub Releases](https://github.com/gaofeng21cn/opl-dsh/releases)，以对应版本页面实际提供的附件为准。macOS 支持 Apple Silicon、macOS 13 及以上；Windows 构建目标为 Windows 10/11 x64。

1. macOS 打开 DMG，将 **OPL DSH** 拖入「应用程序」；Windows 运行安装程序。
2. 打开 **设置 → OPL Gateway**，登录账号。
3. 在会话中选择 **OPL Gateway / DeepSeek-V4.1-Flash**，开始工作。

账号页可查看余额、Token 用量、费用和推理地址。应用直接连接 OPL Gateway，无需安装 OPL App、OPL Framework 或额外的命令行工具。

## 主要能力

| 能力 | 使用方式 |
| --- | --- |
| DeepSeek 原生接入 | 使用 DSH 官方 `DeepSeekAdapter`，通过 Messages 协议调用模型，保留 DSH 的思考、工具调用与会话处理 |
| OPL Gateway | 独立登录、自动管理 DeepSeek/Codex 双组密钥、故障切换、用量与搜索 |
| Codex 与 DSH 协作 | Codex Skill 派发、继续和查询 DSH 任务，DSH 插件记录任务反馈 |
| 会话与项目 | 普通聊天、编辑重发、会话与文件回退、会话移动到项目 |
| 桌面体验 | 通知、托盘、关闭行为设置；Windows 支持原生执行与 WSL2 |
| Shell | PowerShell、Bash 与 Git Bash，沿用 DSH 权限和执行环境 |

## 账号、密钥与升级

OPL DSH 登录后分别申请或复用 **DeepSeek** 与 **Codex** 分组的专用 API key。默认模型 ID 为 `deepseek-flash`，界面显示 **DeepSeek-V4.1-Flash**；推理地址为 `https://gateway.medopl.com/v1`。

默认通道使用官方 DeepSeek adapter 和 Messages 协议。在尚未输出任何响应时，连接失败、超时、限流、额度不足、认证失败或端点不可用会触发一次 OpenAI 兼容通道切换，由官方 `dsh-llm-pi-ai` 使用 Codex 分组 key 发起 Responses 请求。取消、无效请求和已开始输出的响应不自动重放。两条通道均由 DSH 管理 Agent 循环与工具执行。

也可在模型列表直接选择 **OPL Gateway · OpenAI**。设置页分别显示两组 key 的就绪状态；Codex 分组不可用时保留默认通道，并提示刷新账号。

升级后，旧版的 Codex/AGI 分组 key 不会被改组或自动禁用。应用分别使用 `OPL_GATEWAY_DEEPSEEK_API_KEY` 与 `OPL_GATEWAY_CODEX_API_KEY` 凭据槽；持有有效的 DSH 登录会话时自动补齐两组 key。若账号页提示分组或登录问题，请重新登录，并确认账号可使用 DeepSeek 分组。

本机已有 OPL App 登录记录时可用于账号状态识别，但其中的 Codex/AGI key 不会作为 DSH 推理凭据导入。登录保存用于续期的会话令牌，不保存密码。

| 平台 | 默认数据目录 |
| --- | --- |
| macOS | `~/.dsh-opl` |
| Windows | `%APPDATA%\@deepseek-ai\dsh-desktop\dsh-home` |

可通过 `DSH_OPL_HOME` 指定数据目录。升级前建议备份该目录；它包含会话、设置和凭据。

本版会话文件格式为 V5。这里的 V4/V5 是本地会话文件的版本号，与模型 API 协议无关。打开旧会话时按 DSH 官方相邻迁移机制读取；首次写入时在原文件旁保存 V5 后继文件，保留旧文件。

## Codex 与 DSH 协作

协作由两部分组成：DSH 内的 `task-feedback` 插件和本仓库的 [opl-dsh-workflow Skill](.agents/skills/opl-dsh-workflow/SKILL.md)。Codex 通过本地控制接口调度任务；模型请求、工具执行和权限判断仍由 DSH 承担。

将 `.agents/skills/opl-dsh-workflow` 安装到 Codex 的 skills 目录，按照 [配置说明](.agents/skills/opl-dsh-workflow/references/setup.md) 创建本机私有配置。设置 `startCommand` 后，Skill 在未发现桌面控制连接时自动启动 DSH，并等待连接就绪。macOS 可配置 `/usr/bin/open` 和参数 `["-a", "OPL DSH"]`。

派发和继续操作使用显式 operation 标识，重试会复用已有记录。自动唤醒 Codex 还需要配置可用的回调桥；安装 Skill 本身不代表后台通知已经接通。

## 构建与维护

<a id="run-from-source"></a>

需要 Node.js 24、pnpm，以及目标平台原生构建工具。

```sh
pnpm install --frozen-lockfile
pnpm run build:official
pnpm run typecheck
```

macOS 分发使用钥匙串中可用的 Developer ID Application 证书和 notarytool 凭据配置：

```sh
DSH_DESKTOP_MACOS_SIGNING_IDENTITY='<certificate name without Developer ID Application prefix>' \
DSH_DESKTOP_MACOS_TEAM_ID='<10-character Team ID>' \
APPLE_KEYCHAIN_PROFILE='<notarytool profile>' \
pnpm --filter @deepseek-ai/dsh-desktop run package:opl:mac:arm64
```

Windows 需要 Visual C++ Build Tools、Python 和可用的 WSL2 Linux 发行版来构建内置 Linux 运行时：

```powershell
pnpm run package:opl:desktop:win:x64:unsigned
.\scripts\opl-dsh.cmd "list the files in the current workspace"
```

构建产物位于 `apps/desktop/.desktop-build/targets/`。OPL 构建使用独立产品标识 `com.onepersonlab.dsh`，经 GitHub Releases 手动更新，不接入上游强制更新服务。详细平台说明见 [桌面文档](apps/desktop/README.md)。

上游只作为同步来源；OPL 自维护网关插件、协作能力和打包配置。同步后需核对这些改动与新版 DSH 接口，并运行相应测试。发布只面向本 fork，不使用上游 npm scope 的发布工作流。

## 当前限制

- Windows 安装包未配置代码签名，SmartScreen 可能显示提示。
- macOS 安装包需完成签名与 Apple 公证后才提供下载；源码发布与安装包发布状态分别以 Release 附件为准。
- 需要人机验证或两步验证的账号登录流程尚未内置。
- 模型与搜索能力由 Gateway 的分组、路由及账号权限决定。

## 许可证

本项目及新增插件使用 [MIT License](LICENSE)，保留上游版权与第三方依赖声明。
