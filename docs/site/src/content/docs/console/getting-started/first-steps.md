---
title: First steps
description: Take a new Kantel deployment to its first session, by connecting models, adding connections and starting a session in the console or through the API.
---

A new deployment needs three things before an agent does useful work: models, the services it should reach, and a first session. Each can be done in the console or through the public API.

## 1. Connect models

Self-hosted, the console asks for this the first time an admin signs in: **Set up Kantel** opens on **Connect a model**.

1. Choose the **Provider**: CLI Proxy API, LiteLLM, Cloudflare AI Gateway or OpenRouter.
2. Enter its **Base URL** (CLI Proxy API and LiteLLM; a provider on the same machine as the Compose stack is `http://host.docker.internal:<port>/v1`), or the Cloudflare **Account ID** and **Gateway ID**, and its key.
3. Select **Test connection**, which lists the provider's models.
4. Pick the **Default model** and select **Save**.

The key goes into the vault, and new sessions use the default model through the **Assistant** agent. **Skip for now** leaves it for later; until a provider is connected, sessions answer with an echo model. Change it any time in **Settings** > **Models**, under **Providers**. Through the API, it's [Model providers](/api/model-providers/).

A deployment can configure models for every organisation instead. By default that's one model connector, CLIProxyAPI, which serves the subscriptions you've signed in to inside CLIProxyAPI: you give Kantel its URL and client key through environment variables (`KANTEL_CPA_URL` and `KANTEL_CPA_API_KEY` self-hosted; the `MODELS` binding and `KANTEL_CPA_API_KEY` on Cloudflare), and `KANTEL_DEFAULT_MODEL` picks the default model. Self-hosted, `KANTEL_MODEL_CONNECTORS` sets connectors of any preset instead, such as a LiteLLM proxy or an API-key provider. On Cloudflare, that configuration is the only way to models. See [Models](/console/models/).

What you can do from the console and the API:

| Task | Console | API |
| --- | --- | --- |
| Connect a provider and choose the default model | **Set up Kantel**, or **Providers** on the Models page (self-hosted) | `testModelProvider`, `putModelProviderConnection`, `setModelProviderDefault` (self-hosted) |
| See each connector's models | The Models page (`/projects/:projectId/models`) | `GET /v1/connectors?projectId=<id>` (not in the public API) |
| Test an image model | **Test generate** on the Models page | `POST /v1/connectors/<id>/test-image` (Cloudflare only; not in the public API) |
| Set the agent's image model | **Image model** and **Save** on the Models page | `PUT /v1/profiles/<agentId>` with `imageModel` (not in the public API) |
| List the models a session could use | The model picker | `getNewSessionModels` (`GET /v1/profiles/{agentId}/models`) |

The deployment's own connectors and routes can't be added or changed from the console or the API.

## 2. Add connections

Open **Settings** > **Connections**, pick a service from the catalogue or add a remote MCP server by its URL, and connect it by OAuth or with a key. See [Connectors](/console/connectors/).

## 3. Start your first session

In the console, select **New session** under a project, write the first message and send it. See [A tour of the console](/console/getting-started/tour/) and [Sessions](/console/sessions/).

With the API, create the session and send its first message in one call:

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });

const session = await kantel.createSession({
	projectId: "prj_…",
	agentId: "assistant",
	message: { text: "Read the README and tell me what this project does." },
});
console.log(session.id, session.submission?.id);
```

```sh
curl -s -X POST "$KANTEL_URL/v1/sessions" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"projectId":"prj_…","agentId":"assistant","message":{"text":"Read the README and tell me what this project does."}}'
```

`GET /v1/projects` lists your project IDs. On Cloudflare the default agent profile is `assistant`. Self-hosted, the bootstrap makes an `echo` profile, plus `assistant` when real models are configured. Both have the tools of Cloudflare's default profile: the file tools and `bash` on a workspace of the session's own, `present_files`, `create_document`, `codemode`, `save_program` and the connection tools, with `generate_image` once you set an image model. See [Quick start](/api/quick-start/) for following the session's answer.

<!-- Sources (8584d5b, models rechecked at ba80016): apps/console/src/app/router.ts:1-40, apps/console/src/app/models-screen.tsx:1-134, apps/console/src/api/models-http.ts:1-10, apps/cloudflare/src/connectors.ts:1-23, apps/cloudflare/src/models.ts:1-60, apps/selfhosted/src/gateway/models.ts:1-21, apps/model-gateway/src/app.ts:140-155, packages/contracts/src/models.ts:72-92, packages/contracts/src/identity.ts:428-429,462-464, packages/api/src/routes.ts:256-320,1110, packages/api/generated/sdk.ts:427-457,500-520,645-653,2209-2214,2516-2519, packages/runtime/src/http/server.ts:620-660,739-747, packages/runtime/HTTP.md:112-140, deploy/compose/README.md:115-132, apps/cloudflare/src/stack.ts:660-672 -->
