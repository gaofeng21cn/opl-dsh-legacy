---
description: "桌面应用的任务通知：通过 shell 桥接上报任务结束、实时失败，以及等待审批或回答的交互暂停。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-notifications

[English](README.md) | 中文

## 摘要

在桌面应用内，本包把客户端本就收到的主机事实转换为 Windows 系统通知：任务运行停止、Agent 实时失败，以及等待用户审批或回答的交互暂停。通知本身——文案、去重、用户的开关、应用是否在前台，以及点击后重新打开会话——都属于 Electron shell，本包只负责上报。在普通浏览器会话中没有 shell 桥接，因此插件不会安装任何内容。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

应用不在前台时会出现通知，桌面设置界面可以关闭通知。通知写明事件及其所属会话；点击通知会聚焦窗口并打开该会话。

### 上报内容

| 事件 | 来源事实 | 通知 |
|---|---|---|
| 一次运行停止 | `api-session/status` 由运行转为空闲的边沿 | 任务已结束 |
| 一次运行失败 | 该会话运行期间的 Agent 实时失败 | 任务失败 |
| 有待处理的审批 | 客户端可回答的待交互注册表，`approval` | 等待你审批 |
| 有待回答的问题 | 同一注册表，`question` 或 `plan-review` | 等待你输入 |

连接中断不会发布状态事件，因此断线永远不会被上报为任务结束；客户端接入时已经空闲的会话也不会产生通知。上报标识由观察到的事实推导（运行区间、失败、或交互的请求键），因此同一事件的重复投递会被 shell 丢弃，而不是显示两次。子代理的结束保持静默——用户的任务是它父级的回合——但子代理发出的阻塞式审批仍会上报。

### 内容

上报只包含事件标识、种类、会话标识和该会话的显示标题；状态文案由 shell 按语言提供。消息正文、提示词、工具参数、错误消息和凭据都不会经过该桥接。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

### 桥接探测

Electron preload 只在应用文档中暴露 `dshDesktop.notifications`。`desktopNotificationBridge()` 读取该值，校验两个成员都是函数，在浏览器会话中返回 undefined，这正是插件在桌面 shell 之外完全惰性的原因。

### 上报

`DesktopNotificationReporter` 把三类订阅折叠为上报。`api-session/status` 为每个会话维护一个带计数器的运行区间，使每次结束都有独立标识；`api-session/error` 把当前区间标记为失败并上报一次，同时抑制随后的结束上报。`uiSession.sessionStatus` 是客户端自身可回答的暂停注册表：请求键变化意味着新的暂停，因此回答一个再收到下一个会再次通知，而重复投递的待处理请求保持同一键并保持静默。

### 激活

插件向 shell 注册一个激活监听器。点击会通过 `ctx.uiWorkspace.openSession()` 路由到列表仍持有的会话；若点击指向客户端已不再列出的会话，则无处可去并被丢弃。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [ui-session](../ui-session/README.zh.md) — 使交互暂停可回答的待交互注册表。
- [ui-approval](../ui-approval/README.zh.md) 与 [ui-user-questions](../ui-user-questions/README.zh.md) — 请求出现在该注册表中的两个交互暂停域。
- [桌面应用](../../../apps/desktop/README.zh.md) — 负责通知呈现、关闭行为和托盘的 shell。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只观察主机状态变化，从不贡献提示词文本、工具或会话事件。

#### KV 缓存影响

无失效。模型可见输入不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了客户端能够如实上报的范围，属于当前包约束。

- **取消会被上报为运行结束** — 客户端可见的主机事件能区分失败与正常停止，但不携带仅存在于主机的持久化 `turn/end` 原因。因此被取消的运行上报中性的“任务已结束”，而不会声称完成。
- **通知依赖渲染器** — 上报来自应用窗口，因此从未加载的窗口，或没有该窗口的 shell，不会为任何事件发出通知。主机自身没有通知界面。

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>维护者工作上下文——点击展开</summary>

shell 侧策略——去重、前台抑制、Windows AppUserModelID 和设置开关——位于 `apps/desktop/src/notifications.ts`、`app-identity.ts` 和 `desktop-preferences.ts`；本包从不决定呈现方式。

</details>

**运行时不变式：** 不发布伴随模块。Remote 事件与注册表订阅是各自注册表持有的 effect，上报流跨越由 shell 在到达时校验的进程边界。
