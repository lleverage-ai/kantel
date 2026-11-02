---
title: Connectors
description: Connect agents to outside services by OAuth or by key on the Connections page, and the other ways in, through host tools, browsers and the vault.
---

Connectors let a session's agent use an outside service, such as GitHub, Linear or a remote MCP server, without ever holding the secret. You connect a service once on the **Connections** page, and agents use it through tools that run on Kantel's side.

Model providers are set up separately, as model connectors. See [Models](/console/models/).

## The Connections page

**Settings** > **Connections** (`/connections`) has three tabs. It opens on **Connected** once anything is connected, and on **Browse** until then:

- **Browse**: the catalogue. Search it ("Search GitHub, Slack, Google Drive and more") or pick a category, then open a service to connect it. **Add a custom MCP server** takes a remote MCP server's URL, and **Connect any API with a key** sets up a service that isn't listed.
- **Connected**: what's connected, whether each is healthy (**Connected**, **Refresh failing**, **Needs reconnecting**, **Error**, **Test failing** or **Disabled**) and when it was last used. Open one to see its account and granted scopes, to **Disable** or **Enable** it, or to **Disconnect** it (see [Disconnecting](#disconnecting)).
- **OAuth clients**: the OAuth apps people sign in through, for providers that need one registered.

The catalogue ships with templates for GitHub, Gmail, Google Drive, Google Calendar, Slack, Linear, Notion, Atlassian, Sentry, Stripe, Vercel, Supabase, Neon, Hugging Face and others, both remote MCP servers and plain HTTP APIs.

### Connect by OAuth

Open a service, choose who the connection is for and which permissions to ask for beyond the defaults, and press **Connect** followed by the service's name (or **Connect another account**). The console opens a window for the provider's sign-in; if your browser blocks it, the page gives you the link to open by hand. Kantel handles the redirect and the callback itself, so no token passes through the console. When the sign-in finishes, the page shows which account was connected.

A provider marked as needing a client (GitHub, Google, Slack and some others) can't be connected until someone registers an OAuth app for it on the **OAuth clients** tab. An organisation admin adds the app's client ID and secret once, and everyone can connect. The app's redirect URI must be the deployment's callback, `https://<your host>/v1/connections/callback`. The secret goes to the vault and is never shown again.

For Google, while the app's publishing status on its OAuth consent screen is **Testing**, Google expires refresh tokens after 7 days, so Gmail, Drive and Calendar connections need reconnecting every week. Publishing the app (Google verifies apps that ask for sensitive scopes) ends that.

The catalogue says for each service how it connects for you (its setup tier):

| Tier | When |
| --- | --- |
| `none` | An open server, or one Kantel registers itself with (client ID metadata or dynamic client registration) |
| `public_client` | The deployment supplies a client ID with no secret. Where the provider has a device sign-in (GitHub), you type a code at the provider's page |
| `own_app` | You or your project register your own app. For GitHub, `POST /v1/connections/github-app` has GitHub create the app from Kantel's manifest and stores its client |
| `host_client` | The organisation's registered app, or a confidential one the deployment supplies |
| `key` | No OAuth: the service takes a key |

### GitHub

GitHub's page walks through three states, with one main action each: set up the organisation's GitHub App (GitHub makes it from Kantel's manifest), install it on repositories and connect your account, then the connection itself. Once connected, the page says who it's connected as and who can use it, what it can reach (`GET /v1/connections/{connectionId}/reach`: the accounts the app is installed on, each with its settings page, and their repositories, up to 300), and what agents may do. A GitHub App's sign-in gets the app's permissions whatever it asks for, so the page lists them read-only and has no scope checkboxes. Signing in connects your own account, so it starts as **Just me**.

### Token refresh and reconnecting

Kantel refreshes an OAuth connection's access token before it expires, whether or not anyone is using it. Concurrent requests on one connection share one refresh, across gateway processes too, since providers that rotate refresh tokens refuse a second refresh with the same one.

- If a refresh fails for now (no answer, a 5xx), the connection shows **Refresh failing** and Kantel tries again after 30 seconds, doubling up to 30 minutes. A token that hasn't expired is still used. Once it has, requests are refused as `connection_refresh_failing`, which is retryable.
- If the provider refuses the refresh token, or a refreshed token still gets a 401, the connection shows **Needs reconnecting**. Every request is refused as `connection_reconnect_required`, with a link to the connection's page. Reconnecting keeps its ID, rules, shares and history.

The audit log records `connections.connection.refreshed`, `connections.connection.refresh_failed` and `connections.connection.needs_reconnect`.

### Disconnecting

**Disconnect** stops every use at once, then asks the provider to revoke the access it granted, deletes the credential from the vault, and removes the connection with its rules and any approvals not yet used. Its uses and audit history stay. The page then says what happened at the provider:

| The page says | Means |
| --- | --- |
| ...revoked the access too | The provider accepted the revocation. |
| ...gives apps no way to revoke access | The provider has no revocation endpoint (Slack, GitHub's MCP server), or the app has no client secret where the provider needs one (GitHub with the device flow). Remove the app in the provider's settings; the page links there when Kantel knows the page. |
| ...didn't revoke the access | Kantel asked and the provider refused or didn't answer within 10 seconds. The connection is removed all the same; remove the access in the provider's settings. |
| ...deleted the key, but it still works | A key can only be revoked at the service that issued it. |
| ...nothing to revoke | An open server, or a connection with no credential left. |

Kantel revokes with the provider's RFC 7009 revocation endpoint (named by the authorisation server's metadata for a remote MCP server, or by the catalogue for Google), or with GitHub's own grant endpoint for a GitHub app with a client secret. It sends the refresh token where it holds one, which ends the whole grant. The answer to `DELETE /v1/connections/{connectionId}` and the `connections.connection.removed` audit event carry the same outcome: `revoked`, `unsupported`, `failed` or `none`.

### Connect by key

**Connect any API with a key**, or a listed service that takes a key, asks for the key, the hosts it may be sent to and how it is sent:

| How the key is sent | Means |
| --- | --- |
| Bearer | `Authorization: Bearer <key>` |
| Basic | HTTP basic auth, with a user name |
| Header | A header you name, with an optional prefix |
| Query | A query parameter you name |

Confirm where the key may be sent before saving it: it goes only to those hosts. The key is write-only. You can replace it later, but no one can read it back.

## Who a connection is for

Each connection has an owner, which decides who manages it and bounds where it can be used:

- **The organisation**: usable in every project. Managing it needs the organisation's admin role.
- **A project**: never leaves that project. Managing it needs admin on the project.
- **A person**: used only in sessions acting for that person.

Usage settings narrow where it can be used: only some projects, only sessions for some people, only some agent profiles, whether sessions acting for no one (such as scheduled runs) may use it, and whether it is private. A private connection is used only in a session nobody but its person can see. A person's connection is private by default. Unless the deployment runs with `KANTEL_CONNECTIONS_PERSONAL=on`, a session is seen by its project, so a private connection can't be used in it; the add forms start on the project you have open, and warn when you pick **Just me** on such a deployment (`GET /v1/connections/settings` says which it is). You can connect several accounts to one provider, each with its own owner and settings.

### Scheduled runs

A run a schedule starts is unattended: nobody is watching it, and its session says which schedule and occurrence started it.

- With `KANTEL_CONNECTIONS_PERSONAL=on`, a run of a schedule a person made acts for that person and is private to them, so it may use their own (**Just me**) connections, as their own session would. Nobody else can open it. A schedule an agent, a service or Kantel made acts for no one.
- Without it, a run acts for no one, so a person's connection is refused to it.
- A run never uses another person's connection, even one shared with its project.
- An organisation's or a project's connection still needs **Unattended sessions may use it** (`usage.unattended`).

Every use records whether it was unattended and who it acted for, and so does its `connections.use.*` audit event.

Rules can treat scheduled runs differently (see [Access rules](#access-rules)): a rule for **unattended** sessions covers scheduled runs and any session with no person behind it. When a rule asks about a request in a scheduled run, the run waits: the request goes to the connection's approvers' queue, its `connections.use.held` event says `unattended: true` so a host can tell its person, and it goes out once if someone approves in time. If nobody answers before the approval expires, the agent gets an `approval_expired` refusal and nothing is sent.

## How agents use a connection

A session gets four tools:

| Tool | What it does |
| --- | --- |
| `connections_list` | Lists the connections the session may use, the most specific owner first: its person's, then the project's, then the organisation's |
| `connection_tools` | Lists a remote MCP server's tools |
| `connection_call` | Calls a tool on a remote MCP server |
| `connection_request` | Sends an HTTP request to a connected API |

The tools run on Kantel's side, never in the sandbox. Kantel checks the connection may be used in that session, refreshes an OAuth token when it is due, adds the credential for the request's host only, and strips it from the answer. A tool can't set `authorization`, `cookie` or `host` itself. Agents never create, change or remove connections.

### Access rules

Usage says whether a session may use a connection at all. A connection's access rules say what it may do with it, request by request. On an API connection's page, **What agents may do** shows them as a grid: a row per permission group, with Allow, Ask or Block for its reads, writes and deletes and, under them, what scheduled runs get (**Same**, **Reads only** or **Block**, never more than the cells allow), then, for GitHub, which repositories it may reach, then the exceptions, the rules that decide some requests themselves. The grid is made of ordinary rules; **Advanced** holds every rule and the answer for unmatched requests. Each rule has:

- **Who**: any session, sessions a person is in (`attended`), scheduled runs and other sessions with nobody present (`unattended`), organisation sessions (in no project), one project, one agent profile or one session.
- **What**: anything, an HTTP endpoint (a method or `*`, an optional host, and a path pattern of whole segments, where `*` is one segment and a trailing `/**` the rest), an MCP tool by name, or an operation: what the request does as the template classifies it, by permission group, access (`read`, `write`, `delete` or `admin`) and repository (`owner/repo`, `owner/*` or `*/*`, ignoring case). Only templates that classify their requests (GitHub) match operation rules; GitHub's GraphQL queries are reads and anything else sent to `/graphql` a write.
- **Action**: `allow`, `ask` or `deny`, optionally with an expiry and a use limit.

The most specific rule decides: first by what (a tool, then an endpoint by method, host and literal path, with an operation rule ranked by how much it names, above a pattern open from the root and below one with a literal segment, then anything), then by who (a session, an agent, a project, the organisation, attended or unattended, anyone). A request that names no single repository (a GraphQL call, a search) matches no rule that names one. Between equally specific rules, `deny` beats `ask` and `ask` beats `allow`. With no match, the connection's `unmatched` setting decides. Expired and used-up rules don't match. Paths are made canonical before they are matched, and once a connection has rules, a path with an escaped `/` or `\`, a backslash, a NUL, or a `.` or `..` segment is refused.

A request is checked in order: usage, the connection itself (disabled, https, its hosts), the organisation's ceiling, then the rules. An `allow` or `ask` rule must fit inside the ceiling to be saved. **Try a request** on a connection's rules (`POST /v1/connections/{connectionId}/rules/dry-run`) shows the decision a request would get, from the same check, and records nothing. It can be tried as a scheduled run, with a body (for GraphQL), and says how the request was classified and which rule decided.

A new connection starts with its template's defaults, for any agent: reads (`GET`, `HEAD`) allowed, deletes denied, the template's writes asked about, and anything else asked about. GitHub's are by operation too: reads allowed, writes and admin changes asked about, deletes denied, so a GraphQL query goes through and a mutation asks. An MCP server's tools get theirs from its listing: read-only tools allowed, destructive ones denied, and the rest asked about. Rules you edit are kept; the console warns about a set that allows unmatched requests and can reset it to the template's defaults.

### Approving one request

A connection's access rules can say `ask` for some requests: by default, a connection reset to its template's rules allows reads and asks about writes. When a request is asked about, nothing is sent. The session shows a **Needs approval** card with the request, its binding code and a link to the connection request page. The page shows the whole request: method and URL, the headers that count, the body (formatted when it is JSON, with the bytes as sent a click away), and its digest. Characters you can't see, such as zero-width spaces or direction overrides, are drawn by name. Pick the code the card shows, then approve with your passkey, or deny.

When the request waits in a call the session shows, the console shows it in that call instead, with **Approve once**, **Allow for this session**, **Always allow…** and **Deny**, and you don't type the code. See [Connection requests](/console/connection-requests/). A session's access menu lists the connections it can use, with each one's policy in a line and what this session alone was allowed, which you can revoke if you manage the connection.

An approval lets out that exact request once, within ten minutes. The agent is waiting and sends it as soon as you approve; if it changes anything, even one byte of the body, it asks again. A denied or expired request comes back to the agent as refused, and nothing was sent. Exact requests can't be narrowed: approve them as they are, or deny them.

**Approve and always allow requests like this** approves the request, then adds a rule to the connection that allows the same method and path (or the same MCP tool) for that agent, whatever the body. The page says what the rule will be before you press it. You need the right to change the connection's rules, and the rule shows on the connection, marked as coming from the approval, where you can stop it.

Every use is recorded with the session, the tool call and who could see the session at the time (`GET /v1/connections/uses`), with the approval it waited on or used. A use is `allowed` (it went out), `denied` (refused) or `held` (waiting for a person to approve it, nothing sent). Secrets are vault items: each time one is opened, the vault records a use, and it refuses an open for another host, another organisation, or a blocked or ended session.

## From the API

Everything on the page works with an API key alone. A headless OAuth connect for one person looks like this:

```bash
# Start: a remote MCP server for one person.
curl -s -X POST "$KANTEL_URL/v1/connections/connect" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"mcpUrl":"https://mcp.example.com/mcp","owner":{"kind":"user","organisationId":"ORG_ID","userId":"USER_ID"},"forUserId":"USER_ID"}'
# The answer is a pending attempt with a connectUrl, valid once for 15 minutes.
# The person opens connectUrl and signs in at the provider. Then poll the attempt:
curl -s "$KANTEL_URL/v1/connections/connect/ATTEMPT_ID" -H "authorization: Bearer $KANTEL_API_KEY"
# { "status": "completed", "connectionId": "..." }
```

The connect URL checks that the person who opens it is the one it was made for. The routes and bodies are in the [Connections reference](/api/reference/connections/).

## Turning connections on

| Target | What it needs |
| --- | --- |
| Cloudflare | On by default once `KANTEL_HOSTNAME` is set, which the deploy config does. `KANTEL_CONNECTIONS=off` turns them off. |
| Self-hosted | On with `KANTEL_PUBLIC_URL` and a vault (`KANTEL_VAULT_CIPHER_KEY`). `KANTEL_CONNECTIONS=off` turns them off. |
| Both | `KANTEL_CONNECTIONS_PERSONAL=on` for a deployment with one person, so their personal connections work in all their sessions. |
| Both | `KANTEL_CONNECTIONS_CIMD=on` only once `/v1/connections/oauth/client-metadata.json` is reachable without signing in. On Cloudflare that needs an Access Bypass policy on the path. Without it, remote MCP servers connect through dynamic client registration or a registered client. |
| Both | `KANTEL_OAUTH_CLIENTS`: the deployment's own OAuth clients, as a JSON array of `{ "templateId", "clientId", "secretEnv", "label" }`. Put a confidential client's secret in its own variable or secret and name it in `secretEnv`; never write it in the JSON. A client with no `secretEnv` is public: GitHub then signs people in with a code they type at GitHub (turn on Device Flow in the app's settings). |

## Other ways in

### Host tools

A host app can give a session's agent its own tools. The host registers them with a callback URL, and Kantel POSTs each call there, signed with `harbour-signature`. The host's code runs with whatever access it already has, so the agent never sees those credentials. See [Host tools](/api/host-tools/).

### Browsers

An agent can ask for a browser on named sites, and a person allows or declines it. You can watch the browser live and replay it. See [Browsers](/console/browsers/).

### Connection requests and sandbox egress

Kantel's encrypted store holds credentials and decides outbound requests from a sandbox. A value never leaves it: a sandbox holds only a placeholder, and the egress path asks the store what to inject. See [Connection requests](/console/connection-requests/).

A connector is how Kantel talks to a model or a channel; a connection is a credential an agent uses.

On Cloudflare, sandboxes have no network yet, so a session reaches outside services through connections, host tools or a browser, not from its sandbox. In the self-hosted Docker Compose stack, an egress proxy is a sandbox's only way out.

<!-- Sources (d031001, rules and refresh checked at ba80016): packages/contracts/src/connections.ts, packages/connections/src/rules.ts, packages/connections/src/service.ts, apps/cloudflare/src/connections.ts:1-20, apps/cloudflare/src/gateway.ts:25,259-262, apps/selfhosted/src/gateway/connections.ts:1-8, apps/selfhosted/src/gateway/main.ts:84-87, apps/console/src/app/router.ts:25, apps/console/src/app/app.tsx:306-313, packages/ui/src/connections/connections-page.tsx:1-4,136-140, packages/ui/src/connections/connect-flow.tsx:1-8, packages/ui/src/connections/connections-model.ts:302-322, packages/connections/src/catalogue.ts:77-480, packages/connections/src/service.ts:355-385, packages/runtime/HTTP.md:112-143, apps/cloudflare/README.md:89-90 -->
