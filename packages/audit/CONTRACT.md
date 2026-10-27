# Audit contract

## What it is for

One append-only record of what happened, for every organisation. Components never write to it directly: each puts
events in an outbox inside its own transaction, and a relay drains the outbox to the store with retries. The store is
idempotent by organisation and event id, so a retry never adds a row. Humans, services and the system read it by actor, organisation,
project, session, subject and time; agents cannot.

## Records

- **AuditEventInput**: a stable `id` chosen by the source (`vault:decision:<id>`), `at`, `source`, `type`
  (`<source>.<noun>.<verb>`), `actor`, `organisationId`, optional project, session, agent and `subject`, and `data`
  that never holds a secret value.
- **AuditEvent**: the stored row, plus the store's `seq` (increasing across the whole store) and `recordedAt`.
- **Retention**: per organisation, in milliseconds. Default: keep forever.

## Key operations

`outbox.append` → `outbox.drain(store)` → `store.query` / `store.get`. `setRetention` and `applyRetention` are the only
way rows ever leave. The portable helpers in `@harbour/audit` are `matchesQuery`, `actorMatches`, `typeMatches`,
`assertValidAuditEvent` and `findSecret`.

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
  in seq order and narrows by project, session, agent, actor, source, type prefix, subject and time".
- Cursors are the last `seq` seen, so paging is stable while rows are appended: "pages through 250 rows 100 at a time,
  each row once, while rows are appended between pages".
- Organisation isolation: "never returns another organisation's rows, and get is not_found for them".
- Agents cannot read the log or set retention: "refuses an agent querying, reading or setting retention".
- Worker calls (settled by Tom on 27 Oct 2026, question 13: "Require a system identity"): `store.append`,
  `store.applyRetention`, `outbox.append`, `outbox.drain` and `outbox.pending` take a `SystemContext` and call
  `requireSystem` first. Any other actor, or no caller, is `forbidden`, changes nothing, and is audited once as
  `access.denied` with no secret: the store writes the refusal as its own row, and the outbox queues it. A refusal
  with no caller goes under `PLATFORM_ORGANISATION`. Case: "worker calls: append, retention, drain and pending refuse
  every caller but system, and change nothing".
- Project access (settled question 7), through `ProjectAccess`, after the organisation lookup (another organisation's
  row stays `not_found`) and after the agent rule (agents stay `forbidden`, unaudited, whichever project their session
  is in). `query` naming a `projectId` or `sessionId` requires `viewer` on them (`audit.query`); without either it keeps
  only the rows the caller `allows`: viewer on a row's project, or an organisation-wide viewer role for a row without
  one, before the page is cut, so cursors stay stable. `get` requires viewer on the row's project, or organisation-wide
  for a row without one (`audit.get`, subject `{ kind: "audit.event", id }`). `setRetention` requires an
  organisation-wide `admin` (`audit.setRetention`). `append`, `applyRetention` and the outbox are worker calls (see
  below). Refusals are audited by `ProjectAccess` to its own sink, not to this store. Cases: "project access: refuses
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

## The in-memory implementation

`createMemoryAuditStore({ clock?, retentionMs?, access? })` keeps rows in one array in `seq` order with an index by id;
`retentionMs` is the default for organisations that set none; without `access` it checks only the organisation. Pages hold up to 500 rows (default 100).
`createMemoryAuditOutbox()` keeps a queue, validates events as they arrive (so one malformed event cannot block it) and
runs drains one at a time. It leaves out durability, a transactional outbox shared with a component's own records,
scheduled retention, and a record of ids already removed by retention (a very late retry of such an id is stored again,
and goes at the next retention run).

## Open questions

- Idempotency is by organisation and id, so one organisation's event never shadows another's that reuses an id ("keeps
  an event per organisation when two organisations reuse an id"). Should ids also be namespaced by source?
- Who may set retention: settled (question 7) as an organisation-wide admin. Should there be a minimum retention?
- Should `query` reject `from >= to` or an unknown source as `invalid`, rather than return nothing?
