# @kantel/api

Kantel's public API, defined once. Each route is written one time, in `src/routes.ts`, over the wire shapes
in `src/schema.ts` (JSON Schema with [TypeBox](https://github.com/sinclairzx81/typebox), which Pi already uses for tool
schemas). Everything else is made from those definitions:

| What | Where | Made by |
| --- | --- | --- |
| The server's routing and request checks | `createRouter(routes, handlers)` (`src/router.ts`) | `@kantel/compute/http` serves `computeRoutes`; the dormant `@kantel/browser/http` and `@kantel/environments/http` serve `browserRoutes` and `environmentRoutes` |
| The OpenAPI 3.1 document | `generated/openapi.json` (`@kantel/api/openapi.json`) | `pnpm --filter @kantel/api generate` |
| The TypeScript SDK | `generated/sdk.ts` (`@kantel/api/sdk`) | the same |

The console uses the public API like any other client, so anything it can do a host app can do too.

`routes` holds the compute plane's routes, the projects list, and the browser and environment routes of the dormant
libraries. The agent plane's routes (sessions, skills, memory, schedules, sharing, connections, tool servers and model
providers) were removed in TASK-4721; they are on the `agent-plane-archive` branch.

## The compute plane

The compute plane's routes are in `src/compute-routes.ts` over `src/compute-schema.ts`, and in `routes` like every
other: accounts and organisations (`/whoami`, `/accounts`), sandboxes (`/sandboxes`, isolates and microVMs behind one
API) with their commands, files, ports, SSH, desktop and browser, snapshots (`/snapshots`, a sandbox's automatic history
and named saved ones), scoped API keys (`/api-keys`), the egress proxy's settings (`/proxy`), events, webhooks and
OpenTelemetry export (`/events`, `/webhooks`, `/telemetry`), and the super-admin's hosts (`/admin/hosts`). A self-hosted
gateway always serves them. The schemas are the source of the types (`Static`), so these have
no twin in `@kantel/contracts`; `computeSchema.API_KEY_SCOPES`, `API_KEY_PRESETS` and `EVENT_TYPES` list the values a
server checks.

```ts
const kantel = createKantelClient({ baseUrl: "https://kantel.example/v1", token: process.env.KANTEL_API_KEY });
const sandbox = await kantel.createSandbox({ type: "microvm", wait: true });
const run = await kantel.runCommand(sandbox.id, { command: "uname -a" });
console.log(run.exitCode, run.stdout);
await kantel.stopSandbox(sandbox.id);
```

## Adding a route

1. Add its schemas to `src/schema.ts`, each named with a `title`, and a type check in `test/types.test.ts` against its
   type in `@kantel/contracts`.
2. Add the route to `src/routes.ts` with `defineRoute` and list it in `routes`.
3. `pnpm typecheck` now fails until the server gives it a handler (`createRouter` takes one per route).
4. Run `pnpm --filter @kantel/api generate` and commit `generated/`. CI runs `generate:check`, which fails while the
   generated files are stale.
5. Run `pnpm docs:reference` and commit the docs site's API reference pages (`docs/site/src/content/docs/api/reference/`),
   which are made from `generated/openapi.json`. CI fails while they are stale too.

## The router

`createRouter(routes, handlers, { basePath })` returns `(ctx, request) => Promise<Response | undefined>`. It matches by
method and path (`/sandboxes/{sandboxId}`), checks path parameters, query and body against the route's schemas and
answers a mismatch with an `invalid` `KantelError` naming the field (`body command: must be string`). Body properties
the schema doesn't name are dropped before the handler sees them, so a caller can't slip a field past the contract.
Query values are converted by the schema (`limit=20` is a number), and `<name>.<key>=<value>` is gathered into a record
when the schema has a `name` property (`label.ref=a`). A handler returns the route's output, which is sent as JSON with
the route's status (no body for 204), or a `Response` of its own for a stream or an upgrade. A request no route matches
resolves `undefined`, so the server can answer its other routes. Authentication is the server's: it signs the caller
in first and passes the context.

## The SDK

`generated/sdk.ts` is one file with no imports: the named types, a small `fetch` runtime (`src/sdk-runtime.ts`, copied
in) and `createKantelClient`, with one method per route. Path parameters come first, then the body, then the query,
then per-call options (`signal`, `requestId`, `headers`).

```ts
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: "https://kantel.example/v1", token: process.env.KANTEL_API_KEY });
const sandbox = await kantel.createSandbox({ type: "isolate", wait: true });
// Paths are relative to the sandbox user's home unless they start with `/`.
await kantel.writeFile(sandbox.id, { path: "bin/hello.sh", content: "#!/bin/sh\necho hello\n", mode: "0755" });
const run = await kantel.runCommand(sandbox.id, { command: "bin/hello.sh" });
console.log(run.stdout);

// Three copies of its state, for three agents to try different things from.
const { items: forks } = await kantel.forkSandbox(sandbox.id, { count: 3 });

try {
	await kantel.readFile(sandbox.id, { path: "missing.txt" });
} catch (error) {
	if (!(error instanceof KantelApiError) || error.code !== "not_found") throw error;
}
```

An error answer rejects with a `KantelApiError` carrying the HTTP status and Kantel's error code (`not_found`,
`invalid`, `unauthenticated`, …).

## Auth

Every route takes a bearer: a host app's API key (`ktk_…`, issued on the API keys page or with `POST /v1/keys`), which
acts as a `service` actor limited to the key's projects and role. Behind Cloudflare Access a person's browser is
signed in by Access's cookie instead and sends no header; that is how the console calls it. There are no short-lived
tokens scoped to a user and a session, so a host's browser can't call Kantel directly.
