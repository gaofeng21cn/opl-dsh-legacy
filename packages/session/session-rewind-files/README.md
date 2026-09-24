---
description: "Per-turn workspace content baselines and change records that let session.rewind put a turn's file writes back, refusing anything it cannot prove."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-rewind-files

English | [中文](README.zh.md)

## Summary

This package records what each tool execution writes inside a session workspace, so a conversation rewind can put those files back instead of only rolling back the transcript. Use it when a deployment composes [`session.rewind`](../../api/session-controller/README.md) and its users expect a rewound turn to leave the workspace as it found it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in any profile that runs filesystem or shell tools and offers a rewind. It requires the tool registry, the projection registry, and `ctx.fs`; without them the fiber stays pending and nothing records.

```yaml
- name: '@deepseek-ai/dsh-session-rewind-files'
  config:
    maxFileBytes: 2097152
    maxEntries: 50000
    maxCheckpointBytes: 67108864
```

### What it records

Before a turn's first tool dispatch the journal captures a bounded content baseline of the session workspace, addressed by SHA-256. After every later execution of that turn it diffs the workspace and appends one `file/change` event naming what moved, with content addresses rather than inline bytes. Both events are log-only: they never enter the model-visible surface.

A rewind restores exactly what those records prove. It rewrites a recorded path to its before-content and reapplies the permission bits the baseline recorded for it, removes a path the turn created, and refuses the entire restore when any recorded path currently holds something other than the state the turn left.

### Configuration

| Field | Meaning |
|---|---|
| `maxFileBytes` | Largest regular file the baseline records; a larger file is listed as unrecorded, and changing it makes its turn unrestorable |
| `maxEntries` | Largest number of workspace entries one scan visits before truncating |
| `maxCheckpointBytes` | Largest total byte count one baseline reads |
| `blobRoot` | Overrides the content-addressed store root; defaults to `$DSH_HOME/rewind-files` |

### Failures

Every refusal leaves the workspace untouched, because the whole plan is verified before the first replacement. `session.rewind` reports the condition in its `fileReason`: `file-journal-absent`, `file-outside-workspace`, `file-unrecoverable`, `file-checkpoint-over-budget`, `file-conflict`, `file-blob-missing`, or `file-workspace-busy`. A turn that dispatched no tool has no baseline and restores nothing, which is not a refusal.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Why the baseline precedes the write

Writes reach the workspace through two boundaries. Every Harness-authored text mutation goes through `ctx.fs.writeText`/`editText` — the `write`, `edit`, and `str_replace_editor` tools — so the filesystem seam sees it. A command run through `ctx.shell` (`bash`, `pwsh`, `run_code`, a terminal) is an opaque process that can create, modify, delete, or rename any workspace file without calling back into the harness: nothing observes those writes and no operating-system snapshot is available here.

The journal therefore captures the baseline BEFORE the turn's first tool dispatch and diffs the workspace AFTER each execution. That ordering is what makes an opaque process's writes recoverable: the diff finds what moved, and the baseline still holds the bytes those paths had before. No interception of the process itself is needed, which is why an unknown deployment tool is covered by the same mechanism.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the tool wrapper, the write observation, the projection registration |
| [`src/journal.ts`](src/journal.ts) | `ctx.fileJournal`: baselines, per-execution diffs, the restore |
| [`src/workspace-scan.ts`](src/workspace-scan.ts) | The bounded walk and the workspace-relative path discipline |
| [`src/blob-store.ts`](src/blob-store.ts) | The content-addressed store under `$DSH_HOME/rewind-files` |
| [`src/projection.ts`](src/projection.ts) | The `fileJournal` fold that rebuilds the same facts from the log |
| [`src/types.ts`](src/types.ts) | The event payloads and the reason vocabulary |

### Path discipline and content addressing

The walk descends only from the canonical workspace root and never follows a symbolic link, so a journaled relative path cannot escape the root; a restore re-resolves each relative path inside that root before writing. Paths are compared by their exact code units — the journal applies no Unicode normalization — so a key is always the name the host reported. Content is addressed by the SHA-256 of its exact bytes, so identical content across turns and sessions is stored once and a restore can prove it recovered what was recorded. Binary content is stored and compared byte for byte; nothing decodes it. Writes publish through a same-directory temporary file and a rename, with the recorded permission bits applied to the temporary file first, so a restored file keeps its mode and a failure leaves the original file rather than a truncated one.

### Excluded stores

The walk skips dependency trees, version-control object stores, and language caches (`.git`, `node_modules`, `.venv`, `__pycache__`, `.next`, `target`, …). Skipping them keeps one checkpoint proportional to a project's own sources. Ordinary build output (`dist`, `build`, `out`) is NOT skipped and is recorded like any other file. A write into an excluded store is refused whenever the journal sees it: `ctx.fs` mutations are reported through the filesystem observation, and a path the baseline never recorded makes its turn unrestorable.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session controller](../../api/session-controller/README.md) — the `rewind` command that consumes this journal.
- [Session package map](../README.md) — adjacent durable-session packages.
- [Filesystem package](../../fs/fs/README.md) — the `ctx.fs` seam the observation is reported through.

-----

<a id="model-experience"></a>
## Model Experience

### Workspace state after a rewind

#### What the model sees

Nothing from the recording itself. The journal registers no tool, adds no prompt section, and appends only the log-only `file/checkpoint` and `file/change` events, so a request's messages, tool definitions, and system prompt are unchanged whether or not this plugin is composed. The one model-visible difference is indirect: after a rewind, the workspace files the rewound turn wrote hold their pre-turn content again, so a later read of those paths returns the earlier state instead of what the turn left.

#### Token effect

None while recording: no request gains a message, a tool definition, or a prompt section. A rewind removes a branch of the model-visible surface, which reduces the next request's input tokens by whatever that branch carried — the effect the rewind command already has on its own.

#### KV Cache effect

None while recording. A rewind discards a branch of the model-visible surface, the same prefix-invalidating effect the rewind command already has; the surviving prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the journal can prove. Each is a current constraint, not a pending fix.

- **An opaque write into an excluded store is invisible** — a shell command that writes inside `node_modules`, `.git`, or a language cache changes no path the walk records, so its turn can still report a successful restore. Dependency stores and version-control metadata are outside what this journal claims to undo.
- **A write outside the workspace is refused, not undone** — the journal detects an out-of-workspace write only when the operation reports it through the filesystem observation, and it refuses that turn rather than pretending to restore it.
- **A turn whose baseline exceeded a budget is unrestorable** — a workspace larger than `maxEntries` or `maxCheckpointBytes`, or a single file larger than `maxFileBytes`, refuses its turn instead of restoring part of it.
- **Content is retained, not garbage-collected** — every recorded version stays under `$DSH_HOME/rewind-files`; nothing prunes a blob whose turn has left the surface.
- **Live state is an optimization, not the source of truth** — the store is rebuilt by folding `file/checkpoint` and `file/change` events, so a process that never observed a turn can still restore it.
- **A permission change without a content change is not journaled** — a verifiable path is compared by content address, so a `chmod` that leaves the bytes identical records nothing and its rewind does not revert it. Rewriting recorded content does reapply that path's recorded permission bits, which is what keeps a restored script executable.
- **Path keys are exact code units, never normalized** — the journal uses the name the host reported, so on a host that answers lookups normalization-insensitively while storing a different spelling (macOS), a filesystem write spelled in the other Unicode normalization does not match its baseline entry and refuses its turn. Normalizing keys is not a safe repair: where the host keeps canonically equivalent names distinct (Windows NTFS, Linux filesystems), one normalized key would let one file's recorded bytes validate and overwrite its sibling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The recorder is a `tools/execute` wrapper, not a filesystem-service decorator, because that seam is the only one carrying both the caller's agent identity and the full duration of an execution. The filesystem intent waterfalls name a target before a mutation and `fs/observed` confirms it landed; together they detect an out-of-workspace or uncovered write without wrapping the service. The baseline is captured on the first tool dispatch of a turn rather than at `turn/start`, so a conversation-only turn appends no events at all and existing recorded sessions keep their event streams.

</details>

**Runtime invariant:** No companion is published. The package owns one projection fold whose state the projection registry schema-validates, and the workspace observations it depends on (`session/event` ordering, `tools/execute` bracketing, `fs/observed` follow-up emissions) are owned and runtime-checked by dsh-session, dsh-tools, and the filesystem tools.
