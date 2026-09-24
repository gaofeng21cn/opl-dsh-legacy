---
description: "Host and Client session control: create, resume, prompt, follow history, and project live session state."
kind: "package-reference"
---
# Session Controller

English | [中文](README.zh.md)

Client creation accepts standalone: true to allocate an independent directory under the configured standaloneRoot (default: $DSH_HOME/tasks, or ~/.dsh/tasks when unset). Its stable directory name is the SHA-256 of the session id; retries retain files and different ids receive different directories. Standalone cannot be combined with workspaceId or cwd. Ordinary default Agent composition applies. No Workspace is created. A caller-supplied cwd whose canonical directory a registered Workspace already owns joins that Workspace; an unowned, non-directory, or unresolvable cwd leaves the Session outside projects, still without creating one. Workspace resolution never rewrites the stored cwd, and an explicit workspaceId keeps its own named failure. A standalone create and the defaultCwd fallback name no directory the caller chose, so neither joins a project: each records the registry's explicit outside placement, which start-time directory adoption honours and a later explicit moveSession overrides; a failed placement write rejects the create as session/membership-unrecorded with the created sessionId, so the caller retries the placement instead of letting a later start adopt the Session by directory. Explicit agentPreset remains supported; the create reply seeds its projection until follow arrives.

## Summary

`@deepseek-ai/dsh-api-session-controller` owns the Host `ctx.sessionController` service and the generated Client `session`, `skills`, and `fileReferences` Remote namespaces. It serves Session lifecycle and history, the Host-generation model catalog, workspace-path opening, user-invocable skill discovery, and Agent-scoped file references. Use it through API Gateway when a Client needs operations addressed by a Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Session media references](#session-media-references)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

History pages and follow opening snapshots carry one `{ type: 'event', event: SessionWireEvent }` record per durable Session event. The Client retains each accepted record as one durable `SessionEventLikeEntry`; Assistant token boundaries remain inside the compact stream on `assistant/message` or `assistant/attempt`. Tool arguments, result content, failures, and `tool/result.data.meta` pass through unchanged; the controller does not resolve a Tool definition, run a presenter, or attach UI data.

The Client journal validates exact V3 event envelopes before publishing follow snapshots, live entries, or history pages. It reuses the browser-safe Session validators for required surface markers, exact replacement endpoints, earlier unique source seqs, embedded Assistant provider metadata, request-header omissions, and tool-error consistency. Invalid records fail without field stripping or normalization; range membership and source existence remain durable-log checks on the Host.

Each endpoint states its activation policy. List reads only stored headers and projection-cache rows: it never calls per-session stat or opens a cold Session body. A current-format cache identity may supply every list hint; a lifecycle-matching predecessor cache may supply only its version-compatible title as a stale display fact, never as an authoritative fold seed. Search, attachment, history pages, log following, skill discovery, and workspace-path opening can inspect persistence without activating an Agent; `canOpenWorkspacePath()` reports native-opening availability without addressing a Session. Queue mutation and cancellation require live state; model, rename, prompt, and file-reference operations may resolve or resume an ordinary Session. Prompt rejects content with neither non-whitespace text nor an attachment before resolving the Agent or appending Session events; queue edits accept only non-empty text content. `editPrompt` rewrites the Session's last editable user message and resends it. It refuses with `session/edit-unavailable` — and changes nothing — when the addressed seq is not that message (`not-last`), the Session holds no direct human prompt (`no-user-message`), it is archived (`archived`), or a turn is live (`busy`); synthetic user-role events (injected context, goal rounds) are never editable. An accepted edit appends one `user/message` carrying the edited content as a surface replacement of every model-visible node from the addressed prompt through the current surface tail, citing each shadowed node, and then queues that same message as its own turn. The replacement is what removes the abandoned assistant and tool output from the model-visible branch; every original event stays in the log, so the replaced history remains traceable. A retried requestId returns the committed replacement without appending a second one. A retried requestId returns the committed replacement without appending a second one. `rewind` returns the model-visible surface to the state before the Session's last direct human prompt: the Host appends one empty `system/message` replacing every node from that prompt through the current surface tail and citing each shadowed node, so the next request sees only the history that preceded the prompt while every shadowed event stays in the append-only log. It is accepted only while that prompt is the last one on the surface, the Session is not archived, no turn is running, and the turn has closed; otherwise it refuses with `session/rewind-unavailable` — and changes nothing — with reason `not-last`, `no-user-message`, `archived`, `busy`, or `turn-open`. Pending queue work the rewound turn produced is discarded; pending direct human prompts are kept. It also restores the workspace files that turn changed, through the optional [`fileJournal`](../../session/session-rewind-files/README.md) service: the whole restore is verified before the first replacement, so a refusal leaves the log and the workspace untouched, and an accepted rewind reports the paths it rewrote or removed in `files`. When the turn's files cannot be put back — the journal is not composed (`file-journal-absent`), it recorded no baseline for a turn that dispatched a tool (`file-journal-absent`), a recorded path changed again afterwards (`file-conflict`), a changed path carried no recoverable content (`file-unrecoverable`), the baseline exceeded a scan budget (`file-checkpoint-over-budget`), a write landed outside the workspace (`file-outside-workspace`), stored content is missing (`file-blob-missing`), or another agent is running in the same workspace (`file-workspace-busy`) — the command refuses with `session/rewind-unavailable`, `reason: 'file-unavailable'`, and that condition in `fileReason`, changing nothing. A retry of the same seq returns the committed replacement without appending another, and a concurrent request for the same Session is serialized so exactly one rollback and one restore land. Prompt admission consumes opaque receipts from the injected [`fileUploads`](../../client/file-upload/README.md) Host service and resolves every same-Agent receipt before sending the complete ordered content list through `ctx.attachments`. Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message. Create and fork are the only operations that create a new Agent directly. The service applies one preset-aware resume policy and subagent ownership fence to its own methods and to the Typert Agent and Session lookups used by other Remote namespaces. Queue mutation has one narrow exception: a live child whose current projected identity is continuable and comes from its own non-seed suffix accepts the ordinary Edit, Remove, and QueueDock Steer actions across both inbox destinations. One-shot, missing, unknown, corrupt, seed-only, or cold children remain rejected without resume. The skill catalog uses a live Agent when present or the recorded preset's standing scope when cold, so listing never starts an Agent. The authenticated delivery routes use `workspaceDesktop()` for the serving Host name and file-manager behavior. `openWorkspacePath({ path, action: "reveal" })` delegates file-manager navigation to the native adapter; omitting `action` opens the default application.

The Client adapter exposes `SessionEventStream`, a Gateway `RemoteJournalStream` bound to one ordinary or direct-subagent address. It opens follow before the initial page, publishes only contiguous `replace`, `prepend`, `append`, and `settle-assistant` changes, and repairs reconnect or sequence gaps through a tail page. Backwards paging has two verbs: `loadOlder()` pulls one 50-message page, and `loadThrough(seq)` — the turn-jump loader — loops 200-message pages until the window covers the target seq, lowering a shared target on repeated calls, stopping on a page that makes no progress, and reporting busy through the same `loadingOlder` snapshot bit. The Web adapter explicitly opts into cursorless Assistant frames: each opening carries the active attempt's `startedAfterSeq`, `nextIndex`, and compact stream, and every stream member becomes a Client-only `assistant/live-chunk` entry ordered between durable cursors. The Host captures a follower-local arrival ordinal with that baseline and suppresses buffered frames at or before the cut; a replacement Agent may restart frame revision at one. A durable `assistant/message` or `assistant/attempt` arriving after an active opening stays staged only when its seq follows `startedAfterSeq` and its Turn and Step match; the matching end type, seq, and index publishes one named settlement delta that retires the attempt's transient rows and adds the durable entry while earlier same-step retries remain visible. Revision, dense-index, or settlement gaps for a known attempt reopen follow, while a controller that missed the start ignores unknown-attempt frames and publishes their durable settlement normally. An abandoned end publishes a settlement delta without a durable entry so its transient rows retire immediately. A durable gap-repair page has no Assistant baseline, so its held notification reopens follow once for a paired page and baseline. Every history record covers exactly its event seq. A business, persistence, or unresolved continuity failure terminates the stream, while only physical carrier loss selects automatic resumption. `SessionControlStream` is a Gateway `RemoteSnapshotStream`; every generation opens with a complete process-local baseline, so reconnect replaces queue, jobs, and projection state instead of treating transient values as durable events. For each inbox change, the Host publishes the projection frame first and derives the queue replacement from that same validated post-fold value, so listener registration order cannot produce a stale queue frame.Client Agent contexts provide the identity used by the independent [`fileUpload`](../../client/file-upload/README.md) service; Session objects expose lifecycle, prompt, queue, and history operations rather than file transfer.

The Session object also carries local submission echoes: `session.beginSubmission` inserts one into `SessionSnapshot.pendingSubmissions` synchronously, before the caller serializes and prompts, so a conversation UI can show the message on the submit click's own frame. The echo stores ordered image previews and durable file references. Session derives its `transcript`, `queued`, or `steering` placement from the current running state and requested delivery mode, then retains that placement while serialization is in flight. The prompt's `requestId` is the correlation identity: the Host echoes it as the durable user source's `rpcId`, and queue occurrences project it as `SessionQueuedItem.rpcId`. An echo retires one animation frame after its durable event or queue occurrence is observed, immediately when its identified prompt fails or is abandoned, and as failed on disposal. Each retirement fires `onRetire` exactly once; an observed retirement includes the ordered durable attachment references so the composer can release successful cards while preserving failed drafts. Echoes are Client memory only; reload and reconnect rebuild the conversation from durable events alone.


The user-invocable `skills/list` metadata includes the winning provider’s optional instruction-file `path`. The composer can preview that file without loading every skill body or activating a cold Agent.

Fork copies history through the selected completed turn, including its `turn/end`. Events after that point, including queued input and model-setting changes, are excluded. An omitted or past-end anchor selects the last completed turn; an anchor inside an unfinished turn is rejected.

`session.wait` resolves one Session's next terminal outcome without polling. It settles on the awaited turn's `turn/end` — `completed`, `failed` (with the recorded message and code), or `cancelled` (with the cause) — or on a pending approval as `needs-input`. An omitted `turn` waits on the turn that is open when the call arrives; a named `turn` awaits exactly that turn, reporting its recorded outcome when it already closed.

A Session counts as still working only while an active driver can publish another fact: a turn is open, or the Agent's driver is `running`. A merely registered Agent does not, because it stays registered while idle after its last turn and opens no further turn unless new input wakes it — the state a parent reaches once its final child or subtask has finished. A driver that reaches idle with no open turn releases its waiters, and a settled Session reports its recorded outcome instead of waiting forever: its last `turn/end`, `completed` when it never ran, and a failed outcome for a named turn an idle Session can no longer open. Because waking input puts the driver in `running` before the turn opens, a `prompt` immediately followed by a `wait` still observes the prompt's turn. Caller cancellation rejects. `needs-input` is reported only for approvals: they are the sole interactive pause with a durable bracket (`approval/asked` / `approval/decided`). A `user-questions` pause publishes no durable event, so it is not observable here.

<a id="session-media-references"></a>
## Session media references

`SessionMediaReferences` mounts `GET|HEAD /api/file?path=<absolute path>` on the authenticated `connection.fetch` channel when `connection`, `fs`, and `attachments` are composed. It reads ordinary files through `ctx.fs`, including temporary paths outside registered workspaces and files in remote providers. Neither directory containment nor MIME categories restrict access; `mime-types` supplies the response type, with `application/octet-stream` for unknown extensions. GET reuses `readBytes` for preflight and ongoing byte limits; HEAD reads metadata only. All files use `ctx.attachments.imageLimits.maxImageBytes` (normally 20 MiB); exceeding this limit returns 413. Responses contain the complete file, ignore Range, and carry `private, no-store`, `nosniff`, and a sandbox CSP so directly opened HTML/SVG cannot execute with the API origin. The Client rewrite lives in `ui-chat` (`AssistantMarkdown`); audio/video responses are available, while Markdown audio/video player nodes remain separate work.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `nativeOpen` | platform-detected | Whether Session workspace paths can be handed to a native desktop opener |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-session-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as invoked Agent commands own any model-visible effect.

#### KV Cache effect

No direct effect; model requests remain owned by the Agent and LLM packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The image byte cap does not validate decoded dimensions or pixel count.
- Control baselines represent process-local state and therefore cannot reconstruct jobs after a Host restart.
- A failed follow resumption remains visible to the caller instead of retrying indefinitely.
- The raw browser upload is one streaming HTTP request without resumable offsets; a retry sends the file again from byte zero.
- File-reference completion uses the shared Agent lookup and can resume a cold Session; the `skills/list` catalog is the non-activating alternative for skill metadata.
- `session.wait` reports `needs-input` for approvals only. A `user-questions` pause and the other interactive seams publish no durable settlement, so a wait cannot observe them.
- A wait holds one `session/event` subscription until it settles or its caller cancels; a Host that never reaches a terminal fact holds it indefinitely.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Every page and frame is checked against the addressed durable Session.
