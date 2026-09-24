# Agent Note: Desktop task notifications and window close behavior

Status: implemented

English | [中文](2026-09-23-desktop-notifications-tray.zh.md)

## Problem

The desktop application quit when its main window closed and raised no system notifications, so a user who switched away from a long task had no way to learn that it finished, failed, or was waiting for an approval or an answer. Every close was also final: there was no way to keep a running Host alive while the window was out of the way.

## Decision

**Notifications are reported by the Client and presented by the shell.** The application renderer already receives every fact a notification needs, and the Electron main process is the only place that knows whether the application is in the foreground. A new client plugin (`packages/client/ui-desktop-notifications`) reports four events over a preload bridge: a run stopped (`api-session/status` running-to-idle edge), a run failed (`api-session/error` while that Session was running), and an approval or an answer is pending (`uiSession.pendingInteractions`, the Client's own answerable-pause registry). The shell decides whether to notify, using the user's setting, foreground suppression, and a remembered set of report identities.

A run outcome carries an identity minted once per reporter instance, and a run number is never restarted when a Session leaves the registry. The run number is counted by the renderer, so without the instance part a renderer that reloaded would number its first observed run 1 again and the shell would drop a genuine completion as a repeat. A pending request keeps the Host's own request key, which already names the request rather than the renderer that saw it. A subagent's outcome is the parent turn's business, so both its completion and its failure are suppressed using the Client's session list and the Host's `api-session/added` announcement, which is what identifies a child outside the current navigation chain.

Reporting the pending-interaction registry rather than the `approval/request` and `user-questions/request` waterfalls removes a listener-order dependency: a waterfall consumer that claims a request never calls `next()`, so a later listener would never see it. The registry is also already keyed per request, so a replacement request notifies again while a re-delivered one does not.

**A closed window becomes a tray decision.** On Windows and Linux the first close asks whether to keep running in the tray or to exit, remembers the answer when asked to, and stores it in `$DSH_HOME/desktop/desktop-preferences.json` (defaults: notifications on, ask on every close). The tray answer is the default and the escape answer, because hiding a window is recoverable and stopping the application is not. The tray restores and focuses the primary window and carries an explicit Exit entry; hiding a window never stops the Host, and an exit always takes the existing quit path, which stops the Host, waits for its children, and now also removes the tray icon. macOS keeps its platform behavior, and a build without a usable tray icon does not intercept the close at all. A desktop that refuses to create one is the same case: the failure is reported and the close keeps its historical meaning instead of failing startup over a decoration.

**The shell holds each raised notification until it settles.** Electron collects a notification whose only reference was the local variable that raised it, and a collected notification cannot run the click handler that reopens its Session, so the shell references each one until it reports a click or a close. The hold is bounded, because a platform need not report a close for a toast the user ignored, and it is released when the process leaves.

**Windows toast identity comes from the installer's own value.** The NSIS installer registers electron-builder's `appId` as the AppUserModelID on the shortcuts it creates, so packaging writes the same value into the packaged manifest as `dshAppId` (`extraMetadata` in both builder configurations) and the shell publishes it with `app.setAppUserModelId` before opening a window. An unpackaged run publishes nothing unless `DSH_DESKTOP_APP_ID` names an identity.

## Alternatives considered

Reporting from the Host was rejected: the Host has no notification surface, and reaching the shell would have needed a new Host-to-shell protocol plus a second way to route a click back to session navigation. Notifying from the `approval/request` and `user-questions/request` waterfalls was rejected for depending on listener registration order. Suppressing every notification while the application is focused, but not reporting at all while disabled, was rejected because the setting then could not be turned on without a reload. Adding a durable `turn/end` reason to the forwarded Host events was rejected as the larger change — it would add a wire surface, a generated Cordis catalog entry, and bilingual generated docs for a distinction the neutral "task finished" copy already covers honestly — and is recorded as the deferred improvement that would separate a cancelled run from a completed one.

## Consequences

A user who switches away is told when a task stops, fails, or needs an answer, and can click the notification to reach that Session. Closing the window no longer ends the work by default on Windows and Linux, so the tray is now the way back; the settings surface can restore the prompt at any time. Notifications carry locale-owned status copy plus the Session's bounded display title and nothing else; because the Client derives that title from the first user message when the Session has none, and Windows can show a notification on the lock screen, that title is the one Session-derived value the user should expect to be readable without unlocking. Because the Host publishes no status event for a dropped connection, a disconnect can never be reported as a finished task. A cancelled run reports as "task finished" until the durable turn-end reason reaches the Client.

## Verification

Unit and integration tests cover the report identity rules (run intervals, failure suppression, subagent completion and failure, an announced child outside the session list, renderer-instance identity, request keys), the shell's validation, dedup, foreground, disabled, and unsupported paths, the held-notification lifetime and its bound, the close prompt and its remembered answer, the tray menu, its refusal path, and its disposal, the settings surface in both directions including a rejected change, the activation click, and the AppUserModelID resolution with the publish point that runs before any window opens. `pnpm run verify-client-ui-i18n` covers the copy, and the desktop suite covers the Electron wiring. Toast identity, Focus Assist behavior, and the installed shortcut's AppUserModelID require an installed Windows build and are explicitly not verified here.
