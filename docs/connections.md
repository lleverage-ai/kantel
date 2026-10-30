# Connections API

Epic #322. Connections are how people and organisations connect agents to outside services, by OAuth or by key,
like Claude's connectors: pick a provider from the catalogue (or paste a remote MCP server's URL), connect, sign in,
and agents can use it. No API ever returns a secret; the vault stays the encrypted store underneath.

The contract is `packages/contracts/src/connections.ts`; the routes are `packages/api/src/connection-routes.ts`, in the
OpenAPI document and the SDK (`@harbour/api/sdk`). The console is one client of these routes; everything works with an
API key alone.

## Routes (under `/v1`)

| Route | What it does |
| --- | --- |
| `GET /connections/catalogue?category=&authType=&kind=&q=` | The templates the caller can use, each with `setup`: `ready`, or `needs_client` and the tiers that could register an OAuth app |
| `GET /connections/catalogue/{templateId}` | One template |
| `POST /connections/discover` `{ url }` | What a remote MCP server says about itself: does it need a sign-in, and how Harbour would get a client |
| `POST /connections/connect` | Starts an OAuth connect for a template or an `mcpUrl` and an owner. Answers a pending attempt with a `connectUrl` (15 minutes, once), or a completed one for an open server |
| `GET /connections/connect/{attemptId}` | The attempt's status: pending, completed (with `connectionId`), failed (with `failure.code`) or expired |
| `POST /connections/keys` | A key connection for a template or a custom service (hosts and how the key goes out). The key is write-only |
| `GET /connections` | The connections the caller may see |
| `GET`, `PATCH`, `DELETE /connections/{connectionId}` | One connection: read; change its name, usage or disabled state; remove it and its credential |
| `POST /connections/{connectionId}/key` | Replace a key in place |
| `GET /connections/uses?connectionId=&sessionId=` | Which connection a session used, at which step, acting for whom, and who could see the session |
| `GET`, `POST /connections/clients`, `GET`, `PATCH`, `DELETE /connections/clients/{oauthClientId}` | OAuth clients per tenancy level: the deployment (`platform`), an organisation, a project or a person |

Browser routes beside the JSON API:

- `GET /v1/connections/authorize/{attemptId}`: the connect URL. Checks the signed-in person is the one it was made
  for (`user_mismatch` otherwise), then redirects to the provider with a single-use `state` and a PKCE challenge.
- `GET /v1/connections/callback`: the provider's redirect back. Uses up the state, exchanges the code, stores the
  tokens in the vault and shows a result page (or redirects to the attempt's `returnTo`). This is the redirect URI
  to register for pre-registered OAuth clients.
- `GET /v1/connections/oauth/client-metadata.json`: the deployment's client ID metadata document. Authorisation
  servers fetch it without signing in, so behind Cloudflare Access it needs a Bypass policy on that path.

## A connect, headless

```sh
# 1. Start: a remote MCP server for the caller themselves.
curl -X POST "$HARBOUR/v1/connections/connect" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"mcpUrl":"https://mcp.example.com/mcp","owner":{"kind":"user","organisationId":"…","userId":"…"},"forUserId":"…"}'
# → { "id": "ca_…", "status": "pending", "connectUrl": "https://…/v1/connections/authorize/ca_…", … }
# 2. The person opens connectUrl and signs in at the provider.
# 3. Poll until it settles.
curl "$HARBOUR/v1/connections/connect/ca_…" -H "authorization: Bearer $KEY"
# → { "status": "completed", "connectionId": "conn_…" }
```

## Shared and personal connections

Several connections to one provider may coexist, each with its own owner and usage:

- **Owner**: an organisation, a project or a person. It decides who manages the connection and bounds where it can
  go: a project's never leaves the project; a person's is used only in sessions acting for that person.
- **Usage** (`ConnectionUsage`): narrows it further: only some projects, only sessions acting for some people, only
  some agent profiles, whether unattended sessions may use it, and `visibility`.
- **Visibility**: a `private` connection is used only in a session nobody but its acting person can see
  (`SessionAudience`). A person's connection is private by default; others are shared.

`connectionUsableIn(connection, scope)` in the contract is the one rule every target applies. A session's agent sees
the connections it may use most specific owner first (its person's, the project's, the organisation's), and every
use is recorded as a `ConnectionUse` with the session, the tool call and the session's audience at the time. The full
proposal is in issues #335 and #332.

## How it runs

`@harbour/connections` serves the routes above over a `ConnectionsService`:

- **Records** (connections, connect attempts, OAuth clients, dynamic registrations, uses) are JSON records in one
  table (`connection_records`), in D1 on Cloudflare, Postgres self-hosted, or memory. No record holds a secret.
- **Secrets** (access and refresh tokens, keys, OAuth client secrets) are vault items, put and opened through the
  vault's system-only `connectionSecret` call. An item is bound to its hosts: an access token to the connection's
  hosts, a refresh token and a client secret to the token endpoint's host only. Each open is recorded as a vault use,
  and refused for another host, another organisation, or a blocked or ended session.
- **OAuth client order**: a registered client (the owner's own tier first: the person's, the project's, the
  organisation's, then the deployment's), then CIMD (only when the client metadata document is public and the server
  says it supports it), then DCR (one registration per authorisation server, reused). A connection keeps the client
  that minted it; a client with connections pinned to it can't be removed.
- **Sessions** get four tools: `connections_list`, `connection_tools`, `connection_call` (remote MCP) and
  `connection_request` (HTTP APIs). They run on the host, never in the sandbox: the service checks
  `connectionUsableIn`, records the use against the session and tool call, refreshes the token when due (and once
  on a 401), opens the credential for the request's host, sends with `redirect: "manual"`, and cuts the credential
  out of the answer. A tool can't set `authorization`, `cookie` or `host`.

## Turning it on

| Where | Setting | Meaning |
| --- | --- | --- |
| Cloudflare | `HARBOUR_HOSTNAME` | Set by the deploy config. Redirect URI `https://<host>/v1/connections/callback`. |
| Cloudflare | `HARBOUR_CONNECTIONS=off` | No connections. |
| Cloudflare | `HARBOUR_CONNECTIONS_CIMD=on` | Only after a Cloudflare Access Bypass policy on `/v1/connections/oauth/client-metadata.json`. |
| Both | `HARBOUR_CONNECTIONS_PERSONAL=on` | One-person deployment: sessions acting for the person are private to them. |
| Self-hosted | `HARBOUR_PUBLIC_URL` and a vault | Connections are on with both; `HARBOUR_CONNECTIONS=off` turns them off. |

A provider that needs a registered OAuth app (GitHub, Google, Slack and others in the catalogue marked
`needs_client`) is registered by an admin with `POST /v1/connections/clients`, giving the client ID and secret of an
app whose redirect URI is the deployment's callback above. The secret goes to the vault and is never returned.
