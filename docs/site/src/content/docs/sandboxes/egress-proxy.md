---
title: Egress proxy
description: How a sandbox on your hosts reaches the internet, and how to limit it. Set an account's allow and deny lists, narrow them by method and path with grants, send its traffic on through a proxy of your own with credentials the sandbox never sees, and recognise a refusal.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
The proxy settings are part of Kantel's API, which every control plane serves. They apply to sandboxes on [your own hosts](/hosts/), not the built-in stand-in (`KANTEL_COMPUTE_BACKEND=stub`). Their shapes may still change.
:::

Every sandbox on a host goes out through one door: the egress proxy that `kantel-host` runs. An account's proxy settings decide which sites the door opens to, and can send what goes through on to a proxy of your own. [Grants](#grants) narrow that by method and path for the sandboxes of one environment, or for one sandbox.

The same proxy puts [protected variables](/sandboxes/environments/) into requests: the sandbox holds a placeholder, and the proxy swaps in the real value only for the destinations it is bound to.

## How a sandbox gets out

A microVM's network reaches one address, its host's egress proxy on port 3129. The host's firewall routes nothing else: no NAT, no DNS server, no way to the internet, your network, the host or another sandbox except through the proxy. Nothing can connect in either. You reach a sandbox's SSH, desktop, browser and ports through the control plane's relay.

The sandbox is set up to use the proxy. Shells and commands get the usual variables:

```text
HTTP_PROXY=http://sandbox:@10.231.0.9:3129
HTTPS_PROXY=http://sandbox:@10.231.0.9:3129
NO_PROXY=localhost,127.0.0.1,::1
```

`curl`, `git` over HTTPS, `pip`, `npm` and Node (`NODE_USE_ENV_PROXY=1`) follow them. Chromium and Docker use a forwarder on `127.0.0.1:3128` inside the sandbox, which keeps working after a fork or resume changes the proxy's address. A program that ignores the proxy variables can't connect, and a name it looks up itself doesn't resolve: the proxy resolves names. Plain TCP and UDP don't get out. The proxy takes `CONNECT` to any port, though, so a client that can use an HTTP proxy for other protocols gets through.

Whatever the account's rules say, the proxy refuses private, loopback and link-local addresses, checked after it resolves the name. That covers your network, the host itself and the cloud metadata address `169.254.169.254`. A host's operator can let named private ranges through with `egressAllowCIDRs` in the [host's settings](/hosts/#the-settings-file).

Without proxy settings, a sandbox reaches any public address. That is the host's `egress` setting of `open`. A host set to `none` gives such sandboxes no network at all, not even the proxy. Once an account turns its settings on, its sandboxes use the proxy with those settings on any host.

### Services

A microVM's systemd services get the proxy and CA variables too, so a long-running server you start as a unit reaches the network as it does from a command. They point at the forwarder, not the proxy's own address, so a unit never needs a restart after a fork or resume:

```text
# /etc/systemd/system.conf.d/kantel-proxy.conf, DefaultEnvironment
HTTP_PROXY=http://127.0.0.1:3128
HTTPS_PROXY=http://127.0.0.1:3128
NO_PROXY=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
```

The lower-case forms are there as well. `/etc/environment` has the same lines, for `sudo`, `su`, cron and SSH sessions. A unit's own `Environment=` and `EnvironmentFile=` win over them.

The sandbox's own variables, from `kantel new -e` and its environment's plain variables, are for commands only: every service on the machine, `sshd` and `dockerd` among them, would otherwise run with them. A unit that wants them reads the file the guest agent keeps them in:

```ini
[Service]
EnvironmentFile=-/etc/kantel/env
ExecStart=/home/user/app/server
```

The guest agent writes `/etc/kantel/env` each time the sandbox starts, resumes or is forked, and a unit reads it when the unit starts. Values read the same in a unit as in a command, except that a newline or tab in one arrives written as `\n` or `\t`. These settings come with the sandbox images after `host-images-20261107.1`. On an older image, write the variables into an `EnvironmentFile` of your own.

### Git over SSH

`ssh` doesn't read the proxy variables, so a microVM's image comes with `kantel-connect`, which opens an SSH connection through the proxy with `CONNECT`, and SSH settings that use it for GitHub. `git clone git@github.com:acme/app.git` works as it does anywhere else, given a key GitHub accepts:

```text
# /etc/ssh/ssh_config.d/kantel.conf
Host github.com
	HostName ssh.github.com
	Port 443
	HostKeyAlias github.com
	ProxyCommand /usr/local/bin/kantel-connect %h %p
```

GitHub's connection goes to `ssh.github.com` on port 443, where GitHub serves SSH for networks that let only HTTPS's port out, so an upstream proxy that allows only 443 doesn't get in its way. GitHub's [published host keys](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) are in `/etc/ssh/ssh_known_hosts`, so the first connection isn't asked to trust an unknown key. `kantel-connect` goes through the forwarder on `127.0.0.1:3128`, so it keeps working after a fork or resume and under `sudo`, which drops the proxy variables.

For another host, add the same `ProxyCommand` to `~/.ssh/config`, which `ssh` reads first:

```text
Host gitlab.com
	ProxyCommand /usr/local/bin/kantel-connect %h %p
```

The first connection to a host whose key isn't known asks you to trust it, or fails under `BatchMode`. Add its key to `~/.ssh/known_hosts` first: `ssh-keyscan` can't fetch it, since it doesn't use a `ProxyCommand`.

The proxy's rules apply as to any `CONNECT`. An allow list needs `ssh.github.com` (or `*.github.com`), not only `github.com`. A refusal is printed with the proxy's reason, such as `kantel-connect: ssh.github.com:443: kantel egress: not on the proxy settings' allow list.` A grant with methods or paths on `ssh.github.com`, or a protected variable bound to it (or to `*.github.com`), makes the proxy read TLS on its port 443, which SSH doesn't speak, so bind GitHub tokens to `github.com` and `api.github.com` rather than `*.github.com`.

A private key is a file the sandbox has to read: it can't be a [protected variable](/sandboxes/environments/#which-credentials-suit-protected-mode). Use a deploy key or a short-lived key, and remove it when you're done. Where that's not acceptable, use `git` over HTTPS with a protected token, which the sandbox never holds:

```sh
git clone https://x-access-token:$GITHUB_TOKEN@github.com/acme/app.git
```

The image's `kantel-connect` and its SSH settings come with the sandbox images from `host-images-20261107.1` on. In an image that boots with the injected guest agent (a [custom image](/sandboxes/custom-images/)), it is `/.kantel/bin/kantel-connect`, with no SSH settings: add the `Host` block above to the image or to `~/.ssh/config` with that path. On an older image, `kantel-guest connect %h %p` doesn't exist either; copy a newer `kantel-guest` in, or use HTTPS.

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

Names are compared without regard to case. A rule doesn't name a port, a path or an address range: `10.0.0.0/8` is accepted, but it matches only a request for the literal name `10.0.0.0/8`, which never happens. Rules apply to the name a program asks the proxy for, before it is resolved. To allow private addresses, use the host's `egressAllowCIDRs` instead. To decide by method or path, use a grant.

## Grants

A grant allows or refuses requests to a host, optionally only those with certain methods or paths. An [environment](/sandboxes/environments/) has grants for every sandbox made from it, and a sandbox can have grants of its own.

```sh
kantel env grant work deny api.github.com --method DELETE --path '/repos/**'
kantel grant sbx_4kq9x2mt allow uploads.example.com --method PUT --path '/incoming/*'
kantel egress sbx_4kq9x2mt    # the sandbox's grants and its log
kantel grant rm sbx_4kq9x2mt grt_8f2k
```

| Part | What it matches |
| --- | --- |
| Host | A name, as in a [rule](#rules): `api.github.com`, or `*.github.com` for the names under it |
| Methods | Any of these methods, such as `DELETE`. None: every method |
| Paths | Any of these path patterns. `*` matches one segment and `**` the rest, so `/repos/*` matches `/repos/app` but not `/repos/app/issues`, and `/repos/**` matches both. None: every path. The query isn't part of the path |

Grants apply on top of the account's allow and deny rules: the environment's first, then the sandbox's own. Where a deny and an allow both match a request, the deny wins. Running sandboxes pick up a change within seconds.

The proxy refuses a request a grant denies with status 403 and two headers, `X-Kantel-Proxy-Error: denied` and `X-Kantel-Proxy-Rule`, which names the grant:

```text
HTTP/1.1 403 Forbidden
Content-Type: text/plain
X-Kantel-Proxy-Error: denied
X-Kantel-Proxy-Rule: deny DELETE api.github.com /repos/**
```

[Environments and protected variables](/sandboxes/environments/#refusals) lists the other codes.

### Which HTTPS the proxy reads

To match a method or a path in an HTTPS request, the proxy has to read it. It does that only for the hosts that need it: a host with a grant that names methods or paths, and a host a protected variable is bound to. For those, it ends TLS with a certificate from a certificate authority of the sandbox's own, which can sign only for those hosts and whose certificate is in the sandbox's trust store, and opens its own verified TLS connection to the real host.

HTTPS to every other host stays a tunnel the proxy passes on without reading. A grant with only a host decides on the tunnel as a whole, as a rule does. The proxy reads only port 443, so a tunnel to another port of a host that a method or path deny grant covers is refused: the proxy couldn't check what goes through it. The same applies to a deny grant with methods or paths on `*`, which no certificate can be made for. Every request on a connection the proxy reads is checked against the sandbox's grants at the time it is sent, so a grant changed while a connection is open applies to that connection's next request. A client that pins certificates refuses the proxy's certificate for an intercepted host, so give method and path grants only to hosts where that is acceptable.

## What a refusal looks like

The proxy answers a refused request itself, with a status line that says it's the proxy's and why, an `X-Kantel-Egress` header (`denied` for a refusal, `error` for a failure on the way out), an `X-Kantel-Proxy-Error` code, and the reason in the body:

```text
HTTP/1.1 403 Forbidden (kantel egress: denied by the proxy settings (example.com))
Content-Type: text/plain
X-Kantel-Egress: denied
X-Kantel-Proxy-Error: denied

kantel egress: denied by the proxy settings (example.com).
```

Clients that show only the status line show the proxy's words too: apt prints `502  Bad Gateway (kantel egress: can't connect to example.com:443: timed out) [IP: 10.231.0.9 3129]`. For an HTTPS request the refusal comes before TLS starts, so `curl` shows only `CONNECT tunnel failed, response 403`. Fetch the plain `http://` address, or run `curl -v`, to see the reason.

An answer without `X-Kantel-Egress` came from the site. Once the proxy has opened a tunnel (`HTTP/1.1 200 Connection established`), it passes bytes on and never answers inside it, so an HTTP error over HTTPS through a tunnel, such as `503 Service Unavailable`, is always the site's own, even though the client names the proxy's address (apt's `[IP: 10.231.0.9 3129]` is the address it connected to, which is always the proxy).

| Status | Reason | Why |
| --- | --- | --- |
| 403 | `denied by the proxy settings (example.com)` | A deny rule matched |
| 403 | `not on the proxy settings' allow list` | `defaultAction` is `deny`, and no allow rule matched |
| 403 | `10.0.0.1 isn't on the public internet` | The address is private, loopback or link-local, and not in the host's `egressAllowCIDRs` |
| 502 | `can't connect to example.com:443: timed out` | The site didn't answer, and why: `timed out`, `connection refused`, `its name doesn't resolve` and so on (`can't reach …` for plain HTTP) |
| 502 | `the upstream proxy can't be reached: connection refused` | The upstream's address doesn't answer, or its URL has no port |
| 403 | `the upstream proxy's address isn't one this host may reach (its egressAllowCIDRs)` | The upstream is on a private address the host doesn't allow |

A refusal from your own upstream proxy reaches the sandbox as the upstream sent it, with `X-Kantel-Egress: upstream-proxy` added to say whose it is.

The egress log records each of the proxy's own failures as the sandbox saw it: allowed, with its status and the `upstream-failed` code, and the reason, so `kantel egress <sandbox>` shows `allowed 502  upstream-failed: can't connect to example.com:443: timed out`. A tunnel's entry has no status, because the proxy never reads inside it.

The host logs every decision, allowed or refused, in its journal (`journalctl -u kantel-host`):

```text
level=INFO msg=egress part=egress sandbox=sbx_4kq9x2mt method=CONNECT host=www.iana.org port=443 allowed=false reason="not on the proxy settings' allow list" via=direct attribution="" up=0 down=0
```

Each sandbox also keeps its newest 1,000 requests, allowed and refused, in its [egress log](/sandboxes/environments/#the-egress-log), which `kantel egress <sandbox>` and `GET /v1/sandboxes/{sandboxId}/egress` show. Refusals aren't [events](/api/reference/events/) yet, so webhooks and OpenTelemetry don't see them.

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

<!-- Sources (5be456c): apps/host/internal/egress/egress.go:1-60,146-260,261-460, apps/host/internal/network/network.go:1-25, apps/host/internal/agent/host.go:268-300, apps/host/internal/agent/config.go:47-60, apps/host/internal/proto/proto.go:170-195, apps/host/guest/README.md (what listens where), packages/hosts/src/backend.ts:76-93,276-278, packages/compute/src/service.ts:460-490,2091-2140, packages/api/src/compute-routes.ts:990-1018, packages/api/src/compute-schema.ts:941-997, apps/console/src/compute/api-source.ts:491-566, apps/selfhosted/src/gateway/compute.ts:35-42. Run end to end on a local host for TASK-4706. Git over SSH: apps/host/cmd/kantel-guest/connect.go, apps/host/guest/rootfs/etc/ssh/ (lleverage-ai/kantel#797). -->
