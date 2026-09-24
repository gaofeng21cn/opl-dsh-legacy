# Agent Note: Independent session directories and project membership

Status: implemented

English | [中文](2026-09-20-independent-session-projects.zh.md)

## Problem

Users need full Agent sessions before choosing a project and need to reorganize conversations without breaking relative file paths. The separate plain-chat entry imposes a capability restriction that does not match this workflow.

## Decision

Global New session allocates a unique Host-owned task directory and uses normal Agent composition. Project-row creation keeps the project directory. Projectless sessions render as direct sidebar rows. Session menus move membership to an existing project, a newly registered directory, or outside projects. The composer displays the actual working directory.

Archiving the current Session clears the selection and leaves a replacement owed, so the archive gesture never lands on a workspace-only hero. The replacement, like the first selection after startup, is selected without a navigation generation and without activating the Conversation surface: a navigation or global panel the user already has is untouched, an in-flight user navigation owns the outcome, and a failure re-owes the landing. A superseded navigation releases its claim when it is cancelled rather than when its creation resolves.

Workspace domain version 2 stores optional sessionPlacements keyed by Session identity: a project id means explicit ownership, null means explicitly outside, and a missing entry preserves the old directory account. One durable write changes ownership; both group projections follow it. Session headers, files, and logs remain unchanged, including while an Agent is running. New sessions in a destination project use that project’s directory; moved sessions continue in their original directory. Forks inherit the current project membership and original cwd.

## Alternatives considered

**Move files or change cwd with the sidebar move.** Existing relative paths, running processes, and recorded context would point to a different location. Preserving cwd keeps those references stable.

**One shared general-chat directory.** Unrelated sessions would share files and names. Allocating a directory per newly created session avoids that collision.

**A separate tool-free chat mode.** This requires an extra creation choice and blocks normal Agent work. This decision supersedes the entry policy in [plain-chat entry](2026-09-20-plain-chat-entry.md). Previously persisted chat presets remain readable for compatibility; new sessions use normal presets.

## Consequences

Project membership is organization, not filesystem isolation or permission revocation. Moving out of a project retains access through the original cwd. Removing a project does not remove its files or conversations. Independent directories remain in the Host home after archival. Directory selection is needed only when registering a project; a failed placement leaves the conversation available for retry. Older binaries do not understand explicit placements and are not supported for editing project membership after upgrade.

## Testing

Focused controller, registry, navigation, and browser tests cover distinct directories, retry retention, moves, restart, and existing Session compatibility. The keyless web composition exercises normal Agent capabilities and checks that a relative file survives project moves. Provider authentication and real model quality are outside this change.
