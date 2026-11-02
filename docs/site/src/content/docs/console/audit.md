---
title: Audit log
description: Read who did what in Kantel, filter the log, follow a row back to its session or browser, and query or export the events.
---

Kantel records what people, agents and the system do as audit events. The console's audit log at `/audit` shows them as a timeline, newest first, with filters and an export. Host apps read the same events over `GET /v1/audit/events`.

The log is append-only. Nothing but retention removes a row, and deleting a session or any other record leaves its events in place. Event data never holds a secret value.

## What is recorded

Each event has a type in the form `<source>.<noun>.<verb>`, an actor (a person, a host app's API key, an agent or a system component), the organisation, and where they apply, the project, session, agent and the record it is about (its subject). These are the main groups:

| Area | Event types include |
| --- | --- |
| Sessions | `session.created`, `session.prompted`, `session.steered`, `session.aborted`, `session.settled`, `session.tool.started`, `session.tool.finished` |
| Model calls | `model.call`, one per call that resolved a route |
| Sandboxes | `sandbox.lease.acquired`, `sandbox.lease.released`, `sandbox.escalated`, `sandbox.container.stopped` |
| Workspaces | `workspace.committed`, `workspace.write.refused`, `workspace.forked`, `workspace.hydrated` |
| Connections | `connections.item.created`, `connections.policy.created`, `connections.request.created`, `connections.decision.approved`, `connections.decision.denied`, `connections.grant.revoked`, `connections.egress.injected`, `connections.egress.denied`, and the connection's own `connections.connection.*` and `connections.use.*`. A disconnect's `connections.connection.removed` reads what the provider did: revoked, not supported, or failed |
| Browsers | `browser.grant.created`, `browser.session.opened`, `browser.session.closed`, `browser.session.shared`, `browser.site.refused` |
| Keys, roles and sign-in | `identity.key.issued`, `identity.key.revoked`, `identity.role.granted`, `identity.session.started`, `identity.passkey.reset`, `identity.invite.created`, `identity.invite.revoked`, `identity.invite.accepted` |
| Other components | `capability.*`, `skills.revision.published`, `memory.proposal.*`, `schedules.*`, `sharing.*` |
| Refusals | `access.denied` |

Connection events written before the Connections rename are stored as `vault.*` (`vault.decision.approved`, `vault.use.injected`) and keep that type. The console's filters show old and new together. For one release, a query for an old type or prefix such as `type=vault.use.` also returns the new events it was renamed to; ask for the new type, or both, from now on. The full table is in `packages/audit/CONTRACT.md`.

A `model.call` event is written by the model gateway. Its data holds the route, connector and model, the status, the duration, and the usage: input, output, cache read and cache write tokens, reasoning tokens when the upstream reports them, and cost. `costSource` says where the cost came from: `reported` by the upstream, `computed` from catalogue rates, or `none` (tokens only, as with CLIProxyAPI). The event never holds a prompt, a completion or a key.

## Who can read it

An organisation-wide `viewer` role or above sees the organisation's events. Someone with roles on some projects only sees the events of those projects. Agents can't read the log at all. See [Projects and sharing](/console/projects-and-sharing/) for roles.

A Connections event from a private session you can't open is redacted, in the API (`GET /v1/audit/events`, `GET /v1/audit/event`) and in the console, whichever connection it used. It keeps its type, its time, the connection and the person the session acted for (`data.redacted`, `actingUserId`, `connectionId`), names its actor as a private session (`{ kind: "system", component: "private-session" }`), and drops the session, project, agent, step, request, tool, reason and digest. The person the session acted for, whoever may open the session, and the owner of the person's connection it used see it whole. Other events, and Connections events from shared sessions, are not redacted.

## Filter the log

Open **Settings** > **Audit log**. The filters sit above the timeline:

| Filter | What it does |
| --- | --- |
| Organisation | Shown only when you belong to two or more organisations |
| When | Last hour, Last 24 hours, Today, Yesterday, Last 7 days, Last 30 days or All time |
| What | Everything, Credential uses, Approvals and denials, All connection events, Policy changes, Sandbox, Session lifecycle, Refused access, Browser, Keys and roles, or Capabilities |
| Credential | One vault item's uses, requests, approvals and policies |
| Who | One person, key, agent or component (Anyone by default) |
| Project, Agent, Session | Every project, Every agent and Every session by default |

A filter the console has no choices for is hidden. **Clear filters** keeps the organisation and the time range. The What filter has no option for model calls: pick Everything, or query the API with `type=model.call`.

With a credential picked, a panel above the timeline sums up its use in the range: the sessions that used it, how often, how many uses were refused, the first and last use, and who approved each grant those uses went through, linked to the vault request. Uses under a standing policy say so.

## Read a row

Rows are grouped under a heading for each day. Each row reads as a sentence: the time, a badge for the kind, the actor's name and what they did, then the project and session. The status line counts the events loaded, such as "200 events so far, newest first".

The chevron opens the stored event: its Type, At, Actor, Subject and Event (its ID and `seq`), and its data as JSON.

More rows load as you scroll; **Load older events** at the foot reads the next page. "Start of the log for these filters" means there are no more. When newer events arrive, a button such as "3 newer events" appears above the list rather than moving the rows under you.

## Follow a row back

Each row links to where it came from:

- Connection requests, approvals, denials and wrong codes link to the request on the connection request page (**Connection request**, `/connections/requests/<id>`).
- Session events, tool calls and credential uses link to the session. When the event names a turn, the link ends in `#turn=<id>` and the transcript opens at that turn.
- Browser events link to the session at that browser (**Browser**, `#browser=<id>`), so the transcript scrolls to its view.

An open browser event also has **This browser's history**, which filters the log to that browser session. The filter shows as Browser session; **Every browser** clears it.

## Export

**Export JSONL** writes every event the current filters match, one stored event per line exactly as the store returned it, to a file named `kantel-audit-<from>-to-<to>.jsonl`. **Cancel** stops it. If any page can't be read, nothing is saved and the page says so.

## Query the API

Two `GET` routes serve the log. They aren't in the OpenAPI document or the generated SDK yet; see [Unlisted routes](/api/reference/unlisted/).

- `GET /v1/audit/events` answers `{ items, nextCursor? }`.
- `GET /v1/audit/event?id=<id>` answers `{ event }`. The ID is a search parameter because sources choose IDs, and they may hold a `/`.

The search parameters for `/v1/audit/events`:

| Parameter | Meaning |
| --- | --- |
| `projectId`, `sessionId`, `agentId` | Narrow to one project, session or agent profile |
| `actorKind` with `actorId` | One actor: `human`, `service`, `agent` or `system`. Add `actorKeyId` for one key, `actorSessionId` for one agent session |
| `source`, `type` | A source, or a type: exact, or a prefix ending in `.` (`connections.` is every Connections event; an old `vault.` prefix also finds the renamed ones, for one release) |
| `types` | Up to 20 types or prefixes, comma-separated |
| `subjectKind` with `subjectId` | The record an event is about |
| `itemId`, `grantId` | Events about one vault item or grant |
| `from`, `to` | Epoch milliseconds; `from` is inclusive, `to` exclusive |
| `order` | `oldest` (default) or `newest` |
| `limit`, `cursor` | Page size (default 100, at most 500), and the `nextCursor` of the page before |

An unknown or repeated parameter is `400 invalid`. The organisation is always the caller's own; a person in several organisations names one with the `kantel-organisation` header.

```bash
curl -s "$KANTEL_URL/v1/audit/events?type=model.call&order=newest&limit=50" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

```ts
const url = new URL("/v1/audit/events", process.env.KANTEL_URL);
url.searchParams.set("sessionId", "ses_123");
url.searchParams.set("types", "session.tool.,connections.egress.,vault.use.");

const response = await fetch(url, {
	headers: { authorization: `Bearer ${process.env.KANTEL_API_KEY}` },
});
const { items, nextCursor } = await response.json();
```

Errors are `{ error: { code, message } }`, such as 403 `forbidden` for a project you can't view.

## Retention

Each deployment keeps audit rows indefinitely by default. The store can hold a retention period per organisation, but no API route or console page sets one.

## Usage analytics

Beside the `model.call` event, the model gateway writes one usage row per model call: tokens with the cache split, reasoning, images, cost in US dollars, status, and the session, agent, model, provider and connector. On Cloudflare the rows go to `usage_calls` in D1. Self-hosted, they go to `usage_calls` in Postgres, and optionally to ClickHouse as well (`KANTEL_CLICKHOUSE_URL`). Setting `KANTEL_USAGE=off` on either target stops writing them.

There is no usage page in the console and no usage API. Read `model.call` events from the audit log, or query the rows yourself; [Results and usage](/api/results-and-usage/) lists their columns.

<!-- Sources (8584d5b): apps/console/src/app/router.ts:1-37, apps/console/src/app/router.ts:147-153, apps/console/src/app/app.tsx:280-325, packages/ui/src/audit/audit-view.tsx:1-40, packages/ui/src/audit/audit-view.tsx:180-280, packages/ui/src/audit/audit-view.tsx:420-675, packages/ui/src/audit/audit-model.ts:40-65, packages/ui/src/audit/audit-model.ts:150-171, packages/ui/src/audit/audit-model.ts:265-290, packages/ui/src/audit/audit-model.ts:380-461, apps/console/src/api/audit-http.ts:1-95, packages/ui/docs/audit-view.md, packages/contracts/src/audit.ts:1-139, packages/contracts/src/audit.ts:140-186, packages/contracts/src/audit.ts:195-330, packages/audit/src/http.ts:59-64, packages/audit/src/sql.ts:39-40, packages/audit/src/sql.ts:268-276, packages/audit/CONTRACT.md:50-66, packages/contracts/src/models.ts:341-357, packages/contracts/src/models.ts:495-520, packages/contracts/src/identity.ts:193, packages/contracts/src/usage.ts:1-60, packages/usage/src/sql.ts, apps/cloudflare/src/audit-outbox.ts:1-15, apps/cloudflare/src/usage.ts:1-10, apps/cloudflare/src/stack.ts:393-395, apps/selfhosted/src/gateway/durable.ts:135, apps/selfhosted/src/gateway/usage.ts:26-28 -->
