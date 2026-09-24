# Agent Note: Control CLI steering entry

Status: implemented

English | [中文](2026-09-23-control-steer-entry.zh.md)

## Problem

The packaged desktop control CLI admitted every prompt with `mode: 'queue'`, and the control bridge allowlist did not expose `session.updateQueue`. Anyone wanting to add an instruction to a visibly running Session could therefore only append it for a later turn: converting that queued instruction into steering required a person clicking in the GUI. The backend already implemented both paths — `session.prompt` accepts `mode: 'queue' | 'steer'`, and `session.updateQueue` steers one still-pending occurrence with the placement and running checks — so only the entry points were missing. The [desktop control note](2026-09-21-opl-search-and-desktop-control.md) owns the bridge, binding, and allowlist decision this extends.

## Decision

`opl-dsh-control send SESSION --file PROMPT.txt [--mode queue|steer]` forwards the requested mode to the existing `session.prompt`; an absent `--mode` still sends `queue`, so existing callers keep their delivery. The receipt adds `requestMode` beside the server's `accepted`, and `accepted` means admission only: the CLI never reports that a tool ran or that the model read the prompt.

`opl-dsh-control steer-queued SESSION ITEM` calls `session.updateQueue` with `{ itemId, action: { kind: 'steer' } }`, and the bridge allowlist gains exactly that one `session` method. A backend refusal crosses back unchanged as `session/steer-unavailable` or `session/queue-item-not-found` with exit code 1, and the CLI sends no follow-up request, so a refused steer never becomes a queued prompt reported as steering. ITEM is the pending occurrence id the Session's queue projection reports.

The running-state safety rules and the idle-Session placement stay with the backend: `session.prompt` delivers steering through `Agent.steer`, `session.updateQueue` refuses steering unless the occurrence is still `next-turn` and the Agent is running, and the CLI promises no hard interrupt of a running shell command. The [human inbox control note](2026-08-27-continuable-subagent-human-inbox-control.md) owns those occurrence rules.

## Alternatives considered

**Hardcode `steer` in `send`.** Every existing caller would change delivery, including the delegated-work flow that deliberately queues, and the receipt could no longer tell a caller which placement it asked for.

**Fall back to `queue` when steering is refused.** The caller would exit successfully while the instruction arrived a turn later than requested; the refusal codes exist so the caller, not the CLI, decides what to do next.

**Add a dedicated Remote method for queued steering.** `session.updateQueue` already owns the pending-occurrence lookup, the `next-turn` restriction, and the running check, so a second method would duplicate them and drift.

**Let the CLI pick the queued item itself.** Steering the oldest pending occurrence would remove the ITEM argument but guess the target, which can steer an instruction other than the one the caller meant.

## Consequences

An agent can place an instruction into a visibly running Session without a person at the GUI, and can convert an already-queued instruction instead of retyping it. The CLI reports only what it knows: the mode it requested, the server's admission, and a refusal's own code and exit code. Nothing here interrupts an in-flight tool call; that boundary remains the Agent's. `apps/desktop/tests/opl-control.spec.ts` drives the packaged script through a spawned Node process against a loopback fake desktop, and `apps/desktop/tests/control-bridge.spec.ts` pins the allowlist member plus the refusal passthrough. The CLI's `read` still prints Session records rather than the queue projection, so a caller obtains ITEM through the allowed `controlSnapshot` RPC call or the GUI.
