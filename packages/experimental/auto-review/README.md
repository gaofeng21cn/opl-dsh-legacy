---
description: "Add experimental per-call Auto review to a Web or desktop profile: deterministic rules first, then a fast reviewer route, then the deployment's approval answerers."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

English | [中文](README.zh.md)

## Summary

Add Auto review to the current-session permission pickers in a Web or desktop profile. Before each native or PTC inner tool call, deterministic rules decide the obvious ends of the fixed policy, the configured fast reviewer decides the rest, and a call no reviewer decided goes to the deployment's approval answerers. Default Web keeps its three permission modes until this layer is explicitly installed. Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.

Full access is not a security review. The Auto preset bundles the same sandbox mode and approval policy as Full access, so an allowed call runs unbounded and unconfirmed; the review decision is the only control Auto adds to that bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Configure the gate](#configure-the-gate)
- [What you get](#what-you-get)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

From this source checkout, install the package into the Web profile through the existing CLI:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

The CLI initializes the profile when needed and appends this package's declared patch after the base and Web layers. Reconciliation activates the patch as a profile layer; a package without `dsh.bundle.patch` is only an installed dependency. Select `Auto review` with its superscript `EXP` badge in the composer or `/permission` picker and confirm the current-session risk dialog. An explicit `/permission auto` command switches directly. General settings and future-session defaults do not offer Auto.

Remove the layer through the same CLI:

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

### Two explicit enablements

Installing the layer adds the option; selecting Auto for a Session arms the gate. Nothing reviews a call until both hold, so a Session on Read only, Workspace write, or Full access is untouched by this package. The layer states no desktop settings card of its own, so `enabled` and the reviewer route live in the profile's `cordis.yml` row; selecting Auto stays the per-Session control.

<a id="configure-the-gate"></a>
## Configure the gate

Restate the package row in the profile's `cordis.yml` (or in a later patch layer) to change any field. The [configuration catalog](../../../docs/config-catalog.md) is the exhaustive generated source for accepted fields and their JSDoc.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Explicit switch for the whole gate. `false` passes every call through, including in a Session that already selected Auto. |
| `rules` | `true` | Deterministic first-pass rules. `false` sends every pending action to the reviewer. |
| `reviewProvider` | Session route | Provider of the fast reviewer route; configure together with `reviewModel`. |
| `reviewModel` | Session route | Model of the fast reviewer route. |
| `unresolved` | `'human'` | What a call no reviewer decided does: `'human'` asks the approval answerers once, `'deny'` rejects without asking. |
| `reviewTimeoutMs` | `30000` | Milliseconds one reviewer request may run before it is abandoned. |

A configured route that half names a provider/model pair, or names a provider no live adapter publishes, fails closed instead of silently reviewing with the Session route.

<a id="what-you-get"></a>
## What you get

Auto reviews every supported call once before its body, including each started PTC `tools.*` inner call, in three stages that stop at the first decision.

**Rules decide the obvious ends.** `todo_write`, `ask_user_question`, `create_goal`, `update_goal`, and `get_goal` change only Session state, so they are allowed without a reviewer request. A shell command that recursively force-deletes a filesystem root or the home directory, or that reads a credential store and sends bytes to an external destination in the same command, is denied without one. Every other action escalates, so a rule can only ever add a denial or skip a needless request — never authorize an effect the reviewer would have examined.

**The reviewer decides the rest.** The escalated action goes to `reviewModel` when configured, else to the Session's own current provider and model, with the fixed policy and the five sections described below. An allow executes immediately with Full access; a deny reports the reviewer's own reason.

**The answerers decide what the reviewer could not.** A reviewer request that fails, returns no protocol-legal decision, or exceeds `reviewTimeoutMs` produces no verdict; with the default `unresolved: 'human'`, the deployment's approval answerers get one question about that exact call. Only `allowed-once` runs it. A rejected, cancelled, unavailable, or unrecordable question denies, so the gate never converts a failure into an approval.

Concurrent identical pending actions share one reviewer request, and a denial already decided in the open step is replayed instead of re-asked. An allowance is never replayed: a second execution is a second effect the first verdict did not cover, and the next step reviews the action again.

A denied call uses the ordinary tool card. The collapsed row identifies Auto review; expanded output states that the body did not execute and displays the reason. [The Web permission package](../../client/ui-permission-presets/README.md) owns picker interaction, and [the tool UI](../../client/ui-tool/README.md) owns reason display.

### Traceability

Every decision writes one integration log line naming the kind, the deciding stage, the rule when a rule decided, the tool, the call, and the Session. A denial additionally persists its reason in the tool error, and an escalated call additionally records the ordinary `approval/asked` and `approval/decided` pair. The reviewer's risk class, prompt, reasoning, and raw response are never persisted, logged, or mentioned in the model-facing denial. A rule denial reason names the rule's fixed effect; a reviewer denial keeps the reviewer's own text unchanged.

Navigating from a denial to its decision therefore needs no new durable format: the tool result carries the reason, the approval audit pair covers escalations, and the log line covers allowances.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the package itself as the `auto-review` row. [`src/index.ts`](src/index.ts) requires the LLM, permission, Session, and tools services, then installs the preset contribution and prepended pre-execute listener in one effect. [`src/rules.ts`](src/rules.ts) is the pure first-pass rule set. The [permission owner](../../interaction/permission-presets/README.md) supplies the current identity and process catalog; Auto shares Full access's existing sandbox and approval values without changing tool definitions.

The reviewer reconstructs five sections from the current Session surface and pending execution: fixed policy, cwd-only environment, sourced project constraints, filtered sourced history, and the complete pending action. Native schema comes from the latest request header. A PTC binding freezes its schema and carries it through the scheduler into transient execution metadata; start and settle events never serialize description or parameters. Main-agent `system/message` nodes, assistant text and reasoning, and tool results are excluded. [The decision record](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) owns authority, lifecycle, and child-inheritance rationale; [the routing decision](../../../.agents/notes/implemented/feature/2026-09-23-auto-review-rules-routing.md) owns the three stages, the review memory, and why a configured fast route never degrades to the Session route.

The snapshot runs before the rules, so a Session whose log disagrees with the pending call denies in every stage rather than skipping validation. The rules read only the pending name and arguments; the reviewer reads the frozen snapshot; the answerer path passes the pending execution to the approval service, which owns policy, auditing, and answerer dispatch.

Unloading closes selection and review admission, migrates live Auto Sessions to Full access through the existing preset writer, then aborts and drains in-flight reviews before withdrawing the listener and contribution. The reviewer timeout is the one wait that ends early: an aborted review is still drained, while a reviewer that ignores its cancellation signal cannot hold the call open past `reviewTimeoutMs`. Knobs and persistent terminals survive that migration. A persisted Auto Session cannot publish without the complete integration; reopening it after installation is an explicit user action. Reinstalling the layer restores the option but does not switch live Sessions back to Auto.

No runtime invariant companion is published: this single effect owns selection admission, review enrollment, cancellation, and cleanup; it has no independent observation that can diverge from those owned operations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [Web bundle](../../bundle/web-app/README.md) — the stable profile this patch extends.
- [Auto review decision](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) — fixed risk policy, authority, and lifecycle.
- [Auto review routing decision](../../../.agents/notes/implemented/feature/2026-09-23-auto-review-rules-routing.md) — rules-first routing, review memory, and fail-closed escalation.
- [Tools](../../core/tools/README.md) — execution, cancellation, and PTC result propagation.

-----

<a id="model-experience"></a>
## Model Experience

### Per-call reviewer

#### What the model sees

The reviewer uses the configured fast route, else the latest `request/header.config` provider and model with the shipped adapter's default reasoning. Its fixed `REVIEW_POLICY` replaces human approval for exactly one action: allow executes immediately with Full access. The other four sections contain only the retained facts described above. It returns one strict JSON text object with `risk` and `decision`; deny may include a string `reason`. Reasoning blocks may precede that single text block. Only `low + allow`, `medium + allow/deny`, and `high + deny` are valid.

#### Token effect

At most one additional model request per supported call, without caching, retries, truncation, compaction, or a separate small output budget, and none at all for a call a rule or the review memory already decided. An oversized request fails closed, and a request that outlives `reviewTimeoutMs` is abandoned.

#### KV Cache effect

The fixed reviewer policy can share a prefix; retained history and the pending action vary per call. Auto adds no dedicated runtime context or mode-switch prompt to the main agent.

### Tool denial

#### What the model sees

The denial message is `Auto review rejected tool "<name>"; its body was not executed`. Ordinary native error rendering prefixes it with `Error: `. PTC uses the existing inner-call exception and catch behavior; a caught denial does not force the outer `run_code` to fail. The optional reason is durable structured error detail for users, never main-model content. Risk, reviewer prompt, reasoning, and raw response are not persisted.

#### Token effect

A denied call contributes only the ordinary fixed error result to the main conversation.

#### KV Cache effect

The denial appends an ordinary tool result; it does not rewrite earlier context or hide existing model-visible information.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Auto requires an explicitly installed Web layer; it is absent from default Web, Headless, General settings, and new-session defaults. It ships no desktop settings card, so its switch and reviewer route are edited in the profile's `cordis.yml` rather than a Settings page.
- The Auto preset pins the approval policy to `never`, which the approval service enforces before any answerer is consulted. The default `unresolved: 'human'` routing therefore reaches the answerer seam, records its audit pair, and still resolves to a denial; prompting a human for an unclassified call needs a preset-level decision this package does not own.
- Rules recognize a shell command only through a `command` argument on the `bash` or `pwsh` tool, and they read that command text, so an action that reaches the same effect through another tool or an opaque variable escalates. Rules never allow broad work: `rules: false` exists because a deployment may consider even the session-local allowlist too wide.
- Deduplication covers concurrent identical pending actions and denials inside one step. A repeated allowance is reviewed again, and an identical action in a later step is reviewed again, because a new step may carry a new authorization.
- Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review. Native Git Bash on Windows refuses the confined modes and executes only under explicit full access, so there the review decision is the only gate.
- Model classification can be wrong. There are no persistent grants, configurable policy text, or retry layer.
- In-process Auto children review their own calls. Out-of-process children retain their native permission systems after the parent delegation call is allowed.
- The reviewer reads the Session action history through the deprecated synchronous `snapshotEvents()` reader under a line-scoped waiver. Prior calls, PTC starts, and the direct parent's initial prompt have no projection or paged reader yet, so the migration stays deferred by [the synchronous-read decision](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
