# Audit view

`AuditView` is a filterable timeline of who did what: people, agents and the system, by organisation, project, agent
and session. It covers credential uses, approvals and denials, policy changes, sandbox escalations, refused access and
session lifecycle. Each row links to the session turn or connection request it came from, and the filtered log
exports as JSONL. It lives in `src/audit/`; the console mounts it at `/audit` behind its `ConsoleAudit` seam. What a
person sees on the page is in the docs site's [Audit log](../../../docs/site/src/content/docs/console/audit.md).

## Using it

```tsx
import { AuditView } from "@kantel/ui";

<AuditView
	source={{ query: (query, page) => audit.query(ctx, query, page) }}
	directory={{ person, agent, session, project, item }}
	links={{ session: (id, turn) => `/sessions/${id}${turn ? `?turn=${turn}` : ""}`, proposal: (id) => `/connections/requests/${id}` }}
	choices={{ actors, projects, agents, sessions, credentials }}
	pollMs={10_000}
/>;
```

- `source` is `AuditStore.query` bound to the viewer. Agents can't read the audit log, so the host only builds one for
  a person or the system. The store takes the organisation from the call context, never the query, so the view puts
  the chosen one on its query as `organisationId` (`AuditViewQuery`), and the host's source binds its context to it
  after checking the viewer belongs.
- `directory` turns IDs into names; an unknown ID shows as itself.
- `links` builds each row's link. A builder that returns `undefined` leaves the row unlinked. `links.session` gets the
  event's `projectId` as a third argument, for a host whose session pages sit under their project.
- `choices` fills the filters. A filter with no choices is hidden, and *Organisation* shows only when the viewer
  belongs to two or more.
- `pollMs` makes the view check for newer events and offer *N newer events* above the list, instead of moving the
  rows under the reader.
- `onExport` replaces the default download of `harbour-audit-<from>-to-<to>.jsonl`.

On the console's API source (`?source=api`, the gateway's `/v1/audit/events`), rows link to
`/projects/<project>/sessions/<session>#turn=<id>`, and the *Credential* choices and item names come from the log's
own `connections.item.created` and older `vault.item.created` events (`credentialChoices`).

## Behaviour

- **Credential filter and summary:** the store filters by credential (`AuditQuery.itemId`), so every page is a full
  page of that credential's events however far back they are. With a credential picked, a panel above the timeline
  lists the sessions that used it in the range, how often (and how many uses were refused), the first and last use, and
  who approved each grant those uses went through (`grantId`), however long before the range it was approved.
- **Old and new connection events:** connection events were once `vault.*` and are now `connections.*`. Stored rows
  keep their old type, so every connection kind, the credential summary and the *Credential* choices ask for both, and
  an old row reads the same as its new one. The table of renamed types is in `packages/audit/CONTRACT.md`.
- **Keyboard:** the timeline is one Tab stop, on the current row's chevron and link. Up and down move between rows,
  Home and End jump to the newest and oldest loaded, and Enter opens a row. Tab then goes on to *Load older events*.
- **Export:** *Export JSONL* reads every event the filters match, oldest first, one stored event per line exactly as
  the store returned it. It reports progress and can be cancelled.

## Cost

The timeline is virtualised with `virtua`, as the session transcript is: only the rows near the viewport are mounted.
Pages of 200 come from the store's cursor as the reader nears the end of what's loaded, or from *Load older events*.
Day headings are built only for each new page. `node packages/ui/scripts/audit-perf.ts --pages 500` scrolls the
*Large* story (100,000 events) in headless Chromium and reports the frame times; at most about 32 rows are mounted at
once, and the cost per page stays flat from the first page to the last.

## Stories and checks

Every state has a story under **Audit/Audit view**: default, loading, empty, empty with filters, error, an error on a
later page, long content, mobile, streaming (new events arriving), *Large* (100k), *Sparse matches* (a credential
last used behind 6,000 other events), *Linear key yesterday* (which sessions used one key, and who approved it),
approvals, refused access, one project's sandbox events and one person's actions.

```sh
pnpm --filter @kantel/ui test             # audit.test.ts among them
pnpm --filter @kantel/ui build:workbench
node packages/ui/loop/gates.ts --only audit--audit-view--default,...
node packages/ui/scripts/audit-perf.ts --pages 500 --json audit-perf.json
```
