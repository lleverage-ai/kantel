# Model connectors

Status: proposal for Tom to review, updated with his [decisions of 27 Oct 2026](#decisions). Nothing here changes a
contract yet. Where a change is needed it is listed under [proposed changes](#proposed-changes); it would land with
M1-BE1 (#9, session runtime), M1-BE5 (#13, vault) and the M1 deployments (#17, #18).

How Harbour's runtime reaches a model: LiteLLM, Vercel AI Gateway, OpenRouter, Anthropic, OpenAI and CLIProxyAPI
(CPA).

## Recommendation

**The runtime never calls a provider. It calls Harbour's internal model gateway, a platform service, over pi-ai's own
`pi-messages` protocol. The gateway decides which connector serves the call, attaches that connector's key and streams
pi events back. A connector is configuration, not code: a pi-ai `Provider` built from a wire API, a base URL, a vault
item and a catalogue source.**

1. **The runtime speaks one protocol to one place.** Its only model provider is `harbour`, using pi-ai's built-in
   `pi-messages` API (POST `{ model, context, options }` to `<baseUrl>/messages`, an SSE stream of pi events back). The
   model ID it sends is the route name, so `ModelChoice` stays as it is. The runtime holds a short-lived Harbour session
   token, never a provider key.
2. **The model gateway is its own platform service**, not a route on the vault proxy: `apps/model-gateway` over a
   `packages/models` library. It resolves route → connector → upstream model for the session's organisation and
   project, gets the connector's credential from the vault, and calls the upstream with pi-ai. All provider quirks
   (compat flags, thinking formats, caching, attribution headers) live here.
3. **No bespoke wire adapters.** All six providers speak protocols pi-ai already implements: `anthropic-messages`,
   `openai-completions` and `openai-responses`. Each gets a small preset in the gateway: which headers carry attribution
   and session affinity, where reported cost comes from, and how its catalogue is refreshed.
4. **Connectors belong to the platform or an organisation. Projects only narrow them.** Agents name a route, never a
   connector.
5. **The catalogue comes from two sources.** pi-ai's generated catalogue gives the metadata; the gateway's own list
   (`/v1/models` or equivalent) decides what is available. The runtime sees only its session's routes.
6. **v1 has no Harbour-level cross-provider failover.** Each gateway fails over itself, and Pi Durable retries the same
   route. The model gateway is the one place usage, cost and audit are recorded.
7. **CPA is the default test connector**, locally and in self-hosted CI, and every connector passes a conformance suite
   that runs through the model gateway.

The main trade-off is that the model gateway is a new service on the path of every token, and a second process (after
the vault) that sees decrypted credentials, though only connector credentials. In return the runtime holds no key at
all, routing and provider quirks sit in one place, and the vault proxy stays a small default-deny proxy for untrusted
sandboxes.

## Architecture

```
session runtime (Pi Durable)                model gateway (platform)                         upstream
  provider "harbour", api pi-messages         auth session token → org, project, agent, session
  model id = ModelChoice.route    ──POST──▶   resolve route → (connector, model), pin per session
  bearer = Harbour session token  ◀──SSE───   key from vault (by connector) → pi-ai stream  ──▶ LiteLLM, Vercel,
                                              redact, record usage, cost, model.call           OpenRouter, Anthropic,
                                                                                               OpenAI, CPA
```

### Where it lives: a platform service

Picked over a route on the existing `apps/vault-proxy`, for four reasons:

- **Different trust boundary.** The vault proxy faces untrusted sandbox code: default-deny, TLS interception, one
  injected header per route. The model gateway faces only the trusted runtime and serves a known API.
- **Different work.** The gateway needs pi-ai with every provider, catalogue refresh, the connector directory and usage
  accounting. None of that belongs in the egress proxy.
- **Hot path.** Model streams are long and constant. Keeping them off the sandbox egress process means a model surge
  can't stall sandbox traffic and each scales on its own.
- **It removes the streaming blocker.** The M0 stub proxy reads the whole upstream body before replying
  (`redactBytes(Buffer.from(await upstream.arrayBuffer()))`), so a model stream through it would arrive only at the end.
  Model traffic no longer goes through it. Streaming in the vault proxy is still worth doing for sandbox traffic, but it
  is M1-BE5's business, not a precondition for models.

Deployment:

- **Self-hosted:** its own Deployment beside the session hosts. A NetworkPolicy admits only session hosts; sandboxes
  can't reach it, because the vault proxy has no route to it.
- **Cloudflare:** a Worker with no public route, called from SessionDO through a service binding. pi-ai's
  `pi-messages` client takes a `fetch` per request, so the binding's `fetch` is passed in directly. The Tunnel or
  Workers VPC service to CPA that #17 already plans is bound to this Worker.

### Wire protocol: `pi-messages`

pi-ai already ships the client side: "the request is a single POST of `{ model, context, options }` to
`<baseUrl>/messages`, the response is an SSE stream of serialized assistant-message events plus a terminal
`done`/`error` event". It is the protocol pi's Radius gateway speaks, and Radius publishes its catalogue at
`GET /v1/config` as `{ baseUrl, models }`. Harbour's gateway implements the same two endpoints, so the runtime uses
pi-ai unchanged.

- The client sends `model: model.id` (a string), `context`, and `temperature`, `maxTokens`, `reasoning`,
  `cacheRetention`, `sessionId` and `toolChoice`. It never sends a base URL or provider, so the runtime can't steer the
  call anywhere. The gateway ignores client headers for the upstream request.
- The client takes `usage` from the terminal event as it is, cost included. The gateway fills in `usage.cost`
  (reported or computed), so Durable's usage records carry the real figure.
- The client passes the upstream error message through as `errorMessage`, and Durable decides retries by matching it
  (`isRetryableAssistantError`: "429", "overloaded", "rate limit" and so on). The gateway therefore forwards upstream
  error text verbatim, after redaction, and makes one upstream attempt per request. Durable owns retries.
- Rejected: pointing pi-ai's `openai-completions` or `anthropic-messages` at an internal pass-through URL. The runtime
  would have to know each connector's wire API and compat flags (which pi detects from the provider ID or base URL, both
  of which would then be Harbour's), and a route moved to a gateway with a different API would need translation.
  `pi-messages` hides all of that.

`ModelChoice` stays unchanged. `resolveModel(choice)` returns `{ provider: "harbour", modelId: choice.route }`, and
`thinking` goes as pi's `reasoning` option, which the gateway maps to the upstream model's thinking levels.
`ModelChoice.modelId`, if set, must be a model the route's connector allows the project, and is sent as
`<route>:<modelId>`.

### Resolution and the key

- **Who is calling.** The bearer is a short-lived session token minted by the session runtime from its directory, with
  organisation, project, agent and session as claims, signed with a key only platform services hold. The gateway takes
  scope from the token, never from the request body. It is not a provider key and is useless outside the internal
  network.
- **Which connector.** Routes resolve platform → organisation → project, nearest name winning. The project's narrowing
  list then filters the result (allowed connectors and models). The first call of a session pins `(connector, modelId)`
  for each route it uses, so editing a route doesn't change a running conversation's model. Thinking signatures and
  prompt caches don't survive a provider change.
- **The key.** Each connector names a vault item. The gateway asks the vault for it by connector ID through a narrow
  internal call. The vault checks that the item belongs to the connector's owner and that the connector's base URL is
  one of the item's `hosts`, then records the use. The gateway keeps the value in memory for a few minutes at most and
  drops it when the item rotates. The key goes on the upstream request exactly where that wire API expects it:
  `Authorization: Bearer` for the OpenAI APIs, `x-api-key` for `anthropic-messages`.

### Redaction

The provider key is never in anything the runtime sends or receives, by construction. What remains is an upstream
echoing the key back, typically in an error body. The gateway runs the vault's `Redactor` over error messages and over
text, thinking and tool-call deltas, holding back the last `maxSecretLength − 1` characters of each content block and
flushing at the block's end. That is streaming redaction at event level, which is cheaper than the byte-level version
the proxy would have needed.

## Spike

Two spikes, both kept out of the repo (TASK-3434):

1. pi-ai 1.4.0's `openai-completions` ran unchanged against LiteLLM v1.97.0 (mock upstream); `anthropic-messages` sent
   the key in `x-api-key`. The Messages and Responses streams couldn't be checked because LiteLLM's mock doesn't stream
   them. That still needs a CPA run.
2. pi-ai 1.4.0's own `pi-messages` client, unchanged, against a toy gateway built on pi-ai (about 60 lines, a faux
   upstream). Thinking, text and a tool call streamed incrementally (first delta after 35 ms of 145 ms). The gateway saw
   route `default` resolve to `connector-cpa/claude-x` with `reasoning: "high"` and the session ID. An upstream
   `429 Too Many Requests` reached the runtime with `isRetryableAssistantError` true, and the upstream key appeared in
   nothing the runtime sent.

## How Pi already does it

- **Provider and model shape.** In pi-ai, a `Model` has `api`, `provider`, `baseUrl`, `headers`, `input` modalities,
  `cost`, `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `promptCache` and per-API `compat`
  overrides. A `Provider` bundles models, auth (`apiKey` and/or `oauth`), optional `refreshModels` and the stream
  implementations for each API it uses. One provider can mix APIs: OpenRouter's has both `anthropic-messages` and
  `openai-completions`.
- **Compatibility is detected from the provider ID or the base URL**, for example
  `isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai")`. The gateway keeps the built-in
  provider IDs, so a gateway keeps its quirks: OpenRouter's reasoning format, `x-session-id` affinity, and
  Anthropic-style `cache_control` for `anthropic/*` models.
- **Gateway routing is already modelled.** `compat.openRouterRouting` becomes the request's `provider` object, and
  `compat.vercelGatewayRouting` becomes `providerOptions.gateway`. Both apply only on `openai-completions` (see the
  Vercel gap below).
- **Hooks.** Every request takes `fetch`, `headers`, `sessionId`, `metadata`, `onPayload` (rewrite the body) and
  `onResponse` (read response headers). These are enough for attribution and reported cost without forking an API.
- **Server-side routing is already a pi pattern.** `pi-messages` with `radiusProvider` (a gateway that owns auth and
  the catalogue), and pi-agent-core's `streamProxy` "for apps that route LLM calls through a server. The server manages
  auth and proxies requests to LLM providers."
- **Cost** is computed locally from catalogue rates (`calculateCost`), not taken from the gateway.
- **pi-coding-agent** adds `models.json`, `registerProvider` and virtual models. They are CLI conveniences over the same
  pi-ai `Provider`. Harbour's connector record plays the part of `models.json`, and its route plays the part of a
  virtual model.
- **Pi Durable** takes `models` as a value or a function called at each use, retries retryable errors on the same model
  and records usage per provider and model. With the gateway, the runtime's `models` is just the `harbour` provider,
  refreshed from `/v1/config` for the session.

## The six providers

The gateway, not the runtime, builds these providers and attaches their keys.

| | LiteLLM | Vercel AI Gateway | OpenRouter | Anthropic | OpenAI | CLIProxyAPI |
| --- | --- | --- | --- | --- | --- | --- |
| Wire APIs to use | `openai-completions`; `anthropic-messages` (`/v1/messages`) for Claude; `openai-responses` | `anthropic-messages` (pi's default), also chat and Responses at `/v1` | `openai-completions`, `anthropic-messages` (pi's built-in mixes them) | `anthropic-messages` | `openai-responses` (and `openai-completions`) | All three: `/v1/chat/completions`, `/v1/messages`, `/v1/responses` |
| pi-ai provider in the gateway | `createProvider`, new ID `litellm` | built-in `vercel-ai-gateway` | built-in `openrouter` | built-in `anthropic` | built-in `openai` | `createProvider`, new ID `cliproxyapi` |
| Key the gateway attaches | `Authorization: Bearer` (one virtual key per organisation) | `Authorization: Bearer` or `x-api-key` | `Authorization: Bearer` | `x-api-key` | `Authorization: Bearer` | `Authorization: Bearer` (a CPA client key, not an upstream key) |
| Catalogue | `/model/info` (cost, context, custom `model_info`); `/v1/models` gives IDs only | `/v1/models`, unauthenticated, with context, pricing and reasoning options | `/api/v1/models` and `/models/user`, with context and pricing (pi refreshes from `/models/user`) | `/v1/models`, with `max_input_tokens` and capabilities | `/v1/models` (IDs only) | `/v1/models`, IDs only; CPA refreshes its own list from models.router-for.me every 3 h |
| Caching and reasoning | Passes `cache_control` and thinking through to the deployment | Passes `cache_control` through to Anthropic; `caching: 'auto'`; thinking passes through | `cache_control` for `anthropic/*`; its own `reasoning` field (pi: `thinkingFormat: "openrouter"`) | Native `cache_control` and thinking | `prompt_cache_key` and reasoning effort | Passes the client's protocol through to the subscription upstream |
| Routing and attribution | `x-litellm-tags` header, `metadata` in the body; team and organisation come from the virtual key | `providerOptions.gateway` (`order`, `only`, `sort`, `sessionId`), `x-session-id` | `provider` routing object, `models` fallbacks, `x-session-id`, `HTTP-Referer` and `X-OpenRouter-Title` | `metadata.user_id` | `prompt_cache_key`, `user` | Session affinity from pi and Claude Code session headers when `routing.session-affinity` is on |
| Reported cost | `x-litellm-response-cost` header (non-streaming), `usage.cost` on the last chunk when `include_cost_in_streaming_usage` is set | Generation lookup API by ID | `usage.cost` in every response | None (compute) | None (compute) | None; subscription traffic, so record tokens only |
| Quirks | A fallback to another provider or key cannot decrypt encrypted reasoning; mock responses don't stream `/v1/messages` or `/v1/responses` | pi applies `vercelGatewayRouting` only on `openai-completions`, but its Vercel provider uses `anthropic-messages`, so routing needs `onPayload` | Model IDs are `creator/model`; `~` aliases | Needs `anthropic-version` | Responses keeps server-side state unless `store: false` | Plain http on Sal's host (tailnet); the gateway reaches it directly when self-hosted there, or through the Tunnel or Workers VPC service on Cloudflare |

## Connector shape

A connector is a record the gateway turns into a pi-ai `Provider`. It is not a new contract with its own stream
interface.

```ts
interface ModelConnector {
	readonly id: string; // such as "lleverage-litellm"
	readonly owner: { kind: "platform" } | { kind: "organisation"; organisationId: OrganisationId };
	/** A preset fixes the pi provider, API types, key header and attribution: litellm, vercel-ai-gateway, openrouter,
	 *  anthropic, openai, cliproxyapi, or openai-compatible / anthropic-compatible for anything else. */
	readonly preset: ConnectorPreset;
	readonly baseUrl: string;
	/** The vault item the gateway reads for this connector. Never a value. */
	readonly vaultItemId: string;
	readonly catalogue: { refresh: "gateway" | "static"; include?: readonly string[]; overrides?: Record<string, ModelOverride> };
	readonly compat?: Record<string, unknown>; // pi-ai compat, passed through, such as openRouterRouting
}

interface ModelRoute {
	readonly name: string; // what ModelChoice.route names, such as "default", "deep", "fast"
	readonly owner: { kind: "platform" } | { kind: "organisation"; organisationId: OrganisationId } | { kind: "project"; projectId: ProjectId };
	readonly connectorId: string;
	readonly modelId: string; // the gateway's own ID, such as "claude-opus-5-5" (Anthropic) or "anthropic/claude-sonnet-5" (Vercel)
	readonly thinking?: "off" | "low" | "medium" | "high";
}

/** A project's narrowing of its organisation's connectors. It can't add a connector. */
interface ProjectModelPolicy {
	readonly projectId: ProjectId;
	readonly connectors?: readonly string[]; // allowed connector IDs; absent means all of the organisation's
	readonly models?: readonly string[]; // allowed model IDs on those connectors
}
```

A project can own a route, but only over a connector its organisation or the platform owns. A preset is the only
provider-specific code. It maps the call's scope to headers (organisation, project, agent and session go to LiteLLM as
`x-litellm-tags`, and to Vercel and OpenRouter as their session IDs) and reads reported cost from `onResponse` or the
final chunk. Anything a preset can't express through `headers`, `onPayload` and `onResponse` is a sign the preset is
wrong, not a reason to write a stream implementation.

## Scope

- **Platform** connectors are what Harbour's operator provides. Sal uses CPA as a platform connector: base URL on Sal's
  host (tailnet when self-hosted there, the Tunnel on Cloudflare), a CPA client key as the vault item, and routes such
  as `default` and `deep`. Tom's subscriptions stay inside CPA on the host.
- **Organisation** connectors are what a tenant brings. Lleverage adds one connector with preset `litellm`, the base URL
  of its LiteLLM gateway (taken from Lleverage's own configuration when the organisation is set up), and one LiteLLM
  virtual key for the organisation as the vault item. Its team and budget setup in LiteLLM keeps working. Harbour adds
  `x-litellm-tags` and `metadata` with project, agent and session, so spend per project is visible in LiteLLM without a
  key per project.
- **Projects** narrow: an allow-list of connectors and models, plus routes over those. They can't bring a connector,
  so a project can't add an egress host past its organisation.
- **Agents** name a route through `ModelChoice.route`. They never see a connector, a URL or a key.

## Catalogue and model IDs

- **What the runtime sees.** `GET /v1/config` returns the session's routes as pi models (`id` is the route name, with
  `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `input` and `cost` from the pinned upstream model).
  Durable needs these for compaction and thinking levels.
- **What the gateway knows.** Built-in presets start from pi-ai's generated catalogue and refresh what is available:
  OpenRouter through pi's own `/models/user` refresh, Vercel from `/v1/models` (which also carries pricing), and
  Anthropic from `/v1/models`. LiteLLM refreshes from `/model/info`, and because its model names are Lleverage's
  aliases, each needs a `catalogue.overrides` entry naming the canonical model it stands for. CPA lists IDs only; the
  preset joins them to pi-ai's catalogue by ID, and a model with no match is offered only if an override supplies
  `contextWindow` and `maxTokens`.
- **IDs are never translated across gateways.** A route names the gateway's own ID: `claude-opus-5-5` on Anthropic, a
  `creator/model` ID on OpenRouter and Vercel, whatever CPA lists, an alias on LiteLLM. A route moves to another gateway
  by editing it. A shared canonical key (`creator/model`) is used only to borrow metadata.

## Image generation

Image generation is its own gateway operation, `images`, beside `messages`. It is decoupled from the session's chat
model: a session can chat with Claude over CLIProxyAPI and make images with any connector's image model.

- **What a model gives back.** Each gateway model carries `output: ("text" | "image")[]` beside `input`. In order:
  the connector's override (`catalogue.overrides[id].output`); the upstream's listing (OpenRouter's
  `architecture.output_modalities`, LiteLLM's `model_info.mode: "image_generation"` or
  `supported_output_modalities`, Vercel's `type: "image"` for image models or the `image-generation` tag on a language
  model); pi's image catalogue; the model's name on presets whose catalogue lists IDs only (OpenAI, CLIProxyAPI and the
  compatible presets: `gpt-image-*`, `dall-e-*` and `imagen*` make images only, another `*-image*` model text and
  images); else text. Anthropic and Anthropic-compatible connectors have no image API, so their models give text
  whatever an override says. An override with `image` in `output` offers its model even when the upstream's listing
  leaves it out (CLIProxyAPI serves `gpt-image-*` without listing it). An image-only model is refused by `messages`.
- **Image APIs.** A preset declares `imageApis`, the first its default, and a model's override may pick another with
  `imageApi`; a preset may give image-only models another default (`imageOnlyApi`).
  - `openai-images`: `POST <API root>/images/generations` with a JSON body, and `POST <API root>/images/edits` as
    multipart form data when the call sends reference images (OpenAI, LiteLLM, CLIProxyAPI, the compatible presets,
    and Vercel's image-only models such as `openai/gpt-image-2` and Flux, which Vercel documents on the Images API).
    OpenRouter has a dedicated Images API too (`POST /api/v1/images`, with `n`, `aspect_ratio`, `size` and
    `input_references`), not used yet.
  - `chat-modalities` (OpenRouter, and Vercel's language models with the `image-generation` tag): one non-streaming
    `POST <API root>/chat/completions` with `modalities: ["image", "text"]` (`["image"]` for an image-only model). The
    prompt is the user message; reference images follow it as `image_url` parts (data URLs). Images come back in
    `choices[].message.images[].image_url.url` as base64 data URLs (an https URL is fetched once, without the key),
    and `message.content` becomes the result's `text`. Neither upstream takes `n` on chat completions, so `count` is
    not sent: one request, and the call answers with the images the model made (usually one). `quality` is not sent.
    On OpenRouter the shape goes as `image_config.aspect_ratio` (square 1:1, landscape 3:2, portrait 2:3, matching
    gpt-image's sizes), and an exact `size` as the ratio it reduces to, refused as `invalid` unless it is one
    OpenRouter lists. Vercel documents only `modalities` on chat completions, so it is sent no shape and an exact
    size is refused. The connector's routing compat goes as pi sends it on chat (`provider`,
    `providerOptions.gateway`), then the preset's `onPayload`. A 200 without an image (the model only wrote text, or
    OpenRouter's in-body `error`) fails the call as `unavailable`, recorded with the tokens and cost it was billed.
- **The call.** `POST /images` on the gateway's HTTP API takes `{ model, prompt, count?, aspect?, size?, quality?,
  images? }` and answers `{ images: [{ mimeType, data, revisedPrompt? }], usage, route, modelId }`. The route resolves
  and pins as for `messages`; the key goes in the preset's header with its attribution headers, and LiteLLM's metadata
  and OpenAI's `user` go in a generation's body. One upstream attempt; a 400 is `invalid`, a 429 `exhausted`, anything
  else `unavailable`, with the upstream's text redacted. `aspect` becomes the size each model family takes
  (`gpt-image-*`: 1024x1024, 1536x1024, 1024x1536; DALL-E 3: 1792 sides; others only square).
- **Accounting.** One `ModelCallRecord` and one `model.call` event per call, with `operation: "images"` and
  `usage.images`, the number of images made. Cost: the upstream's report where the preset reports one (`usage.cost`, or
  LiteLLM's `x-litellm-response-cost`); else tokens at the model's rates when the upstream counted any (`gpt-image-*`);
  else the per-image rate (`rates.image`: Vercel's `pricing.image`, LiteLLM's `output_cost_per_image`) times the
  images; `$0` on a `cost: "none"` preset (CLIProxyAPI). Vercel's chat completions answer `usage.cost` too, though
  its documented schema leaves it out, so its image calls take it when present (`imageCost: "reported"`) and are
  computed otherwise. Neither record holds the prompt or an image.
- **The console.** `listConnectorModels` lists each connector's models with `input`, `output` and `imageApi` for the
  connector page; `testImage` makes one small low-quality image, recorded under agent `console` and route
  `connector-test`.
- **Not in v1.** OpenAI's Responses `image_generation` tool, OpenRouter's own `/api/v1/images` and streaming partial
  images.

## Failover, accounting and audit

| | v1 | Later |
| --- | --- | --- |
| Failover | None in Harbour (decided). Gateway-native only: LiteLLM `fallbacks`, OpenRouter `models`, Vercel `order` and fallbacks, CPA credential failover. Durable retries the same route on retryable errors; the model gateway makes one upstream attempt per request. | A route with an ordered list of `(connector, model)` pairs, switched in the gateway only before a fresh turn, never in the middle of one. |
| Usage | Recorded by the model gateway per call: tokens (input, output, cache read and write, reasoning), connector, upstream model, route, organisation, project, agent, session. Durable keeps its own per-route record from the same `usage`. | Budgets and limits per organisation and project, enforced in the gateway before a call. |
| Cost | Gateway-reported cost when there is one (LiteLLM, OpenRouter), otherwise pi's `calculateCost` from catalogue rates, stored with its source and returned in `usage.cost`. CPA records tokens only. | Reconciliation against gateway spend APIs (LiteLLM spend logs, Vercel custom reporting). |
| Audit | A `model.call` event from the gateway with the usage above, status and duration. A vault use record when the gateway reads a connector credential. No prompt or completion text and no key, checked with `CANARY_SECRET`. | Per-organisation export. |

## Testing

- **`registerModelGatewayConformance`** in `@harbour/testing`, following the pattern of the other suites, drives the
  gateway with pi-ai's own `pi-messages` client: incremental deltas (the first arrives before the last byte); text,
  thinking and a tool call round trip; usage present with `cost`; upstream 429 and 5xx text reaching the runtime so
  `isRetryableAssistantError` is true, and 401 so it is false; a context-overflow error passed through unchanged; abort
  from the client cancelling the upstream request; `/v1/config` listing only the session's routes; a session token from
  organisation A refused on organisation B's route and on a project-narrowed model; the route pinned across a route
  edit; the upstream key absent from every event and the canary from every audit event.
- **`registerModelConnectorConformance`** runs once per preset and wire API, through the gateway: each thinking level
  the model supports, prompt caching where the provider supports it, the session ID reaching the upstream as the
  preset's affinity header, attribution headers present, and the catalogue listing the route's model with
  `contextWindow`.
- **CPA is the default target** for local runs and self-hosted CI on Sal's host, covering all three wire APIs. A CPA
  client key for CI is a vault item like any other.
- **A deterministic fake upstream** in `@harbour/testing` replays recorded streams for the three APIs, for hosted CI and
  for failures a real gateway won't produce on demand.
- The live LiteLLM, OpenRouter, Vercel, Anthropic and OpenAI presets run the connector suite when their keys are
  configured. They are skipped otherwise, and never required on pull requests.

## Proposed changes

None is made by this PR.

1. `@harbour/contracts`: add `ModelConnector`, `ModelRoute` and `ProjectModelPolicy` (above), a `ModelConnectors`
   directory, and a `ModelGateway` interface (`config(session)`, `messages(session, request)`) with both suites.
   `ModelChoice` keeps its shape; only its doc comment changes, from "on Harbour, a vault route to a model gateway" to
   "resolved by the platform's model gateway".
2. `@harbour/runtime`: one `harbour` provider (`pi-messages`, refreshed from `/v1/config`), a session token minted per
   session, and `resolveModel` returning `{ provider: "harbour", modelId: choice.route }`.
3. New `packages/models` and `apps/model-gateway`: resolution, pinning, presets, redaction, usage and audit.
4. M1-BE5 (#13): its brief's "Includes the model route to CLIProxyAPI" moves to the model gateway. The vault gains the
   narrow credential read for connectors, and the egress proxy carries no model traffic.
5. M1-CF1 and M1-SH1 (#17, #18): deploy the gateway (a Worker behind a service binding; a Deployment with a
   NetworkPolicy), with the CPA Tunnel bound to it.
6. Audit: a `model.call` event type.

## Decisions

Settled by Tom on 27 Oct 2026:

1. **Model calls don't go through the vault's egress proxy.** In his words: "Agents don't need the keys. Calls to the
   agent use internal APIs and then routing is determined by the platform." Hence the internal model gateway above.
2. **Projects can't bring their own connector.** They can only narrow their organisation's.
3. **v1 has no Harbour-level cross-provider failover.** That is left for later.
4. **Lleverage's LiteLLM virtual keys are per organisation.**

## Open questions for Tom

None new. The internal-API change raised no decision beyond the four above.
