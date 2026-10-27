# The vault page

The page a vault card's **Open in vault** link opens: one request, in full, beside the approver's active grants. It is
where a person narrows what an agent asked for, checks the binding code, confirms with a passkey, pastes a new secret,
or denies. It lives in `@harbour/ui` under `packages/ui/src/vault/`; `apps/console` mounts it at the proposal links
the vault makes (`<linkBase>/proposals/<id>`).

## What it shows

- **The request:** the credential and host, the agent's reason, and a line saying the agent never sees the value.
- **Requested by:** the agent, the person behind the session, the session (linked), project and organisation, and
  how long ago it was asked. When the viewer isn't that person (a forwarded link), a notice says the request isn't
  theirs and names whose it is, so nobody approves someone else's request without noticing.
- **Terms:** host, methods, path prefix, injection, lifetime and uses. While the request is open, methods, path,
  lifetime and uses can each be narrowed, and each says whether it is *Proposed* or *Narrowed*. A sentence under them
  says exactly what the agent will be allowed if you approve. *Undo narrowing* restores the agent's terms.
- **Binding code:** always shown. For a write, a route grant or a secret paste, the approver picks the code from the
  vault's choices (the real one among decoys), matching the card in their session. Approve stays disabled until one is
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
| Wrong code | The vault refused the pick: the refusal under the picker, the pick cleared. |
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
  Approve until they do, and the vault refuses a wrong pick whatever the page does. The page never decides alone.
- A wrong pick is refused by the vault with `refused`, recorded as `vault.binding_code.mismatch`, and nothing changes.
  The page clears the pick and says to check the card, or to deny the request if none of the codes match.
- A secret paste with a wrong code stores nothing: the vault checks the code before it reads the value.

The *Wrong code* story sends a wrong pick through the in-memory vault and shows the audit row it leaves under the page.
*Try the code* lets you pick any code and approve.

## Narrowing

Narrowing can only tighten: fewer methods, a deeper path, a shorter lifetime, fewer uses. The draft is checked with
the vault's own `narrow` and `pathUnder` (from `@harbour/vault`), so the page refuses exactly what the vault would:
a sibling path such as `/graphqlx` under `/graphql`, more uses than asked, an empty method list. Lifetimes longer than
the proposal's aren't offered. The sentence under the terms comes from the same narrowing, and a test approves a
narrowed route grant through the vault and checks that the grant's route, uses and expiry match what the page showed.

## Passkey

Approving needs a passkey. The page takes a `PasskeyCheck` callback, so it never talks WebAuthn itself, and
`webAuthnPasskey` builds one from the browser's WebAuthn API with `userVerification: "required"` and the host's own
challenge and verify endpoints. A dismissed prompt is *cancelled* (nothing sent); a failed verification is an error
(nothing sent). Denying needs no passkey.

## Using it

```tsx
import { VaultPage, loadVaultRequest, loadActiveGrants, webAuthnPasskey } from "@harbour/ui";

const request = await loadVaultRequest(vault, ctx, proposalId, describeRequester);
const grants = await loadActiveGrants(vault, ctx, describeRequester);

<VaultPage
	request={request}
	viewer={{ userId, name }}
	vaultHost="vault.harbour.dev"
	onDecide={(input) => vault.decide(ctx, input)}
	onDecided={reload}
	passkey={webAuthnPasskey({ challenge, verify })}
	grants={{ grants, onStop: (id) => vault.revokeGrant(ctx, id, "Stopped on the vault page").then(reload) }}
/>;
```

`loadVaultRequest` uses only `Vault` contract calls (`approvalView`, `getProposal`, `getItem`, `getGrant`), so it
works with the in-memory vault now and lane 5's decision API when it lands. A viewer without the operator role gets the
request read-only instead of an error.

## Gaps in the contract

These are worked around in the page and should be closed in lane 5's API:

1. **No read for a past decision.** `Proposal.decisionId` names it, but there is no `getDecision`. A settled page
   shows who decided only when the host passes the decision in (`known.decisions`); otherwise it says "Approved" or
   "Denied" without naming who.
2. **The passkey isn't part of the decision.** `DecisionInput` carries no assertion, so the vault can't check that a
   passkey was used. The page asks for one first, but only the server can enforce it. The decision API should take
   the WebAuthn assertion, bound to `proposalId` and `termsHash`, and verify it before deciding.

## Checking it

```sh
pnpm --filter @harbour/ui test           # vault-page.test.ts and passkey.test.ts among them
pnpm --filter @harbour/ui build:workbench
node packages/ui/loop/gates.ts --only vault--vault-page--default,...
node packages/ui/scripts/shoot.ts --only vault--vault-page--pending
```
