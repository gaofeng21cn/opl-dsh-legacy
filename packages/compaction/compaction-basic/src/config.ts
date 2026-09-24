/**
 * Load-time validation and routed-model policy resolution for compaction-basic.
 *
 * @module @deepseek-ai/dsh-compaction-basic/config
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
  ResolvedThreshold,
} from './types.ts'

/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Fields shared by top-level defaults and exact-target overrides. */
const POLICY_CONFIG_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'thresholdTokens',
  'inputBudget',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
] as const

/** Complete public top-level configuration key set. */
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_CONFIG_KEYS,
  'modelPolicies',
  'auto',
])

/** Complete exact-target override key set. */
const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  ...POLICY_CONFIG_KEYS,
])

/** Target-specific pressure configuration failure eligible for warning suppression. */
export class TargetPressureConfigError extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(readonly targetKey: string, message: string) {
    super(message)
  }
}

/**
 * Pre-step condensation that reached the routed pressure trigger and could not
 * bring the priced request back below it. It reports the numbers the step
 * admission decision needs; whether the step may proceed is the caller's policy.
 */
export class PressureCompactionError extends Error {
  /**
   * @param targetKey - exact provider/model route whose trigger stayed reached.
   * @param measuredTokens - priced input tokens measured when condensation stopped.
   * @param thresholdTokens - resolved compaction trigger that stayed reached.
   * @param inputBudget - resolved effective input budget for that route.
   * @param contextWindow - adapter-owned capacity for that route.
   * @param message - actionable detail for the unreduced request.
   */
  constructor(
    readonly targetKey: string,
    readonly measuredTokens: number,
    readonly thresholdTokens: number,
    readonly inputBudget: number,
    readonly contextWindow: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * A refused step: its priced input exceeds the routed effective input budget,
 * so the request is never sent. `cause` carries the failed condensation when
 * one ran.
 */
export class StepInputBudgetError extends Error {
  /**
   * @param targetKey - exact provider/model route whose budget refused the step.
   * @param measuredTokens - priced input tokens measured at refusal.
   * @param inputBudget - resolved effective input budget the request exceeds.
   * @param message - actionable refusal detail.
   * @param options - standard error options; `cause` carries a failed compaction when present.
   */
  constructor(
    readonly targetKey: string,
    readonly measuredTokens: number,
    readonly inputBudget: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Resolve and validate service defaults plus exact-target partial overrides.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable defaults and validated exact-target overrides.
 */
export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  validatePolicy(config, 'BasicCompactionConfig')
  if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    throw new Error('BasicCompactionConfig: auto must be a boolean')
  }

  const headroomTokens = config.headroomTokens ?? 65_536
  const maxTokens = config.maxTokens ?? headroomTokens
  assertPositiveInteger('BasicCompactionConfig.maxTokens (explicit or from headroomTokens)', maxTokens)
  const threshold = resolveThreshold(config, { thresholdRatio: DEFAULT_THRESHOLD_RATIO })
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO })
  validatePressurePolicy(threshold, retention, 'BasicCompactionConfig')
  validateBudgetedRetention(threshold, retention, config.inputBudget, 'BasicCompactionConfig')
  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    if (policy.maxTokens === undefined && config.maxTokens === undefined && policy.headroomTokens !== undefined) {
      policy.maxTokens = policy.headroomTokens
    }
    assertPositiveInteger(
      `BasicCompactionConfig: modelPolicies[${index}].maxTokens (explicit or from headroomTokens)`,
      policy.maxTokens ?? maxTokens,
    )
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    const resolvedThreshold = resolveThreshold(policy, threshold)
    const resolvedRetention = resolveRetention(policy, retention)
    validatePressurePolicy(resolvedThreshold, resolvedRetention, name)
    validateBudgetedRetention(
      resolvedThreshold,
      resolvedRetention,
      policy.inputBudget ?? config.inputBudget,
      name,
    )
  }

  return deepFreeze({
    ...threshold,
    headroomTokens,
    ...retention,
    ...config.inputBudget === undefined ? {} : { inputBudget: config.inputBudget },
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    modelPolicies,
    auto: config.auto ?? true,
  })
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - validated service defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns detached immutable policy before model-capacity scaling.
 */
export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): ResolvedTargetPolicy {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const inheritedThreshold: ResolvedThreshold = config.thresholdTokens === undefined
    ? { thresholdRatio: config.thresholdRatio }
    : { thresholdTokens: config.thresholdTokens }
  const inheritedRetention: ResolvedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  const inputBudget = override?.inputBudget ?? config.inputBudget
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    ...resolveThreshold(override ?? {}, inheritedThreshold),
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    ...inputBudget === undefined ? {} : { inputBudget },
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  })
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 *
 * Ratios use the smaller configured input budget or model window. Admission and
 * retained context also respect the routed output reservation, while pressure
 * reserves additional compaction headroom. Absolute triggers obey those same
 * limits without changing the adapter's model capacity.
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @param reservedCompletionTokens - effective routed output cap, or zero when absent.
 * @returns detached immutable admission, pressure, and retention budgets.
 */
export function resolveCompactSpec(
  policy: ResolvedTargetPolicy,
  contextWindow: number,
  reservedCompletionTokens = 0,
): ResolvedCompactSpec {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`,
    )
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: reservedCompletionTokens (${reservedCompletionTokens}) `
      + 'must be a non-negative integer',
    )
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens `
      + `of its ${contextWindow}-token context window, leaving no message budget; configure `
      + "the adapter model's contextWindow above the effective request maxTokens",
    )
  }
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
  if (pressureBudgetTokens <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens `
      + `and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token context `
      + 'window, leaving no pressure budget; reduce the effective request maxTokens or '
      + 'compaction headroomTokens, or configure a larger adapter model contextWindow',
    )
  }
  const budgetBasis = Math.min(contextWindow, policy.inputBudget ?? contextWindow)
  const inputBudget = Math.min(messageBudgetTokens, budgetBasis)
  const thresholdTokens = Math.floor(Math.min(
    policy.thresholdTokens ?? budgetBasis * policy.thresholdRatio,
    inputBudget,
    pressureBudgetTokens,
  ))
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(inputBudget * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens `
      + `(${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    inputBudget,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  })
}

/** Choose an explicit pressure trigger or inherit the already-resolved fallback. */
function resolveThreshold(
  config: CompactionPolicyConfig,
  fallback: ResolvedThreshold,
): ResolvedThreshold {
  if (config.thresholdTokens !== undefined) return { thresholdTokens: config.thresholdTokens }
  if (config.thresholdRatio !== undefined) return { thresholdRatio: config.thresholdRatio }
  return fallback
}

/** Choose an explicit retention form or inherit the already-resolved fallback. */
function resolveRetention(
  config: CompactionPolicyConfig,
  fallback: ResolvedRetention,
): ResolvedRetention {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens }
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio }
  return fallback
}

/**
 * Reject a capacity-independent trigger/retention conflict at plugin load.
 * Ratio-trigger conflicts compare ratios; absolute-trigger conflicts compare
 * token counts, so both are decidable without the routed model's capacity.
 */
function validatePressurePolicy(
  threshold: ResolvedThreshold,
  retention: ResolvedRetention,
  name: string,
): void {
  if (threshold.thresholdRatio !== undefined && retention.retainRatio !== undefined
    && retention.retainRatio >= threshold.thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than `
      + `the resolved thresholdRatio (${threshold.thresholdRatio})`,
    )
  }
  if (threshold.thresholdTokens !== undefined && retention.retainTokens !== undefined
    && retention.retainTokens >= threshold.thresholdTokens) {
    throw new Error(
      `${name}: retainTokens (${retention.retainTokens}) must be less than `
      + `the resolved thresholdTokens (${threshold.thresholdTokens})`,
    )
  }
}

/**
 * Reject a trigger/retention conflict a configured input budget already
 * decides. At any capacity at or above the budget the effective budget is the
 * budget itself, so both values are known at load and the routed policy would
 * reject every such model at first use. A policy without a configured budget
 * stays capacity-dependent and is judged when that model's capacity resolves.
 */
function validateBudgetedRetention(
  threshold: ResolvedThreshold,
  retention: ResolvedRetention,
  inputBudget: number | undefined,
  name: string,
): void {
  if (inputBudget === undefined) return
  const thresholdAtBudget = threshold.thresholdTokens === undefined
    ? Math.floor(inputBudget * threshold.thresholdRatio)
    : Math.min(threshold.thresholdTokens, inputBudget)
  const retainedAtBudget = retention.retainTokens ?? Math.floor(inputBudget * retention.retainRatio)
  if (retainedAtBudget < thresholdAtBudget) return
  throw new Error(
    `${name}: the configured inputBudget (${inputBudget}) retains ${retainedAtBudget} tokens at a `
    + `${thresholdAtBudget}-token trigger, so retention must be reduced below that trigger`,
  )
}

/** Validate, detach, and reject duplicate exact-target policies. */
function resolveModelPolicies(configured: unknown): ModelCompactPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) {
    throw new Error('BasicCompactionConfig: modelPolicies must be an array')
  }
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    assertModelPolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) {
      throw new Error(
        `BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`,
      )
    }
    seen.add(key)
    return { ...source }
  })
}

/** Validate one untrusted exact-target override and narrow its public type. */
function assertModelPolicy(
  source: unknown,
  name: string,
): asserts source is ModelCompactPolicyConfig {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, MODEL_POLICY_KEYS, name)
  assertNonEmptyString(`${name}.provider`, source.provider)
  assertNonEmptyString(`${name}.model`, source.model)
  validatePolicy(source, name)
}

/** Validate the fields common to defaults and exact-target partial overrides. */
function validatePolicy(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const thresholdRatio = config.thresholdRatio
  const headroomTokens = config.headroomTokens
  const thresholdTokens = config.thresholdTokens
  const inputBudget = config.inputBudget
  const retainRatio = config.retainRatio
  const retainTokens = config.retainTokens
  const maxTokens = config.maxTokens
  const compactionRetries = config.compactionRetries
  const maxOverflowRetries = config.maxOverflowRetries
  if (headroomTokens !== undefined) assertNonNegativeInteger(`${name}.headroomTokens`, headroomTokens)
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio)
  if (thresholdTokens !== undefined) assertPositiveInteger(`${name}.thresholdTokens`, thresholdTokens)
  if (inputBudget !== undefined) assertPositiveInteger(`${name}.inputBudget`, inputBudget)
  if (thresholdRatio !== undefined && thresholdTokens !== undefined) {
    throw new Error(`${name}: thresholdRatio and thresholdTokens are mutually exclusive`)
  }
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio)
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens)
  if (retainRatio !== undefined && retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`)
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens)
  if (compactionRetries !== undefined) {
    assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries)
  }
  if (maxOverflowRetries !== undefined) {
    assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries)
  }

  validateSummarizationPair(config, name)
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error(`${name}.summarizationProvider must be a string`)
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`${name}.summarizationModel must be a string`)
  }
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined
    || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together `
      + 'as an empty or non-empty pair',
    )
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}
