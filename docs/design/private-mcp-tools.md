# Private MCP tools: user-defined tools over a tunnel

Status: proposal for Tom to review. Issues #17 (Cloudflare deployment) and #150 (public API). Nothing here is built.

Tom, 29 Oct 2026: "I think any user of the platform potentially needs to define tools that call back to private MCP over
tunnel - needs some thought". So this is a platform feature for every user, not a callback just for Sal.

**In one paragraph.** A user registers a **tool server**: an MCP server Kantel calls for tools, owned by an
organisation or a project. A private one is reached through a **Kantel tunnel**: the user runs a small client (or the
SDK does it in their process) that dials *out* to Kantel over a WebSocket, which one Durable Object per tool server
holds on Cloudflare, and the gateway holds on self-hosted. MCP JSON-RPC rides that socket. A public MCP server is
reached over HTTPS with a credential from the vault. Today's host-tool callbacks become a third transport of the same
record. Sal is the first user: its worker opens the tunnel in-process instead of serving on `127.0.0.1`.

## Where we are

- Host tools are signed HTTPS callbacks: "The runtime then POSTs each `HostToolCall` to the URL and reads a
  `HostToolResult` back", and "Callback URLs are `https:` only by default"
  (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:packages/runtime/HTTP.md:108-131).
- A profile names one host (`hostId`) and lists tool names; the runtime offers a host tool only when the profile lists
  it and the host's handler is live
  (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:packages/runtime/src/runtime.ts:576-590), and audits each
  call as `session.tool.started` and `session.tool.finished` (same file, 592-641).
- Sal's worker serves its tools on `http://127.0.0.1:<port the OS picks>`, one host per run
  (tvdavies/sal@419e2b1ccd151e7de256621df7d76d16e6bcad93:src/harbour/worker.ts:195-222). Self-hosted accepts that through
  #226's `KANTEL_CALLBACK_ORIGINS=http://127.0.0.1:*`, whose own comment warns "the gateway calls whatever a key holder
  registers within this list" (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:apps/selfhosted/src/gateway/callbacks.ts:1-8).
  Cloudflare can't reach it, which blocks #17's "a real Sal research task runs end to end".
- Cloudflare reaches CLIProxyAPI on Sal's host through one static `vpc_services` binding in the deploy config
  (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:apps/cloudflare/scripts/deploy-config.ts:279). That is a
  deployment's own wiring, not something a user can add.

## 1. Registering a tool server

**The record.** `ToolServer`: ID, owner (an organisation, or a project inside it), `name` (a slug, used in tool
names), `transport` (`tunnel`, `http` or `callback`), `url` for `http`, an optional vault item for `http`, the tool
snapshot (definitions from `tools/list`, their hash, when taken), the tools enabled, and status (connected, last seen).
Ownership follows model connectors, where "Connectors belong to the platform or an organisation. Projects only narrow
them" (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:docs/model-connectors.md:28), with one addition: a
project may own a server too, because a host's per-run tools (Sal's) belong to one project and nobody else should see
them.

**Tools in a profile.** A profile's `tools` already lists names the agent may call
(tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:packages/contracts/src/session.ts:50-67). It gains entries
`<server>/<tool>` and `<server>/*`. The model sees `<server>__<tool>`, which fits `[A-Za-z0-9_-]{1,64}` and so passes
through the gateway's `mcp__harbour__` namespacing on CPA (`packages/models/src/tool-names.ts`). A name too long is
refused when the profile is saved, not at call time. `hostId` stays as an alias for a `callback` server until hosts
move over.

**Descriptions are the server's.** Kantel adds no prompt text: each tool's name, description and input schema go to
the model as the server gave them. Kantel snapshots the list on connect and whenever the server says it changed,
audits a change with the old and new hash, and offers a changed tool to new sessions only (a running session keeps the
list it started with). MCP annotations set `replay`: `readOnlyHint: true` is `safe`, anything else `unsafe`.

**Console page.** *Tool servers*, under the organisation and under each project, built from `@kantel/ui`:

- the list: name, scope, transport, a status dot (connected, offline, last seen), tool count, calls and p50 latency
  over the last day;
- *Add tool server*: name, scope and transport. For a tunnel it shows the token once and the command to run
  (`npx @kantel/tunnel --token … -- <stdio server command>` or `--url http://127.0.0.1:8123/mcp`). For HTTP, the URL
  and a vault item, picked or pasted through the Kantel-hosted secret popup from #150;
- the server page: its tools with an enable toggle and replay class, token rotation, and *Recent calls*, a link to the
  audit view filtered to the server.

## 2. Transports

All figures are from Cloudflare's docs as of 29 Oct 2026.

| | A. Cloudflare Tunnel + Workers VPC per tenant | B. Kantel tunnel (outbound WebSocket, a DO per server) | C. Public HTTPS MCP with auth | D. Direct network (self-hosted) |
| --- | --- | --- | --- | --- |
| What the user runs | `cloudflared` with a tunnel in Kantel's account | `@kantel/tunnel`, or the SDK in-process | Their own ingress (their tunnel, a load balancer) | Nothing; the gateway reaches it |
| Latency per call | Edge to `cloudflared`: good | One DO hop in weur, then the socket: good | Direct: good | Best |
| Kantel's ops | High: a tunnel per tenant by API, reconcile, a binding change and redeploy per tenant | Low: one DO class, one route | Low | Low |
| Cost | 1,000 tunnels free, then $4.50 each a month; VPC free in beta | DO requests only; idle sockets hibernate | None to Kantel | None |
| Self-hosted parity | None (Cloudflare only) | Same client, same protocol; the gateway holds the socket | Same | Self-hosted only |
| Isolation | Network-level: Kantel picks a private address per call | One MCP endpoint per token; no network exposed | Per URL; needs an SSRF allowlist | Deployment allowlist |

**A. Per-tenant Cloudflare Tunnel and Workers VPC.** VPC Services bind "a specific host and port", up to 1,000 per
account (https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/,
https://developers.cloudflare.com/workers-vpc/platform/limits/). VPC Networks bind a whole tunnel or virtual network,
and "the URL you pass to `fetch()` ... determines the destination", but the binding itself is in the Worker's config
(`vpc_networks` with a `tunnel_id` or `cf1:vnet:<UUID>`), and binding to a tunnel "requires the **Connectivity Directory
Admin** role" (https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/). So either each new tenant is
a config change and redeploy, or one `cf1:network` binding reaches every tenant's routes and Kantel's own (CLIProxyAPI
on `sal-app` is in the same account), with only Kantel's URL choice between them. Tunnels: 1,000 per account, 1,000
virtual networks (https://developers.cloudflare.com/cloudflare-one/account-limits/), and beyond that "Tunnels for
Platforms costs $4.50 per additional tunnel per month", a product Cloudflare pitches for "AI and agent platforms"
(https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/). Workers VPC "is currently in beta"
(https://developers.cloudflare.com/workers-vpc/). Good for a deployment's own fixed backends (as `MODELS` is); wrong for
users.

**B. Kantel tunnel.** The client dials `wss://<harbour>/v1/tool-servers/{id}/connect` with a tunnel token. On
Cloudflare a `KantelTunnel` Durable Object per server (named from organisation and server ID, created with the `weur`
hint like the stack) accepts it with the Hibernation API: "Clients remain connected while the Durable Object is not in
memory", "Billable Duration (GB-s) charges do not accrue during hibernation", and pings are answered without waking it
(https://developers.cloudflare.com/durable-objects/best-practices/websockets/). Requests are $0.15 a million beyond the
included million, "There is no charge for outgoing WebSocket messages", and incoming ones count 20:1
(https://developers.cloudflare.com/durable-objects/platform/pricing/). The location hint is "best effort and not a
guarantee" (https://developers.cloudflare.com/durable-objects/reference/data-location/), the same as for the stack.
MCP allows this: transports "MAY" be custom over "any communication channel that supports bidirectional message
exchange", if they keep "the JSON-RPC message format, the message patterns, and the per-request metadata model"
(https://modelcontextprotocol.io/specification/2026-07-28/basic/transports). One JSON-RPC message per WebSocket text
frame; the framing and how a call is cancelled are written down with the protocol, as the spec asks. The client bridges to a local stdio server or a loopback
Streamable HTTP one, so any existing MCP server works unchanged. Self-hosted, the gateway accepts the same socket with
the code that already upgrades the session stream (`packages/runtime/src/http/ws.ts`).

**C. Public HTTPS MCP with auth.** Streamable HTTP to a URL the user publishes, with a vault-held credential. MCP's
HTTP authorization is OAuth 2.1, optional, and "Implementations using an STDIO transport SHOULD NOT follow this
specification" (https://modelcontextprotocol.io/specification/latest/basic/authorization). Cheap, standard, and
the right answer for SaaS MCP servers; but for a private server it moves the tunnel problem onto the user, and Kantel
needs an SSRF allowlist: `https:` only and no private addresses on Cloudflare, like `allowCallbackUrl` today.

**D. Direct network on self-hosted.** C with private URLs allowed by the deployment's
`KANTEL_TOOL_SERVER_ORIGINS` (#226's parser). Useful inside a company network; never on Cloudflare.

**Also considered.** *Cloudflare Mesh nodes per tenant*: 50 Mesh nodes per account (account limits above), so no.
*Tailscale Funnel, ngrok, a user's own `cloudflared` public hostname*: ways for a user to do C, worth a line in the docs,
nothing to build. *Today's signed callbacks*: kept as transport `callback` (section 5).

## 3. Auth, credentials and audit

- **Tunnel tokens.** `hbt_…`, one per tool server, made through the API and shown once, stored hashed like API keys
  (#15), rotatable; revoking one closes its socket. The Worker checks it before forwarding the upgrade to the object.
  Kantel needs no secret in the other direction: the client authenticated Kantel by TLS when it dialled out.
- **HTTP credentials** are vault items bound to the server's host. The runtime's MCP client reads one through a narrow
  system-only vault call, the same shape as the model gateway's connector credential read, where "Only the gateway ever
  holds it, in memory, for a few minutes at most" and the vault records the session on the use
  (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:packages/contracts/src/models.ts:215-232). OAuth tokens for
  remote MCP come later, through #150's Kantel-hosted popup.
- **No secret in the sandbox.** Tool calls are made by the runtime, outside the sandbox, as host tools are now. The
  vault's rule holds: "Agents and sandboxes never hold a value"
  (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:packages/vault/CONTRACT.md:5-7). A private server's own
  credentials (Sal's Slack or Drive access) stay on the user's side of the tunnel.
- **Audit.** Every call keeps `session.tool.started/finished`, with `toolServerId`, transport and duration added.
  New events: `tool_server.created/updated/deleted`, `tool_server.token.created/revoked`,
  `tool_server.connected/disconnected` and `tool_server.tools.changed` (old and new hash). Credential reads are vault
  uses, so the audit view's credential summary covers them.

## 4. Tenancy and isolation

- A token resolves to exactly one server, and the object's name comes from the server's stored organisation and ID,
  never from the request.
- A session may call a server's tool only if the server is in its organisation, is the session's project's or is
  organisation-wide and not narrowed out, and its profile lists the tool. Managing servers is admin on the owner;
  rotating a token is operator. All through `ProjectAccess`, as everywhere else.
- Each call carries the session, project, agent and a call ID stable across retries in Kantel-prefixed `_meta` keys, the
  same fields as `HostToolCall`, so a server can make unsafe tools idempotent and enforce its own rules.
- A tunnel exposes one MCP endpoint, not a network, so no tenant can reach another tenant's or Kantel's addresses
  through it. On Cloudflare Kantel never fetches a private address a tenant chose.
- Limits per server: concurrent calls, message size (the API's existing body limit), the ten-minute call timeout host
  tools already have, and reconnect rate.
- A server's results and tool descriptions are untrusted input to the model, as any tool's are; the snapshot and its
  audited changes are how an admin sees what the model was given.

## 5. The public API (#150), and today's host tools

Tool servers are control-plane routes in `@kantel/api`, generated into OpenAPI and the SDK like the rest, and the
console uses them like any other client:

| Route | What |
| --- | --- |
| `GET/POST /v1/tool-servers`, `GET/PATCH/DELETE /v1/tool-servers/{id}` | The registry |
| `POST /v1/tool-servers/{id}/tokens`, `DELETE …/tokens/{tokenId}` | Tunnel tokens |
| `GET /v1/tool-servers/{id}/tools` | The snapshot, with what's enabled |
| `GET /v1/tool-servers/{id}/connect` (WebSocket) | The tunnel |

The SDK gets `toolServers.serve(serverId, server)`, which opens the tunnel in-process and serves either an MCP server
object or a `HostToolHandler` (wrapped as a minimal MCP server answering `tools/list` and `tools/call`).

**Host tools become one case.** `hostTools.register(ctx, hostId, tools, handler)` keeps working: it creates or updates
a project-owned tool server, with transport `tunnel` when the client can dial out, and `callback` (today's signed
HTTPS, unchanged on the wire) otherwise. Stored host registrations migrate to `callback` servers. Inside the runtime
there is one path: the profile's entries resolve to servers, each server's transport gives a `HostToolHandler`, and the
existing `asPiTool` audits and runs it.

Host apps behind Cloudflare Access need a way through first: the deployed tests note "Host apps aren't let through
Access yet" (tvdavies/harbour@a5a66533a423318c6977103daa7abcfc1cef3cf9:apps/cloudflare/README.md:376-392). Sal's worker
needs that for the session API anyway; the tunnel route needs the same treatment.

## 6. Sal as the first user

Sal's worker registers a host per run and serves it on loopback. With the tunnel it passes `transport: "tunnel"` to
`hostTools.register` instead of `hostCallbacks`, and the SDK dials out to `harbour.myslop.app`. No port, no
`cloudflared` config, no inbound route. The socket lives as long as the run: when the worker stops, the server goes
offline and its tools answer error results, which is what Sal already wants ("nothing runs in Kantel without this
process to serve its tools", tvdavies/sal@419e2b1ccd151e7de256621df7d76d16e6bcad93:src/harbour/worker.ts:136-140). The same change on the self-hosted gateway lets `KANTEL_CALLBACK_ORIGINS=http://127.0.0.1:*`
go, and with it #226's warning about any operator key reaching any port on the host. That closes #17's last blocker for
a real Sal task on Cloudflare.

## 7. Phases

1. **Experimental, behind `KANTEL_TOOL_SERVERS=experimental`** (off by default; on for `harbour.myslop.app` and the
   gateway next to Sal). The tunnel transport only, servers made through the API, host tools able to use it, Sal
   switched over behind its own flag. The console page starts at the same time against fixtures, so there is something
   to see early.
2. **Usable by others.** The console page wired up, `@kantel/tunnel` published, the HTTP transport with vault
   credentials and the URL allowlist, the new audit events, `server/tool` profile entries.
3. **Hardened.** Stored host registrations migrated to `callback` servers and `KANTEL_CALLBACK_ORIGINS=…:*` retired,
   OAuth for remote MCP, several client connections per server, per-server limits and metrics. The switch comes off.

## Recommendation

**Build the Kantel tunnel: an outbound WebSocket the user's side opens, held by one Durable Object per tool server on
Cloudflare and by the gateway on self-hosted, carrying MCP JSON-RPC.** It is the only option that works the same on both
hosts, needs no Cloudflare objects per tenant and no inbound route on the user's side, and isolates tenants by
construction (one endpoint per token, no network). Add public HTTPS MCP with vault credentials second, and fold
today's host-tool callbacks in as a third transport of the same `ToolServer` record. Don't use per-tenant Cloudflare
Tunnels or Workers VPC for users; keep VPC for a deployment's own fixed backends.

### Build plan

| # | Work item | Size | Packages | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Contracts: `ToolServer`, `ToolServers`, transports, `server/tool` profile entries, audit event types | S | `packages/contracts` | none |
| 2 | Tunnel protocol and MCP client: JSON-RPC over a message channel, `tools/list` snapshot and hash, `tools/call` to `HostToolResult`, cancellation, timeouts, `_meta` | M | new `packages/tools` | 1 |
| 3 | Runtime: resolve profile entries to servers, one handler per transport through `asPiTool`; registry store in SQL and the stack's SQLite; the experimental switch | M | `packages/runtime`, `packages/sql`, `targets/*/runtime` | 1, 2 |
| 4 | Cloudflare: `KantelTunnel` DO (hibernation, weur hint), token check in the Worker, `/v1/tool-servers/{id}/connect`, stack-to-tunnel RPC | M | `apps/cloudflare`, `targets/cloudflare` | 2, 3 |
| 5 | Self-hosted: the gateway holds tunnel sockets with the same protocol | S | `apps/selfhosted` | 2, 3 |
| 6 | Public API and SDK: `/v1/tool-servers` routes and tokens, `toolServers.serve()`, `hostTools.register({ transport: "tunnel" })`, OpenAPI regenerated | M | `packages/api`, `packages/runtime` (http client) | 1, 3 |
| 7 | `@kantel/tunnel` CLI: bridge a stdio or loopback HTTP MCP server, reconnect with backoff | S | new `packages/tunnel` | 2, 6 |
| 8 | Sal: open the tunnel instead of loopback callbacks, behind Sal's flag; then an end-to-end Sal task on Cloudflare | S | tvdavies/sal `src/harbour/worker.ts` | 4, 6, host apps through Access |
| 9 | Console *Tool servers* page (fixtures first, then the API) | M | `apps/console`, `packages/ui` | 6 for wiring only |
| 10 | HTTP transport: vault credential read for tool servers (system-only, a use per read), `KANTEL_TOOL_SERVER_ORIGINS`, `https:` only on Cloudflare | M | `packages/vault`, `packages/contracts`, `packages/tools`, `apps/*` | 3 |
| 11 | Host registrations migrated to `callback` servers; `127.0.0.1:*` callbacks retired | M | `packages/runtime`, `apps/selfhosted`, `apps/cloudflare` | 3, 6, 8 |
| 12 | Hardening: remote MCP OAuth through the vault popup, several connections per server, per-server limits and metrics | L | `packages/tools`, `packages/vault`, `apps/*` | 10, #150's popup |

Items 1 to 8 are phase 1 (with 9 started against fixtures); 9 and 10 finish phase 2; 11 and 12 are phase 3.
