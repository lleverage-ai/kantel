# Browser runtime: Kantel runs its own browsers

Tom, 29 Oct 2026: browser execution is part of Kantel, so the whole platform runs self-hosted (Docker, Kubernetes)
or on Cloudflare without brwsr.dev. brwsr's execution layer (tvdavies/brwsr) comes over; the brwsr platform does not.
The broker and its contract (`packages/browser/CONTRACT.md`) stay as they are: this adds a provider and two hosts
under it, a live view and replay in the session, an embed API, and audit links.

## Shape

```
agent tools ─► broker (@kantel/browser, unchanged rules) ─► BrowserProvider
                                                              ├─ brwsr      (today: api.brwsr.dev, a project key)
                                                              └─ harbour    (new: @kantel/browser/runtime)
                                                                   │ coordinator protocol (HTTP + WebSocket)
                                                    ┌──────────────┴──────────────┐
                                     Cloudflare: one Durable Object      Self-hosted: browser host service
                                     per browser + a Container,          (Node, Docker today; Kubernetes:
                                     R2 for profiles and recordings      one Pod per browser), a blob store
                                                    └──────────────┬──────────────┘
                                                     browser image (images/browser): Chromium + the agent
```

`KANTEL_BROWSER_PROVIDER` picks `brwsr` (the default while this matures) or `harbour`, per deployment. Nothing else
changes for a session: same tools, same grants, same teardown.

## The browser image (`images/browser`)

brwsr's `container/` copied, with a header in each file naming its origin (tvdavies/brwsr at 0d22bf8): Debian
Chromium and Chrome for Testing's headless shell, fonts, a prebuilt profile template, and the Node agent on `:8080`.
Every call but `GET /health` needs the per-start agent token (`x-harbour-agent-token`), so a page in the browser can't
drive its own agent. What Kantel uses of the agent: `start`, `stop`, `health`, `screenshot`, Reflex `act`/`look`
(model-free steps), `PUT /profile` and `POST /export` (stored contexts), `domains` (the grant's sites enforced inside
the browser, which `checkSite` alone never was), the `recording/*` endpoints, and the `/cdp` and `/live` sockets.

## Goal mode (`browser_run`, experimental)

Reflex's goal loop (`/reflex/run`), offered as `browser_run {goal, data?, stopBefore?, url?}` beside the step
tools, to sessions of a project with goal mode on. A System One decision model picks each step in about a second; the
session's model is asked again only when the run ends or hands back with its best guesses. Kantel adds no prompt for
it: the tool's description is all a model is told.

- **The switch.** Each project's settings (`GET`/`PATCH /v1/projects/{id}/settings`, admin to change):
  `browserGoalMode` `on`/`off` and `browserDecisionModel` `clef`/`jev`, each falling back to the platform's default
  (`KANTEL_BROWSER_GOAL_MODE`, default `off`; `KANTEL_BROWSER_DECISION_MODEL`, default `clef`). Read as each
  session's tools install, so a change applies to the project's next sessions.
- **The model stays out of the container.** The coordinator gives Reflex a decision endpoint
  (`keys.endpoint`, tvdavies/brwsr#90) and a per-start decision token, never a key. On Cloudflare, `KantelBrowser`
  intercepts its own container's requests to `192.0.2.10:80` (`interceptOutboundHttp`) and routes them to the
  `KantelBrowserDecisions` entrypoint with that token in its props; it answers Clef through the Worker's Workers AI
  binding (`AI`, no key) and Jev with the `KANTEL_JEV_API_KEY` secret. A request without the token is refused, so a
  page that finds the address can't spend the model. Self-hosted has no decisions host yet, so `browser_run` is
  `unavailable` there.
- **Sites.** The agent's own guard keeps the run on the grant's sites; the broker refuses a `url` off them and a run
  that ends off them, as it does a step. Reflex's loop never fills payment fields or presses a final pay button.

## The coordinator (one per browser)

`@kantel/browser/runtime` holds the portable part, written once and run by both hosts: start a browser (restore the
context's profile, set the grant's sites, start recording), run steps and screenshots, proxy the live and CDP sockets,
move closed recording chunks into the blob store as they appear, and on release export the profile (persisting grants
only), drain the recording and stop the container. It is the part of brwsr's `src/session-do.ts` Kantel needs, without
warm pools, billing, vault fills or Browserbase's session API.

Hosts provide two things: a way to run the image (`BrowserMachine`: start with env, fetch the agent, stop) and a
`BlobStore` (get, put, list, delete by key).

- **Cloudflare**: `KantelBrowser`, a Durable Object class with a Container, one per browser (`idFromName` of the
  provider session ID), created with `KANTEL_LOCATION_HINT` (weur). Profiles and recordings go to an R2 bucket made in
  weur. The DO's alarm enforces the browser's timeout even if the stack object forgets it.
- **Self-hosted**: `apps/selfhosted` gains a browser host service. It runs one container per browser through the Docker
  API (labels and a janitor like the sandbox's; runc by default, runsc where configured), publishes nothing but the
  agent port to the host network it shares with the gateway, and keeps blobs in S3/MinIO like workspaces (a directory
  when there's no S3). On Kubernetes the same service creates a Pod per browser instead of a container
  (`KANTEL_BROWSER_DRIVER=kubernetes`; `deploy/kubernetes/browser-host` has its Deployment, a Role for Pods and
  Secrets, and NetworkPolicies). A gateway that isn't
  self-hosted (the Cloudflare app under `wrangler dev`) can use it too, over `KANTEL_BROWSER_HOST_URL` with a bearer
  token, which is how the console runs against local Docker browsers.

The provider talks to either host through one client (`BrowserHostClient.fetch(browserId, path, init)`): a DO stub on
Cloudflare, HTTP with the host token self-hosted. So one provider, one protocol, two hosts.

## Profiles (contexts)

A context's profile is a tarball in the blob store under `contexts/<providerContextId>`, sealed with AES-GCM under
`KANTEL_BROWSER_SEAL_KEY` (a secret, which seals recordings too) before it leaves the coordinator, so a bucket alone
gives no cookies. A
persisting grant writes it back on release; anything else only reads it. The broker's one-persisting-browser-per-context
rule is unchanged.

## Live view

`share()` on the harbour provider returns a Kantel URL, not a brwsr one: `/browser/<browserSessionId>#<token>`, a
console route that needs no sign-in and shows only the browser. The token stays in the fragment, which a browser never
sends, so it never lands in a request path or an access log; the page sends it as `Authorization: Bearer`, or for the
live socket as a WebSocket subprotocol. The page is the console's viewer (`apps/console/src/viewer/`): brwsr's
`web/live.js` canvas and frame protocol, ported, and a replay player. Its socket goes
`/v1/browser/view/<browserSessionId>/live` → host → coordinator → the agent's `/live` (JPEG frames out; input in only
when the token allows control; a watch-only socket forwards only frame acknowledgements and canvas sizes). The console's inline view from #233 (`BrowserLiveView`) stays the one component: it iframes
whatever link the provider gives, so it works for brwsr and harbour alike, and the viewer posts the same
`browserbase-disconnected` message when the browser goes.

## Recording and replay

brwsr's decided approach (Browserbase's): the recorder in the container screencasts each page and keeps a frame only
when Chrome draws something new, appending JPEGs with their real timestamps to Matroska chunks; nothing is encoded in
the browser container. The coordinator moves each closed chunk to the blob store under
`recordings/<browserSessionId>/<page>/<chunk>.mkv` with a small manifest. Each page in the manifest also keeps its
navigations (`{ atMs, url, title }` by the page's own clock, from `Target.targetInfoChanged`, at most 200), so the
replay's address bar and tabs follow the page as it plays; recordings made before this have none and show no address.

Replay in the session plays those frames directly: the viewer reads the chunks (`/v1/browser/view/<browserSessionId>/…`,
with the token as a bearer header) and draws each JPEG at its time on
a canvas (seek, speed, tabs), so watching costs no encoding at all. An MP4 download is the only thing that encodes, on
demand, in brwsr's encoder image run beside the browser host (later; not needed to watch). Retention is short: 7 days
by default (`KANTEL_BROWSER_RECORDING_DAYS`), an R2 lifecycle rule on Cloudflare and the host's janitor self-hosted.
After that a replay link is `gone` and the audit trail still says what happened.

In the console, once a browser closes its view switches from live to replay (when there is a recording) in the same
`BrowserLiveView` slot, with *Play* over the last screenshot.

## Embed API (for apps such as Lleverage)

`POST /v1/sessions/{sessionId}/browsers/{browserSessionId}/embed` with `{ mode: "live" | "replay", minutes? }` answers
`{ url, mode, expiresAt }`. It's in `@kantel/api` like every public route, served by `@kantel/browser/http`. The
caller needs viewer on the session (a host app's API key, or a person; never an agent). The URL is the same
`/browser/<browserSessionId>#<token>` page, absolute, for an iframe; the token says live or replay:

- The token is an HMAC-SHA256-signed claim (`KANTEL_BROWSER_VIEW_KEY`) naming the organisation, session, browser
  session, mode, control (always off for embeds) and expiry: 5 to 60 minutes, default 15. It grants that one view and
  nothing else; it is not an API credential.
- A live socket is closed when its token expires; a revoked grant or ended session closes it too (the browser goes).
- Pages are `no-store`, `no-referrer`, and framed only by origins in `KANTEL_EMBED_ORIGINS` (`frame-ancestors`).
- Issuing is audited (`browser.session.embedded` with mode and expiry), never with the token or URL. Tokens never go
  into tool results, transcripts or logs.

On Cloudflare behind Access, `/browser/*` and `/v1/browser/view/*` need an Access bypass for an outside app to frame
them; the token is their auth. That's a deployment setting for Tom (the console works without it).

## Audit links

Browser events already carry `subject: { kind: "browser.session", id }`. Added:

- `browser.session.step` for each step (the verb and the page's host, never a value typed), `browser.session.run` for
  each goal run (its status, step count, model and the host it ended on, never the goal), and
  `browser.recording.stored` when the recording is complete, so steps, sites, refusals and the recording sit beside
  grants, opens, shares and closes.
- The audit view links a browser event to its session at that browser (`/sessions/<id>#browser=<browserSessionId>`,
  beside the existing `#turn=`), where the transcript scrolls to the browser and offers its replay, and a row's
  *This browser's history* filters by subject to one browser's whole history: open, steps, refusals, shares and
  embeds, close, recording. The request and grant before it keep their own subjects (`browser.request`,
  `browser.grant`) and show under the session's filter.

## Not ported

brwsr's dashboard, billing and usage, Browserbase API parity (`/v1/sessions` and friends), Stagehand and Playground,
the warm pool, CAPTCHA solving, vault credential fills inside the browser (Kantel's vault owns credentials), CLI
tunnels and proxies, extensions and downloads. Each can come later behind the same coordinator if needed.

## Order of work

1. This note.
2. The image, the coordinator and the harbour provider, with the self-hosted Docker host; the console's live view and
   replay against local Docker browsers (screenshots on the PR).
3. Cloudflare: the `KantelBrowser` Container DO and R2 in weur, deployed behind the switch.
4. The embed route and tokens, then the audit events, links and filter.
