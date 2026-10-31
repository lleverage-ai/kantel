# Tool servers

Design: [private MCP tools](design/private-mcp-tools.md). A tool server is an MCP server Kantel calls for tools,
owned by an organisation or by one of its projects. Phase 1 builds one transport, `tunnel`: a client on the server's
side (the `harbour-tunnel` command in `packages/tunnel`, or the SDK in-process) dials out to Kantel over a WebSocket,
and MCP JSON-RPC rides that socket. Nothing on the server's side needs an inbound route, and none of its credentials
reach Kantel.

The contract is `packages/contracts/src/tool-servers.ts`; the routes are `packages/api/src/tool-server-routes.ts`, in
the OpenAPI document and the SDK (`@kantel/api/sdk`). The registry, the tunnels held in one process and the runtime's
port are in `packages/tools`.

## Turning it on

Tool servers are experimental. A deployment turns them on with `KANTEL_TOOL_SERVERS=experimental`. Without it there
are no routes (`/v1/tool-servers` answers 404), no registry tables, no tunnel upgrade and nothing in the runtime.

- **Self-hosted**: the gateway holds the registry in its store (Postgres with `KANTEL_DATABASE_URL`, memory
  otherwise) and each tunnel's socket in its own process. One gateway process holds the tunnels, so run one.
- **Cloudflare**: not yet. One Durable Object per server will hold its socket (build plan item 4).

## Routes (under `/v1`)

| Route | What it does |
| --- | --- |
| `GET /tool-servers?projectId=` | The servers the caller may read, by name. With `projectId`, that project's and the organisation's |
| `POST /tool-servers` `{ projectId?, name, description?, transport: "tunnel" }` | Registers a server (admin on the owner). Answers it with its first tunnel token, `hbt_…`, shown this once |
| `GET`, `PATCH`, `DELETE /tool-servers/{toolServerId}` | One server: read it, with its connection and latest tools; change its description or disabled tools (admin); remove it and its tokens, closing its tunnel (admin) |
| `GET`, `POST /tool-servers/{toolServerId}/tokens` | Its tunnel tokens (never the token itself); make another (operator), shown once |
| `DELETE /tool-servers/{toolServerId}/tokens/{tokenId}` | Revoke a token (operator), closing the tunnel it opened |
| `GET /tool-servers/{toolServerId}/tools` | The latest `tools/list`, each tool with whether it is enabled, the name the model sees and why a session couldn't be offered it |
| `GET /tool-servers/{toolServerId}/connect` | The tunnel: a WebSocket upgrade, not a JSON route |

A name is lower-case letters, digits and single hyphens, at most 32 characters, unique in the organisation, and can't
be changed. Agents never manage servers or tokens. Another organisation's server is `not_found`.

## Opening a tunnel

```sh
# 1. Register a server for a project; keep the token the answer shows.
curl -X POST "$HARBOUR/v1/tool-servers" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"projectId":"prj_…","name":"sal","transport":"tunnel"}'
# → { "server": { "id": "ts_…", … }, "token": { "token": { "id": "tst_…", "prefix": "hbt_AbCd" }, "secret": "hbt_…" } }
# 2. Serve a local stdio MCP server through it (or --url for Streamable HTTP on loopback).
KANTEL_TUNNEL_TOKEN=hbt_… harbour-tunnel --harbour "$HARBOUR" --server ts_… -- node my-mcp-server.js
# 3. See it connected, with its tools.
curl "$HARBOUR/v1/tool-servers/ts_…/tools" -H "authorization: Bearer $KEY"
```

The tunnel's protocol (framing, liveness, close codes, cancellation and the `_meta` each call carries) is written down
in `packages/tools/src/protocol.ts`. Kantel checks the token before it accepts the upgrade: no token or a wrong one is
HTTP 401, another server's token 403, an unknown server 404, and the client stops for good on any of them, as it does
on close 4003 (token revoked) and 4004 (server removed). A newer tunnel for the same server takes over and closes the
older with 4008.

## From the SDK

The session API client (`createSessionApiClient` in `@kantel/runtime/http`) has the registry as `toolServers`, and
serves tool servers in-process when it is given `tunnels: openTunnel` from `@kantel/tunnel`. The tunnel's upgrade
carries the client's credential headers other than `authorization` (a Cloudflare Access service token's, say), and the
tunnel token as `authorization`.

```ts
import { bearer, createSessionApiClient } from "@kantel/runtime/http";
import { openTunnel } from "@kantel/tunnel";

const client = createSessionApiClient({
	baseUrl: "https://harbour.example/v1",
	credentials: bearer(apiKey),
	tunnels: openTunnel,
	hostTransport: "tunnel",
});

// A host's tools, as today, but over a tunnel: no callback URL, no inbound route.
const registration = await client.hostTools.register(ctx, "sal-1a2b3c4d", tools, handler);
// A profile names them `sal-1a2b3c4d/*`; the model sees `sal-1a2b3c4d__<tool>`.

// Or any server made through the API: a host's tools and handler, or an MCP server object (the MCP SDK's McpServer).
const served = await client.toolServers.serve(ctx, "ts_…", mcpServer);
await served.close();
```

- **`toolServers.serve(ctx, serverId, server, { token? })`** opens the server's tunnel and serves `server` on it:
  `{ tools, handler }` (a `HostToolHandler`, wrapped as a minimal MCP server answering `initialize`, `ping`,
  `tools/list` and `tools/call`, whose calls get a `HostToolCall` built from `_meta`), or an object with
  `connect(transport)`. It settles once Kantel shows the server connected with its tools, so a session made after it is
  offered them. Without a `token` it makes one (operator) and revokes it on close.
- **`hostTools.register` with `hostTransport: "tunnel"`**: the host's ID is its tool server's name (the name rules
  above apply), owned by `ctx.projectId`'s project. Registering makes the server when there is none (admin on the
  owner), or else makes a token for the one there is (operator), so an operator's key serves a server an admin made
  for it. Registering the same host again in one client closes the older tunnel first. Closing the registration
  closes the tunnel, so the server goes offline, and removes the server if this client made it, or else revokes the
  registration's token. `hostTools.list` reads the server's tools.

## Tools in sessions

A profile's `tools` names a server's tool as `<server>/<tool>`, or all of them as `<server>/*`. The model sees each as
`<server>__<tool>`, with the description and input schema exactly as the server gave them; Kantel adds no prompt text.
A model name is at most 50 characters with the server's name, and a profile naming a longer one is refused when it is
saved; a `<server>/*` tool whose name is too long is left out, and the server's tools view says why.

A session sees its organisation's servers and its own project's. It keeps the tools it was first offered from each
server (its pin), so a changed `tools/list` reaches new sessions only. A session with no pin yet, because the server
had never connected, picks the tools up when the server connects. A pinned tool stays listed while its server is
offline, or after it is disabled or the server removed, and its calls answer an error result saying so.

Each call carries the session, organisation, project, agent and a call ID stable across retries under `params._meta`
(`harbour/sessionId` and so on, `TOOL_SERVER_META`). Calls time out after ten minutes, as host tools do.

## Audit

Calls keep `session.tool.started` and `session.tool.finished`, with `toolServerId` and `transport` added and
`durationMs` on the finish. The registry adds `tool_server.created`, `.updated`, `.deleted`, `.token.created`,
`.token.revoked`, `.connected`, `.disconnected` and `.tools.changed` (with `oldHash`, `newHash` and the tool count), all
from source `tool_server` with the server as subject. No event carries a token.

## Not in phase 1

Public MCP over HTTPS with a vault credential (`http`), host callbacks as `callback` servers, narrowing an
organisation's server out of a project, per-server limits and several connections per server.
