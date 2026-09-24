# Agent Note: The routed input budget and step admission

Status: implemented

English | [中文](2026-09-23-routed-input-budget-and-step-admission.zh.md)

## Problem

A routed model's nominal capability is not the deployment's working budget. DeepSeek routes advertise a 1M context window, so `dsh-compaction-basic`'s ratio policy planned against 1M: with `thresholdRatio: 0.8` and `retainRatio: 0.16`, condensation started at 800000 estimated tokens and kept a 160000-token verbatim tail. A deployment that runs a 272000-token window wants condensation at 244800 tokens and at most 258400 input tokens per request, and had no way to say so: capacity belongs to the adapter that owns the route, and several consumers read it as the model's advertised capability. Shrinking it there would misreport what the provider serves.

Condensation could also fail — no safe range, an exhausted retry loop, a failed summarizer call — while the step's request was still sent. That is an admission the policy never granted, and it hid the failure behind a warning.

## Decision

`dsh-compaction-basic` owns a routed **effective input budget** next to its trigger and retention policy:

- `inputBudget` is an absolute token budget; the resolved effective budget is `min(routed capacity, inputBudget)`, so a model whose own window is smaller keeps that window and adapter metadata is never rewritten. Both ratios scale from the effective budget; absolute `thresholdTokens` and `retainTokens` are taken as configured except that an absolute trigger clamps to the effective budget.
- The trigger (`thresholdTokens`, or `floor(effectiveBudget × thresholdRatio)`) starts pre-step condensation.
- The effective input budget is the pre-step listener's **admission ceiling**.

Step admission is explicit. At or above the trigger, the listener condenses the oldest balanced span while keeping the priced recent tail. Afterwards:

- A priced request still above the effective input budget refuses the step with `StepInputBudgetError`; the request is never sent, and the error carries the measured tokens, the reached trigger, and the budget.
- A condensation failure that leaves the request within the budget is logged and the step proceeds, because the configured budget admits it. A compaction that reached the trigger and could not reduce it reports `PressureCompactionError`.
- An adapter publishing no capacity for the route, an unscalable policy, or an already-held session compaction lock is a condensation failure, not an admission. Without a configured budget these keep the documented warn-once-and-continue behavior; a configured `inputBudget` is the deployment's own explicit ceiling, so it is enforced even when the adapter publishes no capacity. Only a route with neither capacity nor a configured budget leaves the ceiling to the provider's overflow recovery.
- Automatic condensation carries the whole mechanism. `auto: false` installs no listener, so no step admission runs, and a configured budget then only shapes programmatic `compactIfNeeded` calls.

A configured budget also makes part of retention validation capacity-independent: the budget decides its own trigger, so a retention value that cannot fit below that trigger rejects the plugin at load instead of failing at the first routed request. Without a configured budget the comparison still needs the routed model's capacity and fails when that model is first used, as before.

The OPL deployment carries the values it targets — `inputBudget: 258400` and `thresholdTokens: 244800`, the 95% and 90% shares of the 272000-token window its Codex configuration uses — only where its own route is composed. The shipped `standard` preset holds them as an exact `modelPolicies` entry for `opl-gateway/deepseek-flash`, so every other provider mounting that preset keeps the plugin defaults scaled from its own capacity; `apps/cli/config/opl-headless.cordis.patch.yml` holds them on the base bundle's compaction row, which binds every route that OPL-owned profile resolves. Plugin defaults are unchanged, so no other deployment moves.

## Measurement and timing

Token statistics already exist at three levels, and step admission reuses them:

- `ctx.tokenMeter.measure(session)` folds the durable log and prices the latest canonical request envelope plus the current surface; provider-reported usage anchors a measurement when the envelope matches, so a step's decision is priced rather than guessed. The pre-step path re-measures after the optional model-free prune and after every condensation attempt.
- `compaction/summary` records `shadowedTokenCount` (the estimated price of the replaced span) plus the summarizer's optional `usage`; `compaction/start` and `compaction/end` bracket the transaction in the durable log.
- The meter's projection units (`tokenUsage`, `contextPressure`, `contextBreakdown`) serve the occupancy display, and the refusal error exposes the same numbers to the caller.

Timing is derivable but unreported. Every durable session event carries `seq` and a wall-clock `time`, so condensation duration is `compaction/summary.time - compaction/start.time` for the summarizer call and `compaction/end.time - compaction/start.time` for the whole transaction, including the prune and commit. No plugin logs, aggregates, or emits that duration, and the compaction result does not carry it.

Three gaps are recorded rather than closed here:

1. The durable record holds only the shadowed span's price. Neither the measured total before a pass nor the measured total after it is durable, so post-compaction pressure must be re-folded from the log to be reported.
2. Compaction duration has no owner on the plugin surface; the event `time` fields are the only source, and nothing performs the subtraction for a user or an operator.
3. The pressure check itself is unpriced: each step resolves model capacity and runs an O(surface) `measure()`, and no budget or telemetry covers that cost.

## Alternatives considered

**Rewrite the adapter's `contextWindow` to the deployment budget.** Rejected: that value is the model's advertised capability, read by occupancy displays, model discovery, and overflow detection. A deployment budget is not a provider fact, and the 1M capability must stay reportable.

**Express the budget as a ratio of the nominal window.** Rejected: it reproduces the policy the deployment needed to leave. A ratio of 1M is still 1M, and the points that matter — the trigger, the retention tail, and the admission ceiling — are absolute token counts.

**Keep ratios only, with the deployment ratio 244800/258400.** Rejected: the deployment owns absolute numbers from its own runtime configuration; a repeating decimal in YAML hides which number is authoritative and invites silent drift.

**Refuse every step whose condensation does not reach the trigger.** Rejected: a route whose fixed overhead (system prompt and tool schemas) already exceeds the trigger can never condense, so refusal bricks it. The loop regression suite pins exactly that shape with a 400-token window. The effective input budget, not the trigger, is the hard ceiling.

**Keep warn-and-continue for an over-budget request.** Rejected: that is the silent admission the change exists to remove. A request above the effective budget now fails the turn where it used to be attempted.

**Refuse the step through `PreStepDecision` `reject`.** Rejected: `reject` closes the turn as `blocked` and drops the claimed batch without a diagnostic, while a thrown error carries the measured numbers, the trigger, and the budget into the turn-error surface.

**Put the budget on the `llm-opl-gateway` adapter config.** Rejected: the budget is a deployment policy that holds for every route the deployment runs, and the adapter's capacity field is exactly the provider metadata this change refuses to overwrite.

## Verification

`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` pins the policy and the admission paths: trigger and retention derived from the effective budget (41344 rather than 160000 on a 1M route), a smaller model clamped to its own window, an absolute trigger clamped to a smaller route, exactly-at-trigger condensation and a one-token-below idle step, refusal when condensation cannot reach the budget, continuation when a failure leaves the request inside it, refusal without adapter capacity once a budget is configured, the unconfigured-budget path that keeps the provider's overflow recovery, the warn-once lock path, `auto: false` installing no admission even with a budget, the load-time retention/budget rejection, and tool-call/result integrity in the retained tail. `tests/loader-composition.spec.ts` extracts the shipped standard preset's compaction row and the shipped OPL headless patch through the real Loader and resolves them: the OPL route gets 258400/244800/41344 at nominal 1M and 64000/64000/10240 at 64000, while every other provider keeps 800000/160000. The pre-existing `compaction-loop-repro.spec.ts` real-loop suite pins that a window whose fixed overhead exceeds the trigger still completes its turn.

The two recorded-session snapshots this change affects — `snapshots/acp/image-compaction` and `snapshots/session/compaction-recovery` — replay green with the fix once the checkout resolves the ACP sidecar symlinks and the Windows agent shell selects git-bash, which the fixtures' recorded `bash` tool requires.

## Consequences

The model keeps its nominal 1M capability while the deployment plans, prices, and admits against 258400 tokens; retention on that route is 41344 tokens instead of 160000; and no request above the effective budget is sent. Failures are visible as errors with the numbers that caused them.

The cost is fourfold. An absolute trigger above a smaller route's budget clamps to that route's window, so that route condenses at its window instead of at its configured fraction — deliberate, but it means one absolute trigger cannot preserve a proportional margin across capacities. Sequences that stay above the budget now fail their turn instead of being attempted and possibly succeeding at the provider. A configured budget moves part of retention validation to load, so a configuration that used to load and fail at first use now refuses the plugin outright. And `PressureCompactionError` and `StepInputBudgetError` join the package's public error surface, so consumers distinguishing compaction failures must handle them.
