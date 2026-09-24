# Agent Note: Auto review rules-first routing and fail-closed escalation

Status: implemented

English | [中文](2026-09-23-auto-review-rules-routing.zh.md)

## Problem

The shipped Auto review sent every pending call to the same provider and model that proposed it, with no local decision, no separate reviewer route, no deduplication, and a failure path whose denial carried no attribution. Four costs follow. Each obviously safe call spends a reviewer request. The reviewer shares the proposing model's route, which is the least independent judge available. No record distinguishes a policy denial from a technical failure. And because the Auto preset bundles `danger-full-access`, the reviewer decision is the only control in deployments where no confined mode can run at all — Windows Native Git Bash refuses the restricted modes and executes only under explicit full access.

## Decision

Every supported call passes three stages and stops at the first decision: deterministic rules, then the configured fast reviewer, then the deployment's approval answerers. No stage converts a failure into an approval.

### Deterministic rules

[`src/rules.ts`](../../../../packages/experimental/auto-review/src/rules.ts) is a pure function over the pending tool name and parsed arguments. It decides only the two ends of the fixed policy, where a rule and the reviewer would answer identically:

- `session-local-tool` allows `todo_write`, `ask_user_question`, `create_goal`, `update_goal`, and `get_goal`, whose complete effect is Session state.
- `filesystem-destruction` denies a `bash` or `pwsh` command that recursively force-deletes a filesystem root or the home directory.
- `credential-exfiltration` denies a `bash` or `pwsh` command whose arguments carry both a credential store and a network sink.
- Everything else escalates as `unclassified`.

The rules scan a bounded sample of the action's string leaves. A truncated scan drops a candidate and escalates, so the bound can only cost a needless reviewer request. Both deny rules fire only on a `command` string belonging to a shell tool, so writing a document or a script that mentions the same text stays a reviewer decision.

### Reviewer route

`reviewProvider` and `reviewModel` name the fast route, and the Session's own `request/header.config` route is the default when both are absent. A half-configured pair, or a provider no live adapter publishes, fails closed; the integration never degrades to the Session route, because a deployment that asked for a different reviewer must not silently get the proposing model. `reviewTimeoutMs` bounds the wait directly: the listener races the reviewer against the timeout signal, so a reviewer that ignores its cancellation signal cannot hold the pending call open, while an aborted review is still drained during disposal.

### Fail-closed escalation

`unresolved` selects the undecided path: `'human'` (the default) asks `ctx.approval.request()` once for that exact tool and call id, and `'deny'` rejects without asking. Only `allowed-once` runs the call. A rejected, cancelled, unavailable, or unrecordable question denies and names its cause in the persisted reason. The approval service owns policy, auditing, and answerer dispatch, so no new human-interaction mechanism is introduced.

### Review memory

One action identity is the Session, the open step, the mode, the name, and the serialized arguments. Concurrent identical pending actions share one reviewer request. A denial recorded in the open step is replayed with its original reason and without a reviewer request. An allowance is never replayed: a second execution is a second effect the first verdict did not cover, and the next step reviews the action again because a new step may carry a new authorization.

### Traceability

Every decision writes one integration log line naming the kind, the deciding stage, the rule when a rule decided, the tool, the call, and the Session. The line omits the reason because a reviewer reason has no length bound and grows with whatever the reviewer decided to explain; the durable tool error carries it instead. A denial persists its reason in the existing `AutoReviewDeniedError` metadata, so the persisted error fields keep their declared shape. An escalated call additionally records the ordinary `approval/asked` and `approval/decided` pair. The reviewer's risk class, prompt, reasoning, and raw response are never persisted, logged, or placed in model-facing content; the model-facing denial text is unchanged.

### Configuration

`enabled`, `rules`, `reviewProvider`, `reviewModel`, `unresolved`, and `reviewTimeoutMs` are validated `Config` fields in the profile's `cordis.yml`. `enabled` defaults to `true` because the layer is explicit twice over already — installing it into the profile, and selecting Auto for a Session — so a third default-off switch would only make the documented install a no-op.

### Windows Native Git Bash

The gate reads no sandbox state and requests no confinement. On a Windows host whose selected shell is Git Bash, where the restricted modes refuse to start and only explicit full access executes, the review decision is the only control, and nothing in this integration weakens or claims otherwise.

## Alternatives considered

**Allowlist tools by declared name for every read-only operation.** A name says nothing about effects, and a broader allowlist would authorize host effects the reviewer never saw. The allow rule covers only tools whose owning packages define them as Session-state-only, where the tool name and the effect are the same fact.

**Cache reviewer allowances for identical actions.** A cached allow is a standing grant. The reviewer decides one execution, and an authorized medium action carries an authorized count, so a second execution is outside that decision. Only denials, which are monotone inside one step, are replayed.

**Fall back to the Session route when the configured fast route is unavailable.** Silent degradation would review with the proposing model while the deployment believes a different one reviewed. Fail closed and name the unusable route instead.

**Bound the reviewer with the cancellation signal alone.** `dsh-llm` requires adapters to honor `options.signal`, so the signal is the contract. Relying on it alone still lets one non-conforming adapter hold a tool call forever, which is the failure the timeout exists to bound, so the listener also races the timeout directly.

**Record each decision as a Session event.** `SessionEventMap` membership is required-on-read, so a new type would refuse logs in builds that do not know it and would need a persistence-type acknowledgement. The decision is not model context, and the tool error, the approval audit pair, and the log line already carry it, so no durable format changes.

**Cache rule denials beyond the open step.** A later human or direct-parent instruction can authorize what an earlier step denied. Replaying that denial across steps would refuse work a human just approved.

**Ship a desktop Settings card in this change.** A card needs a browser half, a settings namespace, tsconfig compiler faces, and bundle-composition wiring. The switch and route are reachable through the profile's `cordis.yml`, so the card stays deferred while the routing lands.

## Consequences

Reviewer requests drop to the actions a rule cannot decide, concurrent duplicates cost one request, and repeated denials inside a step cost none. Every denial now names its deciding stage, so a rule change, a reviewer change, and a technical failure are distinguishable from the persisted record alone. The undecided path can no longer be mistaken for a decision: it either reaches an answerer or states why it could not.

The rules can deny useful work — a command that mentions a root deletion or a credential send inside a larger script is denied without review — which the fixed policy already accepts as the safe direction. The rules recognize a shell command only through a `command` argument on two tool names, so another wrapper escalates. The default human route reaches the approval service but resolves to a denial under the Auto preset's `never` policy, because prompting a human needs a preset-level change owned by [the permission-preset layer](../../../../packages/interaction/permission-presets/README.md). Configuration lives in `cordis.yml` rather than a Settings page. `docs/config-catalog.md` and `docs/module-graph.md` need regeneration once the other in-flight workstreams settle; the catalog generator currently rejects a schema spread that the Git Bash settings work introduced in `packages/shell/bash-local` and `packages/shell/pwsh-local`.

## Testing

`tests/rules.spec.ts` pins every rule identity, both allow and deny directions, the non-catastrophic near-misses that must escalate, the shell-tool restriction, and both scan bounds. `tests/auto-review.spec.ts` pins the disabled gate making no reviewer request, the session-local allow, the catastrophic deny, the configured fast route, the half-configured and unpublished route failures, the reviewer timeout, `rules: false`, the approval grant, each fail-closed answerer outcome, the concurrent join, the denial replay, the next-step re-review, and one trace assertion set that fails if a decision, rule, or reason is reported that the deciding stage did not produce. Both files reach full statement, branch, function, and line coverage of `src/index.ts` and `src/rules.ts`.
