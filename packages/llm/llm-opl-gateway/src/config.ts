/** Plugin configuration for the OPL Gateway route and its fixed DeepSeek catalog. */
import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekCatalogModel, Options } from '@deepseek-ai/dsh-llm-deepseek'
import { OPL_GATEWAY_INFERENCE_BASE_URL } from './opl-credentials.ts'
import {
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS,
  OPL_GATEWAY_SEARCH_DEFAULT_MAX_SEARCHES,
  OPL_GATEWAY_SEARCH_DEFAULT_MODEL,
  OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS,
} from './search.ts'

/** Credential reference the Models page writes when a gateway key is typed in. */
export const DEFAULT_API_KEY_REF = 'OPL_GATEWAY_DEEPSEEK_API_KEY'

/**
 * The one model this route advertises. The gateway serves the id
 * `deepseek-v4.1-flash`, which this deployment presents as `DeepSeek-V4.1-Flash`;
 * requests stay unrestricted, so a session that names any other id the
 * gateway enables still reaches it.
 */
export const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash',
    description: 'DeepSeek Flash served by the OPL Gateway.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
  },
]

const MODEL_MODALITIES = ['text', 'image'] as const

/**
 * Auxiliary web search served from this gateway's Responses route.
 *
 * Search runs on a model that serves the gateway's `web_search` tool, which the
 * account's DeepSeek routes are not; the conversation model stays a separate
 * choice. Every field falls back to this route's own endpoint and credential.
 */
export interface SearchConfig {
  /** Model that runs the auxiliary search turn. */
  model?: string
  /** Credential reference; defaults to this route's `apiKeyEnv`. */
  apiKeyEnv?: string
  /** Inference root; `/responses` is appended. Defaults to this route's endpoint. */
  baseURL?: string
  /** Upper bound on generated tokens for the search turn. */
  maxOutputTokens?: number
  /** Budget for one search, covering connection, search, and answer. */
  timeoutMs?: number
  /** Upper bound on server-side searches one request may run. */
  maxSearches?: number
}

/**
 * Plugin config, validated by the same-named schema and doubling as the
 * `llm-opl-gateway` settings-section shape. Every field has a working default:
 * a deployment that mounts this plugin reaches the gateway's DeepSeek model
 * without editing any model, endpoint, or protocol field.
 */
export interface Config {
  /** Credential reference resolved per request through the harness credentials seam. */
  apiKeyEnv?: string
  /**
   * Inference root. Omission uses the endpoint the OPL account binding
   * records for its own client, which is the endpoint that key was issued
   * against; the canonical gateway root is only the fallback for a deployment
   * with no binding to read.
   */
  baseURL?: string
  /** Advisory catalog shown by discovery consumers; defaults to DeepSeek-V4.1-Flash. */
  models?: DeepSeekCatalogModel[]
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort; omitted uses the provider default. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap; a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
  /** Auxiliary web search; omitted mounts the route's own search provider with these defaults. */
  search?: SearchConfig
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  imagePixelBudget: z.union([z.number().step(1).min(1), 'low']),
  imageMaxBytes: z.number().step(1).min(1),
  systemPromptUpdate: z.const('in-history'),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_REF),
  baseURL: z.string(),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
  search: z.object({
    model: z.string().default(OPL_GATEWAY_SEARCH_DEFAULT_MODEL),
    apiKeyEnv: z.string(),
    baseURL: z.string(),
    maxOutputTokens: z.number().step(1).min(1).default(OPL_GATEWAY_SEARCH_DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: z.number().step(1).min(1).default(OPL_GATEWAY_SEARCH_DEFAULT_TIMEOUT_MS),
    maxSearches: z.number().step(1).min(1).default(OPL_GATEWAY_SEARCH_DEFAULT_MAX_SEARCHES),
  }),
})

/**
 * Translate this plugin's settings section into the DeepSeek adapter config
 * that carries the same wire protocol.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param fallbackBaseURL - endpoint used when neither the settings section nor
 *   the OPL account binding names one.
 * @returns adapter configuration with every unset field left to its own default.
 */
export function toAdapterConfig(
  config: Config,
  fallbackBaseURL: string = OPL_GATEWAY_INFERENCE_BASE_URL,
): Options {
  const apiKeyEnv = config.apiKeyEnv?.trim()
  const baseURL = config.baseURL?.trim()
  return {
    ...apiKeyEnv === undefined || apiKeyEnv === '' ? {} : { apiKeyEnv },
    baseURL: baseURL === undefined || baseURL === '' ? fallbackBaseURL : baseURL,
    ...config.models === undefined || config.models.length === 0 ? {} : { models: config.models },
    ...config.thinking === undefined ? {} : { thinking: config.thinking },
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    ...config.defaultContextWindow === undefined ? {} : { defaultContextWindow: config.defaultContextWindow },
    ...config.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: config.streamIdleTimeoutMs },
    ...config.retryPolicy === undefined ? {} : { retryPolicy: config.retryPolicy },
  }
}
