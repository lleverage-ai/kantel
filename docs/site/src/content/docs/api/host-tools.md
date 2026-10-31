---
title: Host tools
description: Serve tools from your own app: register them with Kantel, verify each signed callback and answer the agent's calls.
---

A host tool is a tool your own app serves. The agent calls it like any other tool. Kantel sends each call to an HTTPS
callback on your app, signed with a secret you share, and gives the model what you answer. Use host tools for actions
only your app can take, such as recording a task's outcome in your own database (Sal's `task_outcome` works this way).

:::note
The host and profile routes on this page are served by both the Cloudflare and the self-hosted deployments, but they
are not in the OpenAPI document or the generated SDK yet. Call them over HTTP, or use the client in
`@kantel/runtime/http`. Package and header names still use the old name, `harbour`.
:::

## How a host tool reaches a session

Two records have to agree:

- The **agent profile** names the host in `hostId` and lists each host tool's name in `tools`
  (see [Packaging an agent](/api/packaging-an-agent/)).
- The **host registration** (`PUT /v1/hosts/{hostId}`) lists the tools, with their schemas, and the callback that
  serves them.

A session is offered a host tool only when its profile names it and the host has a current registration. Kantel's own
tools and the memory tools keep their names: a host tool with the same name is not offered beside them. When a
registration changes or is removed, open sessions of profiles with that `hostId` get the new tool set. A host ID has
one registration in an organisation: a new `PUT` replaces the last.

## Register a host

`PUT /v1/hosts/{hostId}` takes:

| Field | What |
| --- | --- |
| `projectId` | The project the registration belongs to. A project key holds roles only on its projects, so it must name one. Leaving it out needs an organisation-wide role, such as an organisation key's. |
| `tools` | Each tool's `name` (unique, not empty), `description`, `inputSchema` (a JSON Schema object, which becomes the tool's parameters) and `replay` policy. |
| `callback.url` | Where Kantel sends calls. `https:` only by default, with no user name or password in it. |
| `callback.secret` | At least 32 characters. Leave it out and Kantel generates one and returns it once. |

Registering, replacing and removing a host need the `operator` role on the project, and on the project of the
registration being replaced. The answer is `{ hostId, registration, tools, secret? }`. Keep `registration`: you need
it to remove the host.

```sh
curl -s -X PUT "$KANTEL_URL/v1/hosts/my-app" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"projectId": "<project ID>",
       "tools": [{"name": "record_outcome",
                  "description": "Record the outcome of the current task. Call it once, when the work is done.",
                  "inputSchema": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]},
                  "replay": "unsafe"}],
       "callback": {"url": "https://tools.example.com/hosts/my-app"}}'
```

On a self-hosted gateway, `KANTEL_CALLBACK_ORIGINS` narrows the callback URLs to a comma-separated list of origins
(`scheme://host[:port]`, or `scheme://host:*` for any port on that host), which also lets you allow a plain `http:`
loopback address for an app on the same machine. The Cloudflare deployment keeps the default: any `https:` URL.

### Replay policy

`replay` says what may happen to a call after a crash:

| Policy | Meaning | What the runtime does today |
| --- | --- | --- |
| `safe` | No effects outside Kantel's own records | Runs the call again |
| `idempotent` | Effects are keyed by the call ID | Does not run it again |
| `unsafe` | May have partly run | Does not run it again |

A call that is not run again is reported to the model instead. The call ID stays the same for every attempt at one
call, so you can make a tool idempotent yourself by keying its effects on `callId`.

## The signed callback

Kantel sends each call as a `POST` with a JSON body (a `HostToolCall`):

| Field | What |
| --- | --- |
| `hostId`, `tool`, `args` | Which host and tool, and the model's arguments |
| `callId` | Stable across retries of the same call |
| `sessionId`, `agentId`, `organisationId` | Where the call came from |
| `projectId` | The session's project; absent for an organisation-scoped session |

Each request carries three headers:

- `harbour-signature: t=<epoch ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`
- `harbour-host-id`
- `harbour-call-id`

Answer `200` with a JSON `HostToolResult`: `{ "output": "…" }`, plus `"isError": true` for a failure the model
should see, and an optional `structured` JSON value. An error status, an answer that isn't JSON or has no `output`, an
unreachable host and a redirect (Kantel doesn't follow them) all fail the call, and the model gets an error result. A
call fails after ten minutes, and Kantel reads at most 1 MiB of your answer. If the run is aborted, Kantel aborts the
request.

### Serve the endpoint

`createHostToolEndpoint(handler, { secret })` is the host side. It reads the body, checks the signature in constant
time, refuses a bad signature or one more than five minutes from your clock with `401`, refuses a body over 1 MiB,
runs your handler with the request's abort signal and answers with its result. A handler that throws answers `500`
with the error's code only. A minimal Bun server:

```ts
import { createHostToolEndpoint } from "@kantel/runtime/http";

const outcomes = new Map<string, string>(); // keyed by callId, so a retried call records once

const endpoint = createHostToolEndpoint(
	async (call) => {
		if (call.tool !== "record_outcome") return { output: `No tool ${call.tool} here`, isError: true };
		const { summary } = call.args as { summary: string };
		outcomes.set(call.callId, summary);
		return { output: "Outcome recorded." };
	},
	{ secret: process.env.HOST_TOOL_SECRET ?? "" },
);

Bun.serve({ port: 8795, fetch: endpoint });
```

Without the package, verify the raw body before you parse it. In Node:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(secret: string, body: string, header: string | null, now = Date.now()): boolean {
	if (header === null) return false;
	const parts = new Map(
		header.split(",").map((part) => [part.slice(0, part.indexOf("=")).trim(), part.slice(part.indexOf("=") + 1).trim()]),
	);
	const t = parts.get("t");
	const v1 = parts.get("v1")?.toLowerCase();
	if (t === undefined || v1 === undefined || !/^\d{1,16}$/.test(t)) return false;
	if (Math.abs(now - Number(t)) > 5 * 60 * 1000) return false;
	const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
	return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

## Register from TypeScript

The client in `@kantel/runtime/http` does the whole round: `hostTools.register(ctx, hostId, tools, handler)` makes a
secret, starts serving the endpoint through your `hostCallbacks.serve` before it registers (so an early call finds
it), and on `close()` removes the registration and stops serving. It sends `ctx.projectId` as the registration's
project; the server takes the caller from the API key, not from `ctx`.

```ts
import type { CallContext } from "@kantel/contracts";
import { bearer, createSessionApiClient } from "@kantel/runtime/http";

const endpoints = new Map<string, (request: Request) => Promise<Response>>();
Bun.serve({
	port: 8795,
	fetch(request) {
		const match = /^\/hosts\/([^/]+)$/.exec(new URL(request.url).pathname);
		const endpoint = match === null ? undefined : endpoints.get(decodeURIComponent(match[1] ?? ""));
		return endpoint === undefined ? new Response("not found", { status: 404 }) : endpoint(request);
	},
});

const client = createSessionApiClient({
	baseUrl: `${process.env.KANTEL_URL}/v1`,
	credentials: bearer(process.env.KANTEL_API_KEY ?? ""),
	hostCallbacks: {
		url: (hostId) => `https://tools.example.com/hosts/${encodeURIComponent(hostId)}`,
		serve: (hostId, endpoint) => (endpoint === undefined ? endpoints.delete(hostId) : endpoints.set(hostId, endpoint)),
	},
});

const ctx: CallContext = {
	actor: { kind: "service", serviceId: "my-app" },
	organisationId: "<organisation ID>",
	projectId: "<project ID>",
};
const subscription = await client.hostTools.register(
	ctx,
	"my-app",
	[{ name: "record_outcome", description: "Record the outcome of the current task.", inputSchema: { type: "object" }, replay: "unsafe" }],
	async (call) => ({ output: `Recorded ${JSON.stringify(call.args)}` }),
);
// later
await subscription.close();
```

## List and remove

`GET /v1/hosts/{hostId}/tools` answers `{ items }`, the registered tools (viewer on the registration's project).

```sh
curl -s "$KANTEL_URL/v1/hosts/my-app/tools" -H "authorization: Bearer $KANTEL_API_KEY"
```

`DELETE /v1/hosts/{hostId}?registration=<id>` removes the host, but only while that registration is the current one,
so an old client closing its subscription never removes the registration that replaced it. Without `registration` it
is `400`; a registration that isn't current is `404`. Only the credential that registered the host may remove it (for
a service, the same API key), and only while it still holds `operator` there. Another operator may replace it with a
`PUT`.

```sh
curl -s -X DELETE "$KANTEL_URL/v1/hosts/my-app?registration=<registration>" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

## Persistence and audit

Both deployments store each registration with its callback URL and secret in the session store, so your tools keep
answering after Kantel restarts, without your app registering again. The store is as sensitive as the secrets in it.
A runtime without durable storage keeps a registration only as long as the API instance that took it.

Every host tool call is audited as `session.tool.started` and `session.tool.finished`, with the host, the tool and the
outcome (`done`, `error` or `aborted`), never the arguments.

:::caution
On Cloudflare, the default `assistant` profile is rewritten each time the deployment starts: its tools go back to the
built-in set and any `hostId` is dropped. Give your agent its own profile ID.
:::

<!-- Sources (8584d5b): packages/runtime/HTTP.md:1-150, packages/runtime/src/http/callback.ts:1-220, packages/runtime/src/http/wire.ts:19-30,109-139, packages/runtime/src/http/server.ts:86-111,250-266,328-336,529-618,742-746, packages/runtime/src/http/client.ts:44-85,268-322, packages/runtime/src/index.ts:104-160, packages/runtime/src/runtime.ts:742-776,806-856,1895-1936,2042-2093, packages/runtime/CONTRACT.md:186-194, packages/contracts/src/session.ts:53-79,538-579, packages/contracts/src/common.ts:87-94,182-189, packages/contracts/src/identity.ts:234-245, apps/cloudflare/src/gateway.ts:1-30,159-191,509, apps/cloudflare/src/stack.ts:662-693, targets/cloudflare/runtime/src/index.ts:161-170, apps/selfhosted/src/gateway/gateway.ts:1-27,157-170,349, apps/selfhosted/src/gateway/callbacks.ts:1-10, apps/selfhosted/src/gateway/main.ts:20-24, apps/selfhosted/src/gateway/durable.ts:9-12,190-193 -->
