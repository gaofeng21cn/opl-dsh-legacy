---
description: "Register a dispatched task against the DSH Session doing the work and durably hand its outcome to the Session that dispatched it — for maintainers wiring the control surface and for dispatchers reading the contract."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-task-feedback

English | [中文](README.zh.md)

## Summary

`dsh-api-task-feedback` records one dispatched task per caller-minted id, watches the bound DSH Session without any model involvement, and queues one bounded notification per notifying state change for the Session that dispatched the work. By default only `completed`, `failed`, `waiting_approval`, and `waiting_input` notify, so a progress-only `running` transition never wakes the reviewer's paid model. Delivery is automatic: a settled task, or one that paused for approval or input, is handed to the wake transport by the service's own scheduler, so a dispatcher that never polls still learns the outcome. A claim has a durable owner, generation, and lease, so a duplicate notification cannot start a second review and a crashed receiver's claim is reclaimed by a later one. A failure recorded as the exact reasoning_text protocol error gets at most a configured number of bounded automatic resumes, each a persisted user instruction in the original Session. A turn the loop recorded as `completed` whose final visible text still carries tool-invocation markup is reported as completed with `leakedToolSyntax` set and a summary saying the outcome is unverified, so a dispatcher never reads unexecuted tool syntax as a business success; that outcome is not resume-eligible. A pause notification is structured rather than a bare state: it carries the bounded question text and offered options, or the approval and its tool, together with the Session the answer belongs to, so a dispatcher relays the question to its operator instead of guessing an answer or resuming the Session. Choose it to close the dispatch loop: a caller registers `{taskId, sessionId, turn, target, acceptance}`, the service reports `queued`, `accepted`, `running`, `waiting_approval`, `waiting_input`, `completed`, `failed`, `cancelled`, or `disconnected`, the outbox delivers the outcome, and the receiver's own durable ledger makes a message that was already queued twice a no-op.

The Host requires `sessionProjections`. Its `taskFeedbackFacts` fold rebuilds resume-instruction ownership and final visible tool-syntax diagnostics from committed events, then maintains them incrementally; task recovery never scans synchronous Session history.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it where the dispatched Sessions run; the desktop control bridge exposes it as the `taskFeedback` namespace.

### When to choose it

Use it when an external dispatcher must learn that a DSH task settled without polling the Session and without waking a model to watch it. Skip it for a one-off `session.wait` call, which already reports the same durable facts to a caller that is willing to block.

### Smallest working setup

```yaml
- name: '@deepseek-ai/dsh-api-task-feedback'
```

Register a task, then read it back:

```json
{ "namespace": "taskFeedback", "method": "register", "args": { "request": {
  "taskId": "review-42",
  "sessionId": "session-abc",
  "turn": 1,
  "target": { "kind": "codex-thread", "threadId": "<caller-supplied>" },
  "acceptance": "the reviewer checks the recorded evidence"
} } }
```

| Method | Meaning |
|---|---|
| `register` | Durably bind a task to a Session, turn, target, and acceptance bar. Idempotent on `taskId`. |
| `task` / `tasks` | Read one task or every task. |
| `outbox` | Read every queued, delivered, acknowledged, or retired notification, with the bounded pause a needs-input delivery announces. |
| `wake` | Probe whether the configured wake executable can start, and report what it observed. |
| `ack` | Record the delivery stage the receiving Session reports: `received`, then `review-started`. Idempotent per `deliveryId`; a repeated or older acknowledgment never moves the stage backwards. |
| `receive` | Claim one delivery for review. Answers `review` on the first claim, `resume` to the consumer that owns an unfinished claim, `busy` while another consumer's claim is live, and `skip` for a consumed one. |
| `receipts` | List the receiver's consumption ledger, so a restart can find claims it still owes. |
| `consume` | Mark a claimed delivery consumed after its review finished, presenting the `claimEpoch` the claim was given. Only this makes a repeated message answer `skip`, and a stale generation is rejected. |
| `resumeFailed` | The deterministic bounded automatic-resume operation for a failure that is the reasoning_text protocol error: claim the delivery under the receiver's consumer identity, verify the failed turn is still the target, and submit one persisted resume instruction or report why not. |
| `flush` | Settle the watcher's writes, then attempt every due delivery once. |

Delivery stages are separate facts, not one progress bar: `enqueued` is durable locally, `delivered` is the transport taking the handoff, `received` is the target acknowledging it, and `review-started` is the target reporting it began its follow-up turn. Only the receiving Session can advance the last two; the sender never writes them, and a transport acceptance stops at `delivered`. A delivery stage is not consumption: the receiver's separate `receipts` ledger records its own claim and is what keeps a repeated message from starting a second review.

### Receiving and consuming a notification

The notification names the task, delivery, Session, turn, acceptance bar, and evidence positions, and its `delivery:` line is the receiver's idempotency key. A transport may still produce duplicate messages, so the receiver claims the delivery before it reviews and records consumption after:

1. `receive <taskId> <deliveryId> [--consumer ID]` — claim the delivery. The answer's `action` is the only decision the receiver needs: `review` on the first claim, `resume` to the consumer that owns an unfinished claim, `busy` while another consumer's claim is live so this message must not start work, and `skip` when the review already finished.
2. Do the review, then `consume <taskId> <deliveryId> --epoch <claimEpoch>` — record that the review finished. Only consumption makes a later message answer `skip`; a claim generation that was reclaimed by a newer owner is rejected.

The claim is durable before `receive` answers and carries owner, generation, and lease. A repeated, concurrent, or replayed message cannot start a second review: a different consumer that arrives while the owner's lease is live is answered `busy`, and the owner itself is answered `resume`. Passing a stable `--consumer` id is what lets a restarted receiver resume its own claim immediately; a consumer with no identity waits out the lease. A claim whose lease expired is reclaimed under a new generation, and the old owner's `consume` is then rejected, so a crashed review is taken over without racing a working one. A receiver that restarts runs `receipts` and resumes every entry whose status is not `consumed`; that outstanding claim is the recovery point, because `receive` already acknowledged the delivery and the sender will not send it again. The receiver — not the sender — owns that resume.

### Relaying a pause the Session is waiting on

A `waiting_input` or `waiting_approval` notification is a request to relay, not to answer. Its payload carries `needsInput`: `kind` (`question` or `approval`), the DSH `sessionId` holding the pause with its `turn` and log cursor, the stable `pauseId` that is also the delivery id's suffix, the bounded `questions` with their options and `multiSelect`, or the `approval` with its id and tool. A dispatcher that was not woken finds the same entry through the control plane:

```sh
opl-dsh-control.cmd outbox --thread <its own thread id> --pending
```

Each entry names its `deliveryId`, target, stage, and payload. The dispatcher then runs the same `receive` and `consume` calls as for an outcome, and gives the question to its operator: the answer belongs in the Session named by the notice, which keeps waiting for its human. This service never submits an answer, never decides an approval, and `resumeFailed` answers `not-applicable` for a needs-input delivery, so no surface here can turn a question into a prompt. Question text, option labels, and tool names are flattened to one line and capped by `needsInputMaxChars`, `needsInputMaxQuestions`, and `needsInputMaxOptions`, and each is quoted as untrusted result data, because the caller wrote it and the receiving model reads it.

When a failure's notification carries `resumeEligible`, the failure is the reasoning_text protocol error that cannot be retried as the same request. The receiver runs one deterministic operation instead of composing a retry:

```sh
opl-dsh-control.cmd resume-failed <taskId> <deliveryId> [--consumer ID]
```

`resumeFailed` claims the delivery under the same stable consumer id the receiver used for `receive`; when the call omits the id it continues the claim already recorded for that delivery, so executing the notification's `receive` then `resume-failed` steps cannot block the receiver with a newly minted identity. It verifies the failed turn is still the target (not running, no newer message or turn, same target), and then either submits one persisted user instruction in the original Session or reports `not-applicable`, `superseded`, `running`, `busy`, or `budget-exhausted`. It registers a follow-up task that shares the original task's resume budget and notifies the same Codex target when the resumed turn completes, fails again, or pauses. The instruction carries a deterministic request id, so a duplicate notification or a crash replay presents the same instruction instead of admitting a second attempt. An attempt that was admitted but whose submission was never observed re-runs the supersession checks before it submits again, so a replay after the operator manually continued cannot append a stale continuation, and no follow-up task is left to settle that manual turn as the automatic resume; an attempt whose instruction is already recorded in the Session log or its live inbox replays without re-validating, which recovers a submission whose receipt flag write was lost. A queued instruction that no turn has claimed yet is withdrawn when the operator stops the Session (`stop` is a cancel that keeps the inbox), because keeping it would start the operator's next turn with a stale automatic continuation; the attempt task is then reported `cancelled` with a summary naming the withdrawal, the admission and its spent budget stay on the ledger, and a later `resumeFailed` re-validates against the stopped Session and reports `superseded` instead of admitting a second attempt. The admission also persists the cursor and the turn-end baseline the instruction was submitted from, and the follow-up task binds to the turn that consumed its own instruction rather than to whichever turn ended last. An attempt task whose registration landed without a turn — accepted with `turn: null` because the instruction was recorded before any turn claimed it — is rebound from the Session's recorded instruction when the Session is later restored, on either attachment order: the service's own recovery pass when the Session is already attached, or the `session/created` reconcile when it attaches afterwards. A registration delayed past that turn — a failed follow-up write, or a restart — therefore settles from the Session's recorded facts: a resumed turn that already completed, failed again, paused for approval, or is still open is reported instead of waiting for an event that already happened, while a manual turn that ran afterwards is never read as the resume. The old `failed` record is never rewritten; the follow-up attempt is its own record with a parent link. Tell your operator when the budget is spent; every other failure goes through normal review and is never auto-resumed.

A receiver running on the desktop Host uses the authenticated control bridge:

```sh
opl-dsh-control.cmd outbox --thread codex-thread-1 --pending
opl-dsh-control.cmd receive <taskId> <deliveryId> --consumer codex-thread-1
opl-dsh-control.cmd receipts
opl-dsh-control.cmd consume <taskId> <deliveryId> --epoch 1
opl-dsh-control.cmd resume-failed <taskId> <deliveryId> --consumer codex-thread-1
```

A `resume-failed` run exits 5 when the service answered a decision other than `resumed` — `not-applicable`, `superseded`, `running`, `budget-exhausted`, `busy`, or `consumed` — and prints that decision and its reason on stderr, so a caller that only checks the exit status cannot read a stand-down as a recovery; those answers are final, and re-running the command cannot change them. A receiver elsewhere posts the same calls to the bridge endpoint with its bearer token, or calls the `taskFeedback` methods over the remote surface. `ack` remains the lower-level delivery-stage record (`received`, then `review-started`) and keeps the receipt ledger consistent; it is not a substitute for `receive`, which is what decides whether a review runs. Enqueueing a message is not a receipt, and neither is a transport that accepted the handoff. The owned claim makes repeated review requests idempotent and an interrupted review resumable; exactly-once delivery is not claimed because a transport cannot promise it.

The automatic-resume budget is counted from the receiver's own receipt ledger, not written beside it. Each admitted failure delivery writes exactly one receipt entry, and the count reported on a task is derived from those entries, so neither a lost task-record write nor a restart can make one attempt spend budget twice or let a replay spend it again. The ledger is keyed by the original dispatched task, not by a delivery or a retry id, and a retry registered under a new task id passes `parentTaskId` or `rootTaskId` so it shares the same budget. The default is two resumes per original task; `maxAutoResumes: 0` disables automatic resume entirely.

### Delivery scheduling

The service schedules delivery itself. Each newly queued notification arms one wake-up; a refused attempt is retried with a capped exponential delay; at most one wake-up and one delivery pass exist at a time, and the pass waits for the watcher's writes before it reads the outbox. A successful transport handoff ends sender retries: enqueueing the same notification again while it waits in the target queue only creates duplicate wake-ups. A restart therefore retries only deliveries the transport refused; it also re-enqueues a notifying state whose delivery never landed, which repairs a crash between the task write and the outbox write. Once the receiver claims a delivery, its receipts ledger, not the sender's outbox, tells a restarted receiver what it still owes. No Session listener blocks on a delivery, and no model request is made anywhere in the loop.

| Field | Default | Meaning |
|---|---|---|
| `autoDeliver` | `true` | Whether the service schedules delivery. Turn it off to drive the outbox from a deployment's own scheduler through `flush`. |
| `maxDeliveryAttempts` | `5` | Attempts one delivery may make before it stops being scheduled; an exhausted delivery stays pending and unacknowledged. |
| `retryBaseMs` / `retryMaxMs` | `1,000` / `60,000` | Base and ceiling of the capped exponential retry delay. |
| `summaryMaxChars` | `500` | Cap on the summary line one notification carries. |
| `notifyStates` | `completed`, `failed`, `waiting_approval`, `waiting_input` | Task states that produce a notification. `queued`, `accepted`, `running`, `cancelled`, and `disconnected` are observed but do not notify unless a deployment adds them. |
| `maxAutoResumes` | `2` | Automatic resumes one original dispatched task may submit. The count is persisted on the task, so a restart or a retry under a new id cannot reset it. `0` disables automatic resume. |
| `claimLeaseMs` | `600,000` | How long a receiver's claim stays live before another consumer may reclaim an unfinished review. A consumer that presents its own identity again needs no reclaim. |
| `needsInputMaxChars` | `500` | Cap on one question, option label, option description, or tool name a needs-input notice carries; longer text is truncated with `…`. |
| `needsInputMaxQuestions` | `8` | Cap on the questions one needs-input notice carries. |
| `needsInputMaxOptions` | `12` | Cap on the options one question may carry. |

`flush` remains available for a caller that wants to attempt the outbox on demand; it shares the same pass chain, so an explicit flush can never send a delivery that the scheduler is sending.

### Wake transport

The shipped default is `unconnected`: it refuses every delivery and `wake()` reports the missing capability, so no deployment silently claims a woken Session. A deployment that can reach its target configures the transport explicitly; nothing is read from the machine environment and no distribution or install path is assumed.

| Field | Default | Meaning |
|---|---|---|
| `wakeTransport` | `unconnected` | `unconnected` refuses every delivery; `codex-queue` runs `codex queue --thread … --message …`. |
| `wakeExecution` | `native` | `native` launches the executable directly; `wsl` launches it through `wsl -d <distro> -- <executable>`. |
| `wakeExecutable` | empty | Absolute path or `PATH` name of the Codex executable. Required by `codex-queue`. |
| `wakeDistro` | empty | WSL distribution the executable lives in. Required by `wakeExecution: wsl` and rejected otherwise. |

A `codex-queue` transport runs with an argv array (never a shell string), `windowsHide`, a bounded deadline, and cancellation on timeout or disposal; a process that cannot start, exits non-zero, or outlives the deadline is reported, not treated as delivered. `wake()` runs `codex --version` through the same entry with the same bound and reports `executable-started` when the executable actually ran. That probe proves the entry starts and nothing more: it cannot show that the target thread exists or that a queued message reaches it, so `connected` is deliberately not a status this surface reports.

```yaml
- name: '@deepseek-ai/dsh-api-task-feedback'
  config:
    wakeTransport: codex-queue
    wakeExecution: wsl
    wakeExecutable: /home/<user>/.local/bin/codex
    wakeDistro: <distro>
```

### What a task state means

The watcher reads the Session's own durable events. A registered process exiting is not a completion, and a Session this Host can no longer observe is `disconnected` — the task keeps its place and is neither cancelled nor re-dispatched. `waiting_approval` and `waiting_input` report a pause; this service never answers one, so a dispatched task still waits for its human. The notification for a pause carries the bounded questions and options, or the approval and its tool, plus the Session, turn, and cursor the answer belongs to, and its `answer location:` and `do not answer:` lines tell the receiver to relay it; the same notice is persisted with the task record, so a delivery rebuilt after a crash between the task write and the outbox write still carries it. A `completed` record whose `leakedToolSyntax` is not null is a completion claim the recorded text does not support: the last assistant message of that turn carried tool-invocation markup that nothing executed, so the state stays the loop's own fact and the field, the summary, and the notification's `attention:` line say the business outcome is unverified. Only the four default `notifyStates` wake the reviewer; a deployment can add the remaining states, but a `running` notification spends a paid model turn on progress, which is why it is off by default. Two distinct approvals or questions at one log cursor produce two notifications because a waiting delivery's identity is its stable pause key; a replayed request or duplicate event of the same pause produces none. Recovery matches a named turn by number and an unnamed one by the cursor, so a turn that ended before the task was registered cannot settle it, and a Session restored after this Host started is reconciled when it is attached because a seeded Session publishes no per-event feed for the history it loads with.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

- The registry, the outbox, and the receiver's ledger are three tables of the `task_feedback` storage domain, keyed by task id and by delivery id. A delivery id is stable per (task, state); a waiting delivery also carries its stable pause key (the deciding event position for an approval, the cursor plus the asked question ids for a structured question), which is what makes a replayed request a no-op while two distinct pauses stay distinct.
- The watcher is a `session/event` subscription plus a pass-through `user-questions/request` listener that always answers `next()`, so a composing deployment's answerer still receives the question. No polling and no model turn take part.
- `fromSeq` is the first log position the task observes, inclusive; registration defaults it to the Session's next sequence number.
- A Session attached after this Host recovered is reconciled on its `session/created` edge, because a seeded Session publishes no per-event feed for the history it loads with. A named turn matches by number; an unnamed turn ignores the end already on the log at registration, so an old turn cannot settle it.
- The receiver's `receipts` table is a consumption ledger separate from the outbox: `receive` claims and answers whether to review, resume, skip, or stay busy; `consume` finishes the claim; `receipts` lists what a restarted receiver still owes. A receipt carries `ownerId`, `claimEpoch`, and `leaseExpiresAt`; reclaiming an expired or ownerless claim increases the generation, and `consume` rejects a generation the caller no longer holds. The sender stops retrying as soon as the transport accepts the queue handoff; claiming records `received` on the delivery and remains a separate fact.
- An eligible failure admission is also recorded on the receipt: `resumeAttempt`, `resumeRootTaskId`, `resumeRequestId`, `resumeTaskId`, `resumeFromSeq`, `resumeLastEndTurnAtRegistration`, and `resumeSubmitted`. The receipt write is the single admission commit point and the budget entry; `resumeRootTaskId` is what lets the service count admissions per original task, and the `autoResumeCount` on a task record is only a derived cache of that ledger. The follow-up task carries the instruction identity (`resumeRequestId`) and, once the Session records it, its log position (`resumeInstructionSeq`): before that instruction exists no turn may settle the task, and an instruction recorded before any turn claims it settles on the first turn that ends after it. Withdrawing a queued instruction on a manual stop clears `resumeSubmitted` and leaves `resumeAttempt` and `resumeRootTaskId` in place, so the attempt keeps its budget but a replay can no longer present itself as an observed submission.
- `settled()` is the quiescence point for the watcher's asynchronous writes; `idle()` is the quiescence point for the delivery pump. `flush()` waits on the first and chains onto the second.
- The scheduler holds at most one armed wake-up (a nearer deadline replaces a later one) and unref's its timer, so a pending retry never keeps the process alive. Disposal cancels the wake-up and waits for the pass already running.
- A terminal state is written once. A replayed or duplicated `turn/end` cannot rewrite a recorded outcome.
- Only transport-refused sends are retried, with a bounded capped-exponential schedule. An exhausted or transport-accepted delivery stays pending and unacknowledged rather than being dropped; accepted means queued, not received.
- Recovery re-enqueues a notifying state whose delivery is missing, which repairs the crash between the task write and the outbox write.
- An upgrade retires pending deliveries whose state the current `notifyStates` excludes, so a `running` entry an older build enqueued is not re-sent. Retirement sets `retired` and leaves `acknowledged` false, so it is never reported as received.
- Target Sessions are woken only through the installed `WakeAdapter`. The shipped default refuses every delivery and probes `not-connected`; it never claims a connected channel. See the limitations below.

</details>

<a id="model-experience"></a>
## Model Experience

None. This package adds no model-visible input: it observes events, writes host-side records, and hands metadata to a wake transport. Its summaries quote Session output as untrusted result text, and its listener never contributes prompt text. Notifying only the default four states means a `running` progress event never spends a paid model turn.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Codex delivery needs an explicit transport configuration.** No default can guess a machine's Codex install: the shipped default is `unconnected`, and a deployment sets `wakeTransport`, `wakeExecution`, `wakeExecutable`, and `wakeDistro` for its own machine. The adapter runs a bounded `codex queue --thread` argv; if the executable cannot start or the queue refuses the message, the outbox retains the delivery for bounded retry. A successful queue handoff is not proof of receipt, but is not retried because doing so would enqueue duplicate messages; the receiver recovers an interrupted review from its durable receipts ledger.
- **A `wake()` probe is not a connection.** The probe runs `codex --version`, so `executable-started` means the configured executable ran. It cannot show that the target thread exists or that a queued message reaches it, so callers must not read it as a connected delivery channel.
- **Consumption is owned by the receiving side.** No sender code writes `received`, `review-started`, or a receipt; the receiver claims with `receive` and finishes with `consume`. A transport enqueue or a `wake()` probe is never reported as a review that started.
- **A receiver that dies after `received` resumes from its ledger, under its own identity or after the lease.** Claiming a delivery stops the sender's retries, so recovery after an interrupted review depends on the receiver running `receipts` and resuming every entry that is not `consumed`. A receiver that presents a stable consumer id owns its previous claim and resumes immediately; a different consumer must wait for `claimLeaseMs` before taking over, and the reclaimed generation is what stops the old owner from finishing it. That lookup is the documented failure boundary; a receiver that never runs it leaves its own review outstanding.
- **Automatic resume is bounded and specific.** Only a `turn/end` failure whose structured `LlmFailure` is an HTTP 400 invalid request stating that reasoning_text must be passed back is eligible; text that merely mentions the token is not. At most `maxAutoResumes` (default two) resumes run per original task; the count is derived from the durable receipt ledger and shared by retries, and an exhausted budget is reported as `budget-exhausted` with the used and configured counts rather than retried. A turn whose recorded outcome is unverified tool-syntax leakage is never resumed automatically: the marker check only sets `leakedToolSyntax`, and a recovery request for it answers `not-applicable`. The resumed turn keeps the Session's existing model selection and thinking state, does not fabricate reasoning, does not delete history, and does not re-execute committed tools.
- A successful queue handoff is sent once; only explicit transport refusal is retried. Receipt and review remain receiver-owned, and an interrupted review resumes from the receipt ledger rather than a second sender message. Exactly-once delivery is not claimed.
- Cross-Windows-native/WSL coordination is out of scope for this batch. The service runs in the Windows-native Host; a WSL receiver reaches the authenticated loopback control bridge by whatever route its network provides, and that route is a deployment concern.
- No invariant companion is published because this package owns no relation that independent observations could diverge on: its tables are written by one service, and its task transitions are derived from the Session log that owns them.

<a id="dev-note"></a>
## Dev Note

`tests/task-feedback.host.spec.ts` drives the real session log, projection registry, storage domain, and a simulated receiving Session, with no model, key, or network; it covers the notification policy, recovery (including a Session attached after the service recovered, a turn that ended before registration, and a notifying state whose outbox write never landed), the consumption ledger (duplicate messages, a lost acknowledgment, an interrupted claim across a restart, concurrent claims, claim takeover after lease expiry, and stale-owner rejection), and the bounded automatic resume (the exact reasoning_text condition, its near misses, supersession by a newer turn/message/cancellation, the notification's claim-then-recover protocol under one consumer identity, rejection of a stale admitted continuation after a manual turn, one admission counted once across both resume writes and a restart, retry lineage, submission replay after a crash, and feedback on the resumed turn). `tests/task-feedback.controller.host.spec.ts` runs the same resume over the production `SessionCommandController` prompt path with the real Agent registry, Session log, and Inbox, replacing only the external model selection and transport, and covers submission replay, stand-down after a manual turn, and recovery of a queued instruction whose receipt flag write was lost. `tests/task-feedback.recovery-diagnostics.host.spec.ts` pins the outcome boundaries: a completed turn whose final text carries DSML/tool markup is reported unverified (live and from restored history) while an ordinary completion, an earlier step's quotation, a reasoning block, and an earlier turn are not flagged; an SSE stream that ended without `[DONE]` keeps its own failure reason and is refused by `resumeFailed`; the reasoning_text budget reports `budget-exhausted`; a manual continuation reports `superseded` or `running` without appending anything; a manual stop withdraws a queued automatic resume and reports the attempt `cancelled`; and a consumer that is not the owner cannot consume the current claim generation. `tests/task-feedback.resume-tracking.host.spec.ts` keeps the delayed-registration regression: the follow-up task write is lost, and by the time the replay registers the task the resumed turn has already completed, failed again, paused for approval, or is still open, or a manual turn ended after it; each case asserts the binding, so the last turn end cannot stand in for the resume. It also keeps the cold-recovery regression over a durable JSON root: a task registered without its turn is rebound from restored history when the service recovers before the saved Session attaches and when the Session is already attached as the service recovers, including a later manual turn, a still-open resumed turn, and a second recovery that must not notify again. `tests/task-feedback.loop.host.spec.ts` runs the same flow over the real Agent loop: the production `SessionCommandController` queues the instruction into the real Inbox, a real turn claims it and records it, the loop runs it to completion, and the delayed registration still binds that turn; only the model transport is scripted. `tests/independent-review.host.spec.ts` keeps the concurrency and acknowledgment-race regressions. `tests/wake.host.spec.ts` runs the bounded process runner and argv arrays against the real Node executable. `tests/task-feedback.loader.spec.ts` boots the real plugin through Loader and Include over the real storage, Session, and projection providers, including the restart order where the saved Session attaches only after the service recovered.
