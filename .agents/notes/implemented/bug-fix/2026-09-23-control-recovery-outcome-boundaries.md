# Agent Note: Recovery outcomes are told apart by recorded facts

Status: implemented

English | [中文](2026-09-23-control-recovery-outcome-boundaries.zh.md)

## Problem

The [dispatched task feedback note](../feature/2026-09-22-dispatched-task-feedback-and-wake-seam.md) owns the task registry, the resume seam, and the wake delivery this extends. A dispatched task's notification reported the loop's `completed` turn as a business success even when the turn's final visible text still carried tool-invocation markup — a DSML `invoke`/`parameter` block or the bare tag spelling. Nothing executed that markup, so a dispatcher reading `completed` reviewed a task that had not done its work. The delivered notification carried no field a receiver could check, and the wake message's first line said `completed`.

Around that gap the other end-of-turn facts had no focused coverage at the recovery boundary: an SSE stream that ended without `[DONE]` (a `STREAM_CLOSED` failure), the exact reasoning_text failure, an operator stop, and a manual continuation. A stop also had a stale-continuation hole: `session.cancel` keeps pending inbox work, so an automatic-resume instruction that was admitted but not yet claimed by a turn would start the operator's next turn, making an old delivery append a continuation after a manual stop.

## Decision

A settlement reads the settling turn's own last assistant message and reports the tool-invocation families it finds in that message's visible text as `leakedToolSyntax` on the task record and the delivery payload. The state stays `completed` because that is the loop's recorded fact; the summary, the field, and a dedicated `attention:` line in the wake message say the business outcome is unverified. Only the last assistant message is read: a turn ends `completed` when that message requested no tool call, so markup there is syntax that should have been a call, while an earlier step, a reasoning block, a tool result, and an earlier turn are never read. The vocabulary is the tool-invocation subset — DSML wrapper, `invoke`, `parameter`, `tool_calls` — not the wire diagnostic's whole set, because a `thinking` delimiter in visible text does not falsify a completion. A leaked-syntax completion is not resume-eligible, so `resumeFailed` answers `not-applicable` and no automatic continuation follows.

The vocabulary is deliberately narrower than the [control-marker wire diagnostic](2026-09-22-reasoning-passback-and-control-markers.md): that note owns raw-wire evidence and reports delimiters too, while an outcome claim is only falsified by tool syntax nothing executed. A manual stop — a `turn/end` whose cancellation cause is `user` — stands down every automatic resume that is still pending for that Session: the queued instruction is removed from the live Inbox, the receipt's `resumeSubmitted` is cleared while `resumeAttempt` and `resumeRootTaskId` stay (the budget is spent, not refunded), and the attempt task is reported `cancelled` with a summary naming the withdrawal. A replay then re-validates against the stopped Session and answers `superseded`. An instruction a turn already claimed is left alone; that turn's own aborted end settles it.

The record and payload fields are additive with `.default(null)`, so records an earlier build wrote keep loading and the domain version does not change. The control CLI reports a `resumeFailed` decision other than `resumed` on stderr with exit code 5, so a caller that reads only the exit status cannot take "no instruction was submitted" for a recovery and cannot retry a final answer mechanically. The sender-side retry rule that already keeps an accepted handoff from being sent twice stays with the [accepted-feedback handoff note](2026-09-23-stop-requeue-after-accepted-feedback.md).

## Alternatives considered

**Report a new terminal state instead of an additive field.** A `TaskState` member would name the distinction in the state itself, but the state vocabulary is part of the durable domain schema: adding a member makes every record written afterwards unreadable to an older build, and this domain uses the `single` layout, where a version bump rejects the existing store instead of migrating it. An additive nullable field plus an explicit summary states the same fact without that break.

**Treat a leaked-syntax completion as `failed`.** That would be false about the loop's own recorded reason, and it would put the outcome in the resume-eligible vocabulary the reasoning_text failure owns.

**Detect a "handoff summary" or any short answer as a fake completion.** Text shape is not evidence of protocol failure, and a heuristic there would flag legitimate short answers. Only syntax the harness recognizes as an unexecuted control sequence is reported.

**Keep the queued resume instruction after a stop and let the next turn consume it.** `session.cancel` keeps pending inbox work by design, and that is right for the operator's own messages. The automatic instruction is the sender's, so it stands down; otherwise the old delivery appends a continuation inside whatever the operator does next.

**Let the receiver decide whether a non-`resumed` answer is a failure.** The service already reports the reason, but a caller that only looks at the process exit status reads every answered call as success. Exit code 5 makes the stand-down visible without changing what the service does.

## Consequences

A `completed` task record now carries one more nullable field, and a receiver that ignores it still sees the state the loop recorded; the summary and the notification's `attention:` line are what a reader acts on. A leaked-syntax completion notifies (its state is `completed` and in the default `notifyStates`), which is intended: the dispatcher must learn that the outcome needs review, and the notification never offers the resume operation.

The stand-down gives a manual stop one more durable effect on the task registry: the attempt task ends `cancelled` instead of waiting for an instruction that will never arrive. Its spent budget stays spent, so a later manual continuation is a new registration rather than a second automatic attempt.

The CLI's exit code 5 is a new contract for the receiver workflow; exit 1 still means the request itself failed, and 3 and 4 keep their meanings. Nothing about `send`, `steer-queued`, the queue projection, the wake transports, or the Git Bash, WSL, sidebar, and packaging work changed.

## Testing

`packages/api/task-feedback/tests/task-feedback.recovery-diagnostics.host.spec.ts` runs the real Session log, projections, storage, and service, doubling only the prompt surface and the Agent registry's Inbox. It covers: a leaked-syntax completion live and read back from restored history (state, families, summary, payload, wake message, and the `not-applicable` answer); an ordinary completion, an earlier step's quotation, a reasoning block, and an earlier turn staying unflagged; an SSE `STREAM_CLOSED` failure keeping its own message, turn, and evidence while `resumeFailed` refuses it; the reasoning_text budget reporting `budget-exhausted` with its used and configured counts and staying bounded across replays; a manual continuation reporting `superseded` and a still-open one reporting `running`, both without submitting anything; an operator stop reporting `cancelled` with its cause; a queued automatic resume being withdrawn on that stop and refused on replay; a claimed resume still settling from its own aborted turn; and a consumer that is not the owner failing to consume the current claim generation.

`apps/desktop/tests/opl-control.spec.ts` drives the packaged CLI against a scripted loopback endpoint and asserts exit code 5 with the reason on stderr for `budget-exhausted`, `superseded`, and `not-applicable`, exit 0 for `resumed`, and exit 1 for a server refusal.
