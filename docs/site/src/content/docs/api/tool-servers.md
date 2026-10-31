---
title: Tool servers
description: Give agents the tools of an MCP server on your own machine or network, over a tunnel that dials out to Kantel, from the command line or the SDK.
---

A tool server is an MCP server Kantel calls for tools, owned by an organisation or by one of its projects. Its
transport is a tunnel: a client on the server's side dials out to Kantel over a WebSocket, and MCP JSON-RPC runs over
that socket. The server needs no inbound route, and none of its own credentials reach Kantel.

:::caution[Experimental]
Tool servers are off unless the deployment sets `KANTEL_TOOL_SERVERS=experimental`. Without it there are no routes
(`/v1/tool-servers` answers 404), no tunnel and nothing in sessions.
:::

The routes are in the [Tool servers reference](/api/reference/tool-servers/). The contract is
`packages/contracts/src/tool-servers.ts`, and the tunnel's protocol is written down in `packages/tools/src/protocol.ts`.

## Turning it on

- **Self-hosted**: the gateway keeps the registry in its store (Postgres with `KANTEL_DATABASE_URL`, memory
  otherwise) and holds each tunnel's socket in its own process. Run one gateway process when tool servers are on.
- **Cloudflare**: set the Worker variable `KANTEL_TOOL_SERVERS` (it is `""` in `wrangler.jsonc`, so off). The stack
  object keeps the registry in D1, and each server's tunnel is held by its own `KantelTunnel` Durable Object. A tunnel
  client can't pass Cloudflare Access, so add an Access Bypass policy on `<hostname>/v1/tool-servers/*/connect` before
  you turn it on. Kantel checks the tunnel token itself.

## Register a server and open a tunnel

A name is lower-case letters, digits and single hyphens, at most 32 characters, unique in the organisation, and can't
be changed. Registering needs admin on the owner, and the answer holds the server's first tunnel token (`hbt_…`),
shown once. Agents never manage servers or tokens.

```bash
# Register a server for a project; keep the token the answer shows.
curl -s -X POST "$KANTEL_URL/v1/tool-servers" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"projectId": "<project ID>", "name": "my-tools", "transport": "tunnel"}'

# Serve a local stdio MCP server through it.
KANTEL_TUNNEL_TOKEN=hbt_… kantel-tunnel --kantel "$KANTEL_URL" --server ts_… -- node my-mcp-server.js

# See it connected, with its tools.
curl -s "$KANTEL_URL/v1/tool-servers/ts_…/tools" -H "authorization: Bearer $KANTEL_API_KEY"
```

`kantel-tunnel` is the command in `@kantel/tunnel` (`packages/tunnel`). It also bridges a Streamable HTTP MCP server
on loopback with `--url http://127.0.0.1:8123/mcp`, reconnects by itself, and stops for good when its token is
revoked or its server removed. Its options are in the package's README. The command is also installed under its old
name, `harbour-tunnel`.

Kantel checks the token before it accepts the upgrade: no token or a wrong one is HTTP 401, another server's token
403, an unknown server 404. A newer tunnel for the same server takes over and closes the older one with code 4008;
4003 means the token was revoked and 4004 that the server was removed.

## From the SDK

The session API client in `@kantel/runtime/http` has the registry as `toolServers`, and serves tool servers in your
own process when you give it `tunnels: openTunnel` from `@kantel/tunnel`.

```ts
import { bearer, createSessionApiClient } from "@kantel/runtime/http";
import { openTunnel } from "@kantel/tunnel";

const client = createSessionApiClient({
	baseUrl: `${process.env.KANTEL_URL}/v1`,
	credentials: bearer(process.env.KANTEL_API_KEY!),
	tunnels: openTunnel,
	hostTransport: "tunnel",
});

// Your app's host tools, over a tunnel: no callback URL and no inbound route.
const registration = await client.hostTools.register(ctx, "my-app", tools, handler);

// Or any registered server: a host's tools and handler, or an MCP server object (the MCP SDK's McpServer).
const served = await client.toolServers.serve(ctx, "ts_…", mcpServer);
await served.close();
```

- `toolServers.serve(ctx, serverId, server, { token? })` opens the server's tunnel and serves `server` on it. It
  settles once Kantel shows the server connected with its tools, so a session created after it is offered them.
  Without a `token` it makes one (operator) and revokes it on close.
- `hostTools.register` with `hostTransport: "tunnel"` uses the host's ID as its tool server's name, owned by
  `ctx.projectId`'s project. It makes the server if there is none (admin on the owner), or a token for the one there
  is (operator). Closing the registration closes the tunnel. See [Host tools](/api/host-tools/).

The tunnel's upgrade carries the client's other credential headers, such as a Cloudflare Access service token's, and
the tunnel token as `authorization`.

## Tools in sessions

An agent profile's `tools` names one tool as `<server>/<tool>`, or all of a server's tools as `<server>/*`. The model
sees each as `<server>__<tool>`, with the description and input schema exactly as the server gave them. A model-facing
name is at most 50 characters; a profile naming a longer one is refused when it is saved, and a `<server>/*` tool whose
name is too long is left out, with the reason shown in the server's tools.

A session sees its organisation's servers and its own project's. It keeps the tools it was first offered by each
server, so a changed `tools/list` reaches new sessions only. A pinned tool stays listed while its server is offline,
disabled or removed, and its calls answer with an error result that says so.

Each call carries the session, organisation, project, agent and a call ID that stays the same across retries, under
`params._meta` (`harbour/sessionId` and so on; `TOOL_SERVER_META` in `@kantel/contracts`). Calls time out after ten
minutes, as host tools do.

## Audit

Calls are recorded as `session.tool.started` and `session.tool.finished`, with the `toolServerId`, the `transport`
and the call's `durationMs`. The registry records `tool_server.created`, `.updated`, `.deleted`, `.token.created`,
`.token.revoked`, `.connected`, `.disconnected` and `.tools.changed`, from source `tool_server` with the server as
subject. No event carries a token.

<!-- Sources (ba80016): packages/contracts/src/tool-servers.ts, packages/tools/src/protocol.ts, packages/tunnel/package.json:11-14, packages/tunnel/src/tunnel.ts:70, packages/tunnel/README.md, apps/cloudflare/src/tool-servers.ts:13-36, apps/selfhosted/src/gateway/tool-servers.ts, packages/runtime/src/http/tool-server-client.ts -->
