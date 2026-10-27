# Capability registry contract

## What it is for

One registry that direct tool calls, code-mode scripts and saved programs all call. A capability is a host-authorised
action with a credential-free schema. An agent discovers only what it may call, every call is checked against its grants
again at call time, and every call is journalled by call ID so a retry can be replayed safely. There is no exactly-once
promise: each capability says how it may be replayed, and a call that began and never committed is left for an operator.

## Records

- **Definition**: dotted name, version, description, schemas, replay policy (`safe`, `idempotent`, `unsafe`), `runsIn`.
- **Registration**: definitions plus the handler that serves them, per organisation; a `Subscription` unregisters them.
- **Grant**: selector (project, agent, session; absent fields match anything), exact names or `ns.*` namespaces, who
  granted it, optional expiry, status `active`, `revoked` or `expired`.
- **Journal entry**: call ID, capability, version, input fingerprint (hex SHA-256 of canonical JSON), session, agent,
  replay policy, status (`started`, `committed`, `failed`, `resolved`), result, error, timestamps, `resolvedBy`.

## Key operations

`register` and `discover`; `grant`, `revokeGrant`, `listGrants`; `invoke` (agents only); `journal` and `listJournal`;
`resolve`, the operator path for a call that began and never committed. Portable helpers in `src/index.ts`:
`canonicalJson`, `fingerprint`, `capabilityCovered`, `selectorMatches`.

## Rules and the suite cases that enforce them

- Discovery shows only covered capabilities; `ns.*` covers `ns.x` and `ns.x.y`, never `ns` or `nsx.y`: "shows an agent
  only the capabilities its grants cover, and a namespace grant covers its members but not a sibling namespace sharing
  its letters".
- A grant applies only to the callers its selector names: "applies a grant only to the session, agent and project its
  selector names".
- Agents never register, grant or revoke: "refuses an agent registering capabilities or granting or revoking access".
  Agents never resolve: "refuses retrying a crashed unsafe call until an operator resolves it, and only an operator may
  resolve".
- Only agents invoke; without a covering grant the call is `forbidden` and audited: "refuses an invoke without a
  covering grant as forbidden and audits it". A refusal's audit id names the session and the capability as well as
  the call ID, so refusals for different capabilities under one call ID each keep a row (same case).
- Grants are checked on every call, retries included: "refuses a retry with the same call ID once the grant is revoked
  or expired".
- Committed and failed calls replay without the handler: "replays a committed call's result without calling the handler
  again", "replays a safe call's failure without calling the handler again".
- An `unsafe` handler that throws, or is aborted, leaves the call `started` (uncertain): the caller gets the handler's
  own error, `capability.call.settled` is audited with `outcome: "uncertain"`, a retry is `refused` and an operator
  can resolve it. An `unsafe` handler that returns `isError: true` is still `committed`: "leaves an unsafe call whose
  handler throws uncertain, refuses its retry, and lets an operator resolve it".
- Same call ID, other arguments or capability: "treats the same call ID with other arguments or another capability as a
  conflict".
- An uncertain `unsafe` call is `refused` until resolved; `safe` and `idempotent` ones rerun: "refuses retrying a
  crashed unsafe call until an operator resolves it, and only an operator may resolve", "runs a crashed safe or
  idempotent call again with the same call ID".
- Version pinning: "refuses an invoke whose expectVersion differs from the registered version as a conflict".
- One provider per name; closing unregisters: "lets only one provider register a name, and closing a registration
  removes it".
- The journal's fields and filters: "journals the version, fingerprint, status and timestamps, and lists entries by
  session and status".
- Isolation: "hides another organisation's capabilities, grants and journal entries", "hides one session's journal
  entries and results from another session's agent".
- Cancellation: a `safe` call aborted mid-run is `failed`, an `unsafe` one uncertain: "aborts the handler's signal
  when the caller's signal aborts, failing a safe call and leaving an unsafe one uncertain".

## The in-memory implementation

`createMemoryCapabilityRegistry({ clock?, audit?, testing? })` keeps registrations, grants and the journal in maps keyed
by organisation. `invoke` awaits only the fingerprint, then checks the grant, the journal, the registration and the
version and writes the `started` entry in one synchronous step. A `safe` or `idempotent` handler throw is journalled
as `failed` with `{ output: <message>, isError: true }`; an `unsafe` one leaves the entry `started` and rethrows. A run that finishes after a newer run or a resolution returns the journalled
result instead of overwriting it. Audit event IDs are keyed by organisation and call ID, so retries never duplicate
a row. `testing.crashBeforeCommit(callId)` makes a call run its handler and then reject with `unavailable` without
settling, as a crash would. It leaves out durability, schema validation of arguments and results, timeouts, and
role checks beyond "not an agent".

## Open questions

- System actors are treated like humans and services (allowed to register, grant, revoke and resolve). Should they be?
- Agents see only grants that apply to them in `listGrants`, and only their own session's journal. Is that the intended
  reading?
- Reusing a call ID from another session is `conflict`, so one session never receives another's result.
- A replayed committed, failed or resolved call returns its result even if the capability has since been unregistered,
  and `expectVersion` is not checked on replay.
- `resolve` on an entry that is not `started` is `conflict`.
- An `unsafe` handler that ignores the abort and returns a result is `committed`: only a throw makes the call
  uncertain. Is that the intended reading of "aborted"?
