# Session API over HTTP

`@harbour/runtime/http` serves the session runtime contracts (`SessionRuntime`, `SessionDirectory`, `AgentProfiles`,
`HostToolBridge`) over HTTP as one portable fetch handler, and gives host apps a client that implements the same
contracts over it. It imports only `@harbour/contracts`, `@harbour/protocol` and `@harbour/api`, never Pi, so it runs
in a Worker, a Durable Object, Bun or Node, and a host app can import the client and the callback endpoint on their own.

```ts
import { createAuthenticator } from "@harbour/identity/authenticator";
import { createSessionApi } from "@harbour/runtime/http";

const authenticator = createAuthenticator({ identity });
const api = createSessionApi({ runtime, directory, profiles, hostTools, authenticator });
Bun.serve({ fetch: api.fetch }); // or `export default { fetch: api.fetch }` in a Worker
```

The conformance suite runs through the client against the in-memory runtime twice: in process
(`test/http.conformance.test.ts`) and over real sockets (`test/http.network.test.ts`).

## Who is calling

The server takes the caller from the deployment's `Authenticator`, the contract every Harbour API takes (M1-BE7):
`createAuthenticator` from `@harbour/identity/authenticator` in production. It never reads an actor or organisation
from the request itself. `staticTokenAuthenticator` is for tests and local development.

A missing or invalid credential is 401 with a `WWW-Authenticate` challenge; an organisation the caller may not act in
is 403. A `system` actor is refused with 401 too: Harbour's own components call the runtime directly. Every other
check is the runtime's own project-access check, so deploy the API only over a runtime given `identity`.
`harbour-request-id` becomes the call's `requestId`.

A call's context does not carry the request's abort signal: a run a prompt admits outlives the request that sent it.
Only `result` (its wait stops, answering `aborted`) and `events` (its watch closes) end with their request.

## Routes

Every route is under `/v1` (`basePath` changes it). Bodies are JSON, at most 1 MiB.

The routes in Harbour's public API are defined once in `@harbour/api` (`packages/api/src/routes.ts`), with their
schemas; the server answers them through that package's router, which checks the path, query and body before the
contract call, and the OpenAPI document and TS SDK are generated from the same definitions. They are `POST /sessions`,
`GET /sessions`, `GET /sessions/:id`, `POST /sessions/:id/abort`, `POST /sessions/:id/close` and
`POST /sessions/:id/messages` (prompt, steer or follow-up by `via`, with an `Idempotency-Key`) so far. The rest of
this table moves there route by route (#150); until then those routes are served as before.

| Route | Contract call | Answer |
| --- | --- | --- |
| `POST /sessions` | `runtime.create` (body `CreateSessionInput`) | 201 `SessionRecord` |
| `GET /sessions?projectId&agentId&status&parentSessionId&label.<key>=<value>&limit&cursor` | `directory.list` | `Page<SessionRecord>` |
| `GET /sessions/:id` | `directory.get` | `SessionRecord` |
| `GET /sessions/:id/children` | `directory.children` | `{ items }` |
| `GET /sessions/:id/snapshot` | `runtime.snapshot` | `SessionSnapshot` |
| `GET /sessions/:id/history?cursor&before&limit` | `history.history`, when the API has `history` | `SessionHistoryPage` |
| `GET /sessions/:id/models` | `models.modelState`, when the API has `models` | `SessionModelState` |
| `POST /sessions/:id/prompt`, `/steer`, `/follow-up` | `prompt`, `steer`, `followUp` (body `{ text, requestId?, model?, thinking? }`) | 202 `Submission` |
| `POST /sessions/:id/abort` | `runtime.abort` (body `{ reason? }`) | 204 |
| `POST /sessions/:id/close` | `runtime.close` | 204 |
| `GET /sessions/:id/result?submission=<id>&timeoutMs=` | `runtime.wait` | `RunResult`, or 202 `{ status: "pending" }` |
| `GET /sessions/:id/events?after=<cursor>` | `runtime.watch` | `text/event-stream` |
| `PUT /profiles/:agentId` | `profiles.put` (body `AgentProfile`) | `AgentProfile` |
| `GET /profiles/:agentId`, `GET /profiles?limit&cursor` | `profiles.get`, `profiles.list` | `AgentProfile`, `Page` |
| `GET /profiles/:agentId/models?projectId=` | `models.startModels`, when the API has `models` | `SessionModelState` |
| `PUT /hosts/:hostId` | `hostTools.register` (body below) | `{ hostId, registration, tools, secret? }` |
| `GET /hosts/:hostId/tools` | `hostTools.list` | `{ items }` |
| `DELETE /hosts/:hostId?registration=<id>` | closes the registration | 204 |

Errors are `{ error: { code, message, details? } }` with the HarbourError code: `invalid` 400, `forbidden` 403,
`not_found` 404, `conflict` and `aborted` 409, `expired` 410, `refused` 422, `exhausted` 429, `not_supported` 501,
`unavailable` 503. Any other error is a bare 500 `unavailable`, never its message. The client turns each back into a
`HarbourError` with the same code.

`history` is the transcript in pages, newest first (`SessionHistory`, proposed). With no query it is the latest
`limit` items (default 50, at most 200); `?cursor=` takes a page's `nextCursor` and `?before=<item id>` pages back
from an item a client already holds, such as a snapshot's first. A cursor names an item, not an offset, so pages
behind it stay the same while new turns arrive. The API serves it only when it is given `history` (the runtime's);
without it the route is `not_found`.

`models` is what a client's model and thinking pickers show (`SessionModels`, proposed): the models the session may
name, what it runs with now (`selected`) and what its agent profile names (`defaults`). On a profile it is what a new
session in `projectId` would get, so a New session screen can offer the choice; the first prompt carries it. A prompt's
`model` and `thinking` stay with the session for its later runs (and from a steer's next model call); an unknown model
or level is `invalid`, and a level the model lacks runs as its nearest one. Without `models` both routes are
`not_found` and prompts still take the fields.

`result` waits up to `timeoutMs` (default 25 s, at most 120 s) and answers 202 while the run goes on; the client polls
until it ends. Submission IDs hold a `/`, which is why they go in the query.

## Watching

`events` is `watch` as server-sent events. Each protocol frame is one event named after its type (`hello`, `snapshot`,
`delta`, `error`) with the `ServerFrame` as its JSON data. Snapshot and delta events carry their cursor as the event
ID, so a reconnecting `EventSource` resumes with `Last-Event-ID` (or pass `?after=`). After the first frames (hello,
then a snapshot or the missed deltas) the server sends one `ready` event, which tells a client it has caught up; a
comment every 15 s keeps idle connections open. A refused or unknown session is a JSON error, not a stream.
`EventSource` cannot send an `Authorization` header, so a browser reads the stream with `fetch` (and `readSse`) or
authenticates with a cookie.

The same route upgrades to a WebSocket when the request asks (`Upgrade: websocket`) and the API was given
`acceptWebSocket` (`ws.ts`; the Cloudflare gateway's Durable Object gives it a `WebSocketPair`). The watch opens before
the upgrade is accepted, so a refused or unknown session is the same JSON error and no socket opens. Each message is
a JSON array of the frames the watch gave in one turn of the event loop (hello and the snapshot arrive together); an
empty array every 15 s keeps the socket open. Resume by reconnecting with `?after=<cursor>`; the client sends
nothing. Workers negotiate `permessage-deflate` with the browser by themselves, so the frames travel compressed, the
window shared across messages. A browser can't put an `Authorization` header on a socket either: it authenticates with
a cookie (behind Access), and a client holding a bearer reads the event stream. Without `acceptWebSocket` an upgrade
gets the event stream, which a WebSocket client takes as a failed handshake.

## Host tools over signed callbacks

A host registers its tools with a callback URL and a secret of at least 32 characters (one is generated and returned
once when none is given):

```json
{ "projectId": "proj-docs", "tools": [{ "name": "task_outcome", "description": "…", "inputSchema": {}, "replay": "unsafe" }],
  "callback": { "url": "https://sal.example/harbour/tools/sal", "secret": "…" } }
```

The runtime then POSTs each `HostToolCall` to the URL and reads a `HostToolResult` back. Each request carries
`harbour-signature: t=<epoch ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, plus `harbour-host-id` and
`harbour-call-id`; the call ID is stable across retries, so a host can make unsafe tools idempotent by it.
`createHostToolEndpoint(handler, { secret })` is the host side: it checks the signature in constant time (and refuses
one more than five minutes off), runs the handler with the request's abort signal and answers with its result.
Aborting the call aborts the request, so the handler's signal aborts. Redirects are not followed, a host that answers
with an error status or is unreachable fails the call (the model gets an error result), and a call fails after ten
minutes (`callbackTimeoutMs`).

Callback URLs are `https:` only by default; a deployment should narrow `allowCallbackUrl` to its hosts, since Harbour
calls whatever is registered. Only the credential that registered a host may `DELETE` it (for a service, the same
API key, not just the same service); another operator on the project may replace it with `PUT`, as
`hostTools.register` allows. Each `PUT` answers a new `registration` ID, which `DELETE` must name (400 without it):
`DELETE …?registration=<id>` removes the host only while that registration is the current one (404 otherwise), so an
old client closing its subscription never removes the registration that replaced it. A subscription whose close fails
(the API unreachable) can be closed again to retry.

`PUT /profiles/:agentId` checks the profile's shape (name, model route, prompt layers, tool, skill and memory-scope
lists, sandbox tiers) and answers 400 for a malformed one, so it never reaches storage.

The client's `hostTools.register(ctx, hostId, tools, handler)` does all of this: it makes a secret, serves the
endpoint through `hostCallbacks.serve` before registering, and removes both when the subscription closes.

## Not yet

Without the `hosts` option, registrations live only as long as the API instance. With it (the runtime's `hosts`, and
the runtime given `hostHandler: callbackHostHandlers({ fetch })`), each one is stored with its callback and secret,
survives restarts, and is removed only by `DELETE` from the same caller. History paging is not served (the
runtime contract has no `history` yet). There is no CORS handling; serve the console from the same origin or proxy it.
