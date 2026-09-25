---
description: "OPL Gateway Settings page for the dsh web client: sign in to the gateway account, read its balance and usage, and release the key this machine holds."
kind: "package-reference"
---

# @one-person-lab/dsh-client-ui-settings-opl-gateway

English | [中文](README.zh.md)

## Summary

Provides the OPL Gateway account and search settings pages. Users sign in once, inspect usage and channel readiness, and manage search preferences. The Host owns authentication, independent DeepSeek and Codex keys, and automatic model-request failover; the page renders those facts without storing secrets.

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

`dsh-client-ui-settings-opl-gateway` contributes the OPL Gateway account page to Settings: users sign in with the account's email and password, then read the balance, today's and all-time usage, and the state of the inference key. The page is what makes the `opl-gateway` model route's credential resolve, so signing in here is that route's setup step. Facts come from the same account surface the adapter reads, and an observation past its freshness window is marked as stale rather than shown as current.

DSH requests its own API key in the Gateway **DeepSeek** group and uses the official DeepSeek adapter. An existing OPL account session can supply the sign-in state; the Codex-group inference key used by OPL App is not the DSH key. The separate **Search** page preserves the cloud or local search selection, test action, and local usage statistics.

Open Settings and choose **OPL Gateway** to sign in, refresh the account facts, or sign out of this machine.

### When to choose it

Mount it wherever the `opl-gateway` model route is mounted, so the people using that route can sign in from the app. A machine whose OPL installation already recorded a binding keeps working without the page — the adapter obtains a DSH key in the DeepSeek group — but nobody can sign in, refresh, or release the key from the harness. Deployments serving direct provider keys mount neither.

### Minimal configuration

The page takes no configuration. It is a client plugin row in the composition:

```yaml
- id: ui-settings-opl-gateway
  name: '@one-person-lab/dsh-client-ui-settings-opl-gateway'
```

The row is paired with the adapter's row; the page writes the credential reference the adapter resolves, so mounting one without the other leaves an account page whose sign-in nothing consumes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package has two halves. The host half registers nothing; the browser half contributes one Settings section (id `opl-gateway`, order 30) into the `settings.section` ledger and owns its dictionary namespace, `settings.oplGateway`.

Every action is a call on the account Remote — `oplGatewayAccount.status`, `signIn`, `refresh`, and `signOut` — and a business failure surfaces its message, with the error code kept as a support handle rather than shown as copy. The password crosses the wire once, during sign-in; what the harness stores afterwards is the refresh token, which lives in the credentials seam beside every other sign-in.

| File | Responsibility |
|---|---|
| `src/index.ts` | Host half: nothing to register node-side. |
| `src/client/index.ts` | Section registration, locale namespace, and the Remote-backed injected callbacks. |
| `src/client/OplGatewaySection.tsx` | The page: signed-out form, account facts, freshness line, and the action buttons. |
| `src/client/locales.ts` | Page copy for both languages. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [llm-opl-gateway adapter](../../llm/llm-opl-gateway/README.md) — the route whose credential this page establishes.
- [ui-settings](../ui-settings/README.md) — the Settings shell this page registers its section into.
- [ui-primitives](../ui-primitives/README.md) — the controls the page composes.
- [credentials](../../credentials/credentials/README.md) — the seam holding the refresh token after sign-in.
- [remotes](../../api/remotes/README.md) — the Remote boundary the account methods cross.

-----

<a id="model-experience"></a>
## Model Experience

### Settings and notifications

#### What the model sees

The page adds no prompt or tool to `GenerateOptions`. Account configuration selects the next model route; notifications present existing task state.

#### Token effect

The page and notifications make no additional model calls.

#### KV Cache effect

No direct cache changes. A route switch follows the selected adapter’s cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the page's reach; they are current package constraints, not a settings roadmap.

- **One account per machine** — the page signs in a single OPL account and replaces the stored session on the next sign-in; switching between accounts means signing in again.
- **The page reads facts, not configuration** — endpoints, model catalogs, and reasoning effort stay on the Models page and in the plugin config, so the account page cannot retarget a route.
- **A password is not stored** — only the refresh token survives sign-in, so an account whose stored session cannot be renewed must sign in again from this page.
- **Facts can be stale** — the page shows the last observation with its freshness line instead of blocking on the control plane, and an unreachable gateway leaves the previous observation in place.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin contributes two settings sections to the slot ledger and calls the Host account and search Remotes; the account session, the cached facts, and the slot registrations belong to the Host service and the slot ledger, so this package holds no relation two independent observations could disagree on.
