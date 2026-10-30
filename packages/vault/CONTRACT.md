# Vault contract

## What it is for

The vault holds credentials, decides every outbound request and injects credentials on the way out. Agents and
sandboxes never hold a value: a sandbox holds an item's placeholder, and the egress proxy asks the vault what to inject.
Agents ask for access with proposals; only a human (or a service acting for one) decides them.

## Records

- **Item**: owner, name, bound hosts, injection rule (`Authorization: Bearer {key}`), `placeholder`
  (`harbour://<name>/<6 hex>`, random, never derived from the value), `hasValue`. The value is never returned.
- **Ceiling**: the organisation's outer bound on routes. No policy, grant or egress may go outside it.
- **Policy**: a standing rule (selector, route, optional lifetime) set by an admin.
- **Proposal**: an agent's request, with a derived kind, terms hash, binding code (`ABC-DEF`), expiry and vault link.
- **Decision** and **Grant**: an approval creates a grant for the requester's organisation, project, agent and session.
- **Use**: one egress decision, injected or denied with a reason.

## Key operations

`propose` → `approvalView` (the real code among decoys) → `decide` → `waitForOutcome` (effective terms and "No request
has run"). `decideEgress` matches the first active grant, then policy, and returns the header to inject or a denial with
a `fix`. `putItem`, `putPolicy`, `setCeiling`, `revokeGrant`, `revokePolicy` for admins. `endSession` is the vault's
session-end teardown.

## Rules and the suite cases that enforce them

- Values never leave the vault except in an allowed `inject`: "never returns an item's value from getItem or listItems",
  "keeps the canary value out of every record and audit event", "stores a pasted secret only with the matching code and
  never returns it".
- The kind is derived from terms (a POST used once is a write): "derives the proposal kind from its terms, never from the
  agent".
- Every proposal has a binding code, terms hash, link and expiry; identical terms get different codes: "gives every
  proposal a binding code, a terms hash, a pending status, a link and an expiry".
- The approver sees the real code once among at least four: "shows the approver the real code exactly once among at
  least four choices".
- Writes, route grants and secret pastes need the matching code; a wrong or missing code is refused, audited
  (`vault.binding_code.mismatch`) and changes nothing: "refuses approving a write without the matching binding code",
  "refuses approving a route grant without the matching binding code", "refuses a secret paste with a wrong code and
  stores nothing". Reads need no code but a wrong one is still refused: "approves a read without a binding code",
  "refuses a read approval that cites a wrong binding code".
- Approval is bound to the terms hash: "refuses a decision citing a different terms hash".
- Agents never decide, open the approval view or change items, policies or the ceiling: "refuses a decision from an
  agent actor, even on its own proposal", "refuses the approval view to an agent actor", "refuses admin changes from an
  agent actor".
- Narrowing only tightens; the agent is told the narrowed terms: "applies a narrowing and tells the agent the narrowed
  terms", "refuses a narrowing that widens the terms".
- Exactly one decision: "settles concurrent decisions on one proposal exactly once", "keeps an approval that lands
  as the proposal expires consistent", "refuses a narrowing to a sibling path that shares the prefix's letters", "tells a waiting agent its
  proposal expired without anyone touching it", "refuses a secret paste without a code".
- Outcomes: "resolves waitForOutcome after a later decision and says no request has run", "yields a denied outcome and
  no grant for a denied proposal", "stops waiting when the caller's signal aborts", "refuses approving a pending proposal
  past its expiry", "refuses deciding a proposal twice", "lets the agent withdraw its own pending proposal".
- Egress is denied unless a grant or policy matches selector, host, method and path, and every denial carries a fix:
  "denies egress without a grant and offers a proposal as the fix", "allows egress under a matching grant and injects
  the credential header", "denies egress for another host, method, path prefix or session", "denies egress once a
  grant's uses are spent", "denies egress after a grant expires by the clock", "denies egress after a grant is revoked",
  "denies egress under a grant whose item has no value yet", "expires and exhausts policies with a lifetime like
  grants".
- Path prefixes match whole segments and credentials go out only over https: "matches a path prefix by whole
  segments", and the `/repositories` and `http://` rows of "denies egress for another host, method, path prefix or
  session".
- Item hosts and the ceiling bound everything: "refuses a proposal outside the organisation's ceiling", "refuses a
  proposal or policy for a host the item is not bound to", "refuses a policy outside the ceiling and lets egress through
  under one inside it" (outside the ceiling the fix is `none`).
- Organisation isolation: "hides another organisation's records as not found".
- Project access (settled question 7), checked through `ProjectAccess` after the organisation lookup, as
  `vault.<method>`. An item is in a project when its owner is one; a proposal by its `projectId` and requester session;
  a grant or policy by its selector's `projectId` and `sessionId`. Records in neither are the organisation's: reads and
  lists show them as before, and changes to them need an organisation-wide role. `putItem`, `putPolicy`,
  `revokePolicy` need admin on the item's project, and `setCeiling` organisation-wide admin; `getItem`, `listItems`,
  `listPolicies` need viewer, and `getCeiling` organisation-wide viewer. `propose` needs operator: an agent in its own
  session, which must be in a project-owned item's project (the proposal's `projectId` is the session's, never
  `ctx.projectId`); a human or service on the item's project or `ctx.projectId`. `getProposal`, `listProposals`,
  `waitForOutcome` need viewer and `withdraw` operator on the proposal's project and session; `approvalView` and
  `decide` operator on its project (agents are still `forbidden` first). `getGrant`, `listGrants`, `listUses` need
  viewer and `revokeGrant` operator on the grant's selector. A list filtered by session checks that session; otherwise
  it keeps what the caller may view. `decideEgress` is a worker call (settled by Tom on 27 Oct 2026, question 13:
  "Require a system identity"): only the egress gateway's `system` context may make it; no caller, a human, a service
  or an agent is `forbidden`, audited once as `access.denied`, and records no use ("worker calls: decideEgress refuses
  every caller but the gateway's system one, and records no use"). Cases: "project access: refuses an
  operator outside the project every change and read, and changes nothing", "project access: refuses an agent whose
  session belongs to another project, and changes nothing", "project access: refuses an agent whose session was
  closed", "project access: lists leave out another project's records for an operator outside it", "project access:
  lets an operator on the project and an agent in its own session through".
- Session end (settled question 8): `endSession(ctx, sessionId, reason)` (operator on the session; the hook's system
  actor passes) revokes the session's active grants, each audited `vault.grant.revoked` once with `data.reason`, so
  its egress is denied. `session_ended` also withdraws its pending proposals (a waiting agent hears `withdrawn`);
  `aborted` leaves them pending and later grants work. A second run changes and audits nothing: "ends a session's
  grants and withdraws its pending proposals when the session ends", "ends a session's grants on abort and leaves its
  pending proposals and later grants working".

## Platform items and the connector credential read

- `putItem` with `owner: { kind: "platform" }` is for Harbour's operator only: a `system` caller. Anyone else is
  `forbidden`, audited once as `access.denied` (operation `vault.putItem`), and nothing is stored. Platform items are
  stored outside every organisation, so no organisation's caller lists, reads, proposes for or writes a policy on one
  (`not_found`), and egress never injects one. Cases: "platform items: only a system caller creates one, and no
  organisation's caller lists or reads it".
- `readConnectorCredential(ctx, request)` (`ConnectorCredentials` in `models.ts`) is the model gateway's key read. A
  worker call, like `decideEgress`: any caller but `system` is `forbidden`, audited once as `access.denied`, and records
  no use. The item must belong to the connector's owner: a platform item for a platform connector; for an
  organisation's connector, an item its organisation or one of its projects owns, read only for a session of that
  organisation. The base URL's host must be one of the item's `hosts` (http is allowed here, as upstreams may be
  internal), and the item must have a value. Otherwise `refused` (`invalid` for a base URL that is not http(s)). Every
  read records a `VaultUse` (method `POST`, the base URL's host and path, the scope's session and project) as `injected`
  or `denied`, audited `vault.use.injected` or `vault.use.denied` with `data.connectorId`; neither holds the value,
  which is returned only as `ConnectorCredential.value`. Cases: the six `connector credentials:` cases.
- `HarbourVault = Vault & ConnectorCredentials` (`@harbour/vault/engine`) is what `createVault` and `createMemoryVault`
  return.

## Storage, encryption and races

`createVault({ store, cipher, clock?, audit?, proposalTtlMs?, linkBase?, expiryPollMs?, access?, sessionEnd? })`
(`@harbour/vault/engine`) runs every rule above over a `VaultStore` (`@harbour/vault/store`). Without `access` it checks
only the organisation (and "not an agent"); with `sessionEnd` it registers `endSession` as `vault`.

- **Store.** One table per record kind: items (with the sealed value), ceilings, policies (with their use counts),
  proposals, decisions, grants (with their use counts and revocation) and uses. Each row is an ID, the owning
  organisation (`null` for platform items), a revision and the record as JSON, listed in insertion order. The store
  holds no rules. Its one guarantee is `commit(writes)`: every write or none, each insert only for a new ID and each
  update only while the row still has the revision the engine read (compare-and-set). Targets:
  `createMemoryVaultStore` (maps), `createPostgresVaultStore` (`@harbour/vault-selfhosted`: `pg.Pool` or PGlite, one
  transaction per multi-write commit, `UPDATE … WHERE revision = $n`, `migrate()` creating the schema
  `harbour_vault` by default) and `createSqliteVaultStore` (`@harbour/vault-cloudflare`: a Durable Object's
  `ctx.storage.sql`, each commit checked and applied in one synchronous step, inside `transactionSync`).
- **Races across processes.** Every decision reads the store, and every change that races is one conditional commit,
  so two vault instances over one store behave as one. A decision, a withdrawal, a session-end withdrawal and an expiry
  each settle a proposal by a compare-and-set on its record, together with the decision, the grant and any pasted
  value or new item: exactly one wins, and a loser reads again and answers `conflict` (or `expired`). A decision
  is taken only while the clock reads before the proposal's expiry (`decidedAt` is that reading). Its commit is
  conditional on the proposal row alone, not on the clock, so a commit already under way when expiry passes may still
  land; an expiry stored first (by any reader) makes it lose. A grant's lifetime counts from `decidedAt`, so a late
  commit never extends it. Session teardown withdraws pending proposals before it revokes the session's grants, so an
  approval racing teardown either loses to the withdrawal or has its grant revoked. Spending a grant's or policy's use, and revoking one, are
  compare-and-sets too, so `maxUses` is never exceeded and a revocation through one instance holds for the next
  decision through any other. Within one instance a second `decide` or a `withdraw` while a decision is in flight is
  still `conflict` at once. Cases: the suite above on every target, and the `races:` proof.
- **Encryption at rest.** A `VaultCipher` seals values before they reach the store. `createAesGcmCipher({ key, keyId? })`
  (`@harbour/vault/cipher`, Web Crypto only, so Workers and Node alike) uses AES-256-GCM with a random 96-bit IV per
  seal, in the envelope `hv1.<keyId>.<iv>.<ciphertext>` (base64url). The additional data binds the item ID and value
  version, so a sealed value copied onto another item, or replayed as another version, does not open; nor does one
  sealed under another key ID (`unavailable`). Values are opened only to build an allowed egress decision's `inject`
  and to answer `readConnectorCredential`. No plaintext value reaches the store: the `canary:` proof reads every row
  raw.
- **Durable waits.** `waitForOutcome` reads its proposal from the store every `expiryPollMs` (default 25 ms) while it
  waits, so a vault instance built after a restart resolves a wait for a proposal decided through another instance; a
  decision through the same instance wakes it at once. Expiry is still read from the clock: reading a pending proposal
  past its expiry stores it as `expired`. Cases: the `durable waits:` proof.

`createMemoryVault(options)` (`@harbour/vault/memory`) is `createVault` over `createMemoryVaultStore()` and a cipher
with a random key that lives as long as the vault. It leaves out value rotation.

## Egress decision API

`createEgressDecisionApi({ vault, authenticate, basePath? })` (`@harbour/vault/egress-api`) is the fetch-style handler
the egress proxy (`apps/vault-proxy`) and the model gateway call; the self-hosted vault and the VaultDO serve it.
Routes, under `basePath` (default none), both `POST` with a JSON body:

| Route | Body | Returns |
| --- | --- | --- |
| `/v1/egress/decisions` | `EgressRequest` | `EgressDecision` |
| `/v1/connector-credentials` | `ConnectorCredentialRequest` | `ConnectorCredential` |
| `/v1/egress/session-placeholders` | `SessionPlaceholderRequest` | `SessionPlaceholders` |
| `/v1/egress/session-open` | `ModelCallScope` | `{ "open": true }`, or `refused` |

`authenticate(request)` returns the calling component's `SystemContext` or throws `forbidden`;
`createSharedKeyAuthenticator({ keys: { [component]: secret } })` checks `Authorization: Bearer <key>` in constant time
(SHA-256 of both sides, every key tried). The vault still refuses any caller but `system`. Errors are
`{ "error": { "code", "message" } }` with one status per `ErrorCode` (as in the workspace read API: `invalid` 400,
`forbidden` and `refused` 403, `not_found` 404, `conflict` 409, `expired` 410, `exhausted` 429, `aborted` 499,
`not_supported` 501, wrong method 405, `unavailable` 503), and 500 without detail for anything else. No error echoes a
value. Every response is `cache-control: no-store`. `createEgressDecisionClient({ baseUrl, token, fetch? })` has
`decideEgress(request)` and `readConnectorCredential(request)` and rebuilds a `HarbourError` from the error JSON.

The Cloudflare target's `VaultDurableObjectCore({ sql, cipherKey, clock?, audit?, … })` builds the vault over the
object's SQLite (migrating it) and exposes `decideEgress`, `readConnectorCredential` and the API handler as `fetch`,
so a VaultDO class is a thin wrapper. Its single-threaded execution plus the conditional commits keep the race rules.

## Session placeholders, blocking and usage

A sandbox holds no credential. For a client that insists on a key, the host starting a session's sandbox asks
`issueSessionPlaceholders` (system only) for one random placeholder (`harbour-ph-` and 32 hex digits) per item the
session could be granted, and puts those in its environment. Each issue replaces the session's earlier placeholders
(`generation` counts them), and ending the session (`session_ended`, not `aborted`) retires them for good. Audit events
name the items, never a placeholder.

The proxy looks for a placeholder only in `Authorization` and `x-api-key` (`PLACEHOLDER_AUTH_HEADERS`) and sends it as
`EgressRequest.placeholder`. The vault then allows the request only if the placeholder is one of the session's current
ones and its item is bound to the request's host, and considers that item's grants and policies alone. Approval-
matching is the same as before: the placeholder narrows which item may answer, and never adds a grant or policy. The
proxy drops the header that carried it and sets the item's injection. A placeholder anywhere else (another header, the
URL, the body) is never read or swapped, so an upstream that echoes a request echoes the placeholder.

`setSessionAccess(ctx, sessionId, { blocked, reason? })` (operator on the session, never an agent; audited as
`vault.session.blocked` / `vault.session.unblocked`) blocks a session at once: `decideEgress` denies its every
request, `readConnectorCredential` refuses its key reads, and `assertSessionOpen` (which the model gateway asks on each
cached-key hit) refuses its model calls. An ended session is refused the same way. `getSessionAccess` and
`getSessionUsage` (viewer on the session) read the state and the session's egress decisions counted from its use
records, by host. Model-call tokens and cost stay in the gateway's usage rows; the vault does not count them again. The
approval API serves the three as `GET`/`POST /sessions/:id/access` and `GET /sessions/:id/usage`.

## Host grant import

`importHostGrants(vault, ctx, grants)` (`@harbour/vault/import`) is the vault side of importing a host's grants (such
as Sal's) that have a host mapping. Each grant (`name`, `description?`, `hosts`, `injection`, `value?`, `routes`,
`selector`) becomes an item (or reuses the one of the same name and owner: the selector's project, else its
organisation) and one policy per route, through the vault's own calls and checks. A re-run creates nothing. A grant
with no hosts or routes (local-only), or with a route to a host it is not mapped to, is listed in `refused` as
`invalid`; one the vault refuses (outside the ceiling) as `refused`, keeping what was created before the refusal. Any
other error is thrown. A reused item keeps its value.

## Proofs (issue #13)

Each durable target runs `registerVaultDurableProofs` (`@harbour/testing/vault`), one test file per proof, on PGlite
and on `node:sqlite` (and on Postgres when `HARBOUR_TEST_DATABASE_URL` is set): `canary:` (the value appears only in
an allowed decision's `inject.value`, never in a stored row, record, audit event, outcome, error, console output or
placeholder, over a full flow through the egress API over HTTP), `revocation:` (revoked through one instance, refused
by another within 5 s; in practice the next decision), `wrong code:` (a wrong code on a write, route or secret paste is
`refused`, audited, and leaves every stored row as it was), `lifecycle:` (approve, narrow, deny, expire and revoke,
each followed by a decision over the API), `durable waits:` and `races:`.

## Open questions

- `getCeiling` rejects `not_found` when no ceiling is set (no ceiling means no bound beyond item hosts). Should every
  organisation start with an explicit ceiling instead?
- Ports are not part of a route; a credential bound to a host goes to any https port on it. Should routes carry a
  port?
- A secret proposal may name an existing valueless item by `itemId`; pasting then sets its value. Is that the intended
  reading of "the item to create"?
- Settled 27 Oct 2026 (question 7): who may withdraw and revoke. The requesting agent, or an operator on the
  proposal's or grant's project (see Project access above).
- An item owned by a user is treated like the organisation's: changing it needs an organisation-wide admin, and it is
  readable as before. Should a user's own items be theirs to manage?
- `getCeiling` is organisation-wide, so it needs an organisation-wide viewer and an agent cannot read it. Should agents
  see the ceiling their proposals are bound by?
