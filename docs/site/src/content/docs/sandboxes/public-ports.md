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

The answer is an [ExposedPort](/api/reference/types/#exposedport) with the URL. Its host name is the port and the sandbox's `subdomain` under the deployment's ports domain: `ports.kantel.dev` on Kantel's hosted service, as in `https://3000-brave-otter-ab12cd.ports.kantel.dev`, or the domain you set on your own install. Exposing a port that's already exposed answers the URL it has.

Every port name under one ports domain is the same site to browsers until the domain is on the Public Suffix List, and `ports.kantel.dev` isn't yet. So a page one sandbox serves can set cookies another sandbox's pages receive: don't rely on cookies being private between sandboxes. [Security model](/self-hosting/security/#the-ports-domain) has the details.

## Tokens and public URLs

By default the URL carries a token (`?_token=...`), and anyone holding the whole URL can open it. Treat it like a password: share it only with people who should see the app. A request without the token is refused with `401` and never reaches the sandbox.

Opening the URL in a browser trades the token for a cookie on that one host name and takes it out of the address bar, so the app's own links and requests work. A script or test runner can send the token in the query each time, or as the `_kantel_port` cookie. Kantel takes the token and its cookie off before the request reaches the app.

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
