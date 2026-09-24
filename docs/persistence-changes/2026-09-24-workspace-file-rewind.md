---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-workspace-file-rewind

English | [中文](2026-09-24-workspace-file-rewind.zh.md)

## Summary

Adds two log-only Session event types, file/checkpoint and file/change, that record one turn's workspace baseline and each tool execution's observed workspace writes so a rewind can restore them. Adding an ordinary event type is a same-version change: no previously declared root changed.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid because the change only introduces two new event roots and every previously declared root keeps its digest. The new events are required on read, so a build that does not recognize file/checkpoint or file/change refuses those logs instead of replaying them with the record dropped; that refusal is the intended failure, because a dropped file/change would let a rewind restore a turn whose writes it never observed, and a dropped file/checkpoint would hide that no baseline existed. A log written without these events replays exactly as before. Both events stay outside the model-visible surface and every message projection, so no request, projection, or derived message changes.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run packages/session/session-rewind-files/tests/journal.spec.ts packages/api/session-controller/tests/commands-rewind-files.host.spec.ts: 2 files, 27 tests passed, 1 skipped (the symlink case skips when the host cannot create symlinks). The journal suite appends both events through a real Session and restores a recorded turn, covering modify, create, delete, rename, binary content, conflict refusal, and replay from the folded projection. node node_modules/tsx/dist/cli.mjs scripts/gen-persistence-catalog.ts --check: catalog, both catalogs and known-event-types.ts are up to date.

<a id="dev-note"></a>
## Dev Note

None.
