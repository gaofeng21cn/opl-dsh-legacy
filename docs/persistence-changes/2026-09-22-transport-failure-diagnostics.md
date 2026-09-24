---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-transport-failure-diagnostics

English | [中文](2026-09-22-transport-failure-diagnostics.zh.md)

## Summary

Records transport failure diagnostics and the Session V4 to V5 transition required by the rewind message-source vocabulary.

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
## Compatibility

The optional transport diagnostics remain readable by V4-compatible consumers, while the rewind source kind is a structural Session change that requires V5. The adjacent V4-to-V5 migration preserves every existing event and header field, advances only the generation marker, and lets the installed Session understand the rewind producer source. Historical files remain unchanged; V5 is published as a validated successor beside the source. V4 readers reject the V5 header instead of silently dropping rollback semantics.

<a id="verification"></a>
## Verification

pnpm run gen-session-format-catalog --check; pnpm run gen-persistence-catalog --check; pnpm exec tsc -b packages/session/session-format-v4-to-v5 packages/session/session-format-catalog packages/core/session; pnpm exec tsx scripts/migrate-sessions-to-v5.ts --help. The V4-to-V5 codec, identity migration, and current Session restoration were type-checked and wired into the build-static catalog.

<a id="dev-note"></a>
## Dev Note

None.
