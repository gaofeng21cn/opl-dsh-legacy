---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Compact display folds completed-turn process rows while keeping the final answer and independently useful context visible; packed historical Assistant runs remain collapsed. Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Edit and resend](#edit-and-resend)
- [Conversation rewind](#conversation-rewind)
- [Completed-turn footer](#completed-turn-footer)
- [Turn Process Folding](#turn-process-folding)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Sent file references and skills confirmed by the message’s logged invocation open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## System prompt row

Each nonempty appended `system/message` owns a collapsed prompt row, including a complete prompt at the start of a headerless window; the same-step header does not duplicate it. Chat also shows a collapsed `System prompt` row for a non-empty initial request, explicit message-series start, or `system/message` surface node replacement whose text differs, reading the last nonempty surviving system node in surface order at the `request/header`; a non-initial request whose preceding header is outside the loaded history window also shows one. A resume repeats the row even when its system text is unchanged, including after pagination supplies the preceding header and system node; same-series config-only or tool-only changes, tool steps, and retries create no repetition, and a `system/message` event is never rendered as a transcript message. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A request whose system node is empty or outside the loaded window creates no row until the page holding the node arrives.

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

After Assistant replies settle, the completed-turn timing dialog omits TTFT and decoding speed, both after live replies and after reopening history. Elapsed turn time remains available. The Session Stats pill reads timing independently from its durable projection.

<a id="edit-and-resend"></a>
## Edit and resend

The last direct human prompt carries an edit-and-resend action: its row opens an inline draft with cancel and resend, reports the Host's refusal copy, and disappears while a turn runs. Escape and Cmd/Ctrl+Enter are inert while an IME is composing — including the composition-closing keystroke and the short window after `compositionend` — so no Chinese or Japanese IME gesture cancels the draft or resends it. The Host owns the rule — only that one message is editable — and the view mirrors the same last-prompt fact. Resending mints a fresh submission echo, which the durable replacement `user/message` retires like any other prompt.

The replacement also opens a transcript generation: the superseded prompt and every row its branch produced up to the replacement — Assistant replies, Tool rows, process disclosure, and completed-Turn footer — leave the visible transcript in the same publication, and the replacement renders as an ordinary prompt ahead of its own Turn. Every replaced event stays in the append-only log, so reopening, forking, or inspecting the Session still reaches it. A Turn keeps its rail mark while any of its rows survives, so replacing a steering message hides only the rows the branch covered; a compaction checkpoint declares no such branch and keeps its existing contract that the rows it shadowed stay visible.

<a id="conversation-rewind"></a>
## Conversation rewind

The same last direct human prompt also carries a rewind action: it rolls the conversation back to the state before that message without deleting anything. The Host appends one empty `system/message` that replaces every model-visible node from the prompt through the current surface tail, so the next request sees exactly the history that preceded the prompt; the shadowed events, including the assistant and Tool output the turn produced, stay in the append-only log. The action disappears while a turn runs, and a refusal — the same four states as editing plus a turn that never closed — renders the Host's reason under the row.

The replacement carries no prompt text, so it materializes as a rewind marker row instead of a prompt card, at the position the removed branch occupied. The marker declares the shadowed branch, so those rows and the Turn's rail mark leave the current transcript generation exactly as a prompt rewrite does; reopening the Session from the log reproduces the same view. On acceptance the rolled-back prompt's text returns to the composer when it is still empty — a draft the user typed since is newer input and is left alone.

<a id="completed-turn-footer"></a>
## Completed-turn footer

The completed-turn action footer starts 20px below the preceding prose or extension content.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

Each reasoning row starts collapsed, including during streaming and in reasoning-only replies. Clicking the row opens or closes its complete text; incoming answer text, Tool calls, and stream completion preserve that choice. The collapsed summary follows the latest reasoning line while streaming and shows the first line after settlement.

Settings → General exposes a persisted, localized `Normal` / `Compact` conversation-display preference in the `ui-chat` namespace; `Compact` is the default. Normal leaves process rows visible and renders no Turn-process control. In Compact mode, the System prompt remains independently visible before the opening User throughout the Turn. Context injection, reasoning, Assistant material, Tool rows, and Retry rows remain expanded while a Turn is open. At `turn/end`, its latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block—and no Tool-call block; preceding Context injection, reasoning, earlier Assistant material, Tool rows, and Retry rows then collapse by default. The control reports Turn-wide durable counts for non-subagent Tool calls, reply-bearing Assistant messages before the final answer, and subagent delegation calls; zero-valued segments are omitted, the Tool and subagent figures are mutually exclusive, and neither System prompt nor Context injection contributes a count. When all three counts are zero, the process still folds and the control reads `Thought for a while`. A full-width divider below the summary separates it from the answer or expanded process rows. User and steering messages, System prompt, error, max-token, and turn-tail rows stay outside, and a closed Turn with no final answer keeps all process evidence visible. A newly available process control is inserted without changing the relative order of existing rows: opening human input precedes the control and process rows from their first projection, while System prompt remains above that input. While older history remains available through Load earlier, process controls stay absent and no members are hidden; once history is complete, every eligible closed Turn uses the collapsed default immediately. Stable Chat Node Seats keep every renderer mounted, hidden members add no flow spacing, and a closed control sits 8px above its answer only when no independent input intervenes. Completion collapse does not depend on tail-follow position, so a reader above the tail may see the transcript reflow. An automatic collapse that would hide keyboard focus keeps the group open and leaves focus in place; a manual close focuses the process control before hiding its members. The session-scoped store records only manually expanded Turn-and-answer-Step generations; a different answer generation starts collapsed.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. Pinned scroll deliveries without reader movement update follow ownership immediately, before subsequent layout changes can invalidate their floor. Reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.
- **Read-only aggregates still count a superseded branch** — hiding a replaced branch removes its rows and rail mark, but whole-log projections (`sessionStats`, `turnOutline`, token usage) keep counting its events, and the new Turn's rail card shows no prompt preview because the replacement prompt is logged before that Turn starts.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
