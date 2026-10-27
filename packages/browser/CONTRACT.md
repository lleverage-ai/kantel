# Browser contract

## What it is for

The browser broker hands agents a browser without handing them the browser provider. Harbour holds the provider's
key (brwsr acts for a whole project), so the broker decides which stored profile (context) an agent's browser uses.
**A supervisor or a human chooses the context, never the agent.** The agent gets a session-scoped CDP URL, and every
browser session is a lease that ends with its agent session.

A supervisor is a human, a service, or an agent acting in the parent session of the target session. Humans and
services may grant any context. An agent supervisor may only pass on, no wider, a context it already holds. Tom
confirmed agent supervisors on 27 Oct 2026 ("Yes, as built").

## Records

- **Context**: a stored profile at the provider (name, owner, `providerContextId`). Only humans and services see it.
- **Grant**: binds one agent session to one context, with `persist`, `timeoutMs`, `allowedSites` and `grantedBy`.
  Status `active`, `revoked` or `ended`. `parentGrantId` names the grant it was passed on from, when an agent
  supervisor granted it; it ends when that one does.
- **Request**: an agent asking for a browser, with a reason and sites, never a context.
- **Browser session**: one open browser under a grant: `cdpUrl`, `persisting`, `expiresAt`, and an `endReason` of
  `closed`, `timeout`, `session_ended`, `aborted` or `revoked`. It never carries the provider context ID.

## Key operations

`putContext` and `listContexts` (humans and services) → `request` (agent) → `grant` (supervisor, optionally answering a
request) → `open` (agent) → `checkSite` → `close`. `revokeGrant` (supervisor) and `endSession` (the session-end
teardown) end things.

## Project access (settled 27 Oct 2026, question 7)

A context owned by a project belongs to it; a grant, a request and a browser session belong to their agent session's
project (and a grant to its `projectId`). With `access`, every call checks the caller through `ProjectAccess` after the
organisation lookup (another organisation's record stays `not_found`) and after the existing agent rules (agents stay
`forbidden` from contexts, humans from `request` and `open`). Refusals are `forbidden`, audited `access.denied`:

| Operation | Checks |
| --- | --- |
| `browser.putContext` | operator on the owner project; organisation-wide operator for an organisation-owned context |
| `browser.listContexts` | per record: viewer on a project-owned context's project; others list as before |
| `browser.request` | operator on the agent's own session |
| `browser.grant` | operator on `{ projectId, sessionId }` of the input, and on a project-owned context's project |
| `browser.revokeGrant` | operator on the grant's session and project |
| `browser.listGrants` | viewer on the filter's session, or per record |
| `browser.open`, `browser.close` | operator on the browser session's (or grant's) agent session |
| `browser.checkSite`, `browser.get` | viewer on the browser session's agent session |

`grant` checks an agent on `input.projectId` first, so an agent of another project is `forbidden`, while one in the
project that does not supervise the session (or grants to its own) still gets the supervisor rule's `refused`; then
everyone on the session as well. Cases: "project access: refuses an operator outside the project every change and read
of its records", "project access: refuses an agent whose session belongs to another project", "project access: refuses
an agent whose session was closed", "project access: leaves another project's contexts and grants out of an operator's
lists", "project access: lets an operator on the project and an agent in its own session act".

## Session end (settled 27 Oct 2026, question 8)

`endSession(ctx, sessionId, reason)` is the broker's teardown, registered as `browser` with the session-end hook. It
is a worker call (settled by Tom on 27 Oct 2026, question 13: "Require a system identity"): `ctx` is a
`SystemContext`, and any other actor, the session's own agent included, or no caller is `forbidden`, audited once as
`access.denied`, and ends nothing ("worker calls: endSession refuses every caller but system, the session's own agent
included, and ends nothing"). For
`session_ended` or `aborted` it closes the session's open browser sessions with that end reason and ends its grants,
and the grants passed on from them (closing their browsers with the same reason). Only `session_ended` declines pending
requests; after `aborted` they stay pending and the session can be granted and open browsers again. A second run
changes and audits nothing. Cases: "session end: closes the session's browsers, ends its grants and those passed on,
declines its requests, once", "session end: an abort closes the session's browsers and ends its grants once, keeps its
requests and leaves it usable".

## Rules and the suite cases that enforce them

- An agent never grants to its own session: "refuses an agent granting a browser context to its own session" (`refused`,
  audited `browser.grant.refused`, even if the directory names the session as its own parent).
- Only the parent session's agent may grant as an agent; unrelated agents, a child granting to its parent and system
  actors are refused: "refuses an unrelated agent, a child agent or a system actor granting to another session".
- Supervisors grant: "lets an agent in the parent session pass on a browser context it holds to its child", "lets a
  human or a service grant a browser context".
- An agent supervisor needs an active grant of its own, for its own session, on the same context (the parent grant);
  otherwise `refused` with reason `no_parent_grant`: "refuses an agent supervisor granting a context it holds no
  active grant for".
- The child grant is no wider than the parent grant: `persist` only if the parent's is, `timeoutMs` no greater, and
  every site covered (an exact host in the list or under a wildcard; a wildcard equal to or under one). Anything wider
  is `refused` with reason `wider_than_parent`: "refuses an agent supervisor passing on a grant wider than its own in
  persist, sites or timeout".
- Revoking or ending a grant ends every grant passed on from it, transitively, the same way, and closes their
  browsers; ending the parent session does the same: "ends the grants passed on from a grant, transitively, and closes
  their browsers, when it is revoked or its session ends".
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
- A wildcard must sit over at least two labels (`*.com` is `invalid`). There is no public suffix list, so `*.co.uk`
  is accepted: "rejects a wildcard over a single label as invalid".
- Timeouts close and release: "closes a browser session past its timeout as timeout and releases it at the provider".
- Nothing outlives the agent session: "ends every browser session and grant when the agent session ends".
- Revoking closes: "closes a grant's browser sessions when the grant is revoked".
- A revoke or session end while `open` is in flight fails the open as `expired`, releases the new browser and frees
  the persisting slot: "fails an open in flight when its grant is revoked, releasing the browser and freeing the
  persisting slot", "fails an open in flight when its session ends, releasing the browser and freeing the persisting
  slot".
- A failed provider release never fails the caller's request or the other releases. The browser session still reads
  `closed`; the failure is audited once per attempt as `browser.session.release_failed` and retried on the next call:
  "releases each browser independently when a provider release fails, and retries the failed one on the next call".
- Organisation isolation: "hides another organisation's contexts, grants and browser sessions as not found".
- Audit: "audits every grant, refusal, open and close with its actor". A refusal's audit id names the session, the
  operation and the target (context or grant) as well as the request ID, so different refusals under one request ID
  each keep a row: "refuses an unrelated agent, a child agent or a system actor granting to another session".

## The in-memory implementation

`createMemoryBrowser({ clock?, audit?, provider?, parentOf?, access?, sessionEnd? })` keeps everything in maps. Without
`access` it checks only the organisation; with `sessionEnd` it registers `endSession` as `browser`, ignoring the hook's
context. `parentOf` defaults to "no parent", so only humans and services can grant. `createFakeBrowserProvider()` opens
nothing real; its CDP URLs are `wss://browser.invalid/<providerSessionId>` and `live()` lists unreleased sessions. Every
call first sweeps sessions past `expiresAt` (by the clock) and releases them. `open` reserves the persisting slot before
awaiting the provider and re-checks the grant afterwards, so a revoke or session end during the open releases the new
browser. Releases run independently; failed ones wait in a retry set that every call's sweep retries. When an agent
supervisor holds more than one active grant on the context, the first one the new grant is no wider than becomes its
parent. The fake provider's `failReleases(times)` and `holdNextOpen()` drive the release and in-flight cases. It leaves
out durable storage and site enforcement inside the browser itself (`checkSite` is the decision; the egress layer must
apply it).

## Open questions

- A provider release that keeps failing is retried on every call, for ever, and each attempt is audited. Should it
  give up and alert after some attempts? Retries also run inside whichever call sweeps next, in any organisation, so
  a `release` that hangs delays that call. A durable broker should retry from a background loop with a timeout.
- The contract has no read for requests, so "marked granted" is only visible through the `browser.request.granted`
  audit event. Should `Browser` gain `getRequest` or `listRequests`, and a way to decline?
- Who may revoke: here any supervisor of the grant's session (`forbidden` otherwise, including the agent itself).
- Opening under a revoked or ended grant is `expired`; checking a site on a closed browser session returns
  `allow: false` rather than an error.
- `putContext` always creates a new context; should it upsert by name?
