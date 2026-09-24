# Agent Note: Conversation-turn rewind

Status: implemented

English | [中文](2026-09-24-conversation-turn-rewind.zh.md)

## Problem

Sending a prompt was irreversible from the product surface. Edit-and-resend rewrites the last prompt but keeps the turn it opened, and forking puts the rolled-back state in a new child Session, so neither restores the conversation the user had before the send. A user who sent a prompt by mistake, or who watched a turn produce work they want retracted, had no way back to the pre-send state of the Session they are in.

"Restore the environment" cannot mean every effect of a turn. Files the model wrote through tools, network calls, external services, background jobs, and terminals are outside what a Session log can reverse, and guessing at them from text or modification times would silently corrupt unrelated work. The reachable, verifiable part is state the harness already owns durably: the model-visible conversation surface, the pending agent inbox, and the client-side composer draft.

## Decision

`session.rewind({ sessionId, seq })` rolls the conversation back to the state before the addressed direct human prompt. The Host appends one empty `system/message` — `createSystemMessage('', REWIND_SURFACE_PLUGIN)` — with `surfaceOp: { op: 'replace', startSeq: prompt.seq, endSeq: surfaceTail }` and `sourceEventSeqs` citing every shadowed node, exactly the shape compaction and edit-and-resend already use. Because an empty system node projects to no model message, the next request sees the history that preceded the prompt, while every shadowed event stays in the append-only log. The branch range travels on the replacement itself as the rewind metadata, so no new event type, no generated event catalog, and no `SESSION_FORMAT_VERSION` bump is involved.

`isRewindSurfaceEvent` in `@deepseek-ai/dsh-session/surface` is the one shared predicate for that convention, imported by both the Host command and the browser Chat fold. A build that predates rewinds still folds such a log to the same model history — it derives no message from the empty node — and only loses the marker's label.

The command refuses, changing nothing, in five cases, reported as `session/rewind-unavailable` with a stable `reason`: the addressed seq is not the last direct human prompt (`not-last`), the Session holds none (`no-user-message`), it is archived (`archived`), a turn is running (`busy`), or the last turn never closed (`turn-open`). It is idempotent on the addressed prompt rather than on a client-minted request id: the effect "this prompt is off the surface" is a function of the prompt, so a retry whose first attempt landed answers with the committed replacement and appends nothing. That read uses the controller's existing asynchronous session read (`readSessionState`), not the deprecated synchronous log readers.

Pending inbox work the rewound prompt or its turn admitted is discarded, derived from the durable `agent/inbox/spliced` records at or after the prompt's seq. Direct human prompts stay pending even inside that window: they are input the user typed, and a rewind must not destroy it. Todo, goal, plan, permission, schedule, and subagent state are not rolled back, and no external side effect is: the rewritten conversation plus the workspace files the [workspace file rewind](2026-09-24-workspace-file-rewind.md) note added are the boundary of what this command claims.

In the browser, the last direct human prompt carries a rewind action beside the edit action, gated by the same owner fact (`!running && editablePromptSeq === row.seq`). The replacement materializes as a rewind marker row that declares the shadowed branch through the existing `SupersededBranchFilter`, so the removed rows and the Turn's rail mark leave the current transcript generation exactly as a prompt rewrite does. On acceptance the client restores the prompt text to the composer only when the draft is still empty; a draft typed since is newer input.

## Alternatives considered

**A dedicated `session/rewind` event type plus a replacement.** Two appends cannot be atomic, so a crash between them would leave a rewind record with no surface effect; it also requires regenerating `KNOWN_SESSION_EVENT_TYPES` and the persistence catalog for a record the replacement already carries.

**A `system/message` with summary text as the marker.** It would enter model history as a system message and could be mistaken for a prompt update by the in-history route; an empty node is already the documented "projects to no message" shape.

**Roll back the inbox to its exact pre-prompt contents.** Re-inserting the claimed prompt would immediately re-run the turn the user just undid, and dropping every later entry would delete prompts the user typed. Discarding only turn-produced, non-human work is the safe subset.

**Reverse tool side effects.** Rejected at the time, because no durable record of a turn's writes existed and a text- or mtime-based reconstruction would be a guess presented as a restore. The workspace file journal later supplied that record for files inside the session workspace; provider text, servers, and terminals remain outside it ([workspace file rewind](2026-09-24-workspace-file-rewind.md)).

**Refuse retries with `not-last` after a successful rewind.** The client cannot distinguish a lost acknowledgement from a stale request, so a landed rewind would surface as a failure. The seq-keyed idempotency check removes that class of false failure.

## Consequences

The model-visible effect is exactly the pre-prompt prefix, so the KV-cache prefix of the surviving history is reusable and the removed branch is not. A rewound Session keeps every event, so reopening, forking, or searching still reaches the removed turn; whole-log projections (stats, turn outline, token usage) keep counting it, the same limitation the prompt-rewrite generation already documents.

`packages/api/session-controller/tests/commands-rewind.host.spec.ts` covers the accepted rewind and its surface range, the idempotent retry, all five refusals with an unchanged log, the queue rule in both directions, and a malformed seq. `packages/core/session/tests/surface.spec.ts` pins the marker predicate and the fold that derives no message from it. `packages/client/ui-chat/tests/user-prompt-rewind.client.spec.tsx` covers the row action and its localized refusals, `tests/edit-resend-visibility.client.spec.ts` covers the marker row and the hidden branch on both replay and live arrival, and `tests/apply-inject.client.spec.tsx` covers the inject callback's draft restore and verbatim refusal mapping. `tests/session.client.spec.ts` covers the client object layer.

Not rolled back, by design: external side effects, background jobs and terminals, todo/goal/plan/permission/schedule/subagent state, and any other Session's state. Workspace files are restored separately by the [workspace file journal](2026-09-24-workspace-file-rewind.md) for everything it recorded, and it refuses the rewind when it cannot prove a restore.
