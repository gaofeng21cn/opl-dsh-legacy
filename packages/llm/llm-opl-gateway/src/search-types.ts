/**
 * Secret-free record of one auxiliary OPL Gateway search request.
 *
 * The search is a model turn on the gateway rather than a harness request, so
 * the session log carries this record to keep the model-visible auxiliary input
 * reconstructable. It never carries the credential or a header.
 * @module @one-person-lab/dsh-llm-opl-gateway/search-types
 */

/** Exact secret-free Responses request recorded immediately before one auxiliary search dispatch. */
export interface OplGatewaySearchLlmRequest {
  /** Fully resolved Responses endpoint. */
  readonly endpoint: string
  /** Exact JSON body sent to the gateway. */
  readonly body: {
    readonly model: string
    readonly input: string
    readonly tools: readonly [{ readonly type: 'web_search' }]
    readonly max_output_tokens: number
    readonly stream: true
  }
}
