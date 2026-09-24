---
description: "Task notifications for the Electron desktop shell: reports run completion, live failures, and pending approvals or questions over the shell bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-notifications

English | [中文](README.zh.md)

## Summary

Inside the Desktop application this package turns Host facts the Client already receives into Windows system notifications: a task run stopping, a live Agent failure, and an interactive pause waiting for the user's approval or answer. The notification itself — its text, its deduplication, the user's on/off setting, whether the application is in the foreground, and the click that reopens the session — belongs to the Electron shell, which this package only reports to. In an ordinary browser session there is no shell bridge, so the plugin installs nothing at all.

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

Notifications appear when the application is not in the foreground, and the Desktop settings surface turns them off. A notification names the event and the Session it belongs to; clicking one focuses the window and opens that Session.

### What is reported

| Event | Source fact | Notification |
|---|---|---|
| A run stopped | running-to-idle edge of `api-session/status` | task finished |
| A run failed | live Agent failure while that Session was running | task failed |
| An approval is pending | the Client's answerable pending-interaction registry, `approval` | waiting for approval |
| An answer is pending | the same registry, `question` or `plan-review` | waiting for input |

A dropped connection publishes no status event, so a disconnect is never reported as a finished task, and a Session that is already idle when the Client attaches produces no notification. Report identities derive from the observed fact (the run interval, the failure, or the interaction's request key), so a repeated delivery of one event is dropped by the shell instead of shown twice. A subagent's completion stays silent — its parent's turn is the user's task — while a blocking approval from a subagent is still reported.

### Content

A report carries the event identity, its kind, the Session identity, and that Session's display title; the shell adds locale-owned status copy. Message text, prompts, tool arguments, error messages, and credentials never cross the bridge.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Bridge detection

The Electron preload exposes `dshDesktop.notifications` in the application document only. `desktopNotificationBridge()` reads that value, checks both members as functions, and returns undefined in a browser session, which is what makes the plugin inert outside the Desktop shell.

### Reporting

`DesktopNotificationReporter` folds three subscriptions into reports. `api-session/status` maintains one run interval per Session with a counter, so each completion has its own identity; `api-session/error` marks the current interval failed and reports it once, suppressing the completion that follows. `uiSession.sessionStatus` is the Client's own answerable-pause registry: a request key that changes means a new pause, so answering one and receiving the next notifies again, while a re-delivered pending request keeps its key and stays silent.

### Activation

The plugin registers one activation listener with the shell. A click is routed through `ctx.uiWorkspace.openSession()` for a Session the list still holds; a click naming a Session the Client no longer lists has nowhere to go and is dropped.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-session](../ui-session/README.md) — the pending-interaction registry that makes an interactive pause answerable.
- [ui-approval](../ui-approval/README.md) and [ui-user-questions](../ui-user-questions/README.md) — the two interactive-pause domains whose requests appear in that registry.
- [Desktop application](../../../apps/desktop/README.md) — the shell owning notification presentation, the close behavior, and the tray.

-----

<a id="model-experience"></a>
## Model Experience

None. The package observes Host state changes and never contributes prompt text, a tool, or a Session event.

#### KV Cache effect

No invalidation. No model-visible input changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the Client can honestly report; they are current package constraints.

- **A cancellation reports as a finished run** — the Client-visible Host events distinguish a failure from a normal stop but do not carry the durable `turn/end` reason, which is Host-only. A cancelled run therefore reports the neutral "task finished" rather than claiming a completion.
- **Notifications require the renderer** — reports come from the application window, so a window that never loaded, or a shell started without it, notifies for nothing. The Host itself has no notification surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The shell-side policy — deduplication window, foreground suppression, Windows AppUserModelID, and the settings toggle — lives in `apps/desktop/src/notifications.ts`, `app-identity.ts`, and `desktop-preferences.ts`; this package never decides presentation.

</details>

**Runtime invariant:** No companion is published. The Remote-event and registry subscriptions are effects owned by their registries, and the report stream crosses a process boundary the shell validates on arrival.
