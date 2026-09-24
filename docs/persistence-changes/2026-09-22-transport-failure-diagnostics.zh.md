---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-transport-failure-diagnostics

[English](2026-09-22-transport-failure-diagnostics.md) | 中文

## 概述

记录传输失败诊断，并记录 rewind 消息来源词汇所需的 Session V4→V5 迁移。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-transport-failure-diagnostics
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "078724574ff38328faa94bd2de248cdb9d187a5a2703d23713089ada1777554f"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "09dfd7cd766f59c2ad12eaac80093c08e2cf861416ce8634c9b23512131e424f"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "cc6a727927122fcd312e287a9e7e0decf97a48ec4cbba2cd44a375f46a006574"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "14be994ce236eddc21cc192e52f21029c849cf6b4b1598c43b5b95ca89de43e4"
    decision: version-bump
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "97fa5f2b1ab22845443a77bbd7c24e7e3e28433b279e047c2d01439fea88f5f7"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "6f3f1ca08d4737746cfbf0d54937d027037b226d2f3034ed6513e076a01babb7"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "ac530322e0f8623ab429341776425be25c1ea05cc3058d35545eeb245b89b005"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "a304370bd2df86a19b4a9279ffc48c14e8d68f0e106d07d4c31d4877722c34e8"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

可选的传输诊断仍可由 V4 兼容读取器读取；rewind 来源类型属于 Session 结构变化，因此需要 V5。相邻的 V4→V5 迁移保留所有既有事件和 header 字段，只推进代际标记，并让已安装的 Session 识别 rewind 生产者来源。历史文件保持不变；V5 会在源文件旁边作为完成校验的后继文件发布。V4 读取器会拒绝 V5 header，不会静默丢失回退语义。

<a id="verification"></a>
## 验证

pnpm run gen-session-format-catalog --check；pnpm run gen-persistence-catalog --check；pnpm exec tsc -b packages/session/session-format-v4-to-v5 packages/session/session-format-catalog packages/core/session；pnpm exec tsx scripts/migrate-sessions-to-v5.ts --help。V4→V5 编解码器、恒等迁移和当前 Session 恢复已通过类型检查，并已接入构建时固定的格式目录。

<a id="dev-note"></a>
## 开发备注

无。
