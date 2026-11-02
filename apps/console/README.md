# @kantel/console

Kantel's session interface: a project's sessions grouped by what they need from you, the live
session view with its transcript and composer, and a session's workspace files, read-only. Built from `@kantel/ui`; this app only decides what goes where.

```sh
pnpm --filter @kantel/cloudflare dev          # the gateway with the session API, on http://127.0.0.1:8787
pnpm --filter @kantel/console dev             # http://127.0.0.1:5173, on that gateway
pnpm --filter @kantel/console dev:recorded    # http://127.0.0.1:5173, on recorded sessions, no backend
```

`pnpm dev` forwards `/v1` to the gateway (`KANTEL_GATEWAY`, default `http://127.0.0.1:8787`), WebSocket upgrades
included (a session's events, a browser's live view), and signs each call in as the dev admin with a token from the
gateway's mock Access issuer (`scripts/dev-gateway.ts`). Deployed, the gateway serves the console itself, and
Cloudflare Access signs the calls in.

## Routes

| Path | Shows |
| --- | --- |
| `/` | The first project |
| `/projects/:projectId` | The project's sessions: Needs you, Working, Done |
| `/projects/:projectId/sessions/:sessionId` | The session, beside the list on a desktop; on its own with Back on a phone |
| `/connections/requests` | The connection request page: your active grants, each with Stop |
| `/connections/requests/:proposalId` | One connection request to narrow, check the binding code, approve with a passkey or deny, beside your grants |
| `/vault`, `/vault/proposals/:proposalId`, `/vault/requests/:proposalId` | The old paths: the same pages, with the address replaced by the new one |
| `/audit` | The audit log: filter, follow a row to its connection request, export JSONL |
| `/schedules` | The organisation's schedules: a status filter, New schedule, and the open schedule beside the list |
| `/schedules/new` | The schedules page with the form for a new task or check open |
| `/schedules/:scheduleId` | One schedule: when it runs, what it runs, Edit, Pause or Resume, and its run history |
| `/sessions/:sessionId` | A session linked by its ID alone (a schedule's run): replaced by its project's path once that is read |
| `/projects/:projectId/sessions/:sessionId/files` | The session's workspace files: the tree, and the open file beside it |
| `/projects/:projectId/sessions/:sessionId/files/:path` | One file open, its whole path as one encoded segment (`notes%2Fplan.md`) |

The sidebar is `@kantel/ui`'s `Sidebar`: the projects, with the current one's sessions nested under it, then at its
foot the pages outside projects (Skills and Memory under Agent; Schedules, Connection requests, the audit log and API keys
under Organisation), each with an icon, and who is signed in. On one of those pages the last project you were in (or
the first) keeps its sessions open. Its button or Ctrl+B (⌘B) collapses it to a rail of icons, remembered in this
browser. The main area takes the rest of the width; only reading text (the transcript, notes, forms) keeps a
measure. On a phone each page fills the screen with *Back to sessions*, and there is no rail.

`?source=recorded` or `?source=api` picks the source for the tab (the default is `api`, or `VITE_KANTEL_SOURCE`).
`?profile=1` adds the render profiler, `?speed=2` plays recordings faster and `?delay=1500` waits longer before an
opened recording's live part plays.

## The client seam

Every screen talks to a host through `ConsoleClient` (`src/api/client.ts`): the actor, the projects, a project's
sessions followed live, one session's protocol transport (hello, a snapshot or the deltas after a cursor, history
pages), prompt, steer, follow-up and cancel, and the session's workspace (`workspace(sessionId)`), read-only. `SessionClient` (`src/state/session-client.ts`) keeps one session's
transcript over that transport, with connection health and data freshness tracked apart.

Two implementations:

- `createApiClient` (`src/api/http.ts`): the session API under `/v1` on the console's origin. A session's frames come
  over a WebSocket (`src/api/socket.ts`) or, where there is none, as server-sent events
  (`/v1/sessions/:id/events?after=<cursor>`); when the stream drops, `SessionClient`
  reconnects with backoff and resumes after the last cursor it applied. Prompt, steer, follow-up and abort are POSTs
  with a request id, so a retry sends once. A message or steer shows in the transcript the moment it is sent and the
  composer clears; the stream's copy, matched by its request id, takes its place (`src/state/outbox.ts`), and one
  that fails stays in place with Try again and Edit. While the agent runs, the composer's button steers and "Send after this
  run" queues a follow-up. Who is signed in comes from identity's `GET /v1/me`, and their projects from
  `GET /v1/projects`, by name, the most recently active first. The API has no list events, so a project's list is
  polled every 3 seconds. A session's
  files come from the workspace read API (`@kantel/workspace/read-api`, `/v1/workspaces/:id/files` and `/content`),
  for the `workspaceId` on the session's record; it has only GET routes and no way to a sandbox.
- `createRecordedClient` (`src/api/recorded.ts`): the catalogue in `src/recorded/catalogue.ts`, three projects and a
  session in every state the list shows, each served by an in-page stand-in for the session host
  (`src/server-sim/fixture-host.ts`). Recorded sessions can't be steered; the composer says so, and sign-in is a
  stubbed actor. Every recorded session but the weekly digest has the same stand-in workspace
  (`src/recorded/workspace.ts`), with a note, source, a log over the viewer's line cap, an image and a file over the
  read API's size limit.

The connection request page and the audit log have seams of their own beside it, `ConsoleVault` and `ConsoleAudit`
(`src/api/oversight.ts`); without one the console doesn't list its page. They follow the source:

- On `api`, `apiAudit` (`src/api/audit-http.ts`) reads the audit query API the gateway serves under `/v1/audit`,
  sending the organisation the view picks, if any, as `Kantel-Organisation`. The Who and Organisation filters, and
  people's names on rows, come from the identity API (`/v1/organisations`, `/v1/members`); a person it can't name is
  shown by ID. Without the gateway's connection approval API, the connection request page isn't listed.
- On `recorded`, `createRecordedOversight` (`src/recorded/oversight.ts`) serves both in the page: the `@kantel/ui`
  vault fixture's in-memory vault, with a proposal in every state, writing its audit trail into a store that already
  holds a month of generated history. Requests the vault holds link from the log; the history's don't. Each page
  load builds a fresh vault, so a request link only opens from within the page that showed it.

The schedules page has `ConsoleSchedules` (`src/api/oversight.ts`): a `SchedulesSource` from `@kantel/ui`, one call
per schedule route in the public API (`GET`/`POST /v1/schedules`, `GET`/`PATCH`/`DELETE /v1/schedules/{id}`,
`/pause`, `/resume`, `/preview`, `/runs`), with the agents and owner the form needs. On `recorded`,
`createRecordedSchedules` (`src/recorded/schedules.ts`) serves `@kantel/ui`'s schedule fixtures in the page, each
task run naming one of the recorded Kantel sessions so its *Open session* opens it. On `api`, `apiSchedules`
(`src/api/schedules-http.ts`) runs it on those routes through `@kantel/api`'s SDK. New schedule and Edit need a
project the person may operate in and an agent profile they can see; without either, the page reads, pauses and
resumes only.

## Checks

`pnpm --filter @kantel/console test` runs the console's tests, including the token and copy lint over its CSS and
TSX. `src/api/http.test.ts` runs the API client against the real session API handler over the in-memory runtime, with
a scripted model holding runs open: listing, unread, streaming, steer, follow-up, cancel, refusals and resuming after
a dropped stream. `node scripts/evidence.ts` gathers the long-session render and resume evidence against a running build.
`node scripts/oversight-check.ts <out-dir>`, after a build, runs axe over the vault, audit and schedules routes (a new schedule, a task's runs and a check
open) at 1280 px and
420 px (on `source=recorded`), checks each has one `h1` and one main landmark with no page errors, and saves screenshots.

## Files

Files in the session header opens the session's workspace: `FileTree` beside the file preview (`FilePreview`, the
same panel a session opens files in) on a desktop, the tree and then the file with Back on a phone. Directories are
listed when first opened, and a file is read when opened; the files either side of it are read ahead, so Previous and
Next (`j`, `k`) show theirs at once. An archive, or a file the listing says is over the read API's 16 MiB limit, is
shown as such without being read. `src/ui/files-model.ts` says what the preview has of a file, and
`src/ui/preview-cache.ts` keeps what was read while the screen is open. `src/api/workspace.test.ts` browses a whole workspace
through the real read API and session API, with every component auditing into one store, and checks the audit log
has no sandbox event, beside a control where acquiring a sandbox does leave one.
