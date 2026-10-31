---
title: How Lleverage uses Partan
description: How Lleverage runs its agents on Partan through the public API, which parts of that integration are built and which are designed only.
---

Lleverage is the first app Partan's public API was built for. Lleverage's backend calls Partan with an API key, and
Partan runs the agents: their sessions, models, browsers, skills, memory and vault. This page describes the
integration as Partan's repository records it, and says which parts are built and which are designed only. The same
pieces are open to any host app. Package and variable names still use the old name, `harbour`.

## Status

| Part | Status |
| --- | --- |
| A project API key (`hbr_…`) for the host app | Built |
| An organisation API key for the host app, at most `operator` | Built |
| A Partan project for each Lleverage project (`POST /v1/projects`) | Built |
| Sessions labelled with Lleverage's own references | Built |
| Organisation-wide agents beside project ones | Built |
| Models through Lleverage's LiteLLM gateway | The `litellm` preset is built; no deployment can add an organisation's connector yet |
| A session's browser framed in Lleverage's app | Built |
| Sharing Lleverage's own resources | Built |
| Skills carrying Lleverage's data | Built |
| Creating organisations over the API | Not built; each deployment makes its organisation when it starts |
| Token exchange (a short-lived token for one user and session) | Planned |
| External identities (users matched to the host's by external ID) | Planned |
| Connection approvals inside the host's app | Not built; people approve in the [console](/console/connection-requests/) |
| Answering a session's cards from the host | Not built |
| Webhooks for changes across sessions | Not built |

Each unbuilt part is on the [gaps page](/gaps/).

## Calling Partan

Lleverage's backend sends `Authorization: Bearer hbr_…` on every call. The key acts as a `service` in one
organisation. Lleverage uses an **organisation key**: one role, `operator`, across the organisation and every project
in it, with the `create_projects` permission. An organisation admin, signed in as a person, issues it on the console's
API keys page ("Whole organisation", "Can create projects") or with `POST /v1/keys`; see
[Authentication](/api/authentication/#organisation-keys). A host app that should stay out of some projects uses
project keys instead, each with one role on the projects it lists and nothing outside them.

## A Partan project for each Lleverage project

When a Lleverage project is made, the backend creates a Partan project for it, keeps the returned ID beside its own,
and runs that project's sessions there. The organisation key holds its role on the new project at once, and the
project is audited as `identity.project.created` with the key as its actor.

```ts
const project = await partan.createProject({ name: "Invoices" });
// { id, organisationId, name: "Invoices", createdAt }
```

```sh
curl -s -X POST "$PARTAN_URL/v1/projects" -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" -d '{"name": "Invoices"}'
```

The organisation itself is made when the deployment starts; no route creates one.

The key stays on the server. A browser can't put the key on a WebSocket as a header, so a page in Lleverage's app
can't stream from Partan directly until token exchange exists.

## Sessions labelled with Lleverage's references

A session has no separate external-reference field. Lleverage puts its own reference in `labels`, such as
`{ lleverageRunId: "run-42" }`, and finds the session again with `GET /v1/sessions?label.lleverageRunId=run-42`. A
first `message` is sent as a prompt once the session exists; if it is refused, the session is closed and the refusal
answered, so no idle session is left behind.

```ts
import { createHarbourClient } from "@harbour/api/sdk";

const partan = createHarbourClient({ baseUrl: `${process.env.PARTAN_URL}/v1`, token: process.env.PARTAN_API_KEY });

const session = await partan.createSession({
	projectId: "<project ID>",
	agentId: "<agent ID>",
	labels: { lleverageRunId: "run-42" },
	message: { text: "Summarise the open invoices" },
});
const { items } = await partan.listSessions({ label: { lleverageRunId: "run-42" } });
```

```sh
curl -s -X POST "$PARTAN_URL/v1/sessions" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"projectId": "<project ID>", "agentId": "<agent ID>",
       "labels": {"lleverageRunId": "run-42"}, "message": {"text": "Summarise the open invoices"}}'

curl -s "$PARTAN_URL/v1/sessions?label.lleverageRunId=run-42" -H "authorization: Bearer $PARTAN_API_KEY"
```

`userId` names the person a session works for (a host app may name any user); it picks the user layer of skills and
prompt rules. Partan has no field for a host's own user IDs, so the host keeps that mapping. See
[Quick start](/api/quick-start/) and [Streaming](/api/streaming/).

## Organisation-wide agents beside project ones

Lleverage needs agents for the whole organisation as well as agents for one project. A session is scoped to a project,
or to the organisation with `scope: "organisation"` and no `projectId`. An agent profile with no `projectId` is
organisation-wide: it runs in every project and in organisation sessions, while a project's profile runs only in its
project. An organisation session's agent sees what the organisation owns and the session user's own records, and
nothing a project owns unless that project shares it.

Partan adds no system prompt of its own. A session's system prompt is its prompt rules and its profile's prompt
layers, in the order platform, organisation, project, profile, user (an organisation session has no project layer).
On the first prompt it also gets its skills listing and recall from its memory spaces. See
[Prompt rules](/console/prompt-rules/).

Lleverage's organisation key creates and lists organisation sessions (`scope: "organisation"`) and puts
organisation-wide profiles, as an organisation `operator`. A project key can start project sessions that run an
organisation-wide profile, but can't do those.

Prompt rules need `admin`, which no organisation key holds: an organisation admin, signed in as a person, writes the
organisation's and projects' rules.

## Models through Lleverage's LiteLLM gateway

A profile names a route, such as `default`, never a provider. Partan's internal model gateway resolves the route to a
connector, which belongs to the platform or an organisation, and attaches the connector's key from the vault.

As designed, Lleverage's organisation has one connector with the `litellm` preset: the base URL of Lleverage's LiteLLM
gateway, and one LiteLLM virtual key for the organisation as a vault item, so its team and budget setup in LiteLLM
keeps working. The preset is built. It sends `x-litellm-tags` with `organisation:<id>`, `project:<id>` (none for an
organisation session), `agent:<id>` and `session:<id>`, so spend per project shows in LiteLLM without a key per
project; OpenAI-style requests also carry the tags in the body's `metadata`. It takes the cost LiteLLM reports, and
reads the catalogue from `/model/info`, where a catalogue override can name the canonical model an alias stands for.

:::note[Not yet available]
No deployment can add an organisation's connector yet. The Cloudflare and self-hosted deployments each configure one
platform connector, to CLIProxyAPI, from their environment, and no API route creates a connector. See
[Models](/console/models/).
:::

## Showing a session's browser in Lleverage's app

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
const embed = await partan.embedBrowserSession("<session ID>", "<browser session ID>", { mode: "live", minutes: 15 });
// Frame embed.url until embed.expiresAt; the page posts embed.endMessage to its parent when the stream is over.
```

```sh
curl -s -X POST "$PARTAN_URL/v1/sessions/<session ID>/browsers/<browser session ID>/embed" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"mode": "replay", "minutes": 30}'
```

`HARBOUR_EMBED_ORIGINS` lists the outside origins allowed to frame the page, beside the console (on Cloudflare,
`https://` origins without a path or wildcard). Replays need Partan's own browsers (the `harbour` provider); with
brwsr, `replay` is `unavailable`. Self-hosted, set `HARBOUR_PUBLIC_URL` so the link is made absolute against it. On
Cloudflare behind Access, `/browser/*` and `/v1/browser/view/*` need an Access bypass; the token is their
authentication. See [Browsers](/console/browsers/).

## Sharing Lleverage's own resources

Sharing covers Partan's own kinds and a host's. A host registers each of its resources with its owner, then shares it
and handles access requests through the same `/v1/sharing` routes
([Projects and sharing](/console/projects-and-sharing/)).

`POST /v1/sharing/resources` takes `{ resource: { kind, id }, owner, name? }`. A host kind is lowercase words joined
by dots, such as `workflows.workflow`; Partan's kinds and its components' prefixes (`memory.`, `skills.`, `vault.` and
others) are `invalid`. The caller needs `admin` where the resource lives, or an `approver` binding on it; agents can't
register. Registering again is idempotent, and a different owner is `conflict`.

```ts
await partan.registerResource({
	resource: { kind: "workflows.workflow", id: "wf_month_end" },
	owner: { kind: "project", organisationId: "<organisation ID>", projectId: "<project ID>" },
	name: "Month-end close",
});
await partan.createResourceShare({
	resource: { kind: "workflows.workflow", id: "wf_month_end" },
	grantee: { kind: "project", projectId: "<other project ID>" },
	permission: "use",
});
```

```sh
curl -s -X POST "$PARTAN_URL/v1/sharing/resources" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"resource": {"kind": "workflows.workflow", "id": "wf_month_end"},
       "owner": {"kind": "project", "organisationId": "<organisation ID>", "projectId": "<project ID>"}}'
```

Partan keeps and audits the shares, requests and decisions. No Partan component uses a host kind, so the host's app
decides what a share lets someone do, reading shares back with `GET /v1/sharing/shares?resourceKind=&resourceId=`.

## Skills carrying Lleverage's data

`POST /v1/skills/import` loads a skill from a host's source as a new revision. Its `extensions` hold namespaced host
data that Partan keeps but doesn't read, such as `lleverage.workflows`; the console's skills page shows a badge per
namespace ("lleverage data"). Importing needs an organisation admin, or on Cloudflare a key with the `import`
permission. See [Packaging an agent](/api/packaging-an-agent/), and [Host tools](/api/host-tools/) for tools the
host's app serves to its agents.

<!-- Sources (8584d5b): docs/design/public-api.md:1-61,96-178, docs/model-connectors.md:170-180,200-245,350-358, docs/design/org-scope.md:1-60,70-100,140-160,240-262, docs/design/org-api-keys.md:1-60, docs/design/browser-runtime.md:100-117, docs/design/sharing.md:1-30,128-160, packages/api/README.md:30-80, packages/api/src/schema.ts:178-190,882-915, packages/api/src/routes.ts:649-670, packages/api/generated/sdk.ts:427-460,465-479,503-521,681-694,809-825,1040-1058,1293-1314,1369-1384,1966-1981,2218-2223,2300-2330, packages/runtime/src/http/server.ts:620-665, packages/runtime/src/runtime.ts:536-612,1843-1867, packages/contracts/src/identity.ts:48-56,75-113,278-280,520-532, packages/identity/src/memory.ts:134-159, apps/cloudflare/src/gateway.ts:1-30,232-245,501-507, packages/contracts/src/models.ts:116-200, packages/models/src/presets.ts:137-200, apps/model-gateway/src/app.ts:1-50,145-155, apps/cloudflare/src/models.ts:1-25,125-150, apps/selfhosted/src/gateway/models.ts:1-20,127-145, packages/contracts/src/browser.ts:268-290, packages/browser/src/http.ts:1-25,140-165, packages/browser/src/memory.ts:1017-1053, packages/browser/CONTRACT.md:54-70, packages/browser/src/brwsr.ts:1-260, packages/browser/src/runtime/index.ts:30-62, apps/cloudflare/scripts/deploy-config.ts:95-101, apps/selfhosted/src/gateway/main.ts:38-45, apps/selfhosted/src/gateway/browser.ts:1-10, apps/selfhosted/src/gateway/gateway.ts:15-26,243-252,331, packages/contracts/src/sharing.ts:32-72,318-323, packages/sharing/src/rules.ts:207-216,459-490, packages/sharing/src/index.ts:45-58, packages/contracts/src/skills.ts:45-58,172-180, packages/ui/src/skills/skills-page.tsx:535-555, apps/cloudflare/src/import-access.ts:1-10, packages/vault/src/approval-api.ts:9-24 -->
