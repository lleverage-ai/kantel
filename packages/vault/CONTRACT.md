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
a `fix`. `putItem`, `putPolicy`, `setCeiling`, `revokeGrant`, `revokePolicy` for admins.

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

## The in-memory implementation

`createMemoryVault({ clock?, audit?, proposalTtlMs?, linkBase?, expiryPollMs? })` keeps everything in maps per organisation, values in
a private map. Expiry is read from the clock whenever a proposal or grant is read, and each pending wait checks the
clock every `expiryPollMs` (default 25 ms), so a waiting agent hears of expiry on its own. Decisions on one proposal are
serialised: a second `decide` or a `withdraw` while one is in flight is `conflict`, and `decide` makes every state
change before its first await, so an expiry cannot land between them. It leaves out
encryption at rest, durable waits, role checks beyond "not an agent", and value rotation.

## Open questions

- `getCeiling` rejects `not_found` when no ceiling is set (no ceiling means no bound beyond item hosts). Should every
  organisation start with an explicit ceiling instead?
- Ports are not part of a route; a credential bound to a host goes to any https port on it. Should routes carry a
  port?
- A secret proposal may name an existing valueless item by `itemId`; pasting then sets its value. Is that the intended
  reading of "the item to create"?
- Who may withdraw: the requesting agent, or any non-agent actor. Who may revoke grants: any non-agent actor; role
  checks belong with identity.
