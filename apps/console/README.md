# @harbour/console

Harbour's session interface (M1-FE1, issue #6): a project's sessions grouped by what they need from you, the live
session view with its transcript and composer, and a session's workspace files, read-only. Built from `@harbour/ui`; this app only decides what goes where.

```sh
pnpm --filter @harbour/cloudflare dev          # the gateway with the session API, on http://127.0.0.1:8787
pnpm --filter @harbour/console dev             # http://127.0.0.1:5173, on that gateway
pnpm --filter @harbour/console dev:recorded    # http://127.0.0.1:5173, on recorded sessions, no backend
```

`pnpm dev` forwards `/v1` to the gateway (`HARBOUR_GATEWAY`, default `http://127.0.0.1:8787`) and signs each call in
as the dev admin with a token from the gateway's mock Access issuer (`scripts/dev-gateway.ts`). Deployed, the gateway
serves the console itself, and Cloudflare Access signs the calls in.

## Routes

| Path | Shows |
| --- | --- |
| `/` | The first project |
| `/projects/:projectId` | The project's sessions: Needs you, Working, Done |
| `/projects/:projectId/sessions/:sessionId` | The session, beside the list on a desktop; on its own with Back on a phone |
| `/vault` | The vault page: your active grants, each with Stop |
| `/vault/requests/:proposalId` | One vault request to narrow, check the binding code, approve with a passkey or deny, beside your grants |
| `/audit` | The audit log: filter, follow a row to its vault request, export JSONL |
| `/projects/:projectId/sessions/:sessionId/files` | The session's workspace files: the tree, and the open file beside it |
| `/projects/:projectId/sessions/:sessionId/files/:path` | One file open, its whole path as one encoded segment (`notes%2Fplan.md`) |

The vault page and the audit log are the organisation's, so the sidebar lists them under Organisation and shows no
project's sessions beside them. On a phone each fills the screen with *Back to sessions*.

`?source=recorded` or `?source=api` picks the source for the tab (the default is `api`, or `VITE_HARBOUR_SOURCE`).
`?profile=1` adds the render profiler, `?speed=2` plays recordings faster and `?delay=1500` waits longer before an
opened recording's live part plays.

## The client seam

Every screen talks to a host through `ConsoleClient` (`src/api/client.ts`): the actor, the projects, a project's
sessions followed live, one session's protocol transport (hello, a snapshot or the deltas after a cursor, history
pages), prompt, steer, follow-up and cancel, and the session's workspace (`workspace(sessionId)`), read-only. `SessionClient` (`src/state/session-client.ts`) keeps one session's
transcript over that transport, with connection health and data freshness tracked apart.

Two implementations:

- `createApiClient` (`src/api/http.ts`): the session API under `/v1` on the console's origin. A session's frames come
  as server-sent events (`/v1/sessions/:id/events?after=<cursor>`); when the stream drops, `SessionClient`
  reconnects with backoff and resumes after the last cursor it applied. Prompt, steer, follow-up and abort are POSTs
  with a request id, so a retry sends once. While the agent runs, the composer's button steers and "Send after this
  run" queues a follow-up. The API has no projects list, no "who am I" and no list events yet, so the projects are
  the ones the caller's sessions are in, named by id, and a project's list is polled every 3 seconds. A session's
  files come from the workspace read API (`@harbour/workspace/read-api`, `/v1/workspaces/:id/files` and `/content`),
  for the `workspaceId` on the session's record; it has only GET routes and no way to a sandbox.
- `createRecordedClient` (`src/api/recorded.ts`): the catalogue in `src/recorded/catalogue.ts`, three projects and a
  session in every state the list shows, each served by an in-page stand-in for the session host
  (`src/server-sim/fixture-host.ts`). Recorded sessions can't be steered; the composer says so, and sign-in is a
  stubbed actor. Every recorded session but the weekly digest has the same stand-in workspace
  (`src/recorded/workspace.ts`), with a note, source, a log over the viewer's line cap, an image and a file over the
  read API's size limit.

The vault page and the audit log have seams of their own beside it, `ConsoleVault` and `ConsoleAudit`
(`src/api/oversight.ts`); without one the console doesn't list its page. They follow the source:

- On `api`, `apiAudit` (`src/api/audit-http.ts`) reads the audit query API (M1-BE8) the gateway serves under
  `/v1/audit`, sending the organisation the view picks, if any, as `Harbour-Organisation`. Without an identity API
  there are no organisation choices or names yet, so rows show ids. The gateway serves no approval API yet, so the
  vault page isn't listed.
- On `recorded`, `createRecordedOversight` (`src/recorded/oversight.ts`) serves both in the page: the `@harbour/ui`
  vault fixture's in-memory vault, with a proposal in every state, writing its audit trail into a store that already
  holds a month of generated history. Requests the vault holds link from the log; the history's don't. Each page
  load builds a fresh vault, so a request link only opens from within the page that showed it.

## Checks

`pnpm --filter @harbour/console test` runs the console's tests, including the token and copy lint over its CSS and
TSX. `src/api/http.test.ts` runs the API client against the real session API handler over the in-memory runtime, with
a scripted model holding runs open: listing, unread, streaming, steer, follow-up, cancel, refusals and resuming after
a dropped stream. `node scripts/evidence.ts` gathers the long-session render and resume evidence against a running build.
`node scripts/oversight-check.ts <out-dir>`, after a build, runs axe over the vault and audit routes at 1280 px and
420 px (on `source=recorded`), checks each has one `h1` and one main landmark with no page errors, and saves screenshots.

## Files

Files in the session header opens the session's workspace: `FileTree` beside `FileViewer` (or `NoteViewer` for
Markdown) on a desktop, the tree and then the file with Back on a phone. Directories are listed when first opened,
and a file is read when opened. A file whose name says it isn't text (an image, an archive), or that the listing says
is over the read API's 16 MiB limit, is shown as such without being read; bytes that aren't UTF-8 are shown as not
text. `src/ui/files-model.ts` decides which viewer and state. `src/api/workspace.test.ts` browses a whole workspace
through the real read API and session API, with every component auditing into one store, and checks the audit log
has no sandbox event, beside a control where acquiring a sandbox does leave one.
