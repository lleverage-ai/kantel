# Session API over HTTP

`@harbour/runtime/http` serves the session runtime contracts (`SessionRuntime`, `SessionDirectory`, `AgentProfiles`,
`HostToolBridge`) over HTTP as one portable fetch handler, and gives host apps a client that implements the same
contracts over it. It imports only `@harbour/contracts` and `@harbour/protocol`, never Pi, so it runs in a Worker, a
Durable Object, Bun or Node, and a host app can import the client and the callback endpoint on their own.

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

| Route | Contract call | Answer |
| --- | --- | --- |
| `POST /sessions` | `runtime.create` (body `CreateSessionInput`) | 201 `SessionRecord` |
| `GET /sessions?projectId&agentId&status&parentSessionId&label.<key>=<value>&limit&cursor` | `directory.list` | `Page<SessionRecord>` |
| `GET /sessions/:id` | `directory.get` | `SessionRecord` |
| `GET /sessions/:id/children` | `directory.children` | `{ items }` |
| `GET /sessions/:id/snapshot` | `runtime.snapshot` | `SessionSnapshot` |
| `POST /sessions/:id/prompt`, `/steer`, `/follow-up` | `prompt`, `steer`, `followUp` (body `{ text, requestId? }`) | 202 `Submission` |
| `POST /sessions/:id/abort` | `runtime.abort` (body `{ reason? }`) | 204 |
| `POST /sessions/:id/close` | `runtime.close` | 204 |
| `GET /sessions/:id/result?submission=<id>&timeoutMs=` | `runtime.wait` | `RunResult`, or 202 `{ status: "pending" }` |
| `GET /sessions/:id/events?after=<cursor>` | `runtime.watch` | `text/event-stream` |
| `PUT /profiles/:agentId` | `profiles.put` (body `AgentProfile`) | `AgentProfile` |
| `GET /profiles/:agentId`, `GET /profiles?limit&cursor` | `profiles.get`, `profiles.list` | `AgentProfile`, `Page` |
| `PUT /hosts/:hostId` | `hostTools.register` (body below) | `{ hostId, registration, tools, secret? }` |
| `GET /hosts/:hostId/tools` | `hostTools.list` | `{ items }` |
| `DELETE /hosts/:hostId?registration=<id>` | closes the registration | 204 |

Errors are `{ error: { code, message, details? } }` with the HarbourError code: `invalid` 400, `forbidden` 403,
`not_found` 404, `conflict` and `aborted` 409, `expired` 410, `refused` 422, `exhausted` 429, `not_supported` 501,
`unavailable` 503. Any other error is a bare 500 `unavailable`, never its message. The client turns each back into a
`HarbourError` with the same code.

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
