# Compute state contract

What every backend for the compute plane's shared state must guarantee, so that several gateway instances (and the
hosts behind them) agree on sandbox state. The self-hosted gateway implements it in SQL (Postgres, or SQLite under
`node:sqlite`). The Cloudflare Worker can implement it in D1 or in Durable Objects. A backend that passes the conformance
suites below and keeps the guarantees in this file is equivalent, whatever it stores.

This file describes what the code does and marks what it leaves open. Status on 3 Nov 2026:

| Part | Interface | Where | Status |
| --- | --- | --- | --- |
| Records | `ComputeStore`, `Collection<T>` | `packages/compute/src/store.ts`, `sql-store.ts` | on main (#577) |
| Host registry | `HostStore` | `packages/hosts/src/store.ts` | on main (Postgres or SQLite, D1, DO) |
| Relay state | `RelayStore`, `TunnelTickets`, `RelayAccess` | `packages/hosts/src/relay-store.ts`, `tunnel.ts`, `relay-access.ts` | on main (#587) |
| Host connections | the hub (`packages/hosts/src/hub.ts`), `ClusterStore` and `HostCluster` | `packages/hosts/src/cluster.ts`, `apps/selfhosted/src/gateway/cluster.ts` | on main (#592): forwarded to the owning replica (§8) |

## 1. Records

`ComputeStore` is one `Collection<T>` per kind. Every record has a string `id`, and the store treats the rest as an
opaque JSON document.

| Kind | What it is | Secrets |
| --- | --- | --- |
| `users`, `accounts`, `members`, `invites` | people, personal accounts and organisations, membership | invite codes as SHA-256 |
| `sandboxes` | a sandbox: `state`, `hostId`, `latestSnapshotId`, `pausedSnapshotId`, `ports`, `runs`, `stopsAt`, labels | none |
| `commands` | a command run in a sandbox, its state and output | none |
| `snapshots` | automatic (stop) and saved snapshots, with the backend's opaque `ref` | none |
| `apiKeys` | `ksk_` keys with scopes, `revokedAt`, `expiresAt` | SHA-256 only |
| `webhooks`, `deliveries` | endpoints and queued deliveries | the signing secret in full (signing needs it) |
| `telemetry`, `proxies` | OTLP export and egress proxy settings per account | as configured |
| `hosts`, `joinTokens` | the API's view of hosts (name, labels, drain, revoke) and join tokens | SHA-256 only |
| `events` | the event log | none |
| `idempotency` | an idempotent call's claim on its key while it works, then its first answer, by caller, operation and key | none |
| `deviceLogins` | device sign-in (RFC 8628 style) | a key secret, until collected (at most 15 minutes) |

`HostStore` keeps hosts (credential as SHA-256), join tokens (as SHA-256) and placements: which host each sandbox is
on, with its tier, size and resources. A sandbox never moves host, because its disk and memory are there.

Nothing in the store may be logged.

## 2. Reads and writes

These hold for every collection (`Collection<T>` in `store.ts`), and the memory store is the reference.

- **Copies in and out.** `get` and `list` answer copies. A caller changes a record only by writing it back.
- **`put` is an upsert.** It replaces the whole record and is last-writer-wins. It doesn't compare versions.
- **`insert` is insert-if-absent.** It writes the record only when no record has its ID and answers whether it did. Of
  several writers inserting one ID at once, on any gateway, exactly one gets `true`. A deleted record's ID can be
  inserted again. The SQL store does it in one statement (`INSERT … ON CONFLICT DO NOTHING RETURNING id`).
- **`update(id, change)` is a compare-and-set.** It reads the record, calls `change`, and writes the result only if
  nothing else wrote the record in between. If something did, it reads again and calls `change` again, so `change` must
  be pure and may run more than once. `change` answering `undefined` writes nothing. A missing record is never
  written (`update` answers `undefined`). The SQL store retries 50 times and then throws. A backend may retry fewer or
  more times, but it must never write over a version it didn't read.
- **`delete`** answers whether there was a record.
- **`list(where)`** answers the records whose top-level fields are `===` to each defined field of `where` (`matches`
  in `store.ts`), **oldest first by first insertion**. A replace (`put` over an existing ID) keeps the record's place.
  A backend may narrow the query in its own query language, but it must answer exactly what `matches` would.
- **Reads after writes.** A write that has resolved is visible to every later read on every gateway. No backend may
  answer reads from a replica that lags or from a cache.

The SQL store keeps one row per record in `compute_api_records(kind, id, seq, version, data)`. `seq` gives the order
and `version` the compare-and-set. `seq` comes from a sequence on Postgres, and from `MAX(seq)+1` per kind on SQLite,
which is safe only because SQLite has one writer.

## 3. Sandbox lifecycle

States are `starting`, `running`, `stopping`, `stopped`, `paused`, `error`, `deleting` and `deleted`. A lifecycle
call (create, stop, resume, start, fork, recover, delete) puts the sandbox in its passing state, answers at once
(unless `wait: true`), and finishes in the background: `starting` becomes `running` or `error`, `stopping` becomes
`stopped` or `paused`, and `deleting` becomes `deleted`.

**What the contract needs.** Each move into a passing state must be **conditional on the state it was read in**. A
gateway that loses the race to another gateway must answer as if the other gateway's call had come first: a second
`stop` on a `stopping` sandbox is a `conflict`, or the same answer, and never a second `backend.stop`. Only the gateway
that won the transition may call the backend for it. The background step that finishes it (`running`, `stopped`, …)
must also be conditional on the passing state still being the one it set. Otherwise a `delete` that landed meanwhile
would be overwritten.

**How (#597).** Every lifecycle write in `service.ts` goes through `transition()`, an `update` (§2) that
writes only while the sandbox is still in the state the call read it in:

- **Into a passing state.** `stop` (and pause), `start`, `resume` and `recover` move from the state they read. A
  call that loses answers `409 conflict` ("The sandbox is stopping") and calls nothing on the backend. A `start` or
  `resume` that finds the sandbox already `starting` or `running` answers it as it is. `delete` moves from any state
  but `deleted`, and answers a deleted sandbox as it is. A delete already under way (on another gateway, or one that
  died) is done again: destroying is idempotent, and only one of them writes `deleted`.
- **Out of it.** `boot()` writes `running` only from `starting`, the stop's background step writes `stopped` or
  `paused` only from `stopping`, and the delete's writes `deleted` only from `deleting`. A step that finds the sandbox
  moved on writes nothing and emits no event.
- **`fail()`** writes `error` only from the passing state its own work set (`starting`, `stopping` or `deleting`), so
  a stale step never writes `error` over a state another call left.
- **The auto-stop sweep** still runs on every gateway. Its move to `stopping` is conditional on the sandbox being
  `running` *and* still past its `stopsAt`, so exactly one gateway stops an expired sandbox, and one that another
  gateway extended meanwhile isn't stopped.
- **Writes of other fields** (`updateSandbox`, port exposures, usage samples, `latestSnapshotId`) are `update`s too,
  so they never put back a state they read before a transition.

The queue inside each process (`pending`) still orders one gateway's own work on a sandbox. It no longer has to
protect anything across gateways.

Seen on two replicas before the fix: 1 of 10 simultaneous double stops ended `error` ("is stopped, not running")
after `sandbox.stopped`. `packages/compute/test/replica-lifecycle.test.ts` runs two compute APIs over one database
and one backend: a stop, a resume and a sweep that read the sandbox before the other replica moved it, ten double
stops at once (one `backend.stop` each, none `error`), and two sweeps of one expired sandbox (one stop).

## 4. Idempotency

`createSandbox`, `forkSandbox` and `runCommand` take an `Idempotency-Key`. The same caller, operation and key must
create **at most one** sandbox (or fork set, or command), whichever gateway each attempt lands on, and must answer the
first answer to every retry.

**How (#596).** `once()` in `service.ts` **claims the key before it does the work**, with `insert`
(§2): a record `{id, createdAt, claim, claimExpiresAt}` with no `body`. Then:

- The call that wins the insert does the work and `put`s the answer as `body`. That is the same two round trips as
  before (the claim replaces the read that looked for an answer).
- A call that loses reads the record. With a `body`, it answers that body. While the claim is pending, it answers
  **`409 conflict`** ("still in progress; retry it once that call has answered"), and does nothing. On the gateway
  that holds the claim, a concurrent call with the same key instead waits for the answer (`inflight`, in memory), as
  before.
- **A claim lapses 60 s** (`IDEMPOTENCY_CLAIM_MS`) after it was taken or last renewed. The holder renews it every
  20 s while the work runs, so a long `wait: true` create or command keeps it. A gateway that dies mid-call stops
  renewing, and once the claim has lapsed the next call with the key takes it over with `update` (conditional on the
  claim still being lapsed and unanswered) and does the work. So a crashed claim holds a key for at most 60 s.
- A call that **fails** (throws) deletes its claim, so a retry does the work again, as before.

The one way two calls can still both do the work is a holder that stalls for over 60 s without renewing (for example a
frozen process) while another call takes over. Whichever answers last is stored.

Seen on two replicas before the fix: one key sent to both at once made two sandboxes. The two-replica test in
`packages/compute/test/sql-store.test.ts` holds the first create in the backend and checks that the other replica
answers `conflict`, then the same sandbox, with one backend create.

`stop`, `resume`, `start` and `delete` take no key. They are idempotent by state: stopping a stopped sandbox, resuming
a running one or deleting a deleted one answers the sandbox as it is. Section 3's conditional transitions keep that true
across gateways.

## 5. Warm acquisition, claims and leases

- **The warm claim is on the host.** Each host keeps its own pool of pre-warmed microVMs (`microvm/default: 1` by
  default, set by the gateway in the host's welcome). It claims one under its own lock, in 0.2–0.4 ms of the roughly
  145 ms create. The gateway holds no lease on a warm sandbox. So two gateways can't double-claim one: the second
  create on a host with an empty pool falls back to restoring the template snapshot (about 210 ms). That is slower but
  correct.
- **Placement.** The scheduler (`packages/hosts/src/scheduler.ts`) picks among the hosts *this gateway* sees as
  connected. It subtracts what it has placed since each host's last heartbeat (`reserved`, kept in memory per process).
  Two gateways placing at once don't see each other's reservations, so they can place more on one host than its
  heartbeat allows, until the next heartbeat. The host then refuses what doesn't fit, and the create ends in `error`
  rather than in a lost or duplicated sandbox. A shared reservation isn't required for correctness, and this contract
  leaves it open.

  **Open on main:** `reserved` is cleared by the host's hello and heartbeats, which reach only the replica holding
  its socket. A replica that places on a host held elsewhere never clears what it reserved, so after enough placements
  it sees the host as full until it restarts. Reservations must expire on their own, for example by ignoring those
  older than the host's `lastSeenAt` in the shared registry.
- **Join tokens** are spent once by one conditional update (`spendJoinToken`). Two hosts racing with the same token
  can't both join.
- **Webhook deliveries** are leased. A dispatcher claims a due delivery by moving `nextAttemptAt` past its request
  timeout plus 5 s, with `update`. If the dispatcher dies, the delivery falls due again when that lease expires, so a
  delivery is sent at least once and normally exactly once.
- **Device sign-ins** move `pending` → `approved`/`denied` with `update`. The secret is collected once.

## 6. Relay: tunnel tickets, port exposures and grants

These live in `RelayStore`. They are shared by every gateway and survive a restart.

- **Tunnel tickets** (desktop, CDP, SSH): a ticket is `{id}.{secret}`. The store keeps the ID, the SHA-256 of the
  secret, the sandbox, the port, `expiresAt` (at most 60 minutes ahead), the grantee and, for a desktop ticket, its
  mode (`control` or `view`; a row with any other mode is refused). A desktop ticket opens only the desktop's route, and
  any other ticket never opens it. `verify` finds the row by ID,
  compares the hash in constant time and checks expiry. Expiry limits when a connection may *start*. A ticket can be
  used for several connections until it expires, and a connection that opened in time stays open until revoked (§7).
  The store has no signing key, so there is nothing to share or rotate between gateways. Expired rows are swept.
- **Port exposures**: keyed by the label `{port}-{subdomain}`. A row holds the sandbox, the port, the SHA-256 of the
  token (absent for a public port) and the grantee. Exposing a port again replaces the row, which ends the old token.
  Hiding the port, or stopping or deleting the sandbox, removes its rows. The token appears only in the answer to the
  expose call. The sandbox record keeps the URL without it.
- **Grantee**: who the access was given to, as JSON: `{"kind":"key","keyId":…}` or
  `{"kind":"person","userId":…,"session":…}` (`encodeGrantee` in `packages/compute/src/auth.ts`). The store doesn't
  parse it.

## 7. Revocation

`ComputeService.stillAllowed(grantee, sandboxId)` decides whether access may go on. It is true only if the key is
neither revoked nor expired (or the person's sign-in is live), and the grantee can still see the sandbox with the
`access` scope. It reads only shared records, so every gateway gives the same answer.

- A **new** tunnel connection or port request asks first. It may reuse an answer up to 1 s old.
- An **open** session (WebSocket, SSH) is held by the gateway that carries it and asked about again every 2 s. When
  the answer is no, the session is closed with code 4003.
- If the check fails (the store is unreachable), the relay refuses: access must not outlive a revocation it couldn't
  check.

So revoking a key, signing out or leaving the organisation on any gateway ends sessions on every gateway within about
one interval (≤ 2 s plus one check). No message passes between gateways: the shared records are the signal. A backend
that pushes revocations (for example a Durable Object holding the sessions) may end them sooner, but never later.

## 8. Host connections

Each host keeps one outbound WebSocket to one gateway (the hub). Calls to a host (`create`, `stop`, `fork`, a tunnel's
bytes, a port's request) must reach the gateway that holds that socket, whichever gateway the client called. The
contract requires that every gateway can reach every connected host.

The self-hosted gateway **forwards to the replica that holds the socket** (`ClusterStore`, `HostCluster`):

- `compute_gateway_replicas`: each live replica's address (`KANTEL_REPLICA_URL`) and Ed25519 public key, with a
  heartbeat. A replica not seen for 10 s is gone, and nothing is routed to it.
- `compute_host_owners`: which replica holds each host's socket, with an epoch that grows with each claim. A replica
  releases only its own claim, so a late close of an old socket never erases a newer one. A replica that finds its host
  claimed by another live replica closes its own socket, and the host reconnects.
- A call for a host held elsewhere goes to the owner over HTTP (NDJSON: the call's events, then its answer), and a port
  stream over a WebSocket. A replica serves a peer only for hosts connected to itself, so nothing bounces.
- Every request between replicas is signed with the sender's private key (never stored) over the recipient's ID, the
  operation, the time (±30 s), a nonce the recipient hasn't seen and the body's SHA-256. Anything else is a 404.

A Worker can meet this differently (§9.7).

## 9. Implementing it on D1 or Durable Objects

A Worker backend is equivalent if:

1. **It passes the conformance suites** that the memory and SQL stores pass: `packages/compute/test/sql-store.test.ts`
   (order, `update` with 20 concurrent writers ending at 20, copies, NUL and lone surrogates), and in
   `packages/hosts/test` the `HostStore` (`store.test.ts`), tickets (`tunnel.test.ts`), exposures (`ports.test.ts`)
   and revocation (`relay-access.test.ts`) tests. `createSqlComputeStore` already runs on D1 (Miniflare) in that suite, so
   **D1 can use the SQL store as it is**.
2. **`update` is a real compare-and-set** (§2). In a Durable Object with SQLite storage, one object serialises its own
   requests, so a read-modify-write inside one request is atomic, as long as nothing is `await`ed on another object
   between the read and the write. If records are sharded across objects (for example one per account), every record
   that one `update` touches must live in one object.
3. **Reads see every resolved write** (§2): no read replicas and no KV in front of the records. D1's read replication,
   if turned on, must not serve these reads.
4. **Order** is first insertion, kept across replaces (§2).
5. **Secrets** are kept only as the hashes listed in §1, and records are never logged.
6. **Revocation** reaches open relay sessions within 2 s plus one check (§7), by polling `stillAllowed` or by pushing.
7. **Host connections** (§8): a Durable Object per host holding the host's (hibernatable) WebSocket gives each host one
   owner, and every Worker request can reach it by the host's ID. That meets §8 without anything forwarding between
   gateways.
8. **`insert` is atomic** (§2): of concurrent inserts of one ID, exactly one wins. In a Durable Object, check and
   write in one request with nothing awaited between. The conformance suite inserts one ID 20 times at once.
9. Sections 3 and 4 are service behaviour, not store behaviour. They hold on any backend whose `update` and `insert`
   meet §2.

## 10. Open questions

- A sandbox left in `starting` or `stopping` by a gateway that died mid-operation stays there: nothing leases a
  transition, so another gateway's `stop` or `start` on it is `conflict`. It can still be deleted. This was so before
  the conditional transitions too.
- Gateway-local state that isn't shared and isn't covered here:
  - the abort switches of detached commands (a `kill` that lands on another gateway marks the command killed but
    doesn't abort it)
  - the per-process placement reservations (§5)
  - the usage samples the telemetry exporter batches
- Event delivery order across gateways: `events` are ordered by insertion. Two gateways emitting for one sandbox at once
  may interleave, and nothing orders them by sandbox.
