---
description: "Adjacent Session V4-to-V5 migration for the rewind message-source vocabulary, preserving historical files and event coordinates."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

This package is the adjacent V4-to-V5 Session migration. It preserves V4 headers, events, message identities, sequence numbers, and inherited cuts while advancing the generation marker so the current Session can recognize the `rewind` producer source. Persistence owns file reads and successor publication; this library owns the codec, migration stage, and target admission.

## Table of Contents

- [Use this package](#use-this-package)
- [V4-to-V5 specification](#v4-to-v5-specification)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use the build-static [Session format catalog](../session-format-catalog/README.md) for normal restoration. Direct exports are for catalog assembly and focused tests:

```ts
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
const restore = sessionFormatCatalog.createRestore(physicalHeader, {
  recovery: 'strict', validation: 'current',
})
```

The source generation remains on disk. A persistence write open publishes a validated V5 successor beside it; a read open can restore the successor in memory without changing the source.

<a id="v4-to-v5-specification"></a>
## V4-to-V5 specification

The edge is intentionally an identity conversion. V4 physical framing is reused, every event and field is emitted unchanged, and the header version advances from `4` to `5`. Current Session validation then admits the `rewind` message source. No event is renamed, re-sequenced, projected, or dropped.

V4 readers reject the V5 header. V5 readers retain all earlier adjacent migrations and use this edge only for V4 inputs. A missing inherited marker, malformed V4 row, unknown required event, or invalid current message source refuses restoration before a successor is published.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| `src/codec.ts` | V5 physical header and row codec over the released V4 framing |
| `src/migration.ts` | Streaming identity stage that preserves events and inherited cuts |
| `src/validation.ts` | V5 header, row, and complete-artifact admission |
| `src/index.ts` | Public adjacent-edge exports |

The package has no Cordis mount and makes no model or network request. The catalog generator discovers it from the `dsh.sessionFormatMigration` manifest entry.

<a id="further-exploration"></a>
## Further Exploration

- [V3-to-V4 migration](../session-format-v3-to-v4/README.md) — the preceding structural edge.
- [Session format catalog](../session-format-catalog/README.md) — complete historical restoration and current validation.
- [JSONL persistence](../session-persistence-jsonl/README.md) — source generation checks and successor publication.
- [Session format status](../../../docs/session-format-status.md) — finalized and released generation authority.

<a id="model-experience"></a>
## Model Experience

### Session restoration

#### What the model sees

The model sees the same projected messages as the V4 artifact. The `rewind` marker is an empty developer replacement and does not become model-visible content.

#### Token effect

No additional message or token is introduced by this migration.

#### KV Cache effect

The preserved event and message identities keep the current projection stable; cache behavior follows the restored conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One adjacent edge** — this package handles V4 input only; older formats use their own preceding edges.
- **No source rewrite** — publication and file locking belong to the JSONL persistence provider.
- **No external traces** — migration does not expose model reasoning, tool activity, or network diagnostics.

<a id="dev-note"></a>
### Dev Note

None.
