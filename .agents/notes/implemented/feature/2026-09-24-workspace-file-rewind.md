# Agent Note: Workspace file rewind

Status: implemented

English | [中文](2026-09-24-workspace-file-rewind.zh.md)

## Problem

Conversation-turn rewind restored the transcript and said so honestly: files a turn wrote stayed changed. That left the most common reason to rewind — a turn that edited the wrong thing — only half answered, and the earlier note recorded the gap as an explicit boundary rather than a defect.

Closing it needs the one thing the harness did not have: a durable, replayable record of what a turn wrote. Two constraints shape how that record can be taken.

Writes reach a workspace through two boundaries. Every Harness-authored text mutation goes through `ctx.fs.writeText`/`editText` — the `write`, `edit`, and `str_replace_editor` tools — so the filesystem seam sees it. A command run through `ctx.shell` (`bash`, `pwsh`, `run_code`, a terminal) is an opaque process that can create, modify, delete, or rename any workspace file without calling back into the harness. Nothing observes those writes, and no operating-system snapshot is available in this deployment.

And a rewind must never be a guess. Inferring "this file looks like it changed this turn" from modification times would delete or revert work the turn never touched, which is worse than not restoring at all.

## Decision

A new host package, `@deepseek-ai/dsh-session-rewind-files`, captures a bounded content baseline of the session workspace BEFORE a turn's first tool dispatch and appends one log-only `file/change` event after each later execution of that turn. `session.rewind` restores that turn's files through the journal before it appends its own replacement, and refuses — changing nothing — when it cannot prove the restore.

**The baseline precedes the write, which is what makes an opaque process recoverable.** The wrapper is a `tools/execute` listener: the only seam carrying both the caller's agent identity and the full duration of an execution. Before delegating it ensures the turn has a baseline; in a `finally` it diffs the workspace against the journal's known state. The diff finds what an opaque command moved, and the baseline still holds the bytes those paths had before it ran. No process interception is needed, which is also why a tool this plugin has never heard of is covered: the baseline is taken for ANY tool dispatch, not for a declared roster of writers.

**The baseline is captured on the first tool dispatch, not at `turn/start`.** A conversation-only turn therefore appends no events at all, so existing recorded sessions and their fixtures keep their event streams; and a turn that dispatched at least one tool always has a baseline, so a missing baseline is itself evidence of a journal gap rather than of innocence. A turn that dispatched nothing restores nothing, which is a no-op and not a refusal.

**Content is addressed, never decoded.** A blob is named by the lowercase hex SHA-256 of its exact bytes, so identical content across turns and sessions is stored once under `$DSH_HOME/rewind-files`, a restore can prove it recovered what was recorded, and binary content round-trips byte for byte. Per-file (`maxFileBytes`), entry-count (`maxEntries`), and total-byte (`maxCheckpointBytes`) bounds are validated `Config` fields; a file over the per-file limit is recorded as present but unverifiable, which refuses its turn instead of restoring around it.

**Paths are workspace-relative by construction.** The walk descends only from the canonical workspace root, never follows a symbolic link, and produces `/`-separated relative paths; a restore re-resolves each one inside that root and rejects any absolute path, drive letter, or `..` segment before touching the filesystem. A write outside the workspace is detected, not undone: the filesystem intent waterfall names a target before a mutation and `fs/observed` confirms it landed, so a confirmed target outside the root records `file-outside-workspace` and refuses that turn.

**A restore verifies the whole plan before its first replacement.** Every recorded path must currently hold exactly the state the turn's last change left — compared by content address for a recorded file, by kind for anything else. A path that moved since refuses the entire rewind, so a conflicting edit is never discarded and a partial restore never happens. The plan collapses a path's changes to its first before-state and its last after-state; intermediate transitions stay in the log as evidence.

**The record is replayable, not process-local.** A `fileJournal` projection folds `file/checkpoint` and `file/change` into the same facts a live journal holds, so a restarted process or a retry restores a turn it never observed. No hidden state is introduced: the two events are the record, and `SESSION_FORMAT_VERSION` is unchanged because the vocabulary grew without a structural format change.

**Refusals are fail-closed and stable.** `session.rewind` answers `session/rewind-unavailable` with `reason: 'file-unavailable'` and a `fileReason`: `file-journal-absent` (nothing recorded, or a tool dispatched with no baseline), `file-conflict` (a recorded path moved since), `file-unrecoverable` (a changed path had no recoverable content), `file-checkpoint-over-budget`, `file-outside-workspace`, `file-blob-missing`, or `file-workspace-busy` (another agent running in the same workspace). One rewind per Session is serialized, so two concurrent requests produce one marker and one restore rather than two of either.

## Alternatives considered

**Intercept at the `ctx.fs` service and skip shell writes.** Rejected as incomplete: it would silently miss every write a shell command makes, which is the majority of agentic file work.

**Watch the workspace with an operating-system watcher and snapshot on change.** Rejected: a watch event arrives after the content is already replaced, so the pre-change bytes are gone; a shadow copy or an OS snapshot is unavailable here; and the existing `workspaceFiles` change feed is fed by `fs/observed`, so it cannot see shell writes either.

**Infer changes from modification times at rewind time.** Rejected: it cannot distinguish a turn's write from the user's, and it has no content to restore. Restoring from a guess is worse than refusing.

**Use the repository's version control as the content store.** Rejected: it would make the capability depend on the workspace being a clean Git tree, and the acceptance for this work explicitly excludes a `git reset`/`checkout` implementation. Content addressing keeps the journal independent of any VCS state.

**Checkpoint every turn at `turn/start`.** Rejected: it appends a checkpoint to conversation-only turns, changing every recorded session's event stream and every fixture, and it pays a workspace scan for a turn that cannot have written anything.

**Treat a path the walk excludes as unrestorable for the whole turn.** Rejected for the opposite reason: a project with `node_modules` would never be rewindable. Excluded stores refuse only when the journal sees a write into them.

## Consequences

A rewound turn now leaves the workspace as it found it for everything the journal recorded, and the receipt names the paths it rewrote or removed. The model-visible surface effect is unchanged from the earlier rewind, so its KV-cache and whole-log-projection consequences carry over.

The boundaries are narrower than "the turn is undone" and are documented as such: an opaque subprocess write inside an excluded dependency store, version-control metadata, or language cache is invisible; an out-of-workspace write is refused rather than reversed; a turn whose baseline exceeded a budget is refused; and recorded content is retained with no garbage collection.

`packages/session/session-rewind-files/tests/journal.spec.ts` covers baseline capture and the restore of created, modified, deleted, and renamed paths, binary round-tripping, the untouched-file guarantee, a tool the plugin was never told about, conflict refusal with nothing rewritten, the per-file and scan budgets, excluded dependency stores in both directions, out-of-workspace refusal, symlink containment, replay from the log alone, and live state as an optimization rather than the record. `packages/api/session-controller/tests/commands-rewind-files.host.spec.ts` covers the command's file receipt, its refusal when the journal is not composed, the conflict refusal, retry idempotency, concurrent serialization, the workspace-busy guard, and a turn that ran no tool.

`KNOWN_SESSION_EVENT_TYPES` and the persistence catalog are regenerated for the two new event types — the only change to that generated set — and `SESSION_FORMAT_VERSION` stays 3.
