# Audit contract

## What it is for

One append-only record of what happened, for every organisation. Components never write to it directly: each puts
events in an outbox inside its own transaction, and a relay drains the outbox to the store with retries. The store is
idempotent by organisation and event id, so a retry never adds a row. Humans, services and the system read it by actor, organisation,
project, session, subject, vault item, vault grant and time; agents cannot.

## Records

- **AuditEventInput**: a stable `id` chosen by the source (`vault:decision:<id>`), `at`, `source`, `type`
  (`<source>.<noun>.<verb>`), `actor`, `organisationId`, optional project, session, agent and `subject`, and `data`
  that never holds a secret value.
- **AuditEvent**: the stored row, plus the store's `seq` (increasing across the whole store) and `recordedAt`.
- **Retention**: per organisation, in milliseconds. Default: keep forever.

## The encrypted store's events under the Connections name

The vault engine (`@kantel/vault`) used to write its events as `vault.*`. It now writes them under `connections.*`,
the prefix the connections package uses (`connections.use.allowed`, `connections.connection.created`). Its
`source` stays `vault`, its event IDs (`vault:decision:<id>`) stay as they were, and so does every subject kind
(`vault.item`, `vault.proposal`, `vault.grant`): those are internal names, and an ID is how a retry stays idempotent.
The table is `RENAMED_VAULT_AUDIT_TYPES` in `@kantel/contracts`:

| Old type | Current type |
| --- | --- |
| `vault.proposal.created` | `connections.request.created` |
| `vault.proposal.withdrawn` | `connections.request.withdrawn` |
| `vault.decision.approved` | `connections.decision.approved` |
| `vault.decision.denied` | `connections.decision.denied` |
| `vault.binding_code.mismatch` | `connections.binding_code.mismatch` |
| `vault.passkey.refused` | `connections.passkey.refused` |
| `vault.grant.revoked` | `connections.grant.revoked` |
| `vault.use.injected` | `connections.egress.injected` |
| `vault.use.denied` | `connections.egress.denied` |
| `vault.item.created` | `connections.item.created` |
| `vault.policy.created` | `connections.policy.created` |
| `vault.policy.revoked` | `connections.policy.revoked` |
| `vault.ceiling.set` | `connections.ceiling.set` |
| `vault.session.blocked` | `connections.session.blocked` |
| `vault.session.unblocked` | `connections.session.unblocked` |
| `vault.session.placeholders_issued` | `connections.session.placeholders_issued` |

- **Plural, not singular.** The store's events use the plural `connections.` prefix, as the connections package does,
  so one prefix finds them all. Its approval events use it too (`connections.approval.*`).
- **`egress`, not `use`.** `connections.use.allowed` and `connections.use.denied` are the connections package's own
  record of a connection's use; the store's injections and refusals at the egress proxy are `connections.egress.*` so
  the two never share a type.
- **Held is not denied.** A use is `connections.use.allowed` (it went out), `connections.use.denied` (refused)
  or `connections.use.held` (a rule said ask: the exact request waits for a person, nothing sent). The person's answer
  is the store's `connections.decision.approved` or `connections.decision.denied`; an approved request that then goes
  out is a `connections.use.allowed` of its own. Older held uses are stored as `connections.use.denied` with
  `approval: "pending"` in their data, and nothing rewrites them: the audit view and `listUses` read them as held.
- **Stored rows keep their type.** Nothing rewrites a row; the log is append-only. A store reads both.
- **Old queries find new rows.** A query for an old type, or an old prefix ending in `.` (`vault.`,
  `vault.use.`), also matches the new types it covers (`auditTypeAliases`), in every store and in `typeMatches`. A
  query for a new type or `connections.` finds only rows written under the new names. The SQL store writes the aliases
  into the statement as literals from the fixed table, so the aliases add no parameters and the 20-type limit
  still holds on D1. Suite case: "finds the store's renamed events by their old vault types and prefixes, for
  one release (#324)". The aliases are deprecated: a client should ask for the new types, or both.
- **Readers name both.** The audit view's kinds, the credential summary and `credentialChoices` ask for both families
  explicitly (`["vault.use.", "connections.egress."]`), so they show old rows without relying on the aliases, and read
  an old row as its new name (`currentAuditType`).

## Key operations

`outbox.append` → `outbox.drain(store)` → `store.query` / `store.get`. `setRetention` and `applyRetention` are the only
way rows ever leave. The portable helpers in `@kantel/audit` are `matchesQuery`, `actorMatches`, `typeMatches`,
`eventItemId`, `eventGrantId`, `assertValidAuditEvent` and `findSecret`.

## Rules and the suite cases that enforce them

- Appending an id twice keeps the first row and its `seq`: "keeps one row with its first data and seq when the same
  event id is appended twice".
- An outbox removes a batch only after the sink takes it, sends at most 100 at a time and in order, and a retried drain
  delivers each event once: "delivers every event exactly once and in order when a failed drain is retried", "keeps the
  failed batch and everything after it queued when a sink fails part way through", "sends each queued event once when
  two drains run at once", "queues an event id once and counts pending events".
- Draining twice never duplicates a row: "shows a vault event and a human decision drained through the outbox once
  each, even when drained twice".
- Rows come in `seq` order (or reversed with `newestFirst`); every query field narrows; a type ending in `.` is a prefix;
  actors compare by kind and ID (a service's key only when asked); `from` is inclusive and `to` exclusive: "returns rows
  in seq order and narrows by project, session, agent, actor, source, type prefix, subject and time". `types` matches
  any of 1 to 20 types and prefixes (`["vault.policy.", "connections.policy.", "capability.grant."]` is every policy
  change) and narrows with
  `type` and the rest; an empty list, an empty type, a type holding a comma or more than 20 types is `invalid`, in the
  same test. A row two of the types match comes once, a prefix beyond ASCII is measured in characters, and the list
  keeps to the caller's organisation and pages by cursor: "narrows by any of a list of types: each row once,
  characters not bytes, caller's organisation, paged".
- `itemId` and `grantId` match the vault item or grant an event is about: its subject when that is a `vault.item` or
  `vault.grant`, or else `data.itemId` or `data.grantId` when it is a string (a number, a list or a nested field is not
  an ID). They combine with every other field, page by cursor and keep to the rows the caller may see: "narrows by vault
  item and grant, by the record's subject or a string in data, and pages by them". So "which sessions used the Linear
  key yesterday" is one query (`types: ["vault.use.", "connections.egress."]`, `itemId`, `from`, `to`) and "who
  approved this grant" another (`types: ["vault.decision.approved", "connections.decision.approved"]`, `grantId`).
- Cursors are the last `seq` seen, so paging is stable while rows are appended: "pages through 250 rows 100 at a time,
  each row once, while rows are appended between pages".
- Organisation isolation: "never returns another organisation's rows, and get is not_found for them".
- Agents cannot read the log or set retention: "refuses an agent querying, reading or setting retention".
- Worker calls: `store.append`,
  `store.applyRetention`, `outbox.append`, `outbox.drain` and `outbox.pending` take a `SystemContext` and call
  `requireSystem` first. Any other actor, or no caller, is `forbidden`, changes nothing, and is audited once as
  `access.denied` with no secret: the store writes the refusal as its own row, and the outbox queues it. A refusal
  with no caller goes under `PLATFORM_ORGANISATION`. Case: "worker calls: append, retention, drain and pending refuse
  every caller but system, and change nothing".
- Project access, through `ProjectAccess`, after the organisation lookup (another organisation's
  row stays `not_found`) and after the agent rule (agents stay `forbidden`, unaudited, whichever project their session
  is in). `query` naming a `projectId` or `sessionId` requires `viewer` on them (`audit.query`); without either it keeps
  only the rows the caller `allows`: viewer on a row's project, or an organisation-wide viewer role for a row without
  one, before the page is cut, so cursors stay stable. `get` requires viewer on the row's project, or organisation-wide
  for a row without one (`audit.get`, subject `{ kind: "audit.event", id }`). `setRetention` requires an
  organisation-wide `admin` (`audit.setRetention`). `append`, `applyRetention` and the outbox are worker calls (see
  above). Refusals are audited by `ProjectAccess` to its own sink, not to this store. Cases: "project access: refuses
  an operator outside the project its rows, and non-admins retention, changing nothing", "project access: refuses an
  agent before any project check, whichever project its session is in", "project access: a query without a project or
  session returns only rows the caller may see, paging stably", "project access: lets a viewer on the project query and
  read its rows, and an organisation viewer the rest". Agents never call the store, so there is no closed-session case.
- Every row has an actor and a well-formed shape; a bad event refuses its whole batch: "refuses an event without an
  actor, so every stored row has an actor", "refuses an event without an id, a time, an organisation, a type or a known
  source".
- Retention removes only rows with `at` before now minus the organisation's retention: "removes on retention only rows
  older than the organisation's retention, leaving other organisations alone".
- Rows outlive the records they describe and there is no delete method: "keeps a session's rows however much later they
  are queried, until retention, with no API to delete them".
- Secrets in `data` are detectable, IDs are not data: "findSecret ignores a canary in record IDs but finds one anywhere
  in data". Other suites use the suite's `findSecret` to check their events.

## The query API over HTTP

The audit view and host apps read the store through two `GET` routes, defined in
`packages/contracts/src/audit.ts` next to the store:

- `GET /v1/audit/events?<query>` (`AUDIT_EVENTS_PATH`) answers `AuditEventsResponse` (`{ items, nextCursor? }`):
  `AuditStore.query` with the query and page as search parameters. `auditQueryToSearchParams` writes them and
  `auditQueryFromSearchParams` reads them: `projectId`, `sessionId`, `agentId`, `actorKind` with `actorId` (plus
  `actorKeyId` for a service's key, `actorSessionId` for an agent), `source`, `type` (a prefix when it ends in `.`),
  `types` (`AuditQuery.types` joined with commas),
  `subjectKind` with `subjectId`, `itemId`, `grantId`, `from` and `to` in epoch milliseconds, `order` (`oldest` or `newest`), `limit` and
  `cursor`. An unknown, repeated, empty or half-given parameter is `invalid`.
- `GET /v1/audit/event?id=<id>` (`AUDIT_EVENT_PATH`) answers `AuditEventResponse` (`{ event }`): `AuditStore.get`. The
  id is a search parameter, not a path segment, because sources choose ids and one may be `.` or hold a `/`.
- Every call goes through the deployment's `Authenticator`; the organisation is always the caller's, and the store
  decides what they see. Errors answer `{ error: { code, message } }`: 400 `invalid`, 401 `unauthenticated` (with
  `WWW-Authenticate: Bearer`), 403 `forbidden`, 404 `not_found`, 405 for a method other than `GET`, 409 `conflict`,
  410 `expired`, 422 `refused`, 429 `exhausted`, 499 `aborted`, 501 `not_supported`, 503 `unavailable`, and 500 with no detail for anything unexpected.

`@kantel/audit/http` has the handler, `createAuditQueryHandler({ store, authenticator })`, and a client,
`createAuditClient({ baseUrl, headers, fetch })`, whose `query` and `get` mirror the store's and reject with the
server's `KantelError` code.

## The in-memory implementation

`createMemoryAuditStore({ clock?, retentionMs?, access? })` keeps rows in one array in `seq` order with an index by id;
`retentionMs` is the default for organisations that set none; without `access` it checks only the organisation. Pages hold up to 500 rows (default 100).
`createMemoryAuditOutbox()` keeps a queue, validates events as they arrive (so one malformed event cannot block it) and
runs drains one at a time. It leaves out durability, a transactional outbox shared with a component's own records
(both in the durable implementation below), scheduled retention, and a record of ids already removed by retention (a
very late retry of such an id is stored again, and goes at the next retention run; the durable store does the same).

## The durable implementation

`@kantel/audit/sql` runs on any `SqlDriver` from `@kantel/sql`: Postgres (`postgresPoolDriver(pool)` over `pg`) for
the self-hosted target, and D1 (`d1Driver(env.DB)`) or another SQLite for Cloudflare. It passes the whole suite,
with `projectAccess`, on PGlite, `node:sqlite`, D1 in Miniflare and (with `KANTEL_TEST_POSTGRES_URL`) a real
Postgres.

- `migrateAudit(driver)` creates the tables if they are missing; `auditSchema(dialect)` gives the statements for a
  target's own migrations. Tables: `audit_events` (one row per organisation and id, `UNIQUE (organisation_id, id)`),
  `audit_projects` (the projects each organisation's rows name), `audit_retention` and `audit_outbox`.
- `createSqlAuditStore({ driver, clock?, retentionMs?, access? })` behaves as the in-memory store. An append is one
  batch of `INSERT … ON CONFLICT DO NOTHING`, so a retried batch, or one the store took before the relay lost its
  answer, adds no row ("stores each event once when the store took a batch but the relay never heard back"). On
  Postgres each append takes an advisory lock first, so rows commit in `seq` order and a reader paging by cursor never
  skips a row that commits late. Pages are cut in SQL on indexes that lead with the organisation; a query without a
  project or session checks access once per project the organisation's rows name, then pages over those projects.
  `itemId` and `grantId` are matched on indexes over an expression of the stored event (`audit_events_by_item` and
  `audit_events_by_grant`: organisation, the record's ID as `eventItemId` and `eventGrantId` read it, `seq`), so a
  database made before them needs no new column or backfill; `migrateAudit` adds the two indexes.
  `sql.scale.test.ts` seeds 100,000 events and checks that the first page, a page near the end, a session's page,
  newest-first, an access-filtered page, one credential's sparse uses and one grant's rows each take under 100 ms and
  use an index (each takes under 10 ms locally).
- `createSqlAuditOutbox({ driver, clock? })` keeps the queue in `audit_outbox`. A producer queues its events in its
  own transaction with `auditOutboxStatements(events)`: in the same D1 or SQLite `batch` as its own writes, or on
  Postgres through `postgresClientDriver(client)` over the client its transaction runs on. Its records and their
  events then commit, or roll back, together. Drains from one outbox run one at a time; two processes draining at
  once may both send a batch, and the store keeps one row.
- `@kantel/audit/relay` has `startAuditRelay({ outbox, sink, intervalMs?, maxBackoffMs?, onError? })`, which drains
  on a timer and doubles its wait while the sink fails. On Cloudflare, call `outbox.drain` from a Durable Object alarm
  or a cron trigger instead. `applyRetention` is the deployment's to schedule.

## Notes

- Idempotency is by organisation and id, so one organisation's event never shadows another's that reuses an id ("keeps
  an event per organisation when two organisations reuse an id"). Ids are not namespaced by source.
- Setting retention needs an organisation-wide admin. Retention must be a positive whole number of milliseconds; there
  is no other minimum.
- `query` returns nothing for `from >= to` or an unknown source, rather than refusing it as `invalid`.
