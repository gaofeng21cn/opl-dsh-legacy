/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic/types
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Policy fields shared by the default policy and exact model overrides. */
export interface CompactionPolicyConfig {
  /** Compact at this fraction of the input budget or model window, capped by output reservation and headroom. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Extra pressure headroom after reserving output tokens; defaults to 65536. */
  headroomTokens?: number
  /**
   * Absolute token count that starts automatic pressure compaction; mutually
   * exclusive with `thresholdRatio`. A route whose effective input budget is
   * smaller compacts at that budget instead.
   */
  thresholdTokens?: number
  /**
   * Effective input context budget in tokens for a routed target: the largest
   * prompt a step may send and the basis for pressure ratios. The effective
   * ceiling also respects the model window minus reserved output tokens.
   * Omission leaves provider overflow recovery in charge of admission.
   */
  inputBudget?: number
  /** Recent context retained as a fraction of the effective input budget. Defaults to `0.16`. */
  retainRatio?: number
  /** Absolute recent-context budget; mutually exclusive with `retainRatio`. */
  retainTokens?: number
  /** Summary provider; set together with `summarizationModel`, or inherit the conversation target. */
  summarizationProvider?: string
  /** Summary model; set together with `summarizationProvider`, or inherit the conversation target. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to the resolved `headroomTokens`; an explicit cap must be positive. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
}

/** Exact provider/model override merged over the default compaction policy. */
export interface ModelCompactPolicyConfig extends CompactionPolicyConfig {
  /** Registered provider route to match. */
  provider: string
  /** Exact routed model id to match within `provider`. */
  model: string
}

/** Basic compaction configuration with an optional exact-target policy table. */
export interface BasicCompactionConfig extends CompactionPolicyConfig {
  /** Exact provider/model overrides; duplicate targets fail plugin load. */
  modelPolicies?: ModelCompactPolicyConfig[]
  /** Enable automatic step-boundary pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Exactly one validated retention form. */
export type ResolvedRetention =
  | { readonly retainRatio: number; readonly retainTokens?: never }
  | { readonly retainRatio?: never; readonly retainTokens: number }

/** Exactly one validated pressure-trigger form. */
export type ResolvedThreshold =
  | { readonly thresholdRatio: number; readonly thresholdTokens?: never }
  | { readonly thresholdRatio?: never; readonly thresholdTokens: number }

/** Validated policy fields shared before and after exact-target matching. */
interface ResolvedPolicyFields {
  readonly headroomTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  /** Configured effective input budget, before clamping to the routed capacity. */
  readonly inputBudget?: number
}

/** Validated immutable config whose target-specific defaults remain unresolved. */
export type ResolvedConfig = ResolvedPolicyFields & ResolvedThreshold & ResolvedRetention & {
  readonly modelPolicies: readonly Readonly<ModelCompactPolicyConfig>[]
  readonly auto: boolean
}

/** Fully merged policy for one routed conversation target, before capacity scaling. */
export type ResolvedTargetPolicy = ResolvedPolicyFields & ResolvedThreshold & ResolvedRetention & {
  readonly target: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** One routed model's concrete admission, pressure, and retention budget. */
export type ResolvedCompactSpec = Omit<
  ResolvedTargetPolicy,
  'headroomTokens' | 'inputBudget' | 'thresholdRatio' | 'thresholdTokens' | 'retainRatio' | 'retainTokens'
> & {
  readonly contextWindow: number
  /** Effective input budget: the configured budget clamped by the window minus reserved output. */
  readonly inputBudget: number
  readonly thresholdTokens: number
  readonly retainTokens: number
}
