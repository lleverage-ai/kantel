---
title: Models
description: How Kantel reaches models through its model gateway, what the deployment configures, the Models page and the model picker in sessions.
---

Agents in Kantel never call a model provider themselves. Each session calls Kantel's internal model gateway, which picks the connector that serves the call, adds that connector's key from the vault and streams the answer back. The agent sees a route name such as `default`, never a provider URL or a key.

## Connectors, routes and presets

A **connector** is configuration for one upstream: a preset, a base URL, the vault item that holds its key, and where its list of models comes from. The preset fixes the wire API, the header the key goes in, and how the upstream's catalogue is read. The model gateway has these presets:

| Preset | Upstream |
| --- | --- |
| `cliproxyapi` | CLIProxyAPI, which serves model subscriptions you have signed in to there |
| `anthropic` | Anthropic's API, with an API key |
| `openai` | OpenAI's API, with an API key |
| `openrouter` | OpenRouter |
| `vercel-ai-gateway` | Vercel AI Gateway |
| `litellm` | A LiteLLM proxy |
| `openai-compatible` | Any other upstream that speaks OpenAI's APIs |
| `anthropic-compatible` | Any other upstream that speaks Anthropic's Messages API |

A **route** is a name an agent profile uses, such as `default`, that points at one model on one connector. A session can also name `<route>:<modelId>` to use another model the route's connector offers.

Connectors belong to the platform or to an organisation. A project can't bring its own connector; it can only narrow the ones it inherits. Routes resolve from the platform to the organisation to the project, the nearest name winning. A session's first call to a route pins the model it resolved to, so changing a route never switches a conversation that is already running.

The key never reaches the session. The gateway reads it through the vault, which checks that the item is bound to the connector's host and records each use. Every model call is audited as a `model.call` event, with its usage and cost and without the prompt or the answer.

## What the deployment configures

Connectors are platform connectors, configured from the deployment's environment. By default a deployment runs one connector, `sal-cliproxyapi`, with the `cliproxyapi` preset. Model subscriptions, such as Claude or ChatGPT logins, are signed in to inside CLIProxyAPI, not in Kantel; Kantel holds only CLIProxyAPI's client key.

Self-hosted, `KANTEL_MODEL_CONNECTORS` replaces CLIProxyAPI with connectors of any preset and their routes, such as one LiteLLM gateway inside the cluster. Each connector's key comes from a variable of its own; see [Connectors of any preset](/deploy/self-hosted/#connectors-of-any-preset). Cloudflare stays on CLIProxyAPI: the Worker reaches models only through its `MODELS` VPC service, and ignores `KANTEL_MODEL_CONNECTORS`.

Adding, changing or removing connectors, routes and project narrowing from the console or the API isn't available yet, and an organisation can't have connectors of its own.

| Variable | Cloudflare | Self-hosted | What it does |
| --- | --- | --- | --- |
| `KANTEL_CPA_API_KEY` | Worker secret | Gateway environment | CLIProxyAPI's client key. The deployment keeps it as a platform vault item and reads it through the vault. A new key makes a new item |
| `KANTEL_CPA_URL` | (not used) | Gateway environment | CLIProxyAPI's API root, with its `/v1` |
| `MODELS` binding | Workers VPC service (`KANTEL_MODELS_VPC_SERVICE_ID` at deploy) | (not used) | How the Worker reaches CLIProxyAPI |
| `KANTEL_MODEL_CONNECTORS` | (ignored) | Gateway environment | Instead of CLIProxyAPI: the platform connectors and routes as JSON, each connector naming the variable that holds its key. `KANTEL_MODEL_CONNECTORS_FILE` gives a path to the JSON instead |
| `KANTEL_VAULT_CIPHER_KEY` | (not used) | Gateway environment | The vault's key; the gateway needs a vault to hold its connectors' keys |
| `KANTEL_DEFAULT_MODEL` | Variable | Gateway environment | The model the `default` route serves, unless the connectors config gives routes. Default `claude-sonnet-5-5` |
| `KANTEL_IMAGE_MODEL` | Variable | (not used) | Adds an `images` route to this model, such as `gpt-image-1` |

The `default` route serves `KANTEL_DEFAULT_MODEL`, and every other model CLIProxyAPI lists is offered as `default:<model>`. Without the key (and, on Cloudflare, the `MODELS` binding; self-hosted, `KANTEL_CPA_URL`), sessions run on an echo model that repeats what you send.

With a connectors config, the routes are the config's, and each route's connector offers its other models as `<route>:<model>`.

Self-hosted, the gateway checks each connector's key and its routes' models at start and logs any problem, which otherwise shows only as sessions failing with no model.

Every model call records its connector's ID and preset in its usage row and its `model.call` event, whichever connector served it. A `litellm` connector also tags each request with the session's organisation, project, agent and session, so one LiteLLM key can serve the whole deployment and LiteLLM still splits spend by project (see [Building a host app](/api/host-apps/#models-through-a-litellm-gateway)).

On Cloudflare, the default agent profile, Assistant, uses the `default` route. Self-hosted, with real models configured, the bootstrap adds an `assistant` profile on `default` beside the `echo` profile, which stays on the echo model.

## The Models page

Open **Settings** > **Models**; it shows the project you were last in, or the first. Its path is `/projects/:projectId/models`. The page has two parts.

**The agent's image model.** At the top, the agent a new session in this project runs, with its **Chat model** and an **Image model** list: "Only models that make images are listed." Choose one, or **None**, and select **Save**. The page confirms "Saved. New sessions use it." The agent gets the `generate_image` tool when it has an image model. Images use their own model, whatever the agent chats with. Changing the agent needs the operator role.

**Connectors.** Each connector the project can reach, with its ID, its preset and whether the platform, the organisation or the project owns it. Under it, each model it offers, with badges for what the model does: **Text**, **Makes images**, **Reads images**, and the image API it's called over. A model a route points at shows "on route" and the route's name. An image model has **Test generate**, which makes one small image and shows it with its cost and how long it took. Testing needs the admin role on the project.

To offer an image model on Cloudflare, set `KANTEL_IMAGE_MODEL`; CLIProxyAPI serves `gpt-image-*` models without listing them, so the deployment marks that model as one that makes images. Each image call is recorded and audited like a chat call, never with the prompt or the image.

The page needs a model gateway. On a deployment running on the echo model, the connectors route answers that it has none. The self-hosted gateway doesn't serve the connectors route yet, so the page can't list connectors there.

## Choosing a model for a session

The composer has a model picker and a **Thinking** picker, in a new session and in a running one. The model picker groups models by provider, read from their names, and marks models that read images. The list is what the session's routes allow: on a deployment with CLIProxyAPI, `default` and each `default:<model>`.

In a running session, the model you choose goes with your next message, and the session keeps it from that run on. The conversation keeps its context. The agent profile's model stays the default for new sessions.

Through the API, list the models a new session could use, then name one in the first message:

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });

const { models } = await kantel.getNewSessionModels("assistant", { projectId: "prj_…" });
console.log(models.map((model) => model.id)); // such as ["default", "default:gpt-5"]

const session = await kantel.createSession({
	projectId: "prj_…",
	agentId: "assistant",
	message: { text: "Summarise the README", model: "default", thinking: "low" },
});
```

```sh
curl -s "$KANTEL_URL/v1/profiles/assistant/models?projectId=prj_…" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

`getSessionModels` (`GET /v1/sessions/{sessionId}/models`) lists what a running session may switch to, and `sendMessage` takes `model` and `thinking` to switch from that run on. Listing models for a new session needs the operator role on the project, as creating the session does.

<!-- Sources (8584d5b): docs/model-connectors.md:1-125,166-235,251-302, packages/contracts/src/models.ts:1-245, packages/contracts/src/session.ts:46-65, apps/model-gateway/src/app.ts:1-40,140-155, apps/cloudflare/src/models.ts:1-221, apps/cloudflare/src/connectors.ts:1-80, apps/cloudflare/src/gateway.ts:320-325,470-475, apps/cloudflare/src/stack-object.ts:305-340, apps/cloudflare/src/stack.ts:660-690, apps/cloudflare/README.md:36-42,303-322, apps/selfhosted/src/gateway/models.ts:1-175, apps/selfhosted/src/gateway/gateway.ts:1-27, deploy/compose/README.md:115-132, apps/console/src/app/router.ts:126,143-144, apps/console/src/app/app.tsx:245-265, apps/console/src/app/models-screen.tsx:1-134, apps/console/src/api/models-http.ts:1-40, packages/ui/src/models/models-page.tsx:60-260, packages/ui/src/session/model-picker.tsx:530-560,680, packages/ui/src/session/thinking-picker.tsx:169, packages/runtime/src/session-models.ts:1-40, packages/api/generated/sdk.ts:500-520,645-653,912-961,1567-1573,2204-2214 -->
