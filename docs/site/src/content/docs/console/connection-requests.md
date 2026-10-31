---
title: Connection requests
description: Approve, narrow or deny an agent's request for a connection on the connection request page, set up a passkey, and stop grants you no longer need.
---

Connections are the credentials your agents use. Agents and sandboxes never see a credential's value: when a request
leaves a sandbox, Partan decides whether it may go and adds the credential on the way out. An agent asks for access
with a connection request, and only a person (or a service acting for one) decides it, on the console's connection
request page. The credentials themselves sit in Partan's internal encrypted store, which the code calls the vault.

Not to be confused with a connector: a connector is how Partan talks to a model or a channel, and a connection is a
credential an agent uses.

## What Partan holds

- **Items**: a credential with an owner, a name, the hosts it may go to and how it is injected (for example
  `Authorization: Bearer {key}`). Partan never returns an item's value.
- **Requests**: an agent's request, with a kind, terms, a binding code such as `ABC-DEF`, a link to the request page
  and an expiry (15 minutes by default). The code and the API call them proposals.
- **Grants**: what an approval creates, for the requesting agent and session, within the approved terms.
- **Policies** and a **ceiling**: an admin's standing rules, and the organisation's outer bound on routes.

| Kind | On the page | What it allows |
| --- | --- | --- |
| `read` | Read | One use of read methods. You don't pick the binding code. |
| `write` | Write | One use of any other method. You must pick the code. |
| `route` | Route grant | Repeated requests within the terms until the grant expires or is stopped. You must pick the code. |
| `secret` | Secret paste | You paste a value for a new or empty item. You must pick the code. |

An item owned by a person is theirs, not the organisation's. Only they (or a service with an organisation-wide role)
see it and decide requests for it; an organisation admin who isn't the owner is refused. An agent can use it only
from a session that works for that person. The request page marks these "Your personal item" or "Personal item".

:::note[Not yet available]
The console and the public API can't add items, policies or a ceiling. A self-hosted gateway imports the credentialed
routes in its egress policy file into the store when it starts.
:::

## How an agent asks

A request appears in the session's transcript as a `connection.approval` card (`vault.approval` in transcripts written
before the rename, shown the same way): what is wanted and why, the terms, the binding code and the time left.
**Open request** opens it on the connection request page in a new tab; **Copy link** copies the link. The binding code ties the card to the page: a forged link can show any terms, but not the code on
the real card in your session, so always compare them.

:::note[Not yet available]
No session tool or public API route creates a request yet, so live sessions don't show `connection.approval` cards.
The console shows cards read-only; you act on a request from the connection request page.
:::

The session protocol also defines a `question` card (a question with optional answers). The console shows it
read-only.

:::note[Not yet available]
You can't answer a question card yet: no API route takes an answer.
:::

## The connection request page

The connection request page is at `/connections/requests` and lists your active grants; Settings calls it
**Connection requests**, under **You**. A request opens at `/connections/requests/<proposalId>`. Older links (`/vault`,
`/vault/proposals/<proposalId>` and `/vault/requests/<proposalId>`) open the same page and the address changes to the
new one. The console lists the page only when the gateway serves the connection approval API.

A request shows **Requested by** (the agent, person, session, project and organisation), the **Terms**, the
**Binding code**, a **Secret** field for a secret paste, and a countdown that turns amber in its last two minutes.
If the request isn't yours, a notice says whose it is. Without the operator role on its project, it opens read-only.

### Narrow the terms

While a request is open you can narrow its methods, path, lifetime and uses. Each term is marked "Proposed" or
"Narrowed", and the sentence starting "If you approve, the agent may send" says exactly what the agent will be
allowed. **Undo narrowing** restores the agent's terms. Narrowing only tightens: a sibling path (`/graphqlx` under
`/graphql`) or more uses than asked are refused. The agent is told what you approved, never what it asked for.

### Pick the binding code

For a write, a route grant or a secret paste, pick the code under "Pick the code the card in your session shows". The
real code is among decoys, and Approve stays disabled until you pick. A wrong pick is refused, audited as
`connections.binding_code.mismatch`, and changes nothing. If no code matches the card, deny the request. For a read, the
code is shown for checking only.

### Approve, paste or deny

- **Approve** (**Approve with passkey** once you have a passkey) approves with the terms shown.
- **Paste and approve** (or **Paste and approve with passkey**) sends the pasted value once, with the approval.
  Partan checks the code before it reads the value, so a wrong code stores nothing.
- **Deny** refuses the request, and never needs a passkey.

A settled request shows "Approved", "Approved with narrower terms", "Denied", "Expired", "Approved, then stopped" or
"Withdrawn". If nobody decides in time, nothing changes and the agent can ask again.

### Stop a grant

**Active grants** lists each grant's uses, time left, agent and session, with **Stop**. A settled request with an
active grant has **Stop this grant**. A stopped grant is refused from its next request. Ending a session revokes its
grants and withdraws its pending proposals.

## Passkeys

Until you set up a passkey, approvals rest on your sign-in and the binding code, and the request page offers
**Set up a passkey**. After that, every approval asks for your fingerprint, face or PIN, over a challenge bound to the
request, its terms and your narrowing. A cancelled prompt sends nothing. A missing or failed passkey is refused and
audited as `connections.passkey.refused`.

Passkeys are served under `/v1/me/passkeys`. If someone loses theirs, an organisation admin opens the members page
(`/members`), chooses **Reset passkeys** for them and confirms. That removes all their passkeys, and they set up a new
one on the connection request page.

## How a granted credential reaches a request

On a self-hosted deployment, a sandbox's outbound traffic goes through the egress proxy (`apps/vault-proxy`), which
denies by default and asks the store about each request (`POST /v1/egress/decisions`). If an active grant or a policy
matches, the proxy adds the item's header; otherwise it answers 403 with the reason and a suggested fix.
A credential an upstream echoes back is replaced with `[vault:redacted]`.

A client that insists on a key can put a session placeholder (`harbour-ph-` and 32 hex digits) in its `Authorization`
or `x-api-key` header. The proxy swaps it for the credential only if it is current for the session and the request
goes to one of the item's hosts.

:::note[Not yet available]
On Cloudflare the store serves egress decisions, but sandboxes have no network yet, so no sandbox request reaches it.
:::

## Session blocking and egress usage

`POST /v1/connection-approvals/sessions/{sessionId}/access` with `{ "blocked": true, "reason": "…" }` blocks a
session at once: its egress, credential reads and model calls are refused.
`GET /v1/connection-approvals/sessions/{sessionId}/usage` counts its egress
decisions by host. Both need the operator role on the session to change, viewer to read.

:::note[Not yet available]
The console has no controls for blocking a session or viewing its egress usage.
:::

The approval routes under `/v1/connection-approvals` aren't in the generated SDK. The old `/v1/vault` base (and
`/proposals` for `/requests`) still answers for one release, with a `Deprecation` header. See
[Approvals](/api/approvals/) and [Unlisted routes](/api/reference/unlisted/).

<!-- Sources (8584d5b): packages/vault/CONTRACT.md:1-30, packages/vault/CONTRACT.md:66-100, packages/vault/CONTRACT.md:154-200, packages/vault/CONTRACT.md:233-237, packages/vault/src/approval-api.ts:1-38, packages/vault/src/engine.ts:101, packages/contracts/src/vault.ts:108-118, packages/protocol/src/index.ts:166-192, packages/ui/src/session/vault-approval-card.tsx:190-230, packages/ui/src/session/transcript.tsx:141-155, packages/ui/src/vault/vault-page.tsx:140-170, packages/ui/src/vault/vault-page.tsx:205-300, packages/ui/src/vault/vault-page.tsx:420-560, packages/ui/src/vault/vault-page.tsx:590-760, packages/ui/src/vault/vault-page.tsx:860-875, packages/ui/src/vault/vault-page-model.ts:120-136, packages/ui/src/vault/grant-list.tsx:60-125, packages/ui/src/identity/members.tsx:50-195, apps/console/src/app/router.ts:73-81, apps/console/src/app/router.ts:158-160, apps/console/src/app/vault-screen.tsx:24-66, apps/console/src/app/vault-screen.tsx:160-166, apps/console/src/api/vault-http.ts:24-38, apps/console/src/api/vault-http.ts:95-125, apps/console/src/main.tsx:56-63, apps/cloudflare/src/gateway.ts:1-35, apps/cloudflare/src/dev-vault-seed.ts:57-81, apps/cloudflare/README.md:84-90, apps/cloudflare/README.md:214-245, apps/selfhosted/src/gateway/egress.ts:10-20, apps/vault-proxy/src/main.ts:1-38, apps/vault-proxy/src/placeholder.ts:1-25, packages/identity/src/passkey-http.ts:1-9, docs/vault-page.md:1-82, docs/design/org-scope.md:130-150 -->
