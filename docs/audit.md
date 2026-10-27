# The audit view

A filterable timeline of who did what on Harbour: people, agents and the system, by organisation, project, agent and
session. It covers credential uses, approvals and denials, policy changes, sandbox escalations, refused access and
session lifecycle. Each row links to the session turn or vault request it came from, and the whole filtered log
exports as JSONL. It lives in `@harbour/ui` under `packages/ui/src/audit/`; `apps/console` mounts it once the console
shell lands.

## Reading it

- **Filters:** *Organisation*, *When* (last hour, last 24 hours, today, yesterday, last 7 days, last 30 days, all
  time), *What* (a kind of event), *Credential*, *Who*, *Project*, *Agent* and *Session*. A filter with no options from
  the host is hidden, and *Organisation* shows only when the viewer belongs to two or more. *Clear filters* keeps the
  organisation and time range; a new organisation clears the project, agent, session and credential.
- **Organisation:** the store takes the organisation from the call context, never the query, so the view puts the
  chosen one on its query as `organisationId` (`AuditViewQuery`) and the host's source binds its context to it, after
  checking the viewer belongs, and passes the rest to `AuditStore.query`. The fixture's source does this.
- **Rows:** newest first under a heading for each local day. Each row reads as a sentence: the time, a badge for the
  kind, the actor's name and what they did ("Tom Davies approved Linear API key for POST api.linear.app/graphql"), the
  project and session, and a link. The chevron opens the stored event: type, time, actor key, subject, ID and `seq`,
  and its data as JSON.
- **Links:** vault requests, approvals, denials and wrong codes link to the vault page for the proposal. Credential
  uses and session events link to the session, at the turn when the event names one (`session.submission` or
  `session.tool` subjects). The host builds the URLs (`links.session`, `links.proposal`).
- **Credential summary:** with a credential picked, a panel above the timeline lists the sessions that used it in the
  range, how often (and how many uses were refused), first and last use, and who approved each grant those uses went
  through, linked to the vault request. Uses under a standing policy say so.
- **Keyboard:** the timeline is one Tab stop, on the current row's chevron and link. The up and down arrows move
  between rows, Home and End jump to the newest and oldest loaded, and Enter opens a row. Tab then goes on to *Load
  older events*, so the foot of the list is one press away however many rows are loaded.
- **Newer events:** with `pollMs`, the view checks for newer events and offers *N newer events* above the list instead
  of moving the rows under the reader.

### Which sessions used the Linear key yesterday, and who approved it?

Set *When* to Yesterday and *Credential* to Linear API key. The summary answers it: in the fixture, three sessions used
it 15 times, under grants Tom Davies and Alex Rivera approved, each approval linked to its request. The *Linear key
yesterday* story opens there, and `audit.test.ts` checks the answer against the store.

## Paging and 100k events

The timeline is virtualised with `virtua` (as the session transcript is): only the rows near the viewport are mounted.
Pages of 200 come from the store's cursor as the reader nears the end of what's loaded, or from *Load older events*
at the foot. Day headings are built only for each new page, not the whole list again.

Measured on the *Large* story (100,000 generated events over 30 days), in headless Chromium at 1280px, scrolling through
every event with `node packages/ui/scripts/audit-perf.ts --pages 500`:

| Measure | Result |
| --- | --- |
| Rows loaded | 100,000 (500 pages) |
| Rows mounted at once, at most | 32 |
| Frame time, median / p95 / max | 16.7 / 16.8 / 100 ms |
| Frames over 50 ms | 5 of 7,112 |
| Scroll through a page and read the next, median / p95 | 220 / 258 ms |
| First rows, including building the 100k store in the page | 2.8 s |

The cost per page stays flat from the first page to the 500th. In Node, paging the in-memory store through all 100k
events newest first takes a median 15 ms per page of 200 (`audit.test.ts`). That store filters every row for every
page; lane 6's store, with an index on organisation, time and `seq`, should do better.

## Export

*Export JSONL* reads every event the filters match, oldest first, and saves `harbour-audit-<from>-to-<to>.jsonl` with
one stored event per line, exactly as the store returned it. It reports progress and can be cancelled. Hosts that save
elsewhere pass `onExport`. The credential filter applies to the export too.

## Using it

```tsx
import { AuditView } from "@harbour/ui";

<AuditView
	source={{ query: (query, page) => audit.query(ctx, query, page) }}
	directory={{ person, agent, session, project, item }}
	links={{ session: (id, turn) => `/sessions/${id}${turn ? `?turn=${turn}` : ""}`, proposal: (id) => `/vault/proposals/${id}` }}
	choices={{ actors, projects, agents, sessions, credentials }}
	pollMs={10_000}
/>;
```

`source` is the `AuditStore.query` bound to the viewer. Agents can't read the audit log, so the host only builds one
for a person or the system. The directory turns IDs into names; an unknown ID shows as itself.

## Gaps in the contract

`AuditQuery` takes one type or prefix and the fields on the event, but not the event's data. The view works around
this, and lane 6's query API should close it:

1. **No credential filter.** Credential uses and approvals name the vault item only in `data.itemId`. The view reads
   pages of the chosen kind and matches the item itself. A narrow filter over a long range may read many pages for a
   few rows (the status line says how many were read), and the view stops after 25 pages per *Load older events*.
   When those pages hold no match, the view says none of the events it read match and offers *Look further back*,
   not an empty log. An `itemId` filter would make it exact.
2. **No grant filter.** The summary finds each grant's approval by reading `vault.decision.approved` events up to the
   range's end. A `grantId` filter (or `data` match) would make that one read.
3. **One type per query.** A kind such as "policy changes" can't cover both `vault.policy.*` and
   `capability.grant.*`. A list of types would let *What* group them.

## Stories and checks

Every state has a story under **Audit/Audit view**: default, loading, empty, empty with filters, error, an error on a
later page, long content, mobile, streaming (new events arriving), *Large* (100k), *Sparse matches* (a credential
last used behind more than one load of other events), and the definition-of-done story
*Linear key yesterday*, plus approvals, refused access, one project's sandbox events and one person's actions.

```sh
pnpm --filter @harbour/ui test             # audit.test.ts among them
pnpm --filter @harbour/ui build:workbench
node packages/ui/loop/gates.ts --only audit--audit-view--default,...
node packages/ui/scripts/audit-perf.ts --pages 500 --json audit-perf.json
```
