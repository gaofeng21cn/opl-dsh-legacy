---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-transport-failure-diagnostics

[English](2026-09-22-transport-failure-diagnostics.md) | 中文

## 概述

为 LlmFailure 增加可选的 TRANSPORT 失败诊断：传输失败结束时所处的请求阶段，以及底层平台错误的 name 与 errno 风格 code。

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
  - root: "event:assistant/attempt"
    previous: "2026-09-14-image-offload"
    after: "225c315938676248b4d1bd67a4315d603810e6fa1c70e1cb037a1ad58fc5424e"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-14-image-offload"
    after: "402ab9a04e9030a97b395eccf68a2bc300a169967a9698ffc5f97cc3a19da187"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "97fa5f2b1ab22845443a77bbd7c24e7e3e28433b279e047c2d01439fea88f5f7"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-14-image-offload"
    after: "57c0d7860360333a5526f9ce65067ed59e1973c78294388e4e3de370e39216be"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，因为这三个属性均为可选，且没有任何现有属性的类型或必需性发生变化。不认识它们的读取方会忽略它们；此变更之前写入的记录只是省略这些字段，重试策略仍然只依据 LlmFailure.code 路由，因此回放与重试决策不变。这些值取自固定词表（阶段名、错误类名、errno 风格 code），绝不携带凭据、请求正文、请求头或提供方思考文本，因此持久化日志不会新增敏感数据。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm packages/llm/llm-deepseek packages/llm/llm-retry：1331 个测试通过。transport-recovery 套件经真实 HTTP/SSE 适配器覆盖了连接被拒、流中途失败、停滞的响应体、传输重试预算耗尽与凭据脱敏。

<a id="dev-note"></a>
## 开发备注

无。
