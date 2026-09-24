# Agent Note: Directory Membership on Every Start

Status: implemented

English | [中文](2026-09-23-directory-membership-on-every-start.zh.md)

## Problem

A registered Workspace's account of its Sessions was built once, by the first successful start's history bootstrap; afterwards the registry rebuilt only its canonical-cwd header index. Every other composition that creates Sessions — the ordinary `ctx.sessions.create` path a headless run uses, the ACP bridge, seeded children, and any Host that never calls `attachSession` — therefore produced Sessions that ran in a registered project's directory and never appeared under it. The GUI creation path attached only when the caller named a `workspaceId`, so a caller naming a `cwd` a project already owned was left out as well.

The sidebar contract already promised the opposite: a Session joins the project of the directory it runs in. The gap was mechanism, not intent.

## Decision

Directory membership is a property of the immutable stored `SessionHeader.cwd`, so the registry re-applies it on every start instead of consuming it once.

`WorkspaceRegistry` finishes its start by adopting Sessions: for every indexed Session whose canonical cwd equals a registered Workspace path, and that no explicit `sessionPlacements` entry covers, it calls `attachSession`. Candidates attach oldest first so the newest lands at the head — the order creation and bootstrap already produce — and a Session already on the account writes nothing. The pass is per-Session atomic, so one that cannot attach is logged, left outside, and retried on the next start rather than failing the start or leaving a partial account.

`SessionCommandController.create` closes the immediate case: a caller-supplied `cwd` that `resolveByPath` shows a registered Workspace already owns joins that Workspace through the same `attachSession`. Resolution is best-effort and never creates a Workspace: an unowned, non-directory, or unresolvable `cwd`, and a rejected attach, all leave the Session outside projects, where the next start adopts it. An explicit `workspaceId` keeps its own named `session/workspace-attach-failed` failure, because that caller named the Workspace rather than a directory. A `standalone` create allocates a private directory for a task the caller asked to keep project-free, so it never joins one; the `defaultCwd` fallback is not directory-inferred either, because only a `cwd` the caller named states a directory the user chose. Because neither names a directory, neither can be re-derived from the stored header on a later start, so both record the registry's explicit outside placement at create: `adoptSessions` skips a placed Session, and only an explicit `moveSession` over it joins a project afterwards. Without that record the create-time decision and the next start would disagree. A placement write that fails therefore rejects the create as `session/membership-unrecorded` carrying the created `sessionId`, so the caller retries the placement instead of receiving a success the next start would undo.

## Supersession

This note supersedes the `## Consequences` sentence of [Workspace Registration Deletion](2026-07-27-workspace-registration-deletion.md) recording that "re-registration does not automatically re-adopt existing Sessions after bootstrap". That sentence described the one-time bootstrap's incidental cost. The deletion decision itself — that removing a Workspace touches no directory, file, or log, and that its Sessions become Ungrouped — is unchanged and remains this note's premise.

## Alternatives considered

**Keep the one-time bootstrap and attach only from `session.create`.** Rejected because it repairs one creation path of several and leaves the reported defect in place for headless, ACP, and seeded Sessions; the GUI would still show a project missing Sessions that ran in its directory.

**Adopt lazily on read.** Rejected because `sessionIds` is a synchronous projection over durable state. Adoption during a getter would either mutate from a read path or report membership that survives nothing.

**Place each deleted Workspace's Sessions outside projects on `delete`.** This preserves the old re-registration behavior at the cost of one `sessionPlacements` entry per accounted Session in the domain's global state, rewritten by every later order, archive, or placement write — an O(N) global write recording what the directory rule already decides consistently.

**Infer membership from `defaultCwd` or `standalone` too.** Rejected because neither names a directory the caller chose: `defaultCwd` is the Host process's working directory, and a `standalone` directory is allocated privately for a project-free task.

## Verification

Workspace package tests pin historical adoption, symlinked cwds, restart idempotence with no rewriting and unchanged Session facts, explicit `null` and cross-project placements surviving adoption, a create-time outside placement that survives restarts until an explicit move overrides it, archived Sessions staying adopted with the archive set untouched, unowned, missing, and cwd-less directories creating no project, and a failed adoption retried on the next start. Session Controller tests pin create-time adoption with the stored cwd left in the caller's spelling, concurrent creates producing no duplicate members, unowned and unresolvable cwds, a `standalone` create at a project-owned task directory, the un-inferred `defaultCwd`, and a rejected inferred join not failing the create; they also restart over one durable medium and show that a project registered at the private standalone task directory, or at the `defaultCwd`, collects neither Session, while an explicit `moveSession` still groups the standalone Session without rewriting its cwd. The failure branch is pinned too: a rejected outside-placement write fails the create with `session/membership-unrecorded`, reports the created Session id, and accepts that id on a placement retry; the packaged control CLI refuses `--project` together with `--out` before sending any request.

## Consequences

Projects recover Sessions they were missing, including the whole history of a directory that predates its registration and every Session created outside the GUI creation path. Adoption reaches only Sessions the header index validates, so one with no recorded directory, or whose directory no project owns exactly, stays Ungrouped, and an explicit placement always outranks the directory. The cost is a start-time pass over the header index plus one record write per newly adopted Session; an account that is already complete writes nothing. A create that names no caller-chosen directory spends one more durable write recording its outside placement, paid per such create rather than by rewriting history, and that record is what keeps the create-time decision true on every later start. Removal followed by re-registering the same directory no longer discards that directory's membership permanently: the new project is empty for the rest of the run and refills on the next start.
