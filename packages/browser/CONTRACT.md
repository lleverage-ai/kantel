# Browser contract

## What it is for

The browser broker hands agents a browser without handing them the browser provider. Harbour holds the provider's
key (brwsr acts for a whole project), so the broker decides which stored profile (context) an agent's browser uses.
**A supervisor or a human chooses the context, never the agent.** The agent gets a session-scoped CDP URL, and every
browser session is a lease that ends with its agent session.

A supervisor is a human, a service, or an agent acting in the parent session of the target session.

## Records

- **Context**: a stored profile at the provider (name, owner, `providerContextId`). Only humans and services see it.
- **Grant**: binds one agent session to one context, with `persist`, `timeoutMs`, `allowedSites` and `grantedBy`.
  Status `active`, `revoked` or `ended`.
- **Request**: an agent asking for a browser, with a reason and sites, never a context.
- **Browser session**: one open browser under a grant: `cdpUrl`, `persisting`, `expiresAt`, and an `endReason` of
  `closed`, `timeout`, `session_ended` or `revoked`. It never carries the provider context ID.

## Key operations

`putContext` and `listContexts` (humans and services) → `request` (agent) → `grant` (supervisor, optionally answering a
request) → `open` (agent) → `checkSite` → `close`. `revokeGrant` (supervisor) and `endSession` (runtime) end things.

## Rules and the suite cases that enforce them

- An agent never grants to its own session: "refuses an agent granting a browser context to its own session" (`refused`,
  audited `browser.grant.refused`, even if the directory names the session as its own parent).
- Only the parent session's agent may grant as an agent; unrelated agents, a child granting to its parent and system
  actors are refused: "refuses an unrelated agent, a child agent or a system actor granting to another session".
- Supervisors grant: "lets an agent in the parent session grant a browser context to its child", "lets a human or a
  service grant a browser context".
- Agents never see or make contexts: "forbids an agent listing or creating browser contexts".
- A request names no context; a supervisor's grant with `requestId` marks it granted (audited
  `browser.request.granted`), once: "takes a request naming no context and marks it granted when a supervisor answers
  it".
- An agent cannot pick a context at open: "refuses opening with a context the grant does not hold and uses the grant's
  when none is named" (audited `browser.session.refused`).
- Only the grant's own session and agent can open under it, and agents list only their own session's grants: "hides
  another session's grant from an agent opening a browser".
- No agent view holds the provider context ID: "gives the agent a CDP URL and never the provider context ID".
- One persisting browser session per context: "allows one persisting browser session per context at a time and any
  number of non-persisting ones", "settles concurrent persisting opens on one context with exactly one browser
  session".
- Sites: exact host, or `*.host` for subdomains only; ports ignored; http or https only: "checks sites against the
  grant, with wildcards for subdomains and lookalike hosts refused".
- Timeouts close and release: "closes a browser session past its timeout as timeout and releases it at the provider".
- Nothing outlives the agent session: "ends every browser session and grant when the agent session ends".
- Revoking closes: "closes a grant's browser sessions when the grant is revoked".
- Organisation isolation: "hides another organisation's contexts, grants and browser sessions as not found".
- Audit: "audits every grant, refusal, open and close with its actor".

## The in-memory implementation

`createMemoryBrowser({ clock?, audit?, provider?, parentOf? })` keeps everything in maps. `parentOf` defaults to "no
parent", so only humans and services can grant. `createFakeBrowserProvider()` opens nothing real; its CDP URLs are
`wss://browser.invalid/<providerSessionId>` and `live()` lists unreleased sessions. Every call first sweeps sessions
past `expiresAt` (by the clock) and releases them. `open` reserves the persisting slot before awaiting the provider
and re-checks the grant afterwards, so a revoke or session end during the open releases the new browser. Ending a
session also declines its pending requests. It leaves out durable storage, retries of failed provider releases,
role checks beyond "not an agent", and site enforcement inside the browser itself (`checkSite` is the decision; the
egress layer must apply it).

## Open questions

- The contract has no read for requests, so "marked granted" is only visible through the `browser.request.granted`
  audit event. Should `Browser` gain `getRequest` or `listRequests`, and a way to decline?
- Who may revoke: here any supervisor of the grant's session (`forbidden` otherwise, including the agent itself).
- Opening under a revoked or ended grant is `expired`; checking a site on a closed browser session returns
  `allow: false` rather than an error.
- `putContext` always creates a new context; should it upsert by name?
