# Agent Note: 控制 CLI 插话入口

Status: implemented

[English](2026-09-23-control-steer-entry.md) | 中文

## Problem

打包的桌面控制 CLI 一律以 `mode: 'queue'` 提交提示词，控制桥白名单也没有暴露 `session.updateQueue`。因此想给可见的运行中会话补充指令的人只能把它排到后续轮次；要把已排队的指令转为插话，必须有人在 GUI 里点击。后端其实两条路径都已具备——`session.prompt` 接受 `mode: 'queue' | 'steer'`，`session.updateQueue` 会带着落点与运行状态检查把一个仍待处理的条目转为插话——缺的只是入口。[桌面控制记录](2026-09-21-opl-search-and-desktop-control.zh.md)拥有本记录所扩展的桥、绑定与白名单决策。

## Decision

`opl-dsh-control send SESSION --file PROMPT.txt [--mode queue|steer]` 把请求的模式转交给已有的 `session.prompt`；未给出 `--mode` 时仍发送 `queue`，既有调用方的投递方式不变。回执在服务器的 `accepted` 旁增加 `requestMode`，而 `accepted` 只表示已受理：CLI 绝不上报某个工具已执行或模型已读取该提示词。

`opl-dsh-control steer-queued SESSION ITEM` 以 `{ itemId, action: { kind: 'steer' } }` 调用 `session.updateQueue`，控制桥白名单只增加这一个 `session` 方法。后端拒绝会原样返回 `session/steer-unavailable` 或 `session/queue-item-not-found` 并以退出码 1 结束，且 CLI 不会追加任何请求，因此被拒绝的插话绝不会变成一次被谎称为插话的排队。ITEM 是会话队列投影报告的待处理条目 id。

运行状态下的安全边界与空闲会话的落点仍归后端：`session.prompt` 通过 `Agent.steer` 投递插话，`session.updateQueue` 仅在该条目仍是 `next-turn` 且 Agent 正在运行时才接受插话，CLI 不承诺硬中断正在运行的 shell 命令。[人类收件箱控制记录](2026-08-27-continuable-subagent-human-inbox-control.zh.md)拥有这些条目规则。

## Alternatives considered

**在 `send` 中硬编码 `steer`。** 这会改变所有既有调用方的投递方式，包括刻意排队委派工作的流程，而且回执再也无法告诉调用方它请求了哪种落点。

**插话被拒时回退为 `queue`。** 调用方会以成功退出，而指令比请求晚一轮才到达；拒绝码存在的意义正是让调用方而非 CLI 决定下一步。

**为排队条目插话新增专用 Remote 方法。** `session.updateQueue` 已经拥有待处理条目查找、`next-turn` 限制与运行状态检查，新增方法只会重复并逐渐偏离这些规则。

**让 CLI 自行挑选排队条目。** 直接插话最旧的待处理条目可以省掉 ITEM 参数，但这是对目标的猜测，可能插话到并非调用方所指的指令。

## Consequences

Agent 现在无需有人在 GUI 前，就能把指令放入可见的运行中会话，也能把已排队的指令转为插话而不必重新输入。CLI 只报告它确知的内容：它请求的模式、服务器的受理，以及拒绝自身的代码与退出码。这里没有任何东西会中断正在进行的工具调用；那条边界仍归 Agent。`apps/desktop/tests/opl-control.spec.ts` 通过派生的 Node 进程把打包脚本连到回环假桌面来驱动它，`apps/desktop/tests/control-bridge.spec.ts` 则固定白名单成员与拒绝透传。CLI 的 `read` 仍只打印会话记录而非队列投影，因此调用方要通过白名单内的 `controlSnapshot` RPC 调用或 GUI 获取 ITEM。
