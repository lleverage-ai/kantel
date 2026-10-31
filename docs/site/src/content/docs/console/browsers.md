---
title: Browsers
description: Let an agent use a web browser, decide its requests, watch it live or replay it, and set up the browser your deployment needs.
---

An agent can use a web browser when its deployment has one. The agent asks first, and a person decides. You watch the browser from the session, live while the agent works and, where the deployment keeps recordings, as a replay afterwards. Every browser belongs to one session and ends when the session does.

## The browser tools

A session with a browser has five tools:

| Tool | What it does |
| --- | --- |
| `browser_request` | Asks a person for a browser, with a reason and the sites it needs. It waits up to 10 minutes for a decision. |
| `browser_open` | Opens a browser under the session's grant, optionally at a URL. |
| `browser_act` | Runs one step: `look`, `goto`, `click`, `fill`, `select`, `check`, `press`, `scroll` or `wait`. It returns the page as text. |
| `browser_screenshot` | Returns the page as an image to the model. |
| `browser_close` | Closes the browser. |

The agent never chooses which browser profile it gets, and it can't grant itself a browser. A step that would go to a site outside the grant is refused before the browser moves. A step that lands off the grant's sites, through a link or a redirect, sends the browser to `about:blank` and is refused.

After `browser_open` at a URL and after every `browser_act` except `look`, a screenshot goes to the transcript only, so you can see the page change without the model spending tokens on it. Tool results, the transcript and logs never carry the provider's key or the browser's CDP URL.

## Deciding a request

When the agent calls `browser_request`, a notice appears above the composer: "The agent asks for a browser on *sites*: *reason*". It has two buttons:

- **Allow** grants the sites the agent named, for 30 minutes.
- **Decline** refuses. The agent gets the answer and carries on.

Deciding needs the operator role on the session's project. The console sends your answer as `POST /v1/browser/decisions`. The grant uses a browser profile of the deployment's own, named `harbour`, which is never written back.

## Watching the browser

The transcript keeps one line per browsing run, such as "Browsing, 12 steps", and "Browsed for 48s, 12 steps" once it has finished. Open the line to see every step. Under it, a card shows the browser's page and its state:

| Card says | What it opens |
| --- | --- |
| **Live**, "Watch live" | the browser as it is now |
| **Replay**, "Watch the replay" | the recording of a closed browser |
| **Closed**, "Show the last page" | the last screenshot, when there is no recording |

The browser shows in a **Browser** panel beside the transcript. Its header says what the agent is doing now. The panel follows the browser the agent used last, and a session that used more than one browser has a tab for each. **Hide the browser** closes the panel.

The live view is marked **Watch only**: you can't take control of the agent's browser from it. The link is made for you when you open it (`POST /v1/browser/live`). You need only the viewer role on the session, and an agent can never get one. It lasts an hour at most and stops when the browser closes. Then the panel switches to the replay, with a play button over the last screenshot, or shows the last page.

A replay plays the browser's recorded frames, with the address bar and tabs following the page (`POST /v1/browser/replay`). Only Kantel's own browsers record. With brwsr there is no replay, and the panel shows the last screenshot.

## When the session ends

Closing, aborting or deleting a session closes its browsers and ends its grants. Grants and open browsers live in memory: a restart forgets them, and the provider ends each browser when its grant times out.

## Audit events

Browser activity is in the audit log:

- `browser.grant.created` and `browser.grant.refused` for grants;
- `browser.session.opened` and `browser.session.closed`;
- `browser.session.step` for each step, with the verb and the host it ended on, never a value typed or a whole URL;
- `browser.site.refused` when a step leaves the grant's sites;
- `browser.session.shared` for a live or replay link, and `browser.session.embedded` for an embed, never with the link;
- `browser.recording.stored` once a recording is complete, with counts only.

Each event about one browser has the subject `browser.session`. On a browser event's row, **This browser's history** narrows the log to that browser, from open to recording, and **Every browser** clears it. A browser event also links to its session at that browser (`#browser=<id>`), where the panel shows it. See [Audit](/console/audit/).

## Embedding a browser in another app

A host app can show a session's browser in its own page. `POST /v1/sessions/{sessionId}/browsers/{browserSessionId}/embed` takes a `mode` (`live` or `replay`) and `minutes` (5 to 60, default 15), and answers with a URL to put in an iframe. The caller needs viewer on the session, as an API key or a person, never an agent. A live embed is watch-only. The URL carries a token after `#` that grants that one view: treat it as a secret.

```ts
import { createKantelClient } from "@kantel/api/sdk";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });
const embed = await kantel.embedBrowserSession("SESSION_ID", "BROWSER_SESSION_ID", { mode: "live", minutes: 15 });
// embed.url goes in an iframe; embed.expiresAt says when it stops.
```

```bash
curl -s "$KANTEL_URL/v1/sessions/SESSION_ID/browsers/BROWSER_SESSION_ID/embed" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"mode":"replay"}'
```

A closed browser has no live view (`expired`). A deployment without recordings has no replay (`unavailable`), and a recording past its retention is `expired`. Only the console and the origins in `KANTEL_EMBED_ORIGINS` may frame the viewer page. On Cloudflare behind Access, an outside app needs an Access bypass for `/browser/*` and `/v1/browser/view/*`. The token is those paths' only auth. See the [API reference](/api/reference/).

## What a deployment needs

`KANTEL_BROWSER_PROVIDER` picks the provider (`harbour`, for Kantel's own, keeps its name from before the rename). Without what that provider needs, sessions have no browser tools, and the browser routes answer `unavailable`.

| Provider | Cloudflare | Self-hosted |
| --- | --- | --- |
| `brwsr` (brwsr.dev) | The default. Set the `KANTEL_BRWSR_API_KEY` Worker secret, a brwsr project key. No recordings. | Set `KANTEL_BRWSR_API_KEY`. |
| `harbour` (Kantel's own browsers) | Set `KANTEL_BROWSER_PROVIDER=harbour` and `KANTEL_BROWSER_VIEW_KEY` (32 characters or more). Turn on the browser containers with `KANTEL_BROWSER_CONTAINERS=on` and set `KANTEL_BROWSER_SEAL_KEY`, or point at a self-hosted browser host with `KANTEL_BROWSER_HOST_URL` and `KANTEL_BROWSER_HOST_TOKEN`. | Run the browser host (Docker, or one Pod per browser on Kubernetes) and set `KANTEL_BROWSER_HOST_URL`, `KANTEL_BROWSER_HOST_TOKEN` and `KANTEL_BROWSER_VIEW_KEY` to match it. |

On a self-hosted gateway with `KANTEL_BROWSER_PROVIDER` unset, the gateway uses `harbour` when a browser host is set, otherwise `brwsr` when its key is set, otherwise no browser.

Kantel's own browsers seal profiles and recordings with `KANTEL_BROWSER_SEAL_KEY`. They keep recordings for 7 days by default (`KANTEL_BROWSER_RECORDING_DAYS`). They decline cookie and consent dialogs themselves, clicking the dialog's "Reject all" (never an "Accept") before a step or a read returns the page; set `KANTEL_BROWSER_CONSENT=off` to leave those dialogs to the agent. See [Cloudflare](/deploy/cloudflare/) and [Self-hosted](/deploy/self-hosted/) for setting these.

<!-- Sources (8584d5b): apps/cloudflare/README.md:100-125, apps/cloudflare/src/browser.ts:1-120, apps/cloudflare/src/browser-object.ts:1-70, apps/cloudflare/src/gateway.ts:17-21,85-108,270-280,375-395, apps/cloudflare/src/route.ts:1-20, apps/cloudflare/scripts/deploy-config.ts:40-115, apps/cloudflare/wrangler.jsonc:40-52,95-100,120-163, apps/console/src/api/http.ts:813-858, apps/console/src/ui/actions.ts:122-138, apps/console/src/ui/session-view.tsx:395-445, apps/console/src/ui/session-browser.tsx:1-80, packages/ui/src/session/browser-entry.tsx:1-80, packages/ui/src/session/browser-panel.tsx:1-45, packages/ui/src/session/browsing-group.tsx:13-40, packages/ui/src/session/browser-live-view.tsx:130-290, packages/ui/src/audit/audit-view.tsx:175-270,520-535, packages/browser/CONTRACT.md:1-90, packages/browser/src/session.ts:1-130,370-380, packages/browser/src/http.ts:1-70, packages/browser/src/memory.ts:600-635,925-1050, packages/contracts/src/audit.ts:73-78, packages/api/generated/sdk.ts:132-140,600-605,2285-2292, docs/design/browser-runtime.md:60-130, apps/selfhosted/src/gateway/browser.ts:1-60, apps/selfhosted/src/gateway/gateway.ts:20-26, apps/selfhosted/src/browser/host.ts:10-25,240-280, deploy/kubernetes/browser-host/README.md:1-60 -->
