---
title: Desktop and browser
description: Open a microVM's Linux desktop or its Chrome in your browser to watch or drive it, embed the live view in an iframe, and connect Playwright or Puppeteer to the sandbox's browser over CDP.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A microVM has a Linux desktop and a Chrome. You can open either in your own browser to watch an agent work or take over from it, and an agent can drive the sandbox's Chrome with Playwright or Puppeteer. Isolates have neither: the calls on this page answer `501` with `not_supported` for them.

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

Anyone holding the URL can open the desktop until it expires, so share it like a password. To show someone an agent at work in a viewer with no keyboard or mouse, give them a `viewOnly` one. On your own hosts the viewer is what holds back the input, not the desktop: someone who takes the URL apart can still type, so give a `viewOnly` URL only to people you'd trust with the other kind.

### Through the relay

On [your own hosts](/hosts/), the URL is a viewer page on the control plane's public address, such as `https://kantel.example.com/v1/hosts/view/<ticket>`, and `embedUrl` is the same page. The page opens a WebSocket back to the control plane with the same ticket, and the control plane relays the desktop over the connection the sandbox's host keeps open. The host and the sandbox need no open port, but the person opening the URL must be able to reach the control plane's public URL.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/desktop" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"viewOnly": true, "ttlMinutes": 15}' | jq -r .embedUrl
```

## Open the browser

The browser route starts the sandbox's Chrome if it isn't running, and answers two URLs: a live view, to watch and drive that Chrome from your own browser, and a Chrome DevTools Protocol (CDP) WebSocket URL for automation.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/browser" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{}' | jq '{url, cdpUrl}'
```

It takes the same `viewOnly` and `ttlMinutes` as the desktop, and its [BrowserAccess](/api/reference/types/#browseraccess) answer has `url`, `cdpUrl`, `viewOnly` and `expiresAt`.

On your own hosts Chrome runs on the sandbox's desktop from the start, so `url` is the desktop viewer, showing that Chrome. `cdpUrl` goes through the relay too: `wss://kantel.example.com/v1/hosts/tunnel/<ticket>/devtools/browser/<id>`, or `ws://` when the public URL is `http://`. While Chrome is still starting, the route answers `503` with `unavailable` (`The sandbox's browser isn't up yet`); try again a moment later.

## Drive it with Playwright

Connect Playwright to `cdpUrl`. The sandbox's Chrome already has a browser context, so use it rather than making a new one, and the live view shows what your script does:

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

`browser.close()` disconnects Playwright and leaves the sandbox's Chrome running. Puppeteer connects the same way, with `puppeteer.connect({ browserWSEndpoint: access.cdpUrl })`.

The CDP URL is as powerful as the browser itself: anyone holding it can read every page and cookie in that Chrome until it expires. Keep it inside the program that uses it.

## Apps in the sandbox

The sandbox's Chrome runs inside the sandbox, so it reaches a dev server there at `http://localhost:<port>` with no [public port](/sandboxes/public-ports/). Start the server as a detached command, then point Playwright at `localhost`.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:681-712, packages/api/src/compute-schema.ts:671-699. The relay and the CLI (5be456c): packages/hosts/src/backend.ts:204-222,414-441, packages/cli/src/commands.ts:1360-1395, apps/host/guest/README.md; run through a local host for TASK-4706 -->
