---
title: Egress proxy
description: How a sandbox on your hosts reaches the internet, and how to limit it. Set an account's allow and deny lists, send its traffic on through a proxy of your own with credentials the sandbox never sees, and recognise a refusal.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The proxy settings are part of Kantel's API, which every control plane serves. They apply to sandboxes on [your own hosts](/hosts/), not the built-in stand-in (`KANTEL_COMPUTE_BACKEND=stub`). Their shapes may still change.
:::

Every sandbox on a host goes out through one door: the egress proxy that `kantel-host` runs. An account's proxy settings decide which sites the door opens to, and can send what goes through on to a proxy of your own.

## How a sandbox gets out

A microVM's network reaches one address, its host's egress proxy on port 3129. The host's firewall routes nothing else: no NAT, no DNS server, no way to the internet, your network, the host or another sandbox except through the proxy. Nothing can connect in either. You reach a sandbox's SSH, desktop, browser and ports through the control plane's relay.

The sandbox is set up to use the proxy. Shells and commands get the usual variables:

```text
HTTP_PROXY=http://sandbox@10.231.0.9:3129
HTTPS_PROXY=http://sandbox@10.231.0.9:3129
NO_PROXY=localhost,127.0.0.1,::1
```

`curl`, `git` over HTTPS, `pip`, `npm` and Node (`NODE_USE_ENV_PROXY=1`) follow them. Chrome and Docker use a forwarder on `127.0.0.1:3128` inside the sandbox, which keeps working after a fork or resume changes the proxy's address. A program that ignores the proxy variables can't connect, and a name it looks up itself doesn't resolve: the proxy resolves names. Plain TCP and UDP don't get out. The proxy takes `CONNECT` to any port, though, so a client that can use an HTTP proxy for other protocols gets through.

Whatever the account's rules say, the proxy refuses private, loopback and link-local addresses, checked after it resolves the name. That covers your network, the host itself and the cloud metadata address `169.254.169.254`. A host's operator can let named private ranges through with `egressAllowCIDRs` in the [host's settings](/hosts/#the-settings-file).

Without proxy settings, a sandbox reaches any public address. That is the host's `egress` setting of `open`. A host set to `none` gives such sandboxes no network at all, not even the proxy. Once an account turns its settings on, its sandboxes use the proxy with those settings on any host.

## Set the proxy settings

Each account has one set of settings. Read them with `GET /v1/proxy`, which needs `account:read`, and replace them with `PUT /v1/proxy`, which needs `account:admin`. The console's **Egress proxy** page edits the same settings. The examples use `KANTEL_URL` and `KANTEL_API_KEY` as set in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start).

Refuse one site and allow the rest:

```sh
curl -s -X PUT "$KANTEL_URL/v1/proxy" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"enabled": true, "deny": ["example.com"]}'
```

Allow only GitHub:

```sh
curl -s -X PUT "$KANTEL_URL/v1/proxy" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"enabled": true, "defaultAction": "deny", "allow": ["github.com", "*.github.com"]}'
```

```json
{"accountId":"acc_9y3v0gxvuh","enabled":true,"defaultAction":"deny","allow":["github.com","*.github.com"],"deny":[],"attribution":false,"updatedAt":1793698749019}
```

Running sandboxes pick up a change within seconds. A stopped one picks it up when it next starts.

| Field | What it does |
| --- | --- |
| `enabled` | Whether the settings apply. Required |
| `defaultAction` | `allow` (the default) or `deny`: what happens to a site no rule names |
| `allow` | Sites always let through |
| `deny` | Sites always refused. Deny wins over allow |
| `upstream` | A proxy to send allowed traffic on to: `{"url": …, "headers": {…}}`, or `null` for none. See [Send traffic through your own proxy](#send-traffic-through-your-own-proxy) |
| `attribution` | Whether the host signs the sandbox and account it names to the upstream |

A `PUT` replaces the settings: a field you leave out goes back to its default, and an `upstream` you leave out is removed. To keep part of the settings, read them first and send them back. There is no `DELETE`. To turn the settings off, send `{"enabled": false}`.

The console's choices map onto these fields. **Open** is `defaultAction: allow`. **Allow list** is `defaultAction: deny` with an allow list, and **Closed** is `defaultAction: deny` with an empty one. Its options to inspect HTTPS, add headers for a host and log requests aren't in the API yet, and the console says so if you try them.

### Rules

A rule is a host name:

- `api.github.com` matches that name only;
- `*.github.com` matches every name under `github.com`, but not `github.com` itself, so list both if you want both;
- `*` matches every name.

Names are compared without regard to case. A rule doesn't name a port, a path or an address range: `10.0.0.0/8` is accepted, but it matches only a request for the literal name `10.0.0.0/8`, which never happens. Rules apply to the name a program asks the proxy for, before it is resolved. To allow private addresses, use the host's `egressAllowCIDRs` instead.

## What a refusal looks like

The proxy answers a refused request itself, with a status, an `X-Kantel-Egress: denied` header and the reason in the body:

```text
HTTP/1.1 403 Forbidden
Content-Type: text/plain
X-Kantel-Egress: denied

kantel egress: denied by the proxy settings (example.com)
```

For an HTTPS request the refusal comes before TLS starts, so `curl` shows only `CONNECT tunnel failed, response 403`. Fetch the plain `http://` address to see the reason.

| Status | Reason | Why |
| --- | --- | --- |
| 403 | `denied by the proxy settings (example.com)` | A deny rule matched |
| 403 | `not on the proxy settings' allow list` | `defaultAction` is `deny`, and no allow rule matched |
| 403 | `10.0.0.1 isn't on the public internet` | The address is private, loopback or link-local, and not in the host's `egressAllowCIDRs` |
| 502 | `can't connect to example.com:443` | The site didn't answer (`can't reach …` for plain HTTP) |
| 502 | `the upstream proxy can't be reached` | The upstream's address doesn't answer, or its URL has no port |
| 403 | `the upstream proxy's address isn't one this host may reach (its egressAllowCIDRs)` | The upstream is on a private address the host doesn't allow |

A refusal from your own upstream proxy reaches the sandbox as the upstream sent it.

The host logs every decision, allowed or refused, in its journal (`journalctl -u kantel-host`):

```text
level=INFO msg=egress part=egress sandbox=sbx_4kq9x2mt method=CONNECT host=www.iana.org port=443 allowed=false reason="not on the proxy settings' allow list" via=direct attribution="" up=0 down=0
```

Refusals aren't [events](/api/reference/events/) yet, so webhooks, OpenTelemetry and the console don't see them.

## Send traffic through your own proxy

With `upstream`, the host passes every request it allows on to another HTTP proxy, such as a gateway that adds credentials for your registries and APIs. The host applies the allow and deny rules first, so a refused request never reaches the upstream.

```sh
curl -s -X PUT "$KANTEL_URL/v1/proxy" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{
    "enabled": true,
    "upstream": {"url": "http://gateway.internal.example:3128", "headers": {"X-Gateway-Key": "…"}},
    "attribution": true
  }'
```

- **Hosts need the data path.** A host passes traffic on to the upstream only when it was installed with `--proxy-data-path`, or has `"proxyDataPath": true` in its settings. On other hosts the rules still apply, and allowed traffic goes straight out.
- **The URL is `http://` with a port.** The host speaks plain HTTP to the upstream: `CONNECT` for HTTPS, so TLS runs between the sandbox and the site (or your upstream, if it terminates TLS), and proxy-form requests for plain HTTP. It doesn't open TLS to the upstream itself, even for an `https://` URL.
- **The host must be able to reach it.** The upstream's address goes through the same check as any other: a public address, or a private one in the host's `egressAllowCIDRs`.
- **Headers stay on the host.** `headers` go on every request the host sends the upstream, on the `CONNECT` for HTTPS. Kantel never shows their values again: `GET` answers only `headerNames`. Leave `headers` out of a later `PUT` to keep the ones the upstream has. The sandbox never sees them.

The host also tells the upstream where each request came from, in `Kantel-Sandbox` and `Kantel-Account` headers. With `attribution: true`, and `KANTEL_EGRESS_ATTRIBUTION_KEY` set on the control plane to a secret you share with the upstream, it signs them:

```text
Kantel-Sandbox: sbx_4kq9x2mt
Kantel-Account: acc_9y3v0gxvuh
Kantel-Signature: t=1793698834,v1=<hex>
```

`v1` is the HMAC-SHA256, keyed with that secret, of the timestamp, the sandbox and the account, joined with newlines. Without the key the headers go unsigned, so an upstream that trusts them should check the signature and the timestamp's age. A sandbox can't set these itself: the host drops any `Kantel-Sandbox`, `Kantel-Account`, `Kantel-Attribution` or `Kantel-Signature` header a sandbox sends. A user name a program puts in its proxy URL, such as `http://run-42@10.231.0.9:3129`, arrives as `Kantel-Attribution: claimed; run-42`. That is the sandbox's own label, not something the host vouches for.

<!-- Sources (5be456c): apps/host/internal/egress/egress.go:1-60,146-260,261-460, apps/host/internal/network/network.go:1-25, apps/host/internal/agent/host.go:268-300, apps/host/internal/agent/config.go:47-60, apps/host/internal/proto/proto.go:170-195, apps/host/guest/README.md (what listens where), packages/hosts/src/backend.ts:76-93,276-278, packages/compute/src/service.ts:460-490,2091-2140, packages/api/src/compute-routes.ts:990-1018, packages/api/src/compute-schema.ts:941-997, apps/console/src/compute/api-source.ts:491-566, apps/selfhosted/src/gateway/compute.ts:35-42. Run end to end on a local host for TASK-4706. -->
