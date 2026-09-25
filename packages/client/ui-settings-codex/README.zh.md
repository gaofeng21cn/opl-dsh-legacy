---
description: "在桌面设置中安装和配置 Codex DSH 协作 Skill。"
kind: "package-reference"
---

# @one-person-lab/dsh-client-ui-settings-codex

[English](README.md) | 中文

## 概述

为桌面设置增加 **Codex 协作**：检查本机安装状态、安装或更新内置 Skill，并选择是否在分派任务时启动 DSH。即使 Host 运行在其他环境，安装目标仍是本机 Codex 目录。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

默认 web-app 组合已包含此插件，无需填写插件配置。打开设置 → Codex 协作，核对目标目录后点击安装。新建 Codex 任务加载 Skill；必要时重启 Codex。

<a id="understand-the-implementation"></a>
## 理解实现

客户端使用仅向产品页面开放的 `dshDesktop.codex` 接口。Electron 负责文件事务、资源路径和安装清单，保留已修改或非本插件管理的目录，并保留用户覆盖的配置。Host 侧为空，不暴露远程服务或模型凭据。

<a id="model-experience"></a>
## 模型体验

无。本桌面设置页安装外部 Codex 协作 Skill，不贡献 DSH 模型上下文，也不改变工作 Agent 的循环与权限。

#### KV Cache 影响

无；本页面不组装或发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持桌面版，普通浏览器不显示该页面。
- 辅助脚本需要本机 Node.js 和真实 Codex 任务 ID。
- 安装不会启用唤醒桥接。
- 移动应用位置后可能需要再次更新 Skill 配置。

**运行时不变量：** 本包没有 invariant 配套包，因为它只负责设置展示，不拥有新的领域合同。安装事务由桌面包测试；客户端测试覆盖真实 Loader 组合和页面操作。

<a id="dev-note"></a>
### 开发备注

无。
