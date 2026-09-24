# Agent Note: OPL search selection and desktop session control

Status: implemented

English | [中文](2026-09-21-opl-search-and-desktop-control.zh.md)

## Problem

OPL chat credentials do not enable the upstream DeepSeek search endpoint. Operators also need another coding assistant to delegate work to the visible desktop session without starting a second agent runtime.

## Decision

The OPL search service selects local Bing RSS retrieval through the existing public HTTP fetch provider or cloud Responses search through the existing OPL account. Settings offer model discovery, explicit capability testing, saved selection, and counters partitioned by model and initiating session. Failed requests count; absent token usage remains unknown. Queries and credentials are not stored in statistics. Tests use proposed preferences without changing the saved selection.

Desktop Host adds a loopback adapter to its existing Remote gateway. A rotating private bearer binding and a narrow method allowlist protect session and search operations. Browser origins are rejected. The bundled Windows command uses this adapter, so visible sessions, running agents and approval state have one owner; the [control CLI steering entry](2026-09-23-control-steer-entry.md) covers its prompt delivery modes and queued-item steering. Snapshot reads close their stream after the first frame; shutdown aborts outstanding calls and awaits their completion.

This partially supersedes the no-port constraint in the [desktop packaging note](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md); renderer pipes, profile exclusivity and package ownership remain authoritative there. The [upstream default search decision](2026-07-31-web-default-search.md) remains applicable outside OPL compositions.

## Alternatives considered

Routing all search through DeepSeek chat alone loses native retrieval when the gateway converts away search tools. An advertised model list is insufficient evidence of retrieval capability; the test requires actual sources. A separate headless process would separate GUI approvals and runtime state. Pixel automation alone cannot reliably correlate admission with durable completion.

## Consequences

Local search needs no extra credential but inherits network access and search-engine verification failures. Cloud search consumes the selected model's quota; full-page fetching still uses local networking. Search counters are local accounting, not billing authority. Desktop control grants access to the current user's sessions to callers holding its binding, without bypassing tool permissions. Send acknowledgments do not establish completion; callers inspect the correlated session records. Provider/parser and authenticated HTTP tests cover deterministic boundaries; installed desktop acceptance verifies the composition and model-dependent paths.
