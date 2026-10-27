# Model connectors

Status: proposal for Tom to review. Nothing here changes a contract yet. Where a change is needed it is listed under
[proposed changes](#proposed-changes); it would land with M1-BE1 (#9, session runtime) and M1-BE5 (#13, vault and
egress proxy v1).

How Harbour's runtime reaches a model: LiteLLM, Vercel AI Gateway, OpenRouter, Anthropic, OpenAI and CLIProxyAPI
(CPA).

## Recommendation

**A connector is configuration, not code: a pi-ai `Provider` built from one wire API (or a few), a base URL, a vault
item and a catalogue source. Every model call leaves through the vault's egress proxy, which injects the key.**

1. **No bespoke wire adapters.** All six providers speak protocols pi-ai already implements: `anthropic-messages`,
   `openai-completions` and `openai-responses`. Anthropic, OpenAI, OpenRouter and Vercel AI Gateway are pi-ai built-in
   providers used as they are. LiteLLM and CPA are `createProvider` instances of the same API types. Each provider also
   gets a small Harbour preset (tens of lines, not a protocol): which headers carry attribution and session affinity,
   where reported cost comes from, and how its catalogue is refreshed.
2. **Keys live only in the vault.** The runtime resolves a placeholder (`harbour://<item>/<id>`) as the provider's API
   key. Model calls, like sandbox calls, go through the egress proxy, which swaps the placeholder on the way to the
   connector's host and audits the call. The runtime process never holds a provider key.
3. **Connectors are owned by the platform or an organisation.** A project may narrow which connectors and models it
   uses. An agent never picks a connector; `ModelChoice.route` names a route the runtime resolves.
4. **The catalogue comes from two sources.** pi-ai's generated catalogue is the baseline for metadata such as context
   window, pricing, reasoning and modalities. The gateway's own list (`/v1/models` or its equivalent) decides which
   models are available. Harbour's overrides fill gaps where the gateway reports only IDs (CPA, LiteLLM model names).
5. **v1 does no cross-provider failover in Harbour.** Each gateway fails over itself, and Pi Durable retries the same
   model. v1 records usage per call, attributed to organisation, project, agent and session, with a gateway-reported
   cost when there is one. Harbour-level fallback routes come later, switching only between whole turns.
6. **CPA is the default test connector.** It runs locally and in self-hosted CI on Sal's host, so every wire API is
   tested against a real gateway without per-token spend. Every connector must pass a conformance suite in
   `@harbour/testing`, following the pattern of the other contracts.

The main trade-off is that all model traffic, including long streams, goes through the egress proxy. One place holds
the keys and one place audits the calls, but the proxy is on the hot path and must stream. Today's stub buffers whole
responses ([below](#credentials-and-the-egress-proxy)).

## How Pi already does it

- **Provider and model shape.** In pi-ai, a `Model` has `api`, `provider`, `baseUrl`, `headers`, `input` modalities,
  `cost`, `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `promptCache` and per-API `compat`
  overrides. A `Provider` bundles models, auth (`apiKey` and/or `oauth` resolvers), optional `refreshModels` and the
  stream implementations for each API it uses, and one provider can mix APIs: OpenRouter's has both
  `anthropic-messages` and `openai-completions`.
- **Compatibility is detected from the provider ID or the base URL.** For example,
  `isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai")`. Keeping the built-in provider IDs
  means a gateway keeps its quirks (OpenRouter's reasoning format, `x-session-id` affinity, Anthropic-style
  `cache_control` for `anthropic/*` models) even if the URL changes.
- **Gateway routing is already modelled.** `compat.openRouterRouting` becomes the request's `provider` object, and
  `compat.vercelGatewayRouting` becomes `providerOptions.gateway`. Both apply only on `openai-completions`
  (see the Vercel gap below).
- **Hooks.** Every request takes `fetch`, `headers`, `sessionId`, `metadata`, `onPayload` (rewrite the body) and
  `onResponse` (read response headers). These are enough for attribution and reported cost without forking an API.
- **Cost** is computed locally from the catalogue's rates (`calculateCost`), not taken from the gateway.
- **pi-coding-agent** adds `models.json` (custom providers, `modelOverrides`, `compat`, and `apiKey` as literal,
  `$ENV` or `!command`), `registerProvider` (an extension can redirect a built-in provider's `baseUrl` and keep its
  catalogue) and virtual models (one selectable model routed to physical ones). Harbour needs none of these at
  runtime: they are CLI conveniences over the same pi-ai `Provider`. Harbour's connector record plays the part of
  `models.json`, and its route plays the part of a virtual model.
- **Pi Durable** takes `models` as a value or a function called at each use, re-reads retry settings before each
  attempt, retries retryable errors on the same model, and records usage per provider and model. `beforeRequest` and
  `afterResponse` hooks see every attempt. A function-valued `models` is the point where per-organisation connectors
  plug in.

Harbour's runtime already fits this. `createMemoryRuntime` takes a Pi `Models` collection and a
`resolveModel(choice: ModelChoice) => { provider, modelId }`, and `ModelChoice` is documented as "a named model
route, resolved by the runtime (on Harbour, a vault route to a model gateway)".

## The six providers

| | LiteLLM | Vercel AI Gateway | OpenRouter | Anthropic | OpenAI | CLIProxyAPI |
| --- | --- | --- | --- | --- | --- | --- |
| Wire APIs to use | `openai-completions`; `anthropic-messages` (`/v1/messages`) for Claude; `openai-responses` | `anthropic-messages` (pi's default), also chat and Responses at `/v1` | `openai-completions`, `anthropic-messages` (pi's built-in mixes them) | `anthropic-messages` | `openai-responses` (and `openai-completions`) | All three: `/v1/chat/completions`, `/v1/messages`, `/v1/responses` |
| pi-ai provider | `createProvider`, new ID `litellm` | built-in `vercel-ai-gateway` | built-in `openrouter` | built-in `anthropic` | built-in `openai` | `createProvider`, new ID `cliproxyapi` |
| Auth header | `Authorization: Bearer` (virtual key) | `Authorization: Bearer` or `x-api-key` | `Authorization: Bearer` | `x-api-key` | `Authorization: Bearer` | `Authorization: Bearer` (a CPA client key, not an upstream key) |
| Catalogue | `/model/info` (cost, context, custom `model_info`); `/v1/models` gives IDs only | `/v1/models`, unauthenticated, with context, pricing and reasoning options | `/api/v1/models` and `/models/user`, with context and pricing (pi refreshes from `/models/user`) | `/v1/models`, with `max_input_tokens` and capabilities | `/v1/models` (IDs only) | `/v1/models`, IDs only; CPA refreshes its own list from models.router-for.me every 3 h |
| Caching and reasoning | Passes `cache_control` and thinking through to the deployment | Passes `cache_control` through to Anthropic; `caching: 'auto'`; thinking passes through | `cache_control` for `anthropic/*`; its own `reasoning` field (pi: `thinkingFormat: "openrouter"`) | Native `cache_control` and thinking | `prompt_cache_key` and reasoning effort | Passes the client's protocol through to the subscription upstream |
| Routing and attribution | `x-litellm-tags` header, `metadata` in the body; team and organisation come from the virtual key | `providerOptions.gateway` (`order`, `only`, `sort`, `sessionId`), `x-session-id` | `provider` routing object, `models` fallbacks, `x-session-id`, `HTTP-Referer` and `X-OpenRouter-Title` | `metadata.user_id` | `prompt_cache_key`, `user` | Session affinity from pi and Claude Code session headers when `routing.session-affinity` is on |
| Reported cost | `x-litellm-response-cost` header (non-streaming), `usage.cost` on the last chunk when `include_cost_in_streaming_usage` is set | Generation lookup API by ID | `usage.cost` in every response | None (compute) | None (compute) | None; subscription traffic, so record tokens only |
| Quirks | A fallback to another provider or key cannot decrypt encrypted reasoning; mock responses don't stream `/v1/messages` or `/v1/responses` | pi applies `vercelGatewayRouting` only on `openai-completions`, but its Vercel provider uses `anthropic-messages`, so routing needs `onPayload` | Model IDs are `creator/model`; `~` aliases | Needs `anthropic-version` | Responses keeps server-side state unless `store: false` | Plain http on the host; reached through a Cloudflare Tunnel (https) in the plan |

## Connector shape

A connector is a record the runtime turns into a pi-ai `Provider`. It is not a new contract with its own stream
interface.

```ts
interface ModelConnector {
	readonly id: string; // such as "lleverage-litellm"
	readonly owner: { kind: "platform" } | { kind: "organisation"; organisationId: OrganisationId };
	/** A preset fixes the pi provider, API types, auth header and attribution: litellm, vercel-ai-gateway, openrouter,
	 *  anthropic, openai, cliproxyapi, or openai-compatible / anthropic-compatible for anything else. */
	readonly preset: ConnectorPreset;
	readonly baseUrl: string;
	/** The vault item whose placeholder the provider resolves as its key. Never a value. */
	readonly vaultItemId: string;
	readonly catalogue: { refresh: "gateway" | "static"; include?: readonly string[]; overrides?: Record<string, ModelOverride> };
	readonly compat?: Record<string, unknown>; // pi-ai compat, passed through, such as openRouterRouting
}

interface ModelRoute {
	readonly name: string; // what ModelChoice.route names, such as "default", "deep", "fast"
	readonly owner: ConnectorOwner;
	readonly connectorId: string;
	readonly modelId: string; // the gateway's own ID, such as "claude-opus-5-5" (Anthropic) or "anthropic/claude-sonnet-5" (Vercel)
	readonly thinking?: "off" | "low" | "medium" | "high";
}
```

A preset is the only provider-specific code. It maps Harbour's call context to headers: organisation, project, agent
and session go to LiteLLM as `x-litellm-tags` and to Vercel and OpenRouter as their session IDs. It also reads
reported cost from `onResponse` or the final chunk. Anything a preset can't express through `headers`, `onPayload`
and `onResponse` would be a sign the preset is wrong, not a reason to write a stream implementation.

## Credentials and the egress proxy

Recommended: **yes, model calls go through the Harbour proxy, on both targets.**

- The connector's pi `auth.apiKey.resolve` returns the vault item's placeholder. pi-ai puts it where the API expects:
  `Authorization: Bearer …` for the OpenAI APIs, `x-api-key` for `anthropic-messages`, which the spike confirmed. The
  proxy replaces the placeholder with the value for a policy whose selector matches the session's organisation and
  project, and whose `RouteScope` covers the host and path. A placeholder sent to any other host stays inert.
- On the self-hosted target the runtime gets `HTTPS_PROXY` to the vault proxy, like a container sandbox. On Cloudflare
  the runtime's `fetch` goes through the VaultDO's outbound handler. pi-ai takes a `fetch` per request, so no global
  patching is needed.
- CPA for Sal: a platform connector whose base URL is the Tunnel hostname, with a CPA client key as the vault item.
  Tom's subscriptions stay inside CPA on the host, as the plan says. Lleverage: an organisation connector with
  preset `litellm`, its base URL, and a LiteLLM virtual key per organisation (or per project, for separate budgets) as
  the vault item. Its existing team and budget setup keeps working, and Harbour adds tags.
- Gaps in the M0 stub proxy that matter for model traffic:
  1. It reads the whole upstream body (`await upstream.arrayBuffer()`) before replying, so a stream arrives all at
     once at the end. Redaction must work on a stream, holding back only the last `maxSecretLength − 1` bytes.
  2. It sets one fixed header per route. A gateway serving both Messages and OpenAI APIs needs `x-api-key` on one
     and `Authorization` on the other, so model routes should swap the placeholder wherever it appears in those two
     headers.
  3. `RouteScope` injects only over https. Local CPA on `:8317` is plain http, so local runs need the Tunnel hostname
     or an https listener.

## Scope

Connectors resolve per **platform → organisation → project**, and routes the same way, with the nearest name winning.
The platform level holds what Harbour's operator provides (Sal's CPA). The organisation level holds what a tenant
brings (Lleverage's LiteLLM). A project can add routes over its organisation's connectors and narrow the allowed
models. It cannot add a connector, because that would let a project bring its own egress host past the organisation's
ceiling. An agent profile names a route only. A session pins its resolved `(connector, modelId)` when it starts, so a
route edit doesn't change a running conversation's model halfway through. The vault's own `PolicySelector`
(organisation, project, agent, session) decides which key a call gets, so one connector can bill per project.

## Catalogue and model IDs

- **Built-in presets** start from pi-ai's generated catalogue, which holds the metadata, and refresh what is
  available: OpenRouter through pi's own `/models/user` refresh, Vercel from `/v1/models` (which also carries
  pricing), and Anthropic from `/v1/models`.
- **LiteLLM** refreshes from `/model/info`, which carries cost and context and any `model_info` Lleverage adds. Its
  model names are Lleverage's own aliases, so each model's pi metadata comes from a `catalogue.overrides` entry naming
  the canonical model it stands for.
- **CPA** lists IDs only. The preset joins them to pi-ai's catalogue by ID, and a model with no match is offered only
  if an override supplies `contextWindow` and `maxTokens`.
- **IDs are never translated across gateways.** A route names the gateway's own ID: `claude-opus-5-5` on Anthropic,
  a `creator/model` ID such as `anthropic/claude-sonnet-5` on OpenRouter and Vercel, whatever CPA lists, or an alias on
  LiteLLM. A route is moved to
  another gateway by editing it. A shared canonical key (`creator/model`) is used only to borrow metadata.

## Failover, accounting and audit

| | v1 | Later |
| --- | --- | --- |
| Failover | Gateway-native: LiteLLM `fallbacks`, OpenRouter `models`, Vercel `order` and fallbacks, CPA credential failover. Pi Durable retries the same model on retryable errors. | A route with an ordered list of `(connector, model)` pairs, switched only before a fresh turn, never in the middle of a turn: thinking signatures and prompt caches don't survive a provider change. Built on Durable's function-valued `models` and its retry-through-preparation. |
| Usage | Per call: tokens (input, output, cache read and write, reasoning), connector, model, organisation, project, agent, session. From pi's `usage`, which Durable already records. | Budgets and limits per organisation and project, enforced before a call. |
| Cost | Gateway-reported cost when there is one (LiteLLM, OpenRouter), otherwise pi's `calculateCost` from catalogue rates. Both stored, labelled with their source. CPA records tokens only. | Reconciliation against gateway spend APIs (LiteLLM spend logs, Vercel custom reporting). |
| Audit | `vault.allow` / `vault.deny` per model request (already emitted: host, route, status, ms), plus a runtime `model.call` event with the usage above. No prompt or completion text and no key, checked with `CANARY_SECRET`. | Per-organisation export. |

## Testing

- **`registerModelConnectorConformance`** in `@harbour/testing`, following the pattern of the other suites. It runs
  once per preset and wire API, and every case goes through the egress proxy:
  text stream with incremental deltas (the first delta arrives before the last byte); a tool call round trip; each
  thinking level the model supports; usage present and non-zero; abort mid-stream; 401 is not retried and 429 or 5xx
  is; the catalogue lists the route's model with `contextWindow`; the session ID reaches the gateway as the preset's
  affinity header; the placeholder, not the key, leaves the runtime; and the canary never appears in an audit event.
- **CPA is the default target** for local runs and self-hosted CI on Sal's host, covering all three wire APIs. A CPA
  client key for CI is a vault item like any other.
- **A deterministic fake gateway** in `@harbour/testing` replays recorded streams for the three APIs, for hosted CI
  and for failure cases a real gateway won't produce on demand.
- The live LiteLLM, OpenRouter, Vercel, Anthropic and OpenAI presets run the same suite when their keys are
  configured. They are skipped otherwise, and never required on pull requests.

Spike (TASK-3434, kept out of the repo): pi-ai 1.4.0's `openai-completions` ran unchanged against LiteLLM v1.97.0
(mock upstream) through a stand-in proxy that swapped a placeholder key. Text and usage came back as expected, and the
placeholder arrived in `Authorization`. `anthropic-messages` sent it in `x-api-key`. The Messages and Responses runs
could not complete because LiteLLM's mock doesn't stream those endpoints, so they need a CPA run. The cost header was
absent on the stream, as Lleverage already found with LiteLLM.

## Proposed changes

None is made by this PR.

1. `@harbour/contracts`: add `ModelConnector` and `ModelRoute` (above) with a `ModelConnectors` directory and its
   suite. `ModelChoice` stays as it is.
2. `@harbour/runtime`: build `models` per session from the resolved connectors (Durable's function form), and record
   `(connector, modelId)` on the session at start.
3. Vault proxy: streaming redaction, placeholder swap in `Authorization` and `x-api-key` for model routes, and the
   runtime's own egress through it.
4. Audit: a `model.call` event type.

## Open questions for Tom

1. **Should every model call go through the vault proxy?** Recommended, including the runtime's own calls, at the
   cost of putting the proxy on every token stream. The alternative is letting the runtime fetch the key from the
   vault in memory, which is faster but means the runtime holds raw keys.
2. **Can a project bring its own connector,** or only narrow its organisation's? Recommended: only narrow.
3. **Is no Harbour-level cross-provider failover acceptable for v1,** relying on each gateway's own failover?
4. **Lleverage's LiteLLM keys:** one virtual key per Harbour organisation, or per project for separate budgets?
