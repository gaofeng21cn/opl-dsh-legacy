---
description: "OPL Gateway model route for the harness: sign in with an OPL account and reach its gateway-hosted DeepSeek model without distributing a provider key."
kind: "package-reference"
---

# @one-person-lab/dsh-llm-opl-gateway

English | [中文](README.zh.md)

## Summary

`dsh-llm-opl-gateway` serves DeepSeek models through an OPL Gateway account instead of a direct provider key. Sign in on the OPL Gateway Settings page and the route mints or reuses separate DeepSeek and Codex group keys, stores them with the refresh token in the local credential store, and resolves each key on request. The endpoint follows the account binding OPL already recorded, so a machine keeps working across restarts. Deployments that hold their own provider key mount the direct adapter instead.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in a composition that already loads `dsh-llm`; the route registers under the provider id `opl-gateway` and appears in the model picker under the name **OPL Gateway**.

### When to choose it

Choose it when the people using the harness hold OPL accounts and the deployment must not hand out provider keys: the account page signs in, and the adapter reuses the key OPL already provisioned for its own client. Avoid it where the deployment holds its own provider key (mount `dsh-llm-deepseek` instead) or where nobody will sign in — without a key or an OPL binding every request fails and names the credential reference it could not resolve.

### Minimal configuration

```yaml
- id: llm-opl-gateway
  name: '@one-person-lab/dsh-llm-opl-gateway'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `OPL_GATEWAY_DEEPSEEK_API_KEY` | Credential reference resolved per request; the account page writes a key issued in the Gateway `DeepSeek` group. |
| `baseURL` | The account binding's endpoint, else `https://gateway.medopl.com/v1` | Inference root; the plugin prefers what the binding recorded over the built-in root. |
| `models` | One entry: `deepseek-flash`, shown as `DeepSeek-V4.1-Flash` | Advisory catalog the picker lists. |
| `thinking` | Provider default | `disabled` limits every conversation request to `off`. |
| `reasoningEffort` | Provider default | Default effort for this route. |
| `maxTokens` | DeepSeek adapter default | Default output cap; a model's own cap and explicit request values win. |
| `defaultContextWindow` | DeepSeek adapter default | Context capacity used when the selected model has no exact value. |
| `streamIdleTimeoutMs` | DeepSeek adapter default | Maximum provider idle time while one stream read is outstanding. |
| `retryPolicy` | Normal mode, five retries | Retry policy for model requests. |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc. The `llm-opl-gateway:` settings section overrides this row without a restart, and the Models page writes that section.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Two inference channels

The default `opl-gateway` route uses the official DeepSeek Messages adapter with a DeepSeek-group key. The independent `opl-gateway-openai` route uses the official `dsh-llm-pi-ai` Responses adapter with a Codex-group key. Sign-in and stored-session refresh provision both keys under separate machine-specific names; existing Codex/AGI keys from other applications are not modified. An unavailable Codex group leaves the default channel usable and reports compatibility provisioning as unavailable.

The default route retries once through OpenAI on authentication, quota, rate-limit, transport, timeout, server, or missing-endpoint failures before any stream chunk reaches DSH. Cancellation, invalid requests, context overflow, and failures after output starts do not switch channels. Each new request starts with Messages. Both routes retain the DSH agent loop, tool execution, and durable message history. System-prompt updates use the shared head-position behavior supported by both adapters; protocol-specific replay is reused only by its owning adapter.

| File | Responsibility |
|---|---|
| `src/config.ts` | Config schema, the `OPL_GATEWAY_DEEPSEEK_API_KEY` default, the advertised model, and translation into adapter options. |
| `src/index.ts` | Adapter subclass, provider identity, key resolution order, settings-section install, and key adoption. |
| `src/adoption.ts` | Fills an unset or previously adopted credential reference from the OPL binding, recording a key fingerprint instead of the key. |
| `src/opl-credentials.ts` | Read-only access to the OPL state directory: the recorded binding, the bound bearer token, and the account facts OPL observed. |
| `src/account-service.ts` | The `oplGatewayAccount` Remote: status, sign-in, refresh, and sign-out, plus the key OPL needs for this machine. |
| `src/gateway-control.ts` | The gateway control API client: login, session refresh, profile, usage, key groups, and key creation or status changes. |
| `src/session-store.ts` | The refresh token as a credential record, and the cached account facts in the Harness home. |
| `src/types.ts` | Wire-safe account vocabulary exported on the package's `remote` subpath. |

### Where the credential comes from

Each request resolves the key in one order: the credentials seam's value for `apiKeyEnv`, then an OPL binding verified to belong to the DeepSeek group, then a failure naming the reference. Adoption covers the configuration surfaces rather than the request path — it fills a reference that is unset or still holds a value this plugin adopted earlier, so a key typed on the Models page is never overwritten. Both the request path and adoption read the same binding, and neither writes OPL state.

### The control plane and the inference plane

The gateway serves account management at `/api/v1` and model traffic at `/v1`. Sign-in trades the account password for a session, keeps the refresh token as a credential record, and creates or reuses this machine's named key in each of the DeepSeek and Codex groups; sign-out disables the keys this plugin manages and leaves a key the operator typed alone. Account facts are cached in `opl-gateway-account.json` with a freshness window matching the gateway's own, so a restart shows the account immediately and the page reports stale facts as stale.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [dsh-llm service](../llm/README.md) — the provider-neutral service this route registers on.
- [llm-deepseek adapter](../llm-deepseek/README.md) — the adapter whose request assembly this route subclasses.
- [OPL Gateway Settings page](../../client/ui-settings-opl-gateway/README.md) — the browser half that signs the account in.
- [credentials](../../credentials/credentials/README.md) — the seam that stores the refresh token and resolves the reference per request.
- [settings](../../settings/settings/README.md) — the document a deployment or the Models page writes the section into.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the streaming contract the subclassed adapter implements.

-----

<a id="model-experience"></a>
## Model Experience

### OPL Gateway request

#### What the model sees

The selected gateway model receives the harness-assembled request unchanged: system prompt, message history, tool schemas, and call config such as `maxTokens` and `reasoningEffort`. This route contributes no prompt prose of its own, and provider-specific request-extension fields stay outside model input. The dual-channel route omits `systemPromptUpdate: in-history`, so both channels use the system prompt at the history head.

#### Token effect

Provider tokenization governs exact text and image input, and the totals the gateway reports are authoritative. `maxTokens` and the logged reasoning effort bound generation, while `retryPolicy` re-sends a failed request rather than changing its content. Switching this route's endpoint or `models` entry selects a different model, so input tokens are counted under that model's own accounting.

#### KV Cache effect

An unchanged assembled prefix stays eligible for the gateway provider's cache reuse, which reported usage shows. The package-owned changes that can invalidate reuse from the first affected token are the endpoint, the selected model, and the advertised catalog entry; a system-prompt change updates the history head. Provider cache availability and eviction remain outside this package's contract.

### OPL Gateway response

#### What the model sees

Reasoning, text, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble; this route adds no model-authored content.

#### Token effect

Generated tokens follow the request's logged `maxTokens` and reasoning effort, and only loop-retained blocks affect later input.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider, the endpoint, or the model selects a different cache domain.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the route stops; they are current package constraints, not a gateway roadmap.

- **One route serves one account** — the plugin holds the single OPL session this machine signed in to, so a deployment needing several accounts mounts several rows under distinct provider ids and credential references.
- **Chat catalog and search discovery differ** — the chat picker uses configured entries; search settings can query the account model list. Discovery does not establish native search capability.
- **Sign-out releases only the key this plugin minted** — a key typed on the Models page stays active because the account page cannot prove ownership of it.
- **Account reads depend on the control plane** — inference keeps working while `/api/v1` is unreachable, but the page cannot refresh facts and reports the cached observation as stale.
- **Search capabilities depend on the route** — OPL search reuses the signed-in account, but only a model returning actual search sources passes its capability test. The upstream DeepSeek provider still owns its separate endpoint and credentials.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each mutable relation this package keeps has one writer — the account service writes the refresh-token credential, the cached account facts, and the adopted-key fingerprint — so no second, independently maintained observation exists to compare against.
