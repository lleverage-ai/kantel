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

Anyone holding the URL can open the desktop until it expires, so share it like a password. To show someone an agent at work in a viewer with no keyboard or mouse, give them a `viewOnly` one. On Kantel's own hosts the viewer is what holds back the input, not the desktop: someone who takes the URL apart can still type, so give a `viewOnly` URL only to people you'd trust with the other kind.

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

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:681-712, packages/api/src/compute-schema.ts:671-699 -->
