# Agent Note: Accepted feedback handoffs are not retried

Status: implemented

English | [中文](2026-09-23-stop-requeue-after-accepted-feedback.zh.md)

## Problem

The Codex queue command can exit successfully while its message waits for the receiving task to run. Retrying on an acknowledgment deadline inserted the same notification again, waking the task repeatedly even though the first copy was already queued.

## Decision

`delivered` is terminal for sender scheduling. A transport refusal remains `enqueued` and follows the bounded capped-exponential retry policy. A successful handoff records `delivered` with no retry deadline, and neither an explicit `flush` nor Host recovery sends it again. `received` and `consumed` remain separate receiver-owned facts; an accepted handoff is not reported as receipt.

The [outcome-boundary note](2026-09-23-control-recovery-outcome-boundaries.md) owns the receiver-side stand-down that withdraws an automatic resume still queued when the operator stops the Session, so this sender-side rule is not the only thing keeping an old delivery from producing stale work. The receiver owns recovery after handoff. It reads its durable receipt ledger after restart and resumes any claim that is not consumed. A crash before an outbox record exists is still repaired by reconciliation from the task record.

## Alternatives considered

**Keep retrying until receipt.** The sender cannot distinguish a queued message from a message lost by the target, and every retry creates another queue item. The receiver already has durable recovery after it claims a message, so sender retries do not repair an interrupted review.

**Remove retries entirely.** A process launch failure or a queue command that refuses the message leaves no copy at the target. Bounded backoff remains for those explicit transport failures.

## Consequences

A successful transport handoff wakes the target once instead of once per acknowledgment interval. A delivery that was accepted but later disappears before the receiver claims it is not retried automatically; deployments must preserve their accepted queue or initiate a deliberate recovery. Receiver receipt and consumption remain independently observable.
