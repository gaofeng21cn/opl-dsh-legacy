# Agent Note: Thinking-mode CoT passes back under either wire name, and control markers are reported

Status: implemented

English | [中文](2026-09-22-reasoning-passback-and-control-markers.zh.md)

## Problem

A session on the OPL Gateway ended four turns with HTTP 400 `INVALID_REQUEST`, `The reasoning_text in the thinking mode must be passed back to the API.` The chat-completions translator read the thinking channel only as `delta.reasoning_content`; the gateway streams it as `delta.reasoning`, so every tool-call turn was persisted and replayed with no CoT. This is not the official DeepSeek field name, so a fix had to keep the official protocol working while accepting the alias.

Three further turns on the same route failed with only `TRANSPORT: DeepSeek API request to https://gateway.medopl.com/v1 failed`. One code covered a refused connection, a DNS failure, a TLS rejection, a stalled read, and a mid-body stream failure, so the record could not say which layer failed.

Separately, twelve assistant text blocks across that session carried a `<thinking>` delimiter, and the final message carried a whole tool invocation as `<｜DSML｜invoke>`-style markup with no structured tool call at all. Codex sessions against the same model had shown the same markers, so the origin was unknown rather than obviously local.

## Decision

An absolute `DSH_REASONING_TRACE_DIR` opts Chat Completions into per-attempt fingerprint files. Allowlisted raw reasoning fields, settled blocks, projected input and the serialized outgoing messages are observed independently. SHA-256 over UTF-16LE keeps fragmented surrogate pairs comparable without storing text. Tool-call ID hashes join response facts to later history; the session log remains the independent persistence evidence. Reports include failed HTTP statuses and exclude prompts, arguments, credentials and response bodies. Diagnostics contain their own failures and do not change replay or retries. Detailed history retains 128 assistant messages plus a complete digest; files require manual cleanup. The alias fix does not establish that all reasoning-related 400 errors are resolved.

`reasoningDelta` resolves the CoT from `delta.reasoning_content` then `delta.reasoning` and returns the first non-empty value, so a delta carrying both names contributes once rather than twice. An empty string stays "no update", preserving the live first-chunk behavior that must not open a reasoning block. Serialization is unchanged: the block persists as `reasoning_content` on the assistant message, which is what the gateway requires back and what history reconstruction already replays.

`transportDiagnostics` reads the platform error under `fetch`'s wrapper and attaches `transportStage` (`request` or `response-body`), `causeName`, and `causeCode` to the `TRANSPORT` failure. Only the error class name and the errno-style code are copied, never the message, because the message can embed the endpoint, a header, or a credential.

The [outcome-boundary note](2026-09-23-control-recovery-outcome-boundaries.md) reads the tool-invocation part of this vocabulary at the outcome layer, where unexecuted tool syntax in a completed turn's final visible text marks the business outcome unverified. `controlMarkerFamilies` recognizes the observed marker families — the `thinking` delimiter, the DSML wrapper, and the `invoke`, `parameter`, and `tool_calls` tag names in either the bare or DSML-wrapped spelling. `WireObserver` reads each parsed payload's field names, fragment and character counts, marker families, and raw finish reasons on the way in, before `translate` maps any of them, keeping one bounded tail per channel so a marker split across fragments still matches and no text is retained. The chat-completions adapter compares that against the blocks the translation produced and calls `onProtocolAnomaly` once per anomalous attempt, rendering both sides; marker text, prompts, and reasoning are never retained. Markup in visible text is not executed and not stripped.

## Alternatives considered

**Renaming the field to `reasoning` alone** would have broken the official DeepSeek protocol that the same adapter serves. Resolving both names keeps both endpoints working.

**Concatenating both names when a delta carries both** would duplicate every reasoning token, which the endpoint rejects on passback.

**Stripping the markers from visible text** hides the evidence without identifying the cause and would silently discard model output. The anomaly is reported instead.

**Retrying the 400 or synthesizing reasoning text** would fabricate the CoT the endpoint validates; the request must carry the model's own text.

**A general request/response logging system** would persist prompts and reasoning into durable storage. The bounded per-attempt comparison answers the question without a new log surface.

**Preserving the full raw SSE for later inspection** was rejected as the default: it writes prompts and CoT to disk continuously for an anomaly that is rare.

**Observing only the translated chunks** was rejected after review: a settled stream records what the translation produced, not what the endpoint sent, so it cannot distinguish upstream control syntax from a local mapping defect. The raw tap costs a second parse per payload and is skipped entirely when no sink is configured.

## Consequences

Batch A was verified against the live gateway: six requests, all HTTP 200, over five consecutive tool-call rounds, each tool-call turn carrying its CoT and replaying it as `reasoning_content`. A live single request confirmed the gateway streams `reasoning` and never `reasoning_content`. The 400 could not be reproduced in isolated short replays, so the passback path is pinned by the multi-round chain and by offline regression tests over the observed wire shapes rather than by one non-erroring call. Reasoning text lost before this change is not recoverable; those sessions keep replaying without it.

For the marker anomaly, the durable log of the failing turn directly proves only the post-translation position: its text block carries the whole marker text, and its embedded compact stream — packed from `text-delta` chunks, not from raw SSE — carries no reasoning or tool-call run for that step. The preceding step shows the same pattern beside a correctly assembled structured call. Because the shipped mapping produces text blocks only from `delta.content`, that pattern is consistent with the markers having entered as visible content upstream, and a translation-only view makes no prediction that they should have arrived anywhere else. That is an inference from the mapping's implementation, not raw-response evidence, and it cannot separate a model that emitted the syntax from a gateway that translated it. The root cause therefore stays undetermined; the raw tap is what makes the next occurrence decisive, and existing sessions were not repaired. No further live requests were spent trying to reproduce it.

`LlmFailure` gained three optional properties, acknowledged by the [transport-diagnostics record](../../../../docs/persistence-changes/2026-09-22-transport-failure-diagnostics.md) as same-version and extending the payload [bounded LLM request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md) owns. Older readers ignore them, records written earlier simply omit them, and retry routing still reads `LlmFailure.code` alone.

## Testing

`pnpm exec vitest run packages/llm/llm packages/llm/llm-deepseek packages/llm/llm-retry` covers the reasoning alias, the both-names delta, the alias beside an empty official field, the marker families, the raw-wire tallies and their bounds, the two-sided separation, a clean turn staying silent, the report carrying no content, a throwing sink leaving the stream unchanged, and a truncated stream reporting partial facts. `packages/llm/llm-deepseek/tests/reasoning-persistence.spec.ts` drives the real adapter, real agent loop, and real JSONL persistence: it runs an alias-reasoning tool-calling turn, disposes the context, reloads the stored session in a new one, and asserts the next derived wire request carries the CoT under `reasoning_content` with its tool result paired. The transport-recovery suite drives a refused connection, a mid-stream body failure, a stalled body, an exhausted transport budget, and credential sanitization through the real HTTP/SSE adapter.
