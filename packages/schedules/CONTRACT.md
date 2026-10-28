# Schedules contract

## What it is for

Schedules decide when reminders, tasks, summaries, checks, the heartbeat and saved programs run. The scheduler
materialises due occurrences, runners claim them under a lease, and checks turn exit codes and findings into alerts.
Execution is retried rather than exactly-once: a handler keys its idempotent markers by occurrence ID.

## Records

- **Schedule**: owner, kind, title, IANA `timezone`, either a one-off `at` or a `repeat`, optional `until` and
  `count`, an opaque `payload`, check settings, `status` (`active`, `paused`, `ended`), `nextDueAt` and
  `occurrences` (materialised so far, coalesced ones counted once).
- **Occurrence**: `<scheduleId>@<dueAt>`, with `coalesced` (how many due times it stands for), `status`, `attempt`,
  and the current claim (`claimedBy`, `leaseUntil`).
- **Raised finding**: a check's finding plus why it is raised now (`new`, `reraise`, `rising`, `failures`).

## Key operations

`create`, `update`, `pause`, `resume`, `end` for humans and services. `preview` lists the next due times without
materialising them. A scheduler loop calls `tick`; runners call `claim`, then `complete` or, for checks, `reportCheck`.
The portable `nextDue(schedule, after)` and `previewDue(schedule, from, n)` in `@harbour/schedules`, with
`zonedToUtc` and `utcToZoned`, compute due times with `Intl.DateTimeFormat` only.

## Rules and the suite cases that enforce them

- Calendar recurrence is at local time in the time zone: "runs a daily 09:00 Europe/London schedule at 08:00 UTC in
  summer and 09:00 UTC in winter", "runs weekday and weekly schedules only on their days".
- A local time in the spring-forward gap runs at the first valid instant after it; an ambiguous one runs once, at its
  first instant: "runs a local time in the spring-forward gap once at the first valid instant after it", "runs an
  ambiguous fall-back local time once, at its first instant".
- Interval recurrence is absolute: "keeps interval schedules absolute: every 6 hours stays 6 hours apart across a DST
  change".
- Day 31 means the last day: "runs a monthly day-31 schedule on the last day of short months".
- Occurrences are unique per schedule and due time: "creates one occurrence when ticked twice at the same time".
- Missed runs are coalesced into one at the latest: "coalesces a day of missed hourly runs into one occurrence at the
  latest due time".
- Occurrences never overlap: "never overlaps occurrences: ticks create none while one is due or running, and one after
  it completes".
- Claims are exclusive under a lease, the oldest first, and only a live claimant finishes: "claims the oldest claimable
  occurrence first", "keeps a claim exclusive until its lease passes, then hands it over and refuses the first runner",
  "lets only the claimant report a check".
- Several schedulers may share one store: "two schedulers ticking at once materialise each due time once, and racing
  runners never share a claim" (the provider's `peer` is a second store over the same storage).
- A restart neither drops nor duplicates an occurrence (issue #23's definition of done): "a restart neither drops nor
  duplicates an occurrence, and keeps what a check raised" (the provider's `reopen` opens the store again over the same
  storage; a store with no storage of its own carries on with the same object).
- `count` and `until` end a schedule; a one-off ends after it runs: "ends a schedule when its count or until is
  reached".
- Checks: "raises nothing for a check that exits 0", "raises a check's new findings once and audits each raise",
  "raises a finding still present again after reraiseHours", "raises a finding whose value doubles as rising", "raises
  one check-failed finding after three failed runs in a row, and again only after a success".
- Agents may not create or change schedules: "refuses an agent creating, updating, pausing, resuming or ending a
  schedule" (which also checks `schedules.schedule.created` is audited).
- Paused schedules create nothing, and resuming does not backfill: "creates no occurrences for a paused schedule and
  does not backfill paused time on resume".
- Input is validated: "rejects an invalid time zone, a bad HH:MM, or both or neither of at and repeat as invalid".
- Organisation isolation: "hides another organisation's schedules as not found".
- Worker calls (settled by Tom on 27 Oct 2026, question 13: "Require a system identity"): `tick`, `claim`, `complete`
  and `reportCheck` take a `SystemContext`. No caller, a human, a service or an agent is `forbidden`, audited once as
  `access.denied`, and changes nothing: no occurrence is materialised, claimed or settled. Case: "worker calls: tick,
  claim, complete and reportCheck refuse every caller but system, and change nothing".
- Project access (settled question 7): a schedule owned by `{ kind: "project" }` is checked against its `projectId`
  through `ProjectAccess.require`, after the organisation lookup (another organisation's schedule stays `not_found`) and
  after the agent rule (agents stay `forbidden` on changes, unaudited). `create`, `update`, `pause`, `resume` and `end`
  need `operator`; `get`, `preview` and `listOccurrences` need `viewer`. Operations are `schedules.<method>`, with
  subject `{ kind: "schedules.schedule", id }` once the schedule exists. `list` keeps a project's schedules only when
  the caller `allows` viewer on that project, before the page is cut. Organisation- and user-owned schedules have no
  project check. `tick`, `claim`, `complete` and `reportCheck` are worker calls (below). Cases: "project
  access: refuses an operator outside the project every change and read of its schedule, changing nothing", "project
  access: refuses an agent whose session belongs to another project, changing nothing", "project access: refuses an
  agent whose session was closed", "project access: lists leave out another project's schedules, and pages hold only
  visible ones", "project access: lets an operator on the project and an agent in its own session use the project's
  schedule".

## The in-memory implementation

`createMemorySchedules({ clock?, audit?, access? })` keeps schedules and occurrences in maps. `tick` and `claim` change state
with no await, so concurrent calls cannot materialise or claim one occurrence twice. `tick` walks at most 10,000
missed due times per schedule; past that it counts 10,000 and jumps `nextDueAt` past now. `create` and `resume`
compute `nextDueAt` as the first due time at or after now. `create` and `update` copy only `ScheduleInput`'s fields, so
a caller can never set the id, status, counts or timestamps ("update ignores fields outside ScheduleInput and is
audited"). It audits `schedules.schedule.created`, `.updated`, `.paused`, `.resumed` and `.ended` by their actor, and
`schedules.finding.raised` (actor `system:schedules`), with stable IDs. Without `access` it checks only the
organisation. It keeps nothing across a restart and has no scheduler loop.

Both stores decide through the same rules, `src/rules.ts`: validation, what create, a change or a tick does to a
schedule, which findings a check run raises, and the audit events.

## The SQL implementation

`createSqlSchedules({ driver, clock?, audit?, access? })` in `@harbour/schedules/sql` runs on any `SqlDriver`: Postgres
self-hosted, D1 or a Durable Object's SQLite on Cloudflare. Run `migrateSchedules(driver)` (or `schedulesSchema`'s
idempotent statements) first. It passes the whole suite on PGlite, `node:sqlite`, D1 in Miniflare and, with
`HARBOUR_TEST_POSTGRES_URL`, a real Postgres, and several stores (hosts) may share one database:

- `schedules` holds a row per schedule: the columns it is found and changed by (`status`, `next_due_at`,
  `occurrences`, `failures_in_row`) beside the rest of the record as JSON. Every write bumps `revision`; `update`,
  `pause`, `resume` and `end` land only on the revision they read, and re-read and retry otherwise.
- `tick` moves each due schedule on with `… WHERE revision = ?`, stamping a writer token, and inserts the occurrence in
  the same batch only where that token landed. Of two schedulers ticking at once exactly one materialises it, and
  the occurrence's primary key, `<scheduleId>@<dueAt>`, keeps a due time to one row.
- `claim` is one `UPDATE … RETURNING` of the oldest claimable occurrence that re-checks it is still claimable; on
  Postgres the candidate is picked `FOR UPDATE SKIP LOCKED`.
- `complete` and `reportCheck` finish an occurrence only while the runner holds it with a live lease. A check run's
  failure count and its raised findings (`schedule_findings`, per schedule and key) change in the same batch, guarded
  by the occurrence's new token, so a runner whose lease lapsed changes nothing.
- Every time is the injected clock's, passed in as a parameter; the database's clock is never read.

Neither store runs a scheduler loop; that is the next part of issue #23.

## Open questions

- `count` is compared with `occurrences` (coalesced runs count once), so a coalesced occurrence uses one of the count.
  Should it use as many as it stands for?
- A day past the end of a month (29 or 30 in February) is clamped to the last day, like 31. Should it skip instead?
- `create` rejects a schedule that would never be due (a past one-off, an `until` already passed) as `invalid`;
  `update` ends such a schedule instead. `day` with an interval counts days from the creation date.
- Agents are also refused `update`, which the contract does not say. `reportCheck` on a schedule that is not a check is
  `invalid`; `complete` on a check finishes it without touching the failure count.
- Exit 3 counts as a success and resets the failure count. A finding key is `new` only the first time ever; after it
  clears and returns it is raised again only by `reraise` or `rising`.
