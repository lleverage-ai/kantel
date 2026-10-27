# Models contract

## What it is for

`@harbour/models` is the model gateway's library: the connector directory, route resolution, session tokens, the
connector presets, the catalogue, redaction, the gateway itself and its HTTP API. It implements
`packages/contracts/src/models.ts` as designed in `docs/model-connectors.md`. The session runtime never calls a provider:
it calls the gateway over pi-ai's own `pi-messages` protocol with a short-lived session token, and the gateway picks the
connector, reads its key from the vault, calls the upstream with pi-ai and streams pi events back. `apps/model-gateway`
hosts it on Node and Workers.

## Records

- **Connector** (`ModelConnector`): owner (platform or organisation), preset, base URL (the upstream's OpenAI-style API
  root, such as `http://cpa.internal:8317/v1`), the vault item holding its key (never a value), catalogue source
  (`gateway` or `static`, `include`, `overrides`) and pi-ai compat passed through.
- **Route** (`ModelRoute`): a name without `:`, owned by the platform, an organisation or a project, naming a connector,
  the upstream's own model ID and an optional thinking level.
- **Project policy** (`ProjectModelPolicy`): allowed connectors and models. Absent lists allow everything.
- **Pin** (`ModelPin`): per session and model ID (a route, or `<route>:<modelId>`), the connector and model the first
  call used. `ModelPinStore` is an interface with a memory implementation, so a target can make pins durable.
- **Call record** (`ModelCallRecord`): scope, route, connector, model, status, stop reason, duration, usage and where the
  cost came from. Never a prompt, a completion or a key.

## Modules

| Export | What it does |
| --- | --- |
| `./directory` | `createMemoryModelConnectors({ clock?, audit?, access? })`, the reference `ModelConnectors` |
| `./resolution` | Pure functions: `parseModelRequestId`, `nearestRoutes`, `resolveRoutes`, `policyAllows` |
| `./tokens` | `createHmacSessionTokens({ key, clock?, maxTtlMs?, audit? })`, the `ModelSessionTokens` |
| `./presets` | `CONNECTOR_PRESET_SPECS`, the one table of provider-specific behaviour |
| `./catalogue` | pi-ai catalogue join, upstream listing parse and the refreshing catalogue cache |
| `./redact` | `Redactor` and `StreamRedactor` |
| `./gateway` | `createModelGateway(...)`, the `ModelGateway`; `createMemoryModelPinStore`, `createCredentialCache`, `singleRequestFetch` |
| `./http` | `createModelGatewayHttp({ gateway, tokens, basePath? })`, a fetch handler |

## Rules and the suite cases that enforce them

Gateway cases are in `registerModelGatewayConformance` and connector cases in `registerModelConnectorConformance`
(`@harbour/testing/models`); unit cases are in `packages/models/test`.

### Directory

- Platform connectors and routes are changed only by `system`; anyone else is `forbidden`, audited once as
  `access.denied`: "lets only a system caller change the platform's connectors and routes".
- An organisation's connectors, and a project's policy, need an organisation-wide admin; a project's routes need an
  admin on the project. Agents read and change nothing: "needs an organisation-wide admin for an organisation's
  connectors and policies", "keeps agents out of reads and makes resolve a worker call".
- Route names never contain `:` (`invalid`); a route uses only the platform's or its owner's organisation's connector,
  and a project route must pass its project's policy (`refused`): "lets a project admin own routes over the platform's
  or the organisation's connectors only".
- Every change is audited with source `control` (`models.connector.put`, `models.connector.delete`, `models.route.put`,
  `models.route.delete`, `models.policy.set`).
- `resolve` is a worker call (`requireSystem`).

### Resolution

- Routes resolve platform → organisation → project, the nearest name winning; the project's policy then filters, and a
  farther route never stands in for a nearer one the policy drops: "resolves platform → organisation → project, the
  nearest name winning", "filters by the project's policy, without falling back to a farther route".
- Model IDs parse as `<route>:<modelId>`, split at the first `:`: "reads a route, or a route and a model split at the
  first colon".
- `/v1/config` lists only the session's routes, each with its upstream model's metadata, and every other model the
  route's connector offers and the policy allows as `<route>:<modelId>`: "config: lists only the session's routes, with
  the route's other models as overrides".
- A token from organisation A can't reach organisation B's route (`not_found`), and a model the project's policy excludes
  is `refused`; neither reaches the upstream nor records a call: "scope: an organisation A token is refused on
  organisation B's route", "scope: a model the project's policy excludes is refused".
- The first call of a session pins `(connector, modelId)`; a route edit never moves it: "pins: a session keeps its model
  across a route edit". A pin is made only for a request that can be served.
- A pin is served whatever its route now points at, and after the route is edited to a model the policy excludes or is
  deleted. Each call rechecks only the pinned target: its connector still exists and serves the session's organisation,
  the project's policy allows it and the connector's catalogue still offers it. The thinking level is the route's
  current one while the route resolves for the session, else none: "pins: a pin outlives its route's edit to a model
  the policy excludes, and its deletion", "serves a pin only while its connector serves the session's organisation".
- `/v1/config` lists each model ID as `messages` would serve it: a pinned ID (a route, an override, or one whose route
  is gone) by its pin, an unpinned route or override by the route's current connector: "pins: config describes each
  model ID as messages serves it, pinned or not". `ModelPinStore.list(sessionId)` gives config the session's pins.

### Session tokens

- `hms1.<claims>.<mac>`: base64url JSON claims (version, organisation, project, agent, session, expiry) and an
  HMAC-SHA256 over them, on Web Crypto. Keys are at least 32 bytes. Lifetimes default to 15 minutes and are capped at
  `maxTtlMs` (default one hour).
- A token that doesn't verify is `forbidden`, a valid one past its expiry `expired`; the mac is compared in constant
  time. `mint` and `verify` are worker calls: "refuses a tampered, foreign-key or malformed token as forbidden", "expires
  a token after its lifetime, capped by maxTtlMs", "mint and verify are worker calls", "tokens: a bad, tampered or
  expired token is refused".

### The upstream call

- The key is read through `ConnectorCredentials.readConnectorCredential` as `system("model-gateway")`, which records a
  vault use; it is cached in memory, one key per connector, for less than `credentialTtlMs` (default 120 s, capped at 5
  minutes), replaced when a read returns a newer `valueVersion`, and dropped when the upstream answers 401. Each key
  is dropped by a real-time timer at its TTL even if the cache is never touched again, and every access to the cache
  also first drops each key expired by the gateway's clock. A blank key from the vault is refused (`unavailable`)
  rather than sent, because pi treats a request with no auth header as a cue to look for credentials of its own in the
  host's environment. A key cached for an earlier version of the connector (its `updatedAt` moved) is dropped rather
  than reused: "credentials: the key is read through the vault, cached, and read again after a 401", "rereads at the
  TTL, and drops each expired key on any access rather than holding it until the next read", "replaces a key whose
  value rotated, and drops the key of a connector since edited".
- The key goes where the wire API expects it (`Authorization: Bearer` for the OpenAI APIs, `x-api-key` for
  `anthropic-messages`), attribution and affinity come from the token's scope, and the client's headers and body never
  steer the upstream request: "headers: the client's headers never reach the upstream", and per preset and API "a call
  streams back and ends with usage, the key in the preset's header", "attribution and session affinity come from the
  token's scope".
- The gateway sets the key header itself, after the preset's headers so nothing replaces it, and never hands pi the
  key as `apiKey`, so the key's form can't change the auth scheme: an `sk-ant-oat` key is not sent as OAuth with Claude
  Code's identity, and pi's OpenAI client sends no placeholder key: per preset and API "the key travels in the
  preset's header whatever its form, never changing the auth scheme". pi's ChatGPT sign-in handling (a non-`sk-` key
  to `https://api.openai.com/v1`) is off for the same reason; no target reaches that URL, so that is not tested.
- Thinking: the call's `reasoning`, else the route's `thinking` (`off` sends none): "every thinking level the model
  supports reaches the upstream payload".
- Prompt caching reaches the upstream: on `anthropic-messages` pi's cache breakpoints (`cache_control`), on
  `openai-responses` a `prompt_cache_key` of the token's session ID (clamped to 64 characters): per preset and API
  "prompt caching reaches the upstream: Anthropic cache breakpoints, the Responses cache key". Targets on
  `openai-completions` can't show it: pi sends a cache key there only to api.openai.com and breakpoints only where a
  model's compat asks, so the case passes them without a check.
- One upstream request per call: `maxRetries: 0`, and the fetch pi gets (`singleRequestFetch`) sends only the call's
  first request. pi's Anthropic strict-tools fallback, which re-posts without strict mode after certain 400s whatever
  `maxRetries` says, is answered with a copy of the first response, so the first 400 stands and reaches the runtime as
  pi reports it; any other later request is rejected. Upstream error text reaches the runtime verbatim after
  redaction, so `isRetryableAssistantError` holds for 429 and 5xx and not for 401, and a context overflow is
  recognised: "errors: one upstream attempt per call", "errors: one upstream request even where pi would retry without
  strict tools", "sends one upstream request per call, answering a retry with the first failure", "errors: 429 and 5xx
  reach the runtime as retryable, 401 as not", "errors: a context overflow passes through unchanged".
- A request's `context` must have the shape of pi 1.4.0's `Context`, checked before the route resolves: an optional
  string `systemPrompt`; tools with a `name`, `description` and `parameters` object; system messages of a string or
  text blocks with optional `sections`, `toolsAdded` and `toolsRemoved`; user messages of a string or text and image
  blocks; assistant messages of text, thinking and tool-call blocks (a tool call with an `id`, `name` and `arguments`
  object) with `api`, `provider`, `model`, a numeric `timestamp`, pi's `usage` counts and costs, and one of pi's stop
  reasons; tool results with a `toolCallId`, `toolName`, an array of text and image blocks and a boolean `isError`.
  Anything else is `invalid`, naming the first field at fault, and reaches no upstream and records no call: "messages:
  a context not in pi's shape is invalid before it resolves", "takes a context in pi's shape and refuses anything
  else as invalid, recording nothing".
- Deltas are forwarded as they arrive: "messages: deltas arrive incrementally, before the upstream finishes".
- Text, thinking and tool calls round-trip on all three wire APIs: "messages: text, thinking and a tool call round-trip
  on every wire API".
- `usage.cost` is the upstream's reported cost (LiteLLM, OpenRouter: `usage.cost`; the computed breakdown is scaled to
  it), else pi's `calculateCost` from the catalogue's rates, else none (CPA): "messages: usage carries tokens and cost,
  computed or reported", "scales a reported cost's breakdown to the reported total".
- Aborting the request, or the client going away, cancels the upstream request: "abort: the client's abort cancels the
  upstream request", "streams SSE data lines, and cancelling the body cancels the upstream".
- Aborting while the call resolves (a catalogue refresh included) rejects at once with the abort's reason (499 over
  HTTP); the call pins nothing, reaches no upstream and records nothing, and the refresh it waited on carries on for
  the connector's other callers: "abort: aborting while the catalogue refreshes ends the call at once, and it runs on
  no further".
- A throw once the call has resolved, from pi or the gateway, ends the stream in a redacted `error` event, recorded
  with status `error`; only a real abort, or the consumer stopping, is recorded as `aborted`: "ends a call that throws
  once resolved in an error event, recorded as an error, not aborted".

### Redaction

- Every event leaves the gateway through one sanitising pass that redacts every known secret (the current call's key)
  from every string the upstream could have set: content and deltas, signatures, tool-call IDs, names, namespaces,
  arguments and thought signatures, response IDs, thinking levels and error text. Only `type` and `reason` pass as
  they are. A catalogue listing is sanitised when it is read, while its key is at hand: names are redacted and a model
  whose ID holds the key is dropped, so `/v1/config` shows neither: "secrets: the upstream key reaches no client event
  and the canary no audit event" (the fake upstream echoes the key in content, errors, tool-call and response IDs, the
  namespace and catalogue names), "redacts the key from listed names and drops models whose ID holds it", "catches a
  secret split across deltas, holding back no more than it must".
- Deltas are redacted per content block, holding back the text from the first character that could begin a spelling of
  the key (literal, or with `\uXXXX` and `\/` escapes, so up to six characters per key character) and flushing it at the
  block's end. A key split across deltas, even mid-escape, reaches no delta and no partial tool call pi's client parses
  from them: "secrets: a key split inside JSON escapes reaches no delta and no partial tool call", "catches a secret
  split inside its JSON escapes, which pi's client would decode", "holds back only text that could begin a secret".
- How this relates to `apps/vault-proxy/src/redact.ts`: the proxy redacts whole upstream bodies at byte level and
  matches every encoded spelling (JSON and HTML escapes, percent encoding), since a sandbox may receive any body. The
  gateway redacts pi's parsed events, where the key appears as text, so it matches it literally and in the JSON `\u` and
  `\/` escapes an echoed JSON error body can carry. It is portable and doesn't import from apps.

### Accounting and audit

- Each call that resolved a route records exactly one `ModelCallRecord` and one `model.call` audit event (source
  `session`, subject `{ kind: "model.call", id }`), whether it ends done, in an error or aborted; a call rejected before
  that records none: "accounting: exactly one model.call per resolved call, none for a refused one".
- Neither holds a prompt, a completion or a key, checked with `CANARY_SECRET`.
- `listCalls` returns the caller's organisation's calls, newest first, for viewers on the project or session filtered
  by; agents are refused: "lists calls newest first for project viewers, never for agents or other organisations". The
  gateway keeps the last 10 000 records in memory; the audit log is the lasting record, as durable as the sink the
  host binds.
- A `model.call` append that fails is retried at once, up to 3 attempts under the same event ID (sinks are idempotent
  by it). If all fail, the call's record is replaced by a copy marked `auditPending`, and the gateway's
  `onAuditFailure` is given the record, the event, the error and the attempt count so the host can append it later;
  without one the gateway logs one line naming the call and the error, none of the event's data. The call itself is
  never failed after the fact: "retries a failed model.call append under one event ID, then marks the call pending
  and tells the host".

### Catalogue

- Metadata comes from pi-ai's generated catalogue (Anthropic, OpenAI, Google, OpenRouter, Vercel), joined by the
  upstream's ID, by `<provider>/<id>`, or by `override.canonical`, looking in the preset's own provider first. The
  upstream's listing and then the connector's overrides take precedence. Compat is borrowed only from an entry on the
  same wire API, and only from the preset's own provider or a first-party one.
- What is available: for `refresh: "gateway"`, the upstream's listing (`/v1/models`; LiteLLM's `/model/info`;
  OpenRouter's `/api/v1/models` under its `.../api/v1` base URL), read with the connector's key and cached for 10 minutes
  per connector version, with concurrent refreshes shared, each bounded by `catalogueRefreshTimeoutMs` (default 10
  seconds, in real time) and a failed or timed-out refresh retried after 10 seconds; for `static`,
  `include` and the overrides. `include` limits either. A model with no pi match is offered only when an override gives
  `contextWindow` and `maxTokens`: "offers a model with no pi match only when an override gives its limits",
  "refreshes from the upstream once per TTL, deduplicating concurrent refreshes", "bounds a refresh by its timeout,
  and lets a caller abort its wait without ending the refresh", and per preset "the catalogue lists the route's model
  with its context window".

### Presets

| Preset | pi provider | Wire APIs (default) | Affinity | Attribution | Cost | Catalogue |
| --- | --- | --- | --- | --- | --- | --- |
| `litellm` | `litellm` | all three (Claude → Messages, else Chat Completions) | | `x-litellm-tags`, body `metadata` (`metadata.user_id` on Messages) | reported | `/model/info` |
| `vercel-ai-gateway` | `vercel-ai-gateway` | Messages (pi's), Chat, Responses | `x-session-id` | | computed | `/v1/models` |
| `openrouter` | `openrouter` | Chat Completions (pi's), Messages | `x-session-id` | | reported | `/api/v1/models` |
| `anthropic` | `anthropic` | Messages | | `metadata.user_id` | computed | `/v1/models` |
| `openai` | `openai` | Responses, Chat Completions | `prompt_cache_key` | `user` | computed | `/v1/models` |
| `cliproxyapi` | `cliproxyapi` | all three (Claude → Messages, GPT/o-series/Codex → Responses, else Chat) | `x-session-affinity` | | none | `/v1/models` |
| `openai-compatible` | `openai-compatible` | Chat Completions, Responses | | | computed | `/v1/models` |
| `anthropic-compatible` | `anthropic-compatible` | Messages | | `metadata.user_id` | computed | `/v1/models` |

`override.api` picks a wire API the preset speaks. On Vercel, `compat.vercelGatewayRouting` is applied to Messages
bodies through `onPayload` (pi applies it only on Chat Completions).

## HTTP API

`createModelGatewayHttp` serves `GET <basePath>/v1/config` and `POST <basePath>/messages` with
`Authorization: Bearer <session token>`. The SSE stream is one `data: <json>\n\n` per event, enqueued as soon as the
gateway yields it (`cache-control: no-cache, no-store`, `x-accel-buffering: no`). A missing or invalid token is 401
`unauthenticated`, an expired one 401 `expired`. Other errors before the stream are `{ "error": { "code", "message" } }`
with `invalid` 400, `forbidden` and `refused` 403, `not_found` 404, `conflict` 409, `expired` 410, `exhausted` 429,
`aborted` 499, `not_supported` 501 and `unavailable` 503, and a reason phrase, so pi-ai's client reports
`"<status> <statusText>: <message> (<code>)"`.

## Known limits

- Pins live in memory per gateway instance and have no session-end cleanup yet; a durable `ModelPinStore` should drop a
  session's pins when it ends.
- The call log for `listCalls` is in memory (last 10 000 calls). The `model.call` audit events are only as durable as
  the host's sink: the Worker writes them to its log (`logAuditSink`) until #17 binds an outbox, so there a lost log
  line is a lost event.
- On Anthropic, a tool the runtime marks `strict: "prefer"` fails the call when the upstream rejects its grammar as too
  large, where pi alone would retry without strict mode; the runtime sees the 400 and may drop strict mode itself.
