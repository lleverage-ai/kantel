# Connection request page

`VaultPage` is the page a `connection.approval` card's **Open request** link opens: one connection request, in full,
beside the approver's active grants. It is where a person narrows what an agent asked for, checks the binding code,
confirms with a passkey, pastes a new secret, or denies. It lives in `src/vault/` (the code keeps the encrypted
store's name). The console mounts it at `/connections/requests` (the active grants) and
`/connections/requests/:proposalId` (one request) behind its `ConsoleVault` seam; the older `/vault` paths open the
same page. What an approver sees is in the docs site's
[Connection requests](../../../docs/site/src/content/docs/console/connection-requests.md).

## What it shows

- **The request:** the credential and host, the agent's reason, and a line saying the agent never sees the value.
- **Requested by:** the agent, the person behind the session, the session (linked), project and organisation, and how
  long ago it was asked. When the viewer isn't that person (a forwarded link), a notice says whose request it is.
- **Terms:** host, methods, path prefix, injection, lifetime and uses. While the request is open, methods, path,
  lifetime and uses can each be narrowed, and each says whether it is *Proposed* or *Narrowed*. A sentence under them
  says exactly what the agent will be allowed. *Undo narrowing* restores the agent's terms.
- **Binding code:** always shown. For a write, a route grant or a secret paste the approver picks the code from the
  store's choices (the real one among decoys), and Approve stays disabled until one is picked. For a read the code is
  shown for checking only.
- **Secret** (secret pastes only): a password field, sent once with the approval and cleared.
- **Decide:** *Approve with passkey* (or *Paste and approve with passkey*) and *Deny*, with a countdown to the
  request's expiry that turns amber in its last two minutes.
- **Active grants:** every grant the viewer can see, with uses, time left, the agent and session, and **Stop** on
  each. The grant from the current request is highlighted.

## The binding code

The code is the only thing tying the page to the card in the agent's session: a forged link can show any terms, but
not the code on the real card. The page disables Approve until a code is picked where one is required
(`CODE_REQUIRED_KINDS`), and the store refuses a wrong pick whatever the page does, recorded as
`connections.binding_code.mismatch`. The page then clears the pick and says to check the card, or to deny the request
if none of the codes match. A secret paste with a wrong code stores nothing.

## Narrowing

Narrowing only tightens: fewer methods, a deeper path, a shorter lifetime, fewer uses. The draft is checked with the
store's own `narrow` and `pathUnder` from `@kantel/vault`, so the page refuses exactly what the store would, such as a
sibling path (`/graphqlx` under `/graphql`), more uses than asked or an empty method list.

## Passkey

Approving needs a passkey; denying doesn't. The page takes a `PasskeyCheck` callback, so it never talks WebAuthn
itself, and `webAuthnPasskey` builds one from the browser's WebAuthn API with `userVerification: "required"` and the
host's own challenge and verify endpoints. A dismissed prompt is *cancelled* and a failed verification an error;
nothing is sent in either case. The `PasskeyRequest` carries the narrowing the approval will send, so the host's
challenge can bind it.

The console builds its check over the approval API's
`POST /v1/connection-approvals/requests/:id/passkey-challenge` and sends the assertion with the decision as
`passkeyAssertion`, which the API verifies before deciding. It passes the check only when the API says the viewer
needs a passkey (`passkeyRequired`), and offers *Set up a passkey* to a person who has none yet.

## Using it

```tsx
import { VaultPage, loadVaultRequest, loadActiveGrants, webAuthnPasskey } from "@kantel/ui";

const request = await loadVaultRequest(vault, ctx, proposalId, describeRequester);
const grants = await loadActiveGrants(vault, ctx, describeRequester);

<VaultPage
	request={request}
	viewer={{ userId, name }}
	vaultHost="kantel.example.com"
	onDecide={(input) => vault.decide(ctx, input)}
	onDecided={reload}
	passkey={webAuthnPasskey({ challenge, verify })}
	grants={{ grants, onStop: (id) => vault.revokeGrant(ctx, id, "Stopped on the connection request page").then(reload) }}
/>;
```

`loadVaultRequest` uses only `Vault` contract calls (`approvalView`, `getProposal`, `getItem`, `getGrant`). A viewer
without the operator role gets the request read-only instead of an error. Inside a page that has its own `main`
landmark, as the console does, pass `embedded`. The page has no `h1` until a request loads, so a host shows its own
until then.

The `Vault` contract has no read for a past decision, so a settled page names who decided only when the host passes
the decision in (`known.decisions`); otherwise it says "Approved" or "Denied".

## States

Every state has a story under **Vault/Vault page**: proposed, pending (narrowed or a code picked), read, route grant
and secret paste, approved, approved and narrowed, denied, expired, withdrawn, revoked, wrong code, passkey cancelled,
a forwarded link, a forwarded link without the operator role, no access, and loading, empty, error, long content,
mobile and streaming (the countdown ticking to expiry).

```sh
pnpm --filter @kantel/ui test           # vault-page.test.ts and passkey.test.ts among them
pnpm --filter @kantel/ui build:workbench
node packages/ui/loop/gates.ts --only vault--vault-page--default,...
node packages/ui/scripts/shoot.ts --only vault--vault-page--pending
```
