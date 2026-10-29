# @harbour/api

Harbour's public API, defined once (#150). Each route is written one time, in `src/routes.ts`, over the wire shapes
in `src/schema.ts` (JSON Schema with [TypeBox](https://github.com/sinclairzx81/typebox), which Pi already uses for tool
schemas). Everything else is made from those definitions:

| What | Where | Made by |
| --- | --- | --- |
| The server's routing and request checks | `createRouter(routes, handlers)` (`src/router.ts`) | `@harbour/runtime/http`'s `createSessionApi` uses it |
| The OpenAPI 3.1 document | `generated/openapi.json` (`@harbour/api/openapi.json`) | `pnpm --filter @harbour/api generate` |
| The TypeScript SDK | `generated/sdk.ts` (`@harbour/api/sdk`) | the same |

The console uses the public API like any other client, so anything it can do a host app can do too.

## Adding a route

1. Add its schemas to `src/schema.ts`, each named with a `title`, and a type check in `test/types.test.ts` against its
   type in `@harbour/contracts`.
2. Add the route to `src/routes.ts` with `defineRoute` and list it in `routes`.
3. `pnpm typecheck` now fails until the server gives it a handler (`createRouter` takes one per route).
4. Run `pnpm --filter @harbour/api generate` and commit `generated/`. CI runs `generate:check`, which fails while the
   generated files are stale.

## The router

`createRouter(routes, handlers, { basePath })` returns `(ctx, request) => Promise<Response | undefined>`. It matches by
method and path (`/sessions/{sessionId}`), checks path parameters, query and body against the route's schemas and
answers a mismatch with an `invalid` `HarbourError` naming the field (`body agentId: must be string`). Body properties
the schema doesn't name are dropped before the handler sees them, so a caller can't slip a field past the contract.
Query values are converted by the schema (`limit=20` is a number), and `<name>.<key>=<value>` is gathered into a record
when the schema has a `name` property (`label.ref=a`). A handler returns the route's output, which is sent as JSON with
the route's status (no body for 204), or a `Response` of its own for a stream or an upgrade. A request no route matches
resolves `undefined`, so the server can answer its other routes. Authentication is the server's: it signs the caller
in first and passes the context.

## The SDK

`generated/sdk.ts` is one file with no imports: the named types, a small `fetch` runtime (`src/sdk-runtime.ts`, copied
in) and `createHarbourClient`, with one method per route. Path parameters come first, then the body, then the query,
then per-call options (`signal`, `requestId`, `headers`).

```ts
import { createHarbourClient, HarbourApiError } from "@harbour/api/sdk";

const harbour = createHarbourClient({ baseUrl: "https://harbour.example/v1", token: process.env.HARBOUR_API_KEY });
const session = await harbour.createSession({ projectId: "proj-docs", agentId: "assistant", labels: { ref: "run-42" } });
await harbour.abortSession(session.id, { reason: "The user stopped it" });
```

An error answer rejects with a `HarbourApiError` carrying the HTTP status and Harbour's error code (`not_found`,
`invalid`, `unauthenticated`, …).

## Auth

Every route takes a bearer: a host app's API key (`hbr_…`, issued on the API keys page or with `POST /v1/keys`), which
acts as a `service` actor limited to the key's projects and role (#15). Behind Cloudflare Access a person's browser is
signed in by Access's cookie instead and sends no header; that is how the console calls it. Short-lived tokens scoped
to a user and a session, for a host's browser to call Harbour directly, come later (see `docs/design/public-api.md`).
