---
title: Desktop and browser
description: Open a microVM's Linux desktop or its Chromium in your browser to watch or drive it, embed the live view in an iframe, and connect Playwright or Puppeteer to the sandbox's browser over CDP.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A microVM has a Linux desktop and a Chromium browser. You can open either in your own browser to watch an agent work or take over from it, and an agent can drive the sandbox's Chromium with Playwright or Puppeteer. Isolates have neither: the calls on this page answer `501` with `not_supported` for them.

The examples use `KANTEL_URL`, `KANTEL_API_KEY` and the `kantel` client set up in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). The key needs `access`.

From a terminal, the [`kantel` command](/tools/cli/) asks for the URLs and opens them:

```sh
kantel desktop sbx_4kq9x2mt                      # open the desktop in your browser
kantel desktop sbx_4kq9x2mt --view-only --print  # print a watch-only URL instead
kantel browser sbx_4kq9x2mt --ttl 30             # open the live view; print it and the CDP URL
```

Both take `--view-only`, `--ttl <minutes>` (default 10, at most 60) and `--print`, which prints the URL without opening it. Without a terminal, as when an agent runs them, they only print.

## Open the desktop

Ask for a desktop URL, then open it in a browser:

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/desktop" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{}' | jq -r .url
```

```ts
const desktop = await kantel.openDesktop("sbx_4kq9x2mt", { ttlMinutes: 30 });
console.log(desktop.url);
```

The answer is a [DesktopAccess](/api/reference/types/#desktopaccess):

| Field | What it is |
| --- | --- |
| `url` | Opens the desktop in a browser tab |
| `embedUrl` | The same desktop, for an `<iframe>` in your own app |
| `viewOnly` | Whether the viewer can only watch |
| `expiresAt` | When the URL stops working, as epoch milliseconds |

The body takes two optional fields: `ttlMinutes`, how long the URL can be opened for (default 10, at most 60), and `viewOnly`, to give a URL whose viewer only watches. A desktop opened in time stays open after the URL expires; open it again, after a reload for instance, and you need a new URL, so ask for one each time you show it.

Anyone holding the URL can open the desktop until it expires, so share it like a password. To show someone an agent at work without letting them touch it, give them a `viewOnly` one.

### View-only

On [your own hosts](/hosts/), view-only is enforced by the control plane, not by the page. The mode is part of the URL's signed ticket, so changing the URL to drive the desktop breaks the signature and the control plane refuses it. For a view-only URL, the control plane opens the desktop stream as a viewer and passes on only the messages a viewer needs to watch: start and stop the video, ask for a keyframe and send display settings. It drops everything else before it reaches the sandbox: keys, the mouse, the clipboard, file uploads, resizes and commands. That holds whatever the page or a modified client sends.

A view-only viewer still sees everything on the screen, so share it only with people who may see the sandbox.

### Through the relay

On your own hosts, the desktop is [Selkies](https://github.com/selkies-project/selkies), which streams the screen as H.264 over a WebSocket. The URL is a page on the control plane's public address:

```text
https://kantel.example.com/v1/hosts/desktop/<ticket>/          drive the desktop
https://kantel.example.com/v1/hosts/desktop/<ticket>/#shared   view-only
```

The `#shared` fragment only tells Selkies' page to show its viewer layout. View-only comes from the ticket, so taking the fragment off a view-only URL lets nobody drive the desktop.

`embedUrl` is the same page. The page opens a WebSocket back to the control plane at `/v1/hosts/desktop/<ticket>/api/websockets`, and the control plane relays it over the connection the sandbox's host keeps open to the sandbox's port 6080. The host and the sandbox need no open port, but the person opening the URL must be able to reach the control plane's public URL.

The page and its scripts are Selkies' own web client, from the version in Kantel's sandbox image. The control plane serves only those files, and checks each one against the hash it knows before serving it, so a sandbox can't change the page you are shown. Nothing else on port 6080, such as Selkies' file transfer, is reachable through the URL.

The stream is CPU-encoded H.264 at about 30 frames a second at 1080p, with about 100 ms from a key press to the screen. It uses about one core while the screen changes.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/desktop" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"viewOnly": true, "ttlMinutes": 15}' | jq -r .embedUrl
```

## Open the browser

The browser route starts the sandbox's Chromium if it isn't running, and answers two URLs: a live view, to watch and drive that Chromium from your own browser, and a Chrome DevTools Protocol (CDP) WebSocket URL for automation.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/browser" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{}' | jq '{url, cdpUrl}'
```

It takes the same `viewOnly` and `ttlMinutes` as the desktop, and its [BrowserAccess](/api/reference/types/#browseraccess) answer has `url`, `embedUrl`, `cdpUrl`, `surface`, `viewOnly` and `expiresAt`.

### The browser alone

On your own hosts, Kantel's image runs Chromium on a display of its own, apart from the desktop, with a second Selkies stream of just that display. `url` shows the browser alone, with no desktop around it, and `surface` is `browser`. The page is the same Selkies client as the desktop's at the same path, `/v1/hosts/desktop/<ticket>/`, but its ticket is for the browser's stream (the sandbox's port 6081) rather than the desktop's, so each view has its own URL and ticket and neither opens the other. View-only works as it does for the desktop.

The browser's display takes the size of the window that shows it, and Chromium fills it. Its stream runs only while someone watches: the sandbox starts it when the first viewer connects, which adds a few seconds to that first page load, and stops it once nobody has been connected for five minutes, so a sandbox nobody watches spends nothing on encoding the browser. Chromium itself keeps running for CDP either way.

A sandbox's `capabilities.browserSurface` says whether its image has a browser surface. An image without one, such as an image from before it or one that puts Chromium back on the desktop, answers `surface: "desktop"`, and `url` is the desktop page with that Chromium on it. The browser surface is experimental.

`cdpUrl` goes through the relay too: `wss://kantel.example.com/v1/hosts/tunnel/<ticket>/devtools/browser/<id>`, or `ws://` when the public URL is `http://`. While Chromium is still starting, the route answers `503` with `unavailable` (`The sandbox's browser isn't up yet`); try again a moment later.

## Drive it with Playwright

Connect Playwright to `cdpUrl`. The sandbox's Chromium already has a browser context, so use it rather than making a new one, and the live view shows what your script does:

```ts
import { chromium } from "playwright";
import { createKantelClient } from "./kantel-sdk.ts";

const kantel = createKantelClient({ baseUrl: `${process.env.KANTEL_URL}/v1`, token: process.env.KANTEL_API_KEY });
const access = await kantel.openBrowser("sbx_4kq9x2mt", { ttlMinutes: 30 });
console.log("Watch it at", access.url);

const browser = await chromium.connectOverCDP(access.cdpUrl);
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

`browser.close()` disconnects Playwright and leaves the sandbox's Chromium running. Puppeteer connects the same way, with `puppeteer.connect({ browserWSEndpoint: access.cdpUrl })`.

The CDP URL is as powerful as the browser itself: anyone holding it can read every page and cookie in that Chromium until it expires. Keep it inside the program that uses it.

## Apps in the sandbox

The sandbox's Chromium runs inside the sandbox, so it reaches a dev server there at `http://localhost:<port>` with no [public port](/sandboxes/public-ports/). Start the server as a detached command, then point Playwright at `localhost`.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:681-712, packages/api/src/compute-schema.ts:671-699. The relay and the CLI (5be456c): packages/hosts/src/backend.ts:204-222,414-441, packages/cli/src/commands.ts:1360-1395, apps/host/guest/README.md; run through a local host for TASK-4706. Selkies through the relay and view-only (TASK-4738): packages/hosts/src/desktop.ts, packages/hosts/src/tunnel.ts -->
