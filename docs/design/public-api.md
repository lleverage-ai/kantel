# Public API

Issue #150. Harbour is the backend for other apps, Lleverage first, so it needs a public, versioned API. The console
uses it like any other client. This page maps each route to its contract call and records what is built. It grows
with each slice.

## How routes are defined

Each route is defined once in `@harbour/api` (`packages/api/src/routes.ts`), over JSON Schemas in
`packages/api/src/schema.ts` whose types are checked against `@harbour/contracts`. From those definitions:

- the server's router (`createRouter`) matches the request, checks its path, query and body, and calls the handler
  `@harbour/runtime/http` gives for that route;
- `packages/api/generated/openapi.json` is the OpenAPI 3.1 document;
- `packages/api/generated/sdk.ts` is the TypeScript SDK, one file with no imports.

CI fails while the generated files are stale (`pnpm --filter @harbour/api generate:check`). Routes not yet in the public
API are still served by `@harbour/runtime/http` as before (`packages/runtime/HTTP.md`) and move over slice by slice.

Why a package next to `@harbour/contracts` rather than in it: the contracts have no runtime dependencies, and the
schemas need TypeBox to build JSON Schema and check requests. TypeBox is what Pi uses for tool schemas, and its checker
uses no `eval`, so it runs in a Worker.

## Auth

v1 (built): every route takes `Authorization: Bearer hbr_…`, a host app's API key (#15). It acts as a `service`
actor, limited to the key's projects and role; `ProjectAccess` checks it on every call, as it does for people. Behind
Cloudflare Access the console's browser is signed in by Access's cookie and sends no header. A `system` actor is
refused over HTTP.

Planned, not built:

- **Token exchange.** The host's backend, holding its API key, asks for a short-lived token scoped to one user and one
  session, and the host's browser uses it to call Harbour directly (the stream and card responses, without proxying
  through the host).
- **External identities.** Users and organisations matched to the host's by external ID, so audit records the real
  person rather than the host's service.

## Session plane (v1)

| Route | Contract call | Status |
| --- | --- | --- |
| `POST /v1/sessions` | `SessionRuntime.create` | In the public API |
| `GET /v1/sessions` | `SessionDirectory.list` | In the public API |
| `GET /v1/sessions/{sessionId}` | `SessionDirectory.get` | In the public API |
| `POST /v1/sessions/{sessionId}/close` | `SessionRuntime.close` | In the public API |
| `POST /v1/sessions/{sessionId}/abort` | `SessionRuntime.abort` | In the public API |
| `POST /v1/sessions/{sessionId}/messages` | `prompt`, `steer` or `followUp` by `via`, with an idempotency key | Next |
| `WS /v1/sessions/{sessionId}/stream` | `SessionRuntime.watch`, `@harbour/protocol` frames | Next |
| Presigned upload into the session workspace | `Workspaces` | Next |
| `POST /v1/sessions/{sessionId}/cards/{cardId}/respond` | the card's owner (vault, questions, browser grants) | Next |
| `GET /v1/skills` | `Skills.list` (the project named and the calling person's own) | In the public API |
| `GET /v1/skills/{skillId}` | `Skills.get` | In the public API |
| `GET /v1/skills/{skillId}/revisions` | `Skills.listRevisions` | In the public API |
| `GET /v1/skills/{skillId}/revisions/{revision}` | `Skills.getRevision` | In the public API |
| `GET /v1/skills/{skillId}/revisions/{revision}/file?path=` | `Skills.readFile` | In the public API |
| `POST /v1/skills/import` | `Skills.importRevision` (a host's skill source) | In the public API |
| `GET /v1/memory/spaces`, `POST /v1/memory/spaces` | `Memory.listSpaces`, `Memory.createSpace` | In the public API |
| `GET /v1/memory/spaces/{spaceId}/concepts` | `Memory.listConcepts` | In the public API |
| `GET /v1/memory/spaces/{spaceId}/concepts/{conceptId}` | `Memory.getConcept` (the ID's slashes encoded) | In the public API |
| `POST /v1/memory/search`, `POST /v1/memory/recall` | `Memory.search`, `Memory.recall` | In the public API |
| `POST /v1/memory/spaces/{spaceId}/snapshot` | `Memory.importSnapshot` (a host's memory source) | In the public API |
| Memory proposals and decisions | `Memory.propose`, `Memory.decide` (#25) | Later |

## Vault approvals in a host app

Not built yet; see #150 for the three paths (inline in the host with a passkey, from a link, and Harbour-hosted popups
for secrets and OAuth).
