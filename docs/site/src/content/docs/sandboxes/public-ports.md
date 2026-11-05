---
title: Public ports
description: Give a port in a sandbox an HTTPS URL, to open a dev server, preview or API running inside it, with or without a token, and hide it again.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

An app listening on a port inside a sandbox can get an HTTPS URL, so you, a reviewer or a test runner can open it from anywhere. The sandbox has no address of its own: the control plane answers the URL and passes each request, WebSockets included, to the port through its host's tunnel, so neither the sandbox nor the host needs an open port. On your own hosts this needs a [domain for ports](/self-hosting/install/#run-sandboxes-on-your-own-linux-hosts).

The examples use `KANTEL_URL`, `KANTEL_API_KEY` and the `kantel` client set up in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). The key needs `access`. A sandbox can expose ports when its `capabilities.ports` is `true`.

## Expose a port

Start the app first, listening on the port. Both `0.0.0.0` and `localhost` work. A dev server is best run as a [detached command](/sandboxes/commands-and-files/#long-commands-and-servers). Then expose the port:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ports" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"port": 3000}' | jq -r .url
```

```ts
const { url } = await kantel.exposePort("sbx_4kq9x2mt", { port: 3000 });
console.log(url);
```

The answer is an [ExposedPort](/api/reference/types/#exposedport) with the URL. Its host name is the port and the sandbox's `subdomain` under the deployment's ports domain: `kantel.run` on Kantel's hosted service, as in `https://3000-brave-otter-ab12cd.kantel.run`, or the domain you set on your own install. Exposing a port that's already exposed answers the URL it has. On the hosted service, ports are served for sandboxes on [your own hosts](/own-hosts/) (microVMs), WebSockets included, such as a dev server's hot reload; a request's body is at most 4 MiB (`413` past it).

Every port name under one ports domain is the same site to browsers unless the domain is on the Public Suffix List, and `kantel.run` isn't. So a page one sandbox serves can set cookies another sandbox's pages receive: don't rely on your app's own cookies being private between sandboxes. Kantel's token cookie is protected from that: another sandbox's page can't use it, plant it or shadow it ([the port's own cookie](/self-hosting/security/#the-ports-own-cookie)). [Security model](/self-hosting/security/#the-ports-domain) has the details.

`kantel.run` is a separate registrable domain from the hosted console's (`app.kantel.dev`), so a port's page is never the same site as the console. On your own install, a ports domain under the console's registrable domain would be. Either way, the console doesn't depend on cookies or `SameSite` to stay safe: its session is never a cookie, and it refuses a browser's changes from any origin but its own ([the console and the ports domain](/self-hosting/security/#the-console-and-the-ports-domain)).

## Tokens and public URLs

By default the URL carries a token (`?_token=...`), and anyone holding the whole URL can open it. Treat it like a password: share it only with people who should see the app. A request without the token is refused with `401` and never reaches the sandbox.

Opening the URL in a browser trades the token for a cookie on that one host name and takes it out of the address bar, so the app's own links and requests work. A script or test runner can send the token in the query each time, or as the `__Host-kantel_port` cookie (`kantel_port` on an install served over plain http). Kantel takes the token and its cookie off before the request reaches the app.

The cookie works for the app's own pages, for a link followed to it, and for the same sandbox's other ports: a frontend on port 5173 can call its API on port 8080, `fetch` and WebSockets included, once 8080's URL has been opened in that browser. A page on another sandbox's port, or on any other site, can't use it; its requests get `401` as if they had no cookie. To frame one port in another, put the token in the frame's URL: the frame is served directly, without trading the token for the cookie. The cookie was called `_kantel_port` before and that name is no longer read: open the URL with its token again.

A token-gated port's answers go out with `Cache-Control: private, no-cache`, whatever the app sets, so the browser checks with Kantel before reusing anything it cached; an `ETag` or `Last-Modified` still saves downloading it again. A public port keeps the app's own caching.

To end a token, hide the port: exposing it afterwards gives it a new one. Stopping or deleting the sandbox ends its ports too.

To let anyone open it with no token, such as a preview you want to post in a pull request, expose it with `public`:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ports" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"port": 3000, "public": true}'
```

## List and hide ports

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ports" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {port, url, public}'
```

Hiding a port stops its URL working at once:

```sh
curl -s -X DELETE "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/ports/3000" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

```ts
await kantel.hidePort("sbx_4kq9x2mt", "3000");
```

## Dev servers that check the host name

Some dev servers refuse a request whose `Host` header isn't one they know, and show an error such as "host not allowed" at the URL. Tell the server to accept the sandbox's domain, or any host. With Vite, set `server.allowedHosts` in `vite.config.ts`:

```ts
export default { server: { host: "0.0.0.0", allowedHosts: true } };
```

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:622-663, packages/api/src/compute-schema.ts:298-311, packages/api/src/compute-schema.ts:615-642 -->
