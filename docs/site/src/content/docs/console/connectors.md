---
title: Connectors
description: Connect agents to outside services by OAuth or by key on the Connections page, and the other ways in, through host tools, browsers and the vault.
---

Connectors let a session's agent use an outside service, such as GitHub, Linear or a remote MCP server, without ever holding the secret. You connect a service once on the **Connections** page, and agents use it through tools that run on Kantel's side.

Model providers are set up separately, as model connectors. See [Models](/console/models/).

:::note[New]
Connections merged on 30 October 2026 (the service in PR #387, the console page in PR #385). Package and variable names still use the old name, `harbour`.
:::

## The Connections page

**Settings** > **Connections** (`/connections`) has three tabs. It opens on **Connected** once anything is connected, and on **Browse** until then:

- **Browse**: the catalogue. Search it ("Search GitHub, Slack, Google Drive and more") or pick a category, then open a service to connect it. **Add a custom MCP server** takes a remote MCP server's URL, and **Connect any API with a key** sets up a service that isn't listed.
- **Connected**: what's connected, whether each is healthy (**Connected**, **Needs reconnecting**, **Error**, **Test failing** or **Disabled**) and when it was last used. Open one to see its account and granted scopes, to **Disable** or **Enable** it, or to **Disconnect** it, which deletes its credential.
- **OAuth clients**: the OAuth apps people sign in through, for providers that need one registered.

The catalogue ships with templates for GitHub, Gmail, Google Drive, Google Calendar, Slack, Linear, Notion, Atlassian, Sentry, Stripe, Vercel, Supabase, Neon, Hugging Face and others, both remote MCP servers and plain HTTP APIs.

### Connect by OAuth

Open a service, choose who the connection is for and which permissions to ask for beyond the defaults, and press **Connect** followed by the service's name (or **Connect another account**). The console opens a window for the provider's sign-in; if your browser blocks it, the page gives you the link to open by hand. Kantel handles the redirect and the callback itself, so no token passes through the console. When the sign-in finishes, the page shows which account was connected.

A provider marked as needing a client (GitHub, Google, Slack and some others) can't be connected until someone registers an OAuth app for it on the **OAuth clients** tab. An organisation admin adds the app's client ID and secret once, and everyone can connect. The app's redirect URI must be the deployment's callback, `https://<your host>/v1/connections/callback`. The secret goes to the vault and is never shown again.

For Google, while the app's publishing status on its OAuth consent screen is **Testing**, Google expires refresh tokens after 7 days, so Gmail, Drive and Calendar connections need reconnecting every week. Publishing the app (Google verifies apps that ask for sensitive scopes) ends that.

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

Usage settings narrow it further: only some projects, only sessions for some people, only some agent profiles, whether sessions acting for no one (such as scheduled runs) may use it, and whether it is private. A private connection is used only in a session nobody but its person can see. A person's connection is private by default. Unless the deployment runs with `KANTEL_CONNECTIONS_PERSONAL=on`, a session is seen by its project, so a private connection can't be used in it; the add forms start on the project you have open, and warn when you pick **Just me** on such a deployment (`GET /v1/connections/settings` says which it is). You can connect several accounts to one provider, each with its own owner and settings.

## How agents use a connection

A session gets four tools:

| Tool | What it does |
| --- | --- |
| `connections_list` | Lists the connections the session may use, the most specific owner first: its person's, then the project's, then the organisation's |
| `connection_tools` | Lists a remote MCP server's tools |
| `connection_call` | Calls a tool on a remote MCP server |
| `connection_request` | Sends an HTTP request to a connected API |

The tools run on Kantel's side, never in the sandbox. Kantel checks the connection may be used in that session, refreshes an OAuth token when it is due, adds the credential for the request's host only, and strips it from the answer. A tool can't set `authorization`, `cookie` or `host` itself. Agents never create, change or remove connections.

### Approving one request

A connection's access rules can say `ask` for some requests: by default, a connection reset to its template's rules allows reads and asks about writes. When a request is asked about, nothing is sent. The session shows a **Needs approval** card with the request, its binding code and a link to the connection request page. The page shows the whole request: method and URL, the headers that count, the body (formatted when it is JSON, with the bytes as sent a click away), and its digest. Characters you can't see, such as zero-width spaces or direction overrides, are drawn by name. Pick the code the card shows, then approve with your passkey, or deny.

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

<!-- Sources (d031001): docs/connections.md:1-110, apps/cloudflare/src/connections.ts:1-20, apps/cloudflare/src/gateway.ts:25,259-262, apps/selfhosted/src/gateway/connections.ts:1-8, apps/selfhosted/src/gateway/main.ts:84-87, apps/console/src/app/router.ts:25, apps/console/src/app/app.tsx:306-313, packages/ui/src/connections/connections-page.tsx:1-4,136-140, packages/ui/src/connections/connect-flow.tsx:1-8, packages/ui/src/connections/connections-model.ts:302-322, packages/connections/src/catalogue.ts:77-480, packages/connections/src/service.ts:355-385, packages/runtime/HTTP.md:112-143, apps/cloudflare/README.md:89-90 -->
