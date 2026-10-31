---
title: Building a host app
description: Run your app's agents on Kantel through the public API with an organisation key, a project per project of yours, labelled sessions, organisation-wide agents, a LiteLLM gateway, embedded browsers and shared resources.
---

A host app is an app whose backend calls Kantel with an API key while Kantel runs the agents: their sessions, models,
browsers, skills, memory and connections. This page puts together the pieces a host app usually needs. Settings named
`HARBOUR_*` from before the rename still work when the `KANTEL_*` one isn't set.

## Calling Kantel

Your backend sends `Authorization: Bearer hbr_…` on every call. The key acts as a `service` in one organisation. A
host app that works across an organisation uses an **organisation key**: one role, at most `operator`, across the
organisation and every project in it, optionally with the `create_projects` permission. An organisation admin, signed
in as a person, issues it on the console's API keys page ("Whole organisation", "Can create projects") or with
`POST /v1/keys`; see [Authentication](/api/authentication/#organisation-keys). A host app that should stay out of some
projects uses project keys instead, each with one role on the projects it lists and nothing outside them.

The key stays on your server. A browser can't put the key on a WebSocket as a header, so stream sessions from your
backend and pass what your pages need on to them.

## A Kantel project for each of your projects

When your app makes a project, create a Kantel project for it, keep the returned ID beside your own, and run that
project's sessions there. The organisation key holds its role on the new project at once, and the project is audited
as `identity.project.created` with the key as its actor.

```ts
const project = await kantel.createProject({ name: "Invoices" });
// { id, organisationId, name: "Invoices", createdAt }
```

```sh
curl -s -X POST "$KANTEL_URL/v1/projects" -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" -d '{"name": "Invoices"}'
```

The organisation itself is made when the deployment starts; no route creates one.

## Sessions labelled with your references

A session has no separate external-reference field. Put your own reference in `labels`, such as
`{ appRunId: "run-42" }`, and find the session again with `GET /v1/sessions?label.appRunId=run-42`. A first
`message` is sent as a prompt once the session exists; if it is refused, the session is closed and the refusal
answered, so no idle session is left behind.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });

const session = await kantel.createSession({
	projectId: "<project ID>",
	agentId: "<agent ID>",
	labels: { appRunId: "run-42" },
	message: { text: "Summarise the open invoices" },
});
const { items } = await kantel.listSessions({ label: { appRunId: "run-42" } });
```

```sh
curl -s -X POST "$KANTEL_URL/v1/sessions" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"projectId": "<project ID>", "agentId": "<agent ID>",
       "labels": {"appRunId": "run-42"}, "message": {"text": "Summarise the open invoices"}}'

curl -s "$KANTEL_URL/v1/sessions?label.appRunId=run-42" -H "authorization: Bearer $KANTEL_API_KEY"
```

`userId` names the person a session works for (a host app may name any user); it picks the user layer of skills and
prompt rules. Kantel has no field for a host's own user IDs, so your app keeps that mapping. See
[Quick start](/api/quick-start/) and [Streaming](/api/streaming/).

## Organisation-wide agents beside project ones

A session is scoped to a project, or to the organisation with `scope: "organisation"` and no `projectId`. An agent
profile with no `projectId` is organisation-wide: it runs in every project and in organisation sessions, while a
project's profile runs only in its project. An organisation session's agent sees what the organisation owns and the
session user's own records, and nothing a project owns unless that project shares it.

Kantel adds no system prompt of its own. A session's system prompt is its prompt rules and its profile's prompt
layers, in the order platform, organisation, project, profile, user (an organisation session has no project layer).
On the first prompt it also gets its skills listing and recall from its memory spaces. See
[Prompt rules](/console/prompt-rules/).

An organisation key with `operator` creates and lists organisation sessions and puts organisation-wide profiles. A
project key can start project sessions that run an organisation-wide profile, but can't do those. Prompt rules need
`admin`, which no organisation key holds: an organisation admin, signed in as a person, writes the organisation's and
projects' rules.

## Models through a LiteLLM gateway

A profile names a route, such as `default`, never a provider. Kantel's internal model gateway resolves the route to a
connector and attaches the connector's key from the vault.

A self-hosted deployment can reach a LiteLLM gateway as a platform connector with the `litellm` preset, set up in the
gateway's `KANTEL_MODEL_CONNECTORS`: its base URL, such as an in-cluster
`http://litellm.litellm.svc.cluster.local/v1`, and one LiteLLM key for the whole deployment, from a secret. See
[Connectors of any preset](/deploy/self-hosted/#connectors-of-any-preset) for the config and a Kubernetes example.

One key can serve every organisation and project, because each request says whose it is. The preset sends
`x-litellm-tags` with `organisation:<id>`, `project:<id>` (none for an organisation session), `agent:<id>` and
`session:<id>`, and `x-litellm-spend-logs-metadata` with `organisation_id`, `project_id`, `agent_id` and
`session_id`, so spend per organisation and project shows in LiteLLM's spend logs without a key per project.
OpenAI-style requests also carry the tags and the same IDs in the body's `metadata`. The IDs are Kantel's. The preset
takes the cost LiteLLM reports, and reads the catalogue from `/model/info`, where a catalogue override can name the
canonical model an alias stands for. Kantel's usage rows and `model.call` events record the connector, the cost and
the tokens as for any connector.

Connectors come only from the deployment's config: an organisation can't have its own connector, and no API route
creates one. The Cloudflare deployment reaches only CLIProxyAPI. See [Models](/console/models/).

## Showing a session's browser in your app

`POST /v1/sessions/{sessionId}/browsers/{browserSessionId}/embed` takes `{ mode, minutes? }` and answers
`{ url, mode, expiresAt?, endMessage? }`, a link for an iframe:

- `live` is a watch-only view of an open browser (a closed one is `expired`); `replay` plays its recording. An embed
  never gives control.
- `minutes` is a whole number from 5 to 60, default 15.
- The caller needs viewer on the session, and is never an agent. `browserSessionId` is the ID the session's browser
  tool items name.
- The token is in the URL after `#`, so it reaches no server. Treat the URL as a secret.
- Each link is audited as `browser.session.embedded` with its mode and minutes, never the link.

```ts
const embed = await kantel.embedBrowserSession("<session ID>", "<browser session ID>", { mode: "live", minutes: 15 });
// Frame embed.url until embed.expiresAt; the page posts embed.endMessage to its parent when the stream is over.
```

```sh
curl -s -X POST "$KANTEL_URL/v1/sessions/<session ID>/browsers/<browser session ID>/embed" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"mode": "replay", "minutes": 30}'
```

`KANTEL_EMBED_ORIGINS` lists the outside origins allowed to frame the page, beside the console (on Cloudflare,
`https://` origins without a path or wildcard). Replays need Kantel's own browsers (the `harbour` provider); with
brwsr, `replay` is `unavailable`. Self-hosted, set `KANTEL_PUBLIC_URL` so the link is made absolute against it. On
Cloudflare behind Access, `/browser/*` and `/v1/browser/view/*` need an Access bypass; the token is their
authentication. See [Browsers](/console/browsers/).

## Sharing your own resources

Sharing covers Kantel's own kinds and a host's. Your app registers each of its resources with its owner, then shares
it and handles access requests through the same `/v1/sharing` routes
([Projects and sharing](/console/projects-and-sharing/)).

`POST /v1/sharing/resources` takes `{ resource: { kind, id }, owner, name? }`. A host kind is lowercase words joined
by dots, such as `workflows.workflow`; Kantel's kinds and its components' prefixes (`memory.`, `skills.`, `vault.` and
others) are `invalid`. The caller needs `admin` where the resource lives, or an `approver` binding on it; agents can't
register. Registering again is idempotent, and a different owner is `conflict`.

```ts
await kantel.registerResource({
	resource: { kind: "workflows.workflow", id: "wf_month_end" },
	owner: { kind: "project", organisationId: "<organisation ID>", projectId: "<project ID>" },
	name: "Month-end close",
});
await kantel.createResourceShare({
	resource: { kind: "workflows.workflow", id: "wf_month_end" },
	grantee: { kind: "project", projectId: "<other project ID>" },
	permission: "use",
});
```

```sh
curl -s -X POST "$KANTEL_URL/v1/sharing/resources" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"resource": {"kind": "workflows.workflow", "id": "wf_month_end"},
       "owner": {"kind": "project", "organisationId": "<organisation ID>", "projectId": "<project ID>"}}'
```

Kantel keeps and audits the shares, requests and decisions. No Kantel component uses a host kind, so your app decides
what a share lets someone do, reading shares back with `GET /v1/sharing/shares?resourceKind=&resourceId=`.

## Skills carrying your data

`POST /v1/skills/import` loads a skill from your app's source as a new revision. Its `extensions` hold namespaced host
data that Kantel keeps but doesn't read, such as `myapp.workflows`; the console's skills page shows a badge per
namespace. Importing needs an organisation admin, or on Cloudflare a key with the `import` permission. See
[Packaging an agent](/api/packaging-an-agent/), and [Host tools](/api/host-tools/) for tools your app serves to its
agents.

## Approvals and cards

People approve connection requests and answer a session's cards in the
[console](/console/connection-requests/), not in a host app. To follow changes, stream each session; there are no
webhooks for changes across sessions.

<!-- Sources (8584d5b, rechecked at ba80016): packages/api/README.md:30-80, packages/api/src/schema.ts:178-190,882-915, packages/api/src/routes.ts:649-670, packages/api/generated/sdk.ts:427-460,465-479,503-521,681-694,809-825,1040-1058,1293-1314,1369-1384,1966-1981,2218-2223,2300-2330, packages/runtime/src/http/server.ts:620-665, packages/runtime/src/runtime.ts:536-612,1843-1867, packages/contracts/src/identity.ts:48-56,75-113,278-280,520-532, packages/identity/src/memory.ts:134-159, apps/cloudflare/src/gateway.ts:1-30,232-245,501-507, packages/contracts/src/models.ts:116-200, packages/models/src/presets.ts:137-200, apps/model-gateway/src/app.ts:1-50,145-155, apps/cloudflare/src/models.ts:1-25,125-150, apps/selfhosted/src/gateway/models.ts:1-20,127-145, packages/contracts/src/browser.ts:268-290, packages/browser/src/http.ts:1-25,140-165, packages/browser/src/memory.ts:1017-1053, packages/browser/CONTRACT.md:54-70, packages/browser/src/runtime/index.ts:30-62, apps/cloudflare/scripts/deploy-config.ts:95-101, apps/selfhosted/src/gateway/main.ts:38-45, apps/selfhosted/src/gateway/browser.ts:1-10, apps/selfhosted/src/gateway/gateway.ts:15-26,243-252,331, packages/contracts/src/sharing.ts:32-72,318-323, packages/sharing/src/rules.ts:207-216,459-490, packages/sharing/src/index.ts:45-58, packages/contracts/src/skills.ts:45-58,172-180, packages/ui/src/skills/skills-page.tsx:535-555, apps/cloudflare/src/import-access.ts:1-10, packages/vault/src/approval-api.ts:9-24 -->
