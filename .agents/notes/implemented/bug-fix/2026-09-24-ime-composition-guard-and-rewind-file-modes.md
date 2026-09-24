# Agent Note: IME composition guarding and restored file modes

Status: implemented

English | [中文](2026-09-24-ime-composition-guard-and-rewind-file-modes.zh.md)

## Problem

Two cross-platform behaviors failed away from the US-English desktop.

The edit-and-resend draft — a plain `<textarea>` in [ui-chat](../../../../packages/client/ui-chat/README.md) — ran its Escape and Cmd/Ctrl+Enter handlers on every keydown, including the Escape that cancels a composition and the Enter that commits a Chinese or Japanese candidate. A user picking candidates could close the draft or resend a half-composed prompt. The composer input editor already guards its keymap with three composition signals; the draft, which does not use that editor, had none.

The [workspace file journal](../../../../packages/session/session-rewind-files/README.md) records each entry's permission bits in its baseline but never applied them. A restore publishes through a same-directory temporary file and a rename, so the rewound file took the temporary file's creation mode — 0644 under the usual umask. A shell script whose bytes a turn rewrote or that a turn deleted came back non-executable although the baseline had recorded 0755, so the restored workspace did not match what the turn found.

The journal keys every path by the name the host reports, while a filesystem write's path can be spelled in the other Unicode normalization. That mismatch was unexamined.

## Decision

**Every edit-draft shortcut is inert while the draft is composing.** `UserPromptEdit.tsx` uses the same three-signal guard as the composer keymap in `packages/client/ui-conversation/src/client/input/editor/keymap.ts`: `KeyboardEvent.isComposing`, the legacy `keyCode === 229`, and a composition watch that stays armed through the composition and for 10 ms after `compositionend`, which is when Safari delivers the composition-closing keydown. Escape and Cmd/Ctrl+Enter return without preventing the default, so the IME owns the gesture. A keydown with no composition pending behaves exactly as before on every platform, Windows included.

**A restore reapplies the baseline's recorded permission bits.** `writeAtomically` chmods its temporary file to the recorded mode — only the low `0o777` bits — before the rename, so the umask cannot decide the restored file's mode. On Windows, where `chmod` maps only the write bit, the call is harmless and the read-only attribute round-trips through the same path. A `file/change` record that carries no `mode` field still restores its content and leaves the mode the write produced, which is what the optional `FileEntryState.mode` declares for a log written before the field existed.

**Path keys stay exact code units: scan, comparison, and restore apply no Unicode normalization.** A journaled path is not only a comparison key; it is also the path a restore re-resolves inside the workspace root. On a host that keeps canonically equivalent names distinct — Windows NTFS and Linux filesystems — one normalized key would let one file's recorded bytes pass plan verification and overwrite its canonically equivalent sibling, a silent wrong restore of exactly the kind the journal refuses to perform. On macOS, whose filesystems answer lookups normalization-insensitively, the mismatch instead refuses the turn, which is fail-closed. The journal therefore compares what the host reported and documents the refusal as a [known limitation](../../../../packages/session/session-rewind-files/README.md#known-limitations-and-deferred-work).

## Alternatives considered

**Extract one shared IME guard into `ui-primitives`.** Rejected for this change: the keymap guard reads a Lexical command event and the draft guard reads a React synthetic event, so a shared helper would have to abstract both event types; the three signals are the contract each call site implements against its own event. A third non-Lexical call site is the signal to extract.

**Guard the draft on `isComposing` alone.** Rejected: engines emit composition keydowns without it, and Safari delivers the composition-closing keydown after `compositionend`, so the draft would still cancel or resend in those cases. The composer keymap already paid for all three signals.

**Normalize path keys with `String.prototype.normalize('NFC')` everywhere.** Rejected as unsafe, for the reason the decision states: where the host keeps canonical variants apart, a merged key turns a verification step into an overwrite of the wrong file.

**Journal a mode-only change by comparing mode in `sameState`.** Rejected as a different decision with a wider blast radius: it would change what `file/change` records, and it would refuse rewinds when only the mode moved since the turn. Applying the recorded bits fixes the loss the baseline already proves without changing what counts as a change.

## Consequences

A rewound script is executable again, or deleted-then-restored as executable as it was, and a restored file keeps its recorded read-only bit; Windows behavior is unchanged because `chmod` there only moves the write bit. Draft shortcuts are unchanged when no IME is composing.

`packages/client/ui-chat/tests/user-prompt-edit.client.spec.tsx` covers the draft's `isComposing` Escape, the keyCode 229 Escape, the composition watch, the post-`compositionend` window on both Escape and Cmd/Ctrl+Enter, and the resend that still happens once the window has passed. `packages/session/session-rewind-files/tests/journal.spec.ts` covers the restored exec bits of a rewritten and of a deleted script (POSIX hosts, which carry exec bits), the restored read-only bit on every host, a change record without a `mode` field, and exact-code-unit keys for canonically equivalent names where the host keeps them distinct.

No durable format changes: `FileEntryState.mode` already existed, no event was added, and `SESSION_FORMAT_VERSION` is unchanged.
