---
title: Security model
description: What can reach a sandbox, what a desktop, SSH or port URL grants and for how long, how revoking access ends sessions already open, and what several gateways trust in each other.
---

This page is the threat model for the control plane's relay: the gateway that carries desktops, browsers, SSH and exposed ports to sandboxes on your hosts. It says what each part protects against and what it assumes.

## Nothing reaches a sandbox directly

A sandbox has no address anyone can reach. Its host dials out to the control plane over one WebSocket, and every connection to a sandbox (a desktop, Chromium's DevTools, SSH, an exposed port) goes through the gateway and down that WebSocket. Sandboxes have no route to each other, your network or the host; the host's firewall and proxy enforce that, and the [egress rules](/sandboxes/egress-proxy/) decide what they may reach outside.

## URLs are bearer grants, kept as hashes

`openDesktop`, `openBrowser` and `openSsh` answer URLs carrying a ticket, `{id}.{secret}`. Exposing a port without `public` answers a URL with a token. Anyone holding one of these URLs can use it, as with any share link, so treat them like passwords.

| Threat | What stops it |
| --- | --- |
| Guessing or altering a URL | The secret half is 256 random bits. The gateway looks the ticket up by its ID and compares the secret's SHA-256 in constant time. A wrong or altered secret, another ticket's ID or a malformed ticket is refused with close code `4003` before any sandbox is touched |
| Reading the database | It holds only the SHA-256 of each ticket's secret and each port's token, never the secret itself, so a copy of the database opens nothing |
| A stale URL | A ticket may start a connection for 10 minutes by default and 60 at most. Hiding a port, stopping or deleting its sandbox, or exposing it again ends its token |
| A view-only desktop link used to drive | The mode is in the ticket's row, not its URL. A view-only ticket opens Selkies as a viewer, and the gateway drops every message but the few a viewer needs. A desktop ticket opens only the desktop's route, never a raw tunnel to the port |
| A sandbox's page attacking the console | Ports are served on their own domain, which can't be the console's or a parent of it. The token and its cookie are taken off before a request reaches the sandbox. The console's session is never a cookie, and a browser's write from any other origin is refused: see [the console and the ports domain](#the-console-and-the-ports-domain) |
| A sandbox's page attacking another sandbox's | See [the ports domain](#the-ports-domain) |

## Revoking access ends open sessions

Every URL records who it was given to: the API key, or the person and their sign-in. Every relayed session that is open (a desktop stream, a CDP or SSH connection, an exposed port's WebSocket) is checked again every 2 seconds, and every new connection and port request is checked before it starts (with an answer at most 1 second old). Access ends, and an open session is closed with code `4003` ("Access to this sandbox was revoked"), when:

- the API key is revoked or expires
- the person signs out, or their sign-in ends
- they are removed from the organisation, or can no longer see the sandbox
- the sandbox is deleted

The check reads the shared database, so revoking on any gateway ends sessions on every gateway within about 2 seconds, with no message between them. If the check can't be answered (the database is unreachable), the relay refuses: access never outlives a revocation it couldn't check.

## How a WebSocket is refused

The gateway never answers a WebSocket upgrade with an HTTP error status, because Bun, which the gateway's image runs on, drops one. It completes the handshake and closes at once, before reading anything the client sends, so nothing reaches a sandbox. The close code says why:

| Code | Meaning |
| --- | --- |
| `4003` | A ticket, host credential or session that is wrong, expired or revoked |
| `4401` | An exposed port's name without its token (as HTTP `401`) |
| `4403` | An exposed port whose owner no longer has access (as HTTP `403`) |
| `4404` | Nothing upgrades at this path, or an unsigned stream between gateways (as HTTP `404`) |
| `4502` | The gateway couldn't check the request, so it refused it (as HTTP `502`) |

A plain request to an exposed port still gets the HTTP status.

## The ports domain

Each exposed port has its own name under the ports domain (`KANTEL_COMPUTE_PORTS_DOMAIN`), such as `3000-brave-otter-ab12cd.kantel-ports.example`, and its token cookie is set on that one name only. Browsers still treat every name under one registrable domain as the same site: a page one sandbox serves can set a cookie for the whole domain, which other sandboxes' pages then receive, and a sandbox's page is same-site with another's for `SameSite` cookies.

Give ports a domain or subdomain nothing else uses. Kantel's hosted service uses `ports.kantel.dev`, apart from its console. On your own install, set your own with `KANTEL_COMPUTE_PORTS_DOMAIN`, such as `ports.example.com`.

To make each name its own site, as GitHub does for `github.io`, the ports domain must also be on the [Public Suffix List](https://publicsuffix.org/submit/). The list asks for a project with thousands of users and more than two years left on the domain's registration. `ports.kantel.dev` isn't on it yet: its listing is deferred until hosted ports are served and in use. Until a browser ships a list with your ports domain on it, `ports.kantel.dev` included, cookies aren't private between sandboxes, so keep apps in sandboxes from relying on that.

## The console and the ports domain

While the ports domain isn't on the Public Suffix List, a port's page is also the same site as a console under the same registrable domain: `ports.kantel.dev` and `app.kantel.dev` are both `kantel.dev` to a browser. Such a page can set a cookie with `Domain=kantel.dev`, which the console's origin then receives, and its requests to the console are same-site, so `SameSite` doesn't stop them. Neither gateway relies on cookies or `SameSite` for this:

| Threat | What stops it |
| --- | --- |
| A cookie planted for the whole domain, as a session | Kantel's session (`kts_…`) is never a cookie. The console keeps it in the page's own storage, which no other origin can read, and sends it as a bearer in `Authorization`. Neither gateway reads a session from any cookie, whatever its name, so a planted one signs nobody in |
| A cookie planted to shadow one of the console's | Any cookie the console's origin sets for itself is a `__Host-` cookie over HTTPS: `Secure`, `Path=/` and no `Domain`. A browser won't let another name set one, and the console reads only the prefixed name. Over plain http on a laptop, where browsers refuse `__Host-`, it has no prefix |
| A page elsewhere, a port's included, making the console's browser change something | Every request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`) and has no `Authorization` header must come from the console's own origin: `Origin` must be exactly the console's (the address the request came to, the same host over HTTPS, or `KANTEL_PUBLIC_URL`), and `Sec-Fetch-Site`, when the browser sends it, must be `same-origin`. One with a cookie and no `Origin` is refused too. Anything else gets `403`. This covers the API, the sign-in routes and approving a device on the console's device page (`/device`, once `/compute/device`). It matters most behind Cloudflare Access, whose cookie signs a browser in by itself |
| A port's page reading the console's data | The gateway sends no CORS headers, so a page on another origin can't read an answer or send a bearer it doesn't have |

An API key or a session sent as a bearer (the CLI, the SDK, MCP, the console signed in with an email code) is something no other page can attach, so those requests pass as before, with or without an `Origin`. So does a request with neither a cookie nor an `Origin`, such as `kantel login` starting a device sign-in: it carries no one's credential.

Two things are still open before Kantel's hosted service serves ports under `ports.kantel.dev`:

- **A site of their own.** Either `ports.kantel.dev` goes on the Public Suffix List, or hosted ports move to a registrable domain that isn't the console's. Until then a port's page can still set cookies the console's origin receives (and ignores), and sandboxes' cookies aren't private from each other. Don't put Cloudflare Access in front of a console on the same registrable domain as its ports: a port's page could plant its own Access cookie there.
- **A certificate for every port name.** Port names are two levels under `kantel.dev` (`3000-brave-otter-ab12cd.ports.kantel.dev`), so they need a wildcard certificate for `*.ports.kantel.dev`. Cloudflare's free Universal SSL covers only the first level under a zone; deeper names need Advanced Certificate Manager (Total TLS or an advanced certificate) or an uploaded certificate.

On your own install, the simplest choice is a ports domain that is a registrable domain of its own, such as `kantel-ports.example`, not a sibling of the console's name.

## Several gateways

With a database, any number of gateways may run behind one load balancer. They share every record: tickets, exposed ports and access in the database, as above. A host's WebSocket is held by one gateway, which records that it holds it, and a request for that host landing on another gateway is forwarded to it.

| Threat | What stops it |
| --- | --- |
| A forged request between gateways | Each gateway makes an Ed25519 key when it starts. Only the public half goes into the database; the private half never leaves the process. Every request between gateways is signed over the gateway it is for, the operation, the time, a fresh nonce and the body's SHA-256. Anything unsigned, signed by a key no live gateway registered, or signed for another gateway gets `404` (a WebSocket, close code `4404`), as an unknown path would |
| Replaying a captured request | A request is good for 30 seconds, once, on the gateway it was signed for |
| A request bouncing between gateways | A gateway serves a forwarded request only for a host connected to itself |
| A gateway that died | One not seen for 10 seconds gets nothing forwarded to it, and its hosts reconnect to another |
| A late disconnect wiping a newer connection | Each claim on a host has an epoch, and a gateway releases only its own |
| A revoked host | Revoking it on any gateway closes its WebSocket on whichever holds it, and its credential is refused on all of them |

Each gateway needs an address the others can reach, `KANTEL_REPLICA_URL` (by default its first IPv4 address). Requests between gateways are signed but **not encrypted**: they carry commands, files and port traffic for sandboxes. Keep `KANTEL_REPLICA_URL` on a private network, or put TLS in front of it.

## What it assumes

- **The database is trusted.** Write access to it can register a gateway's key, add tickets and change records. Protect it as you protect the console's own data.
- **The gateway is trusted.** It sees desktop, CDP and port traffic in the clear, though not SSH, which is end to end with host keys pinned per sandbox.
- **Out of scope:** a guest kernel escaping Firecracker, and whatever a sandbox's egress rules let out.
