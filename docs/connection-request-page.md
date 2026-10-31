# The connection request page

The page a `connection.approval` card's **Open request** link opens: one request, in full, beside the approver's
active grants. It is where a person narrows what an agent asked for, checks the binding code, confirms with a passkey,
pastes a new secret, or denies. Until #324 it was the vault page. It lives in `@harbour/ui` under
`packages/ui/src/vault/` (component `VaultPage`; code names keep the internal store's name). `apps/console` mounts it
at `/connections/requests` (the active grants) and `/connections/requests/:proposalId` (one request), behind its
`ConsoleVault` seam. The old `/vault`, `/vault/proposals/:proposalId` and `/vault/requests/:proposalId` paths open the
same page, and the console replaces the address with the new one.

Not to be confused with a connector: a connector is how Harbour talks to a model or a channel, and a connection is a
credential an agent uses.

## What it shows

- **The request:** the credential and host, the agent's reason, and a line saying the agent never sees the value.
- **Requested by:** the agent, the person behind the session, the session (linked), project and organisation, and
  how long ago it was asked. When the viewer isn't that person (a forwarded link), a notice says the request isn't
  theirs and names whose it is, so nobody approves someone else's request without noticing.
- **Terms:** host, methods, path prefix, injection, lifetime and uses. While the request is open, methods, path,
  lifetime and uses can each be narrowed, and each says whether it is *Proposed* or *Narrowed*. A sentence under them
  says exactly what the agent will be allowed if you approve. *Undo narrowing* restores the agent's terms.
- **Binding code:** always shown. For a write, a route grant or a secret paste, the approver picks the code from the
  store's choices (the real one among decoys), matching the card in their session. Approve stays disabled until one is
  picked. For a read the code is shown for checking only.
- **Secret** (secret pastes only): a password field for the value. It is sent once with the approval and cleared.
- **Decide:** *Approve with passkey* (or *Paste and approve with passkey*) and *Deny*, with a countdown to the
  proposal's expiry that turns amber in its last two minutes.
- **Active grants:** every grant the viewer can see, with uses, time left, the agent and session, and **Stop** on
  each. The grant from the current request is highlighted.

## States

Every state has a story under **Vault/Vault page** in the workbench.

| State | What the page does |
| --- | --- |
| Proposed | Open, untouched. |
| Pending | Open, with a narrowed draft or a picked code. |
| Read, route grant, secret paste | Open; the binding-code and secret sections follow the kind. |
| Approved | Settled: *Terms in force* with the grant's uses and time left, *Stop this grant*. |
| Approved, narrowed | As approved, plus the terms the agent asked for. |
| Denied, expired, withdrawn | Settled, with who decided (or that nobody did) and the terms asked for. |
| Revoked | Approved, then the grant was stopped. |
| Wrong code | Harbour refused the pick: the refusal under the picker, the pick cleared. |
| Passkey cancelled | Nothing sent; a notice says so. |
| Forwarded link | Another operator opens it: the not-yours notice, decided as themselves. |
| Forwarded, no role | A viewer without the operator role: read-only, with the code shown and why they can't decide. |
| No access | No role on the project at all: the page says it can't be opened. |
| Loading, empty, error, long content, mobile, streaming | As the design loop requires. *Streaming* runs the real clock so the countdown ticks and the page settles as expired. |

## The binding code

The code is the only thing tying the page to the card in the agent's session. A forged link can show any terms, but
it can't show the code on the real card. So:

- The code is always on the page, open or settled, decidable or not.
- For writes, route grants and secret pastes (`CODE_REQUIRED_KINDS`) the approver must pick it. The page disables
  Approve until they do, and the store refuses a wrong pick whatever the page does. The page never decides alone.
- A wrong pick is refused by the store with `refused`, recorded as `vault.binding_code.mismatch`, and nothing changes.
  The page clears the pick and says to check the card, or to deny the request if none of the codes match.
- A secret paste with a wrong code stores nothing: the store checks the code before it reads the value.

The *Wrong code* story sends a wrong pick through the in-memory vault and shows the audit row it leaves under the page.
*Try the code* lets you pick any code and approve.

## Narrowing

Narrowing can only tighten: fewer methods, a deeper path, a shorter lifetime, fewer uses. The draft is checked with
the store's own `narrow` and `pathUnder` (from `@harbour/vault`), so the page refuses exactly what the store would:
a sibling path such as `/graphqlx` under `/graphql`, more uses than asked, an empty method list. Lifetimes longer than
the proposal's aren't offered. The sentence under the terms comes from the same narrowing, and a test approves a
narrowed route grant through the store and checks that the grant's route, uses and expiry match what the page showed.

## Passkey

Approving needs a passkey. The page takes a `PasskeyCheck` callback, so it never talks WebAuthn itself, and
`webAuthnPasskey` builds one from the browser's WebAuthn API with `userVerification: "required"` and the host's own
challenge and verify endpoints. A dismissed prompt is *cancelled* (nothing sent); a failed verification is an error
(nothing sent). Denying needs no passkey.

The `PasskeyRequest` carries the narrowing the approval will send, so the host's challenge can bind it. The console
(`apps/console/src/api/passkey.ts`) builds its check from `webAuthnPasskey` over the approval API's
`POST /v1/connection-approvals/requests/:id/passkey-challenge`. Its `verify` keeps the assertion, and the console's
`ConsoleVault` seam's `decide` sends
it as `passkeyAssertion`, which the API verifies before deciding. The console passes the check only when the API says
the viewer needs a passkey (`passkeyRequired`). A person who has none yet sees *Set up a passkey* above the page, and
once they've set one up, the button reads *Approve with passkey*. A refusal from the API that names the passkey is
shown as a passkey problem, not as a wrong code.

## Using it

```tsx
import { VaultPage, loadVaultRequest, loadActiveGrants, webAuthnPasskey } from "@harbour/ui";

const request = await loadVaultRequest(vault, ctx, proposalId, describeRequester);
const grants = await loadActiveGrants(vault, ctx, describeRequester);

<VaultPage
	request={request}
	viewer={{ userId, name }}
	vaultHost="harbour.dev"
	onDecide={(input) => vault.decide(ctx, input)}
	onDecided={reload}
	passkey={webAuthnPasskey({ challenge, verify })}
	grants={{ grants, onStop: (id) => vault.revokeGrant(ctx, id, "Stopped on the connection request page").then(reload) }}
/>;
```

`loadVaultRequest` uses only `Vault` contract calls (`approvalView`, `getProposal`, `getItem`, `getGrant`), so it
works with the in-memory vault now and lane 5's decision API when it lands. A viewer without the operator role gets the
request read-only instead of an error.

Inside a page that has its own `main` landmark, as the console does, pass `embedded` so the request isn't wrapped in a
second one. The page has no `h1` until a request loads (the request's title is it), so a host shows its own until then.

## Gaps in the contract

These are worked around in the page and should be closed in lane 5's API:

1. **No read for a past decision.** `Proposal.decisionId` names it, but there is no `getDecision`. A settled page
   shows who decided only when the host passes the decision in (`known.decisions`); otherwise it says "Approved" or
   "Denied" without naming who.
2. ~~**The passkey isn't part of the decision.**~~ Closed by #132: `DecisionInput.passkeyAssertion` carries the
   WebAuthn assertion over a challenge from `POST /v1/connection-approvals/requests/:id/passkey-challenge`, bound to the person,
   `proposalId`, `termsHash`, approve or paste, and the narrowing. The approval API verifies it before `decide` and
   refuses (and audits as `vault.passkey.refused`) a missing or bad one once the person must use a passkey. So a
   host's `verify` keeps the assertion for the decision rather than checking it on its own.

## Checking it

```sh
pnpm --filter @harbour/ui test           # vault-page.test.ts and passkey.test.ts among them
pnpm --filter @harbour/ui build:workbench
node packages/ui/loop/gates.ts --only vault--vault-page--default,...
node packages/ui/scripts/shoot.ts --only vault--vault-page--pending
```
