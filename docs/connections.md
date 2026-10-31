# Connections API

Epic #322. Connections are how people and organisations connect agents to outside services, by OAuth or by key,
like Claude's connectors: pick a provider from the catalogue (or paste a remote MCP server's URL), connect, sign in,
and agents can use it. No API ever returns a secret; the vault stays the encrypted store underneath.

A connector is how Harbour talks to a model or a channel; a connection is a credential an agent uses. An agent's
request for a credential is a connection request, decided on the console's connection request page
(`/connections/requests`) through the connection approval API (`/v1/connection-approvals`); see
[the connection request page](connection-request-page.md) and the vault's [names](../packages/vault/CONTRACT.md#names).

The contract is `packages/contracts/src/connections.ts`; the routes are `packages/api/src/connection-routes.ts`, in the
OpenAPI document and the SDK (`@harbour/api/sdk`). The console is one client of these routes; everything works with an
API key alone.

## Routes (under `/v1`)

| Route | What it does |
| --- | --- |
| `GET /connections/catalogue?category=&authType=&kind=&q=` | The templates the caller can use, each with `setup` (`ready`, or `needs_client` and the tiers that could register an OAuth app), its setup `tier`, `signIn` (`browser` or `device`), the `client` a connect would use and, where Harbour has one, a `guide` to registering an app |
| `GET /connections/catalogue/{templateId}` | One template |
| `POST /connections/discover` `{ url }` | What a remote MCP server says about itself: does it need a sign-in, and how Harbour would get a client |
| `POST /connections/connect` | Starts an OAuth connect for a template or an `mcpUrl` and an owner. Answers a pending attempt with a `connectUrl` (15 minutes, once), or a completed one for an open server |
| `GET /connections/connect/{attemptId}` | The attempt's status: pending, completed (with `connectionId`), failed (with `failure.code`) or expired |
| `POST /connections/keys` | A key connection for a template or a custom service (hosts and how the key goes out). The key is write-only |
| `GET /connections` | The connections the caller may see |
| `GET`, `PATCH`, `DELETE /connections/{connectionId}` | One connection: read; change its name, usage or disabled state; remove it and its credential |
| `POST /connections/{connectionId}/key` | Replace a key in place |
| `GET /connections/uses?connectionId=&sessionId=` | Which connection a session used, at which step, acting for whom, who could see the session, and what decided it (`decision`, `decidedBy`, `ruleId`, `rulesVersion`) |
| `GET`, `PATCH /connections/{connectionId}/rules` | A connection's access rules: read them; set `unmatched`, or `reset: "template"` to the template's defaults |
| `POST /connections/{connectionId}/rules`, `PATCH`, `DELETE /connections/{connectionId}/rules/{ruleId}` | Add, change or remove one rule |
| `POST /connections/{connectionId}/rules/dry-run` | "Try a request": the decision a request would get, from the same function the real send uses. Records nothing |
| `GET`, `PUT /connections/ceiling` | The organisation's ceiling, which bounds every `allow` and `ask` rule (the vault's, one per organisation) |
| `GET`, `POST /connections/clients`, `GET`, `PATCH`, `DELETE /connections/clients/{oauthClientId}` | OAuth clients per tenancy level: the deployment (`platform`), an organisation, a project or a person |
| `POST /connections/github-app` `{ owner, projectId?, githubOrganisation?, returnTo? }` | Has GitHub create a GitHub App for Harbour from a manifest. Answers `url`, the page to open (an hour, once) |
| `GET /connections/github-app/{setupId}` | The manifest flow's status: pending, created (with `clientId` and `githubApp`), failed or expired |

Browser routes beside the JSON API:

- `GET /v1/connections/authorize/{attemptId}`: the connect URL. Checks the signed-in person is the one it was made
  for (`user_mismatch` otherwise), then redirects to the provider with a single-use `state` and a PKCE challenge.
- `GET /v1/connections/callback`: the provider's redirect back. Uses up the state, exchanges the code, stores the
  tokens in the vault and shows a result page (or redirects to the attempt's `returnTo`). This is the redirect URI
  to register for pre-registered OAuth clients.
- `GET /v1/connections/oauth/client-metadata.json`: the deployment's client ID metadata document. Authorisation
  servers fetch it without signing in, so behind Cloudflare Access it needs a Bypass policy on that path.
- `GET /v1/connections/github-app/{setupId}/start?state=…`: the page a GitHub App flow's `url` opens. It posts the
  manifest on to GitHub (the person's account, or the GitHub organisation's settings).
- `GET /v1/connections/github-app/callback`: GitHub's redirect back once the app is made. Uses up the state,
  converts GitHub's code into the app's client ID and secret, stores them as an OAuth client for `github` (the secret
  in the vault; the app's private key and webhook secret are not kept) and redirects to the flow's `returnTo`, with
  `githubApp=<setupId>` (and `githubAppError=…` when it failed).

## Setup tiers

No build ships a confidential client secret, so the catalogue says for each template how it connects for the caller
(`tier`, issues #325 and #326):

| Tier | When |
| --- | --- |
| `none` | An open server, or one Harbour registers with itself (CIMD or DCR). |
| `public_client` | The deployment supplies a client ID with no secret (`HARBOUR_OAUTH_CLIENTS` with no `secretEnv`). With a device authorisation endpoint (GitHub) the connect is a device sign-in: the attempt carries `device.userCode` and `connectUrl` is the provider's page to type it at; each `GET /connections/connect/{attemptId}` asks the provider, at most once per `device.interval`. |
| `own_app` | A person or project registers their own app. GitHub's guide can have GitHub create it from a manifest; Google's lists the steps with this deployment's redirect URI and scopes. |
| `host_client` | The organisation's registered app, or a confidential one the deployment supplies. |
| `key` | No OAuth: a key. |

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

## Access rules

Usage says whether a session may use a connection at all. Rules (#332, #341) say what it may do with it, per request:

- **Who**: `any`, `organisation` (sessions in no project), a `project`, an `agent` profile or one `session`.
- **What**: `any`, an HTTP `endpoint` (method or `*`, an optional host, and a path pattern of whole segments: `*` is
  one segment, a trailing `/**` the rest), or an MCP `tool` by name. A request's path is made canonical before it is
  matched (escaped unreserved characters decoded, runs of `/` made one), and `deny` and `ask` rules match it whatever
  its case, so a server that reads paths loosely can't be reached past them; `allow` rules match exactly. Once a
  connection has rules or the organisation a ceiling, a path with an escaped `/` or `\`, a backslash, a NUL or a `.`
  or `..` segment is refused: servers read those differently, so no path rule can judge them.
- **Action**: `allow`, `ask` or `deny`; optionally an expiry and a use limit.

The most specific rule decides: the what first (tool, then endpoint by method, host and literal path, then `any`),
then the who (session, agent, project, organisation, `any`). Between equally specific rules `deny` beats `ask` beats
`allow`; where neither is narrower on both, the stricter one wins. With no match, `unmatched` decides. Listing an MCP
server's tools is allowed unless an `any` rule says otherwise. Expired and used-up rules don't match.

A request is checked in order: usage (refused `forbidden`), the connection (disabled, https, its hosts), the
organisation's ceiling, then the rules (`decideUse` in `@harbour/connections`). The dry run calls the same function.
An `allow` or `ask` rule must fit inside the ceiling to be saved; a `deny` always can.

A connection made before rules has none and `unmatched: "allow"`, so nothing changes until someone adds rules or
resets to the template's defaults (reads `allow`, writes `ask`, `unmatched: "ask"`). `ask` holds the request for a
person to approve that exact request (below). Every change bumps the rules' `version`, which a decision and a use
carry; a use counted against a rule's limit doesn't.

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

## Approvals bound to the exact request (#333)

When the rules (`decideUse`, above) answer `ask`, nothing is sent. The connections service hands the request to the vault (`connectionApproval`, system only),
which freezes it and computes its digest: SHA-256 over the canonical JSON of the connection and its version (a hash of
its owner, hosts, usage and server, so a token refresh keeps it and an edit changes it), the agent and session, the
method, scheme, host, port, path, query parameters (sorted, never decoded: `a+b` and `a%20b` differ), the headers that
count (lower-cased and sorted; transport headers such as `accept`, `user-agent` and `content-length` are left out, and
the credential is never there), the body's SHA-256, the kind and tool, and the rules' version, so a change to the
rules after approval asks again (a rule's use count is not a change). For an MCP tool call the
request is the tool and its arguments as sorted JSON, not the JSON-RPC envelope, whose IDs change.

The vault keeps it as a connection request (a proposal) of kind `request`, the same record the connection request page
decides with the binding code and passkey (`/v1/connection-approvals/requests/:id`). A second identical send while it
is pending gets the same request. The tool's error says `approval_pending` with the approval ID, digest, link and
binding code (`ApprovalPending`). `connection_call` and `connection_request` then wait inside the call: their running
details carry a `connection.approval` card, which the session shows, and they read the approval
(`ConnectionsService.approvalStatus`) until it is decided or expires.

- **Approve** makes a grant for that digest alone: one use, for ten minutes (`requestApprovalTtlMs` on the vault).
  Exact requests are approved as they are or denied, never narrowed. The waiting call sends the identical request
  once; a send with any change asks again. Of two identical sends at once, one gets it.
- **Deny**, an expiry or a withdrawal comes back to the agent as `approval_denied`, `approval_expired` or
  `approval_withdrawn`. Nothing was sent.
- A use that failed before any byte reached the upstream (no address, refused connection, TLS failure) gives the
  approval back (`release`); any other failure keeps it used, since the request may have arrived. A refresh and
  resend after a 401 is the same approved request.
- A grant for an exact request is never used by the egress proxy (`decideEgress` skips it).
- An `ask` rule's use limit is not spent by an approved request: it counts what it lets out unasked.
- **Approve and always allow requests like this** approves the request, then saves an allow rule from the approval
  (`POST /v1/connections/{connectionId}/rules/from-approval`, `createRuleFromApproval`), marked `source: approval`
  with its ID. The page builds it with `alwaysAllowRule`: the agent that sent it (its session without one), on the same
  method and path, or the same MCP tool, never by body or query. The server checks the approval is an exact request
  through that connection, still open or approved, that the rule is an `allow` covering it, and the person's right to
  add rules. A wrong code or a cancelled passkey saves no rule.

Audit: `connections.request.created` (with the digest and route, never the body), the usual decision events,
`connections.approval.used` and `connections.approval.released`. Each use records the approval it waited on or used
(`ConnectionUse.approval`).

## Turning it on

| Where | Setting | Meaning |
| --- | --- | --- |
| Cloudflare | `HARBOUR_HOSTNAME` | Set by the deploy config. Redirect URI `https://<host>/v1/connections/callback`. |
| Cloudflare | `HARBOUR_CONNECTIONS=off` | No connections. |
| Cloudflare | `HARBOUR_CONNECTIONS_CIMD=on` | Only after a Cloudflare Access Bypass policy on `/v1/connections/oauth/client-metadata.json`. |
| Both | `HARBOUR_CONNECTIONS_PERSONAL=on` | One-person deployment: sessions acting for the person are private to them. On Cloudflare, the repository variable of the same name. `GET /v1/connections/settings` reports it as `personal`. |
| Self-hosted | `HARBOUR_PUBLIC_URL` and a vault | Connections are on with both; `HARBOUR_CONNECTIONS=off` turns them off. |
| Both | `HARBOUR_OAUTH_CLIENTS` | The deployment's own OAuth clients, a JSON array of `{ templateId?, issuer?, clientId, secretEnv?, scopes?, label? }`. A confidential client's secret goes in the variable (on Cloudflare, the Worker secret) its `secretEnv` names, never in the JSON; an entry with no `secretEnv` is a public client. A bad entry is logged and left out. |

A provider that needs a registered OAuth app (GitHub, Google, Slack and others in the catalogue marked
`needs_client`) is registered by an admin with `POST /v1/connections/clients`, giving the client ID and secret of an
app whose redirect URI is the deployment's callback above. The secret goes to the vault and is never returned. For
GitHub, `POST /v1/connections/github-app` does the registering: GitHub creates the app from Harbour's manifest and
Harbour stores its client the same way. For example, a public GitHub App client for the whole deployment, signing in
with the device flow (turn on "Enable Device Flow" in the app's settings):

```sh
HARBOUR_OAUTH_CLIENTS='[{"templateId":"github","clientId":"Iv23li…","label":"Harbour for GitHub"}]'
```

Google: while the app's publishing status on the OAuth consent screen is Testing, Google expires its refresh tokens
after 7 days, so Gmail, Drive and Calendar connections need reconnecting weekly. Publishing the app (with Google's
verification for sensitive scopes) ends that.
