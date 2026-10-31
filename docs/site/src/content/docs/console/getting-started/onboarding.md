---
title: Onboarding
description: What Partan's first-run onboarding will cover, and how to do each of its steps today through the console, deployment configuration and the API.
---

Onboarding is the console's first-run guide: it will take a new deployment from a fresh install to a first session. It isn't available yet. This page lists its intended steps and, for each, how to do the same thing today.

:::note[Not yet merged]
Onboarding is being built and has no pull request yet. The console has no onboarding screen today. Everything under "How to do each step today" works now.
:::

## The intended flow

When it ships, onboarding is intended to:

1. Connect models: model subscriptions such as Claude or ChatGPT, and providers you use with an API key.
2. Add your first connectors to outside services.
3. Start your first session.

You will be able to skip it and come back to it, and once you finish it won't be shown again. Onboarding will be a UI over the public API, so anything it does you can also do with an API call. Credentials you enter will go to the vault; the [installer](/console/getting-started/install/) bakes in none.

## How to do each step today

### 1. Connect models

Today models are set in the deployment's configuration, not in the console or the API. Each deployment runs one model connector, CLIProxyAPI, which serves the subscriptions you've signed in to inside CLIProxyAPI. You give Partan its URL and client key through environment variables (`HARBOUR_CPA_URL` and `HARBOUR_CPA_API_KEY` self-hosted; the `MODELS` binding and `HARBOUR_CPA_API_KEY` on Cloudflare), and `HARBOUR_DEFAULT_MODEL` picks the default model. Without them, sessions run on an echo model. See [Models](/console/models/).

The model gateway has presets for API-key providers (Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, LiteLLM and compatible APIs), but no deployment configures one yet, and there is no API to add a connector.

What you can do from the console and the API today:

| Task | Console | API |
| --- | --- | --- |
| See each connector's models | The Models page (`/projects/:projectId/models`) | `GET /v1/connectors?projectId=<id>` (Cloudflare only; not in the public API) |
| Test an image model | **Test generate** on the Models page | `POST /v1/connectors/<id>/test-image` (Cloudflare only; not in the public API) |
| Set the agent's image model | **Image model** and **Save** on the Models page | `PUT /v1/profiles/<agentId>` with `imageModel` (not in the public API) |
| List the models a session could use | The model picker | `getNewSessionModels` (`GET /v1/profiles/{agentId}/models`) |
| Add or change a connector | Not available yet | Not available yet |

### 2. Add connectors

This works today. Open **Settings** > **Connections**, pick a service from the catalogue or add a remote MCP server by its URL, and connect it by OAuth or with a key. See [Connectors](/console/connectors/).

### 3. Start your first session

This works today. In the console, select **New session** under a project, write the first message and send it. See [A tour of the console](/console/getting-started/tour/) and [Sessions](/console/sessions/).

With the API, create the session and send its first message in one call:

```ts
import { createHarbourClient } from "@harbour/api/sdk";

const partan = createHarbourClient({ baseUrl: `${process.env.PARTAN_URL}/v1`, token: process.env.PARTAN_API_KEY });

const session = await partan.createSession({
	projectId: "prj_…",
	agentId: "assistant",
	message: { text: "Read the README and tell me what this project does." },
});
console.log(session.id, session.submission?.id);
```

```sh
curl -s -X POST "$PARTAN_URL/v1/sessions" \
  -H "authorization: Bearer $PARTAN_API_KEY" -H "content-type: application/json" \
  -d '{"projectId":"prj_…","agentId":"assistant","message":{"text":"Read the README and tell me what this project does."}}'
```

`GET /v1/projects` lists your project IDs. On Cloudflare the default agent profile is `assistant`. Self-hosted, the bootstrap makes an `echo` profile, plus `assistant` when CLIProxyAPI is configured. See [Quick start](/api/quick-start/) for following the session's answer.

## Not available yet

- Onboarding itself, and any record of whether a person has finished, skipped or partly done it.
- Adding model connectors, including API-key providers, from the console or the API.

These are listed on the [gaps page](/gaps/).

<!-- Sources (8584d5b): apps/console/src/app/router.ts:1-40, apps/console/src/app/models-screen.tsx:1-134, apps/console/src/api/models-http.ts:1-10, apps/cloudflare/src/connectors.ts:1-23, apps/cloudflare/src/models.ts:1-60, apps/selfhosted/src/gateway/models.ts:1-21, apps/model-gateway/src/app.ts:140-155, packages/contracts/src/models.ts:72-92, packages/contracts/src/identity.ts:428-429,462-464, packages/api/src/routes.ts:256-320,1110, packages/api/generated/sdk.ts:427-457,500-520,645-653,2209-2214,2516-2519, packages/runtime/src/http/server.ts:620-660,739-747, packages/runtime/HTTP.md:112-140, docs/connections.md:1-35, deploy/compose/README.md:115-132, apps/cloudflare/src/stack.ts:660-672 -->
