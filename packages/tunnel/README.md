# @kantel/tunnel

The client side of a Kantel tunnel. It serves the tools of an MCP server on your machine to a Kantel tool server,
without opening a port: it dials out to Kantel over a WebSocket, and Kantel calls the server's tools through it.
Any existing MCP server works unchanged, whether it speaks stdio or Streamable HTTP on loopback. The server's own
credentials stay on your machine; Kantel never sees them.

Tool servers are experimental: a deployment turns them on with `KANTEL_TOOL_SERVERS=experimental`. A tool server,
owned by an organisation or one of its projects, gives agents the tools of an MCP server on your own machine or
network.

## Running it

Make a tool server with transport `tunnel` through the API; you get its ID (`ts_…`) and a tunnel token (`hbt_…`),
shown once. Then:

```sh
# A stdio MCP server: everything after -- is its command.
KANTEL_TUNNEL_TOKEN=hbt_… kantel-tunnel --kantel https://kantel.example.com --server ts_… -- npx my-mcp-server

# A Streamable HTTP MCP server on loopback.
KANTEL_TUNNEL_TOKEN=hbt_… kantel-tunnel --kantel https://kantel.example.com --server ts_… --url http://127.0.0.1:8123/mcp
```

Its names from before the rename still work: the `harbour-tunnel` command, `--harbour`, `HARBOUR_URL` and `HARBOUR_TUNNEL_TOKEN`.

| Option | What |
| --- | --- |
| `--kantel <origin>` | Kantel's origin. Or `KANTEL_URL`. |
| `--server <ts_…>` | The tool server's ID. |
| `--token <hbt_…>` | A tunnel token of that server. Better as `KANTEL_TUNNEL_TOKEN`, so it isn't in `ps`. |
| `-- <command…>` | Run this stdio MCP server, with its stderr on the tunnel's. |
| `--url <url>` | Bridge this Streamable HTTP MCP server. Only `127.0.0.1`, `localhost` or `[::1]`... |
| `--allow-remote-url` | ...unless this is given. |

Status goes to stderr a line at a time: `connected`, `disconnected (…); reconnecting in 4s`, `stopped: token
revoked`. It reconnects by itself, waiting 1 s and doubling to 30 s, with jitter. It stops for good, exiting 1, when
the token is revoked, the tool server is removed, Kantel refuses the token, or the stdio server exits. Ctrl-C
(SIGINT) or SIGTERM closes the tunnel and the server and exits 0.

A stdio server is started once and kept across reconnects: when Kantel initialises the new socket, the tunnel
answers with the server's first `initialize` answer, as a server can't be initialised twice.

## From code

```ts
import { openTunnel, stdioEndpoint } from "@kantel/tunnel";

const tunnel = openTunnel({
	harbour: "https://kantel.example.com",
	serverId: "ts_…",
	token: process.env.KANTEL_TUNNEL_TOKEN!,
	endpoint: stdioEndpoint(["npx", "my-mcp-server"]),
	onStatus: (status) => console.error(status),
});
// Later:
await tunnel.close();
```

`httpEndpoint(url)` bridges a Streamable HTTP server instead, and any `TunnelEndpoint` (`send`, `onMessage`, and an
optional `close`) serves an MCP server in-process. `headers` adds headers to the upgrade, such as a Cloudflare Access
service token's where Access guards the tunnel's path; they never replace the token's `authorization`.

A host app using the session API client needn't call it itself: give the client `tunnels: openTunnel` and it serves a
host's tools, or an MCP server object, through `toolServers.serve()` and the `tunnel` host transport
([tool servers: from the SDK](../../docs/site/src/content/docs/api/tool-servers.md#from-the-sdk)). In Bun, whose `ws` has no `unexpected-response`
event, a refused upgrade reads as a lost connection, so the client retries it with backoff rather than stopping.

## The protocol

One JSON-RPC message per WebSocket text frame on `wss://<kantel>/v1/tool-servers/{id}/connect`, at most 4 MiB, with
Kantel as the MCP client; `ping` and `pong` text frames for liveness; MCP's `notifications/cancelled` for
cancellation; and close codes 4003 (token revoked), 4004 (server removed) and 4008 (replaced). It is written down in
full at the top of [packages/tools/src/protocol.ts](../tools/src/protocol.ts).
