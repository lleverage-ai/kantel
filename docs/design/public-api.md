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
| `POST /v1/sessions` | `SessionRuntime.create`, then `prompt` with `message` when there is one | In the public API |
| `GET /v1/sessions` | `SessionDirectory.list` | In the public API |
| `GET /v1/sessions/{sessionId}` | `SessionDirectory.get` | In the public API |
| `POST /v1/sessions/{sessionId}/close` | `SessionRuntime.close` | In the public API |
| `POST /v1/sessions/{sessionId}/abort` | `SessionRuntime.abort` | In the public API |
| `POST /v1/sessions/{sessionId}/warm` | The host's warmer (Cloudflare: `StackSandboxes.warm`); a hint, idempotent | In the public API |
| `POST /v1/sessions/{sessionId}/messages` | `prompt`, `steer` or `followUp` by `via`; `Idempotency-Key` is the input's `requestId` | In the public API |
| `GET /v1/sessions/{sessionId}/stream` (WebSocket or SSE) | `SessionRuntime.watch`, `@harbour/protocol` frames | In the public API |
| `GET /v1/sessions/{sessionId}/history` | `SessionHistory.history` | In the public API |
| Presigned upload into the session workspace | `Workspaces` | Next |
| `POST /v1/sessions/{sessionId}/browsers/{browserSessionId}/embed` | a live or replay view link for an iframe ([browser runtime](browser-runtime.md)) | Next |
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

### Creating a session

`POST /v1/sessions` takes the project, the agent profile, an optional existing `workspaceId`, `labels` and an optional
first `message`. The host's own reference for the session goes in `labels` (such as `{ lleverageRunId: "run-42" }`),
which `GET /v1/sessions?label.lleverageRunId=run-42` finds again; there's no separate external-ref field. A first
message is sent as a prompt once the session exists and its submission comes back with the session. If it's refused (an
unknown model, say) the session is closed and the refusal answered, so no idle session is left behind. A seeded
workspace is still made first with `POST /v1/workspaces` (not yet in the public API), and its ID passed in.

### Messages and idempotency

`POST /v1/sessions/{sessionId}/messages` takes `{ via?, text, model?, thinking? }` (`via` defaults to `prompt`) and
answers 202 with the `Submission`. The answer itself arrives on the session's stream. An `Idempotency-Key` header
becomes the input's `requestId`, which the runtime already deduplicates per session (the runtime conformance case
"returns the same submission for a retried requestId and asks the model once"): a replay answers the first submission
and submits nothing, before or after the run ends. A key reused for a different `via` is `conflict`. The SDK sends it
from `options.idempotencyKey`. Attachments wait for workspace uploads: they will be workspace paths, not message blobs.

### Stream and history

`GET /v1/sessions/{sessionId}/stream` is the session's `@harbour/protocol` stream: `hello`, then a `snapshot` (or,
with `?after=<cursor>`, the deltas since when the stream still holds them), then live `delta`s, which the protocol's
`applyFrames` folds. It's the same handler as the console's `/sessions/:id/events`: over a WebSocket when the request
upgrades (each message a JSON array of frames, `[]` a keep-alive, `permessage-deflate` where the platform offers it, as
in #147), and as server-sent events otherwise. The OpenAPI document describes the frames as the 101 answer's schema
and the SSE answer's, and the type tests check them against `@harbour/protocol`'s types. The SDK's
`streamSession(sessionId, handlers, { after })` opens the WebSocket and tracks the latest cursor to resume from; in
Node it sends the bearer as a header, and in a browser (which can't) it needs a cookie session until token exchange.
A refused or unknown session is a JSON error before any socket opens. `GET /v1/sessions/{sessionId}/history` pages
back past a snapshot's items, newest first. The stream sends nothing org-wide: a host that wants every session's
changes uses webhooks, later.

## Resource sharing (v1)

Built: `/v1/sharing/…` (`sharingRoutes`, served by `@harbour/sharing/http`), one route per `Sharing` call: shares,
access requests and their decisions, bindings, per-resource policy, host resource registration and a session's uses.
The routes and their rules are in [sharing.md](sharing.md#public-api). A host's key acts as its service: it can read
and request within its projects, and share or decide only where its role gives it authority over the resource.

## Vault approvals in a host app

Not built yet; see #150 for the three paths (inline in the host with a passkey, from a link, and Harbour-hosted popups
for secrets and OAuth).
