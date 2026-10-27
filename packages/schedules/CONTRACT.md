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

## The in-memory implementation

`createMemorySchedules({ clock?, audit? })` keeps schedules and occurrences in maps. `tick` and `claim` change state
with no await, so concurrent calls cannot materialise or claim one occurrence twice. `tick` walks at most 10,000
missed due times per schedule; past that it counts 10,000 and jumps `nextDueAt` past now. `create` and `resume`
compute `nextDueAt` as the first due time at or after now. It audits `schedules.schedule.created` and
`schedules.finding.raised` (actor `system:schedules`), with stable IDs. It leaves out durable storage, a scheduler
loop, role checks beyond "not an agent", and auditing of updates, pauses, resumes and ends.

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
