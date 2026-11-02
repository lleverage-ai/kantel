---
title: Model providers
description: Connect an organisation's own inference (CLI Proxy API, LiteLLM, Cloudflare AI Gateway or OpenRouter) through the API, test it, list its models and choose the default model.
---

The model providers API connects an organisation to its own inference, as the console's first-run setup and its Models page do. A connection is an organisation model connector on one of four upstreams, each of which speaks OpenAI's API and lists its models:

| `provider` | Upstream | What it asks for |
| --- | --- | --- |
| `cliproxyapi` | [CLIProxyAPI](https://help.router-for.me/), which serves the Claude, ChatGPT or Gemini subscriptions signed in to there | `baseUrl`, such as `http://host.docker.internal:8317/v1`, and its client API key |
| `litellm` | A [LiteLLM proxy](https://docs.litellm.ai/docs/proxy/user_keys) | `baseUrl`, such as `http://host.docker.internal:4000/v1`, and a virtual key |
| `cloudflare-ai-gateway` | [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)'s OpenAI-compatible endpoint | `accountId`, `gatewayId` (default `default`) and a Cloudflare API token |
| `openrouter` | [OpenRouter](https://openrouter.ai/docs/api-reference/list-available-models) | An API key; the address is always `https://openrouter.ai/api/v1` |

The self-hosted gateway serves these routes when it has a vault (`KANTEL_VAULT_CIPHER_KEY`, or `KANTEL_VAULT_CIPHER_KEY_FILE` as Compose sets it). Cloudflare doesn't serve them yet, and answers 404. Reading the state needs a member of the organisation; everything else needs an organisation admin. In the examples, `KANTEL_TOKEN` is an admin's sign-in token (`kts_…`). The bootstrap's API key is a project operator's: it can read the state but not change it.

## The key

The key is write-only. Saving a connection puts it in the organisation's vault as an item bound to the provider's host, and the gateway reads it from there for each model call. No answer carries the key or any part of it, and the audit log records each use without it. Changing a connection without `apiKey` keeps its saved key while the host stays the same; a new host needs the key again, so a key never follows a connection to another host.

A base URL must be `http` or `https`, with no user name or password in it. A test follows no redirect, so the key goes only to the address given.

## Connect a provider

Test first: the gateway reads the provider's model list with the key and answers the models, saving nothing. Then save the connection under an ID of your choice (lowercase letters, digits and dashes), and choose its default model.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_TOKEN });

const input = { provider: "openrouter", apiKey: process.env.OPENROUTER_API_KEY } as const;
const { items } = await kantel.testModelProvider(input);
console.log(items.map((model) => model.id)); // such as ["anthropic/claude-sonnet-4.5", "openai/gpt-5", …]

await kantel.putModelProviderConnection("openrouter", input);
await kantel.setModelProviderDefault({ connectionId: "openrouter", modelId: "openai/gpt-5" });
```

```sh
curl -s -X POST "$KANTEL_URL/v1/model-providers/test" \
  -H "authorization: Bearer $KANTEL_TOKEN" -H "content-type: application/json" \
  -d '{"provider":"litellm","baseUrl":"http://host.docker.internal:4000/v1","apiKey":"sk-…"}'

curl -s -X PUT "$KANTEL_URL/v1/model-providers/connections/litellm" \
  -H "authorization: Bearer $KANTEL_TOKEN" -H "content-type: application/json" \
  -d '{"provider":"litellm","baseUrl":"http://host.docker.internal:4000/v1","apiKey":"sk-…"}'

curl -s -X PUT "$KANTEL_URL/v1/model-providers/default" \
  -H "authorization: Bearer $KANTEL_TOKEN" -H "content-type: application/json" \
  -d '{"connectionId":"litellm","modelId":"gpt-5"}'
```

A test that fails says why: `refused` when the provider refused the key (with the HTTP status), `not_found` when there's no model list at the address, `unavailable` when it couldn't be reached, redirected or didn't answer with a model list, and `invalid` for details that can't make a connection. A test without `apiKey` that names a saved connection (`connectionId`) uses its saved key.

## The default model

The default model is the organisation's `default` route. The bootstrap project's `assistant` profile names that route, and the gateway makes the profile when the organisation's first default is chosen, so a new session uses the model from then on. Until there's a default, sessions answer with the echo model. A default the deployment configured (`KANTEL_CPA_URL` or `KANTEL_MODEL_CONNECTORS`) shows as `platformDefault`, and the organisation's replaces it.

Removing the connection the default is on removes the default too, and the deployment's default, if it has one, applies again. Without one, new sessions on the `assistant` profile fail with `no_model` until you choose another default; the `echo` profile still answers.

## Routes

| Route | What it does |
| --- | --- |
| `getModelProviders` (`GET /v1/model-providers`) | Whether sessions have a model (`configured`), whether the caller may change it (`canManage`), the connections and the default |
| `testModelProvider` (`POST /v1/model-providers/test`) | Tests details, or a saved connection, and answers the models |
| `putModelProviderConnection` (`PUT /v1/model-providers/connections/{connectionId}`) | Makes or changes a connection |
| `deleteModelProviderConnection` (`DELETE /v1/model-providers/connections/{connectionId}`) | Removes it |
| `listModelProviderModels` (`GET /v1/model-providers/connections/{connectionId}/models`) | Its models now, with the saved key |
| `setModelProviderDefault` (`PUT /v1/model-providers/default`) | Chooses the default model |

See the [reference](/api/reference/model-providers/) for each route's shapes, and [Models](/console/models/) for the console.

<!-- Sources: packages/api/src/model-provider-routes.ts, packages/api/src/model-providers-schema.ts, packages/contracts/src/model-providers.ts, apps/selfhosted/src/gateway/model-providers.ts, apps/selfhosted/src/gateway/main.ts, packages/models/src/providers.ts, apps/selfhosted/test/gateway/model-providers.test.ts -->
