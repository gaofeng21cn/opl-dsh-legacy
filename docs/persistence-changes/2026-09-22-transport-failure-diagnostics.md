---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-transport-failure-diagnostics

English | [中文](2026-09-22-transport-failure-diagnostics.zh.md)

## Summary

Adds optional TRANSPORT-failure diagnostics to LlmFailure: the request phase a transport failure ended in and the underlying platform error's name and errno-style code.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid because all three properties are optional and no existing property changed type or presence. A reader that does not know them ignores them; a record written before this change simply omits them, and the retry policy still routes on LlmFailure.code alone, so replay and retry decisions are unchanged. The values are a fixed vocabulary (a phase name, an error class name, and an errno-style code) and never carry credentials, request bodies, headers, or provider reasoning text, so no new sensitive data reaches the durable log.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/llm/llm packages/llm/llm-deepseek packages/llm/llm-retry: 1331 tests passed. The transport-recovery suite exercises a refused connection, a mid-stream body failure, a stalled body, an exhausted transport budget, and credential sanitization through the real HTTP/SSE adapter.

<a id="dev-note"></a>
## Dev Note

None.
