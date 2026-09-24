---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-workspace-file-rewind

[English](2026-09-24-workspace-file-rewind.md) | 中文

## 概述

新增两个仅写日志的 Session 事件类型 file/checkpoint 与 file/change，分别记录一轮工作区基线，以及每次工具执行观察到的工作区写入，供回退还原。新增普通事件类型属同版本变更：没有任何既有根发生变化。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-workspace-file-rewind
baseline: false
changes:
  - root: "event:file/change"
    previous: null
    after: "d565bcf464911b1d7c146a3bff99f4ae6dba2f8a1366ab002885de44404367f0"
    decision: same-version
  - root: "event:file/checkpoint"
    previous: null
    after: "408d0cd6d64b7f79e9a3bae259e040ae5f0f3abd509a2273dd7bf54d59a0468e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有记录仍然有效，因为本次只引入两个新的事件根，所有既有根的摘要保持不变。新事件在读取时是必需项，因此不认识 file/checkpoint 或 file/change 的构建会拒绝这些日志，而不是丢掉记录继续重放；这种拒绝正是预期的失败方式：丢掉 file/change 会让回退还原一个它从未观测过其写入的轮次，丢掉 file/checkpoint 则会掩盖“当时没有基线”这一事实。不含这两个事件的日志重放行为与之前完全一致。两个事件都不进入模型可见 surface，也不进入任何消息投影，因此请求、投影与派生消息均不变。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run packages/session/session-rewind-files/tests/journal.spec.ts packages/api/session-controller/tests/commands-rewind-files.host.spec.ts：2 个文件，27 个测试通过，1 个跳过（宿主机无法创建符号链接时跳过该用例）。journal 套件通过真实 Session 写入这两个事件并还原一个已记录轮次，覆盖修改、新建、删除、重命名、二进制内容、冲突拒绝，以及从折叠投影重放。node node_modules/tsx/dist/cli.mjs scripts/gen-persistence-catalog.ts --check：catalog、两份 catalog 与 known-event-types.ts 均为最新。

<a id="dev-note"></a>
## 开发备注

无。
