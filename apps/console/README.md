# @harbour/console

Harbour's session interface (M1-FE1, issue #6): a project's sessions grouped by what they need from you, and the live
session view with its transcript and composer. Built from `@harbour/ui`; this app only decides what goes where.

```sh
pnpm --filter @harbour/console dev    # http://127.0.0.1:5173
```

## Routes

| Path | Shows |
| --- | --- |
| `/` | The first project |
| `/projects/:projectId` | The project's sessions: Needs you, Working, Done |
| `/projects/:projectId/sessions/:sessionId` | The session, beside the list on a desktop; on its own with Back on a phone |

`?profile=1` adds the render profiler, `?speed=2` plays recordings faster and `?delay=1500` waits longer before an
opened recording's live part plays.

## The client seam

Every screen talks to a host through `ConsoleClient` (`src/api/client.ts`): the actor, the projects, a project's
sessions followed live, one session's protocol transport (hello, a snapshot or the deltas after a cursor, history
pages), and prompt, steer, follow-up and cancel. `SessionClient` (`src/state/session-client.ts`) keeps one session's
transcript over that transport, with connection health and data freshness tracked apart.

Until the session API (M1-BE1) lands, `createRecordedClient` (`src/api/recorded.ts`) serves the catalogue in
`src/recorded/catalogue.ts`: three projects and a session in every state the list shows, each served by an in-page
stand-in for the session host (`src/server-sim/fixture-host.ts`). Recorded sessions can't be steered; the composer
says so. Sign-in is a stubbed actor until identity (M1-BE7).

## Checks

`pnpm --filter @harbour/console test` runs the console's tests, including the token and copy lint over its CSS and
TSX. `node scripts/evidence.ts` gathers the long-session render and resume evidence against a running build.
