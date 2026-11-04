---
title: Your own hosts
description: Add a Linux machine of your own to your personal account or an organisation, so that account's sandboxes run on it, through a hosted or self-hosted Kantel with no inbound port.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental and off by default]
A deployment serves account hosts only with `KANTEL_ACCOUNT_HOSTS=experimental`. Otherwise their routes answer `not_supported`. The commands and the API may still change.
:::

Bring your own machines. You add a Linux machine to your personal account or an organisation you administer. From then on, that account's new sandboxes run on it, and no other account's sandboxes ever do. The machine runs `kantel-host` (see [Hosts](/hosts/)), which dials out to Kantel over a WebSocket and keeps that connection open. It needs no inbound port, so it can sit behind NAT, at home, or on a private network such as a Tailscale tailnet, as long as it can reach Kantel over HTTPS.

It works the same way on a self-hosted control plane and on a hosted one such as `https://app.kantel.dev`. The CLI talks to the Kantel API, and the API acts as the gateway to your hosts over the connections they opened.

## Add a machine

You need `account:admin` in the account: you own your personal account, and an organisation's owners and admins have it. You don't need to be the deployment's super-admin.

In the console, open **Hosts** and choose **Add a host**. From the CLI:

```sh
kantel hosts add my-laptop                  # into your personal account
kantel hosts add build-box --account acc_…  # into an organisation
```

It prints a one-line command with a one-use `kth_…` token that is valid for an hour (`--expires <minutes>` changes this). Run that command on the machine as root:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://app.kantel.dev --token kth_…
```

It checks the machine, installs `kantel-host` and the sandbox images, registers with the token and starts the service. The token works once. If someone else tries to use it, they get a 403.

## Where sandboxes go

| The account has… | Its new sandboxes go on |
| --- | --- |
| an online host of its own | its own hosts, by the usual [placement](/hosts/#where-sandboxes-go) (labels, capacity) |
| no online host of its own (none added, all drained, or all offline) | the deployment's shared hosts, those the super-admin joined, if it has any and the account may use them |

Another account's hosts never qualify. A sandbox stays on the host it started on, and so do its snapshots: starting, resuming, recovering or forking it uses that host even after the account adds another (a drained host still takes back what it holds). When its host can't be used, the call fails with `unavailable` rather than moving the sandbox elsewhere on an empty disk. That includes switching account hosts off: a host's sandboxes wait for it to come back. A sandbox made from a host's snapshot whose create failed keeps that snapshot, and starting it again makes it from that snapshot. While account hosts are off, revoking one of these hosts is refused (`unavailable`), because their credentials are kept by that part of the deployment. Sandboxes on a host are stopped at their auto-stop time even if they're only being used over SSH.

## Look after your hosts

```sh
kantel hosts list               # your account's hosts, revoked ones included
kantel hosts info host_…        # one of them: state, version, capacity, sandboxes
kantel hosts drain host_…       # no new sandboxes there; running ones carry on
kantel hosts drain host_… --off # take new sandboxes again
kantel hosts rm host_…          # revoke its credential and close its connection
```

Asking for a host in another account gives `not_found`, so nobody can learn whether a host exists. Once a host is removed, `kantel-host` stops and doesn't retry. `kantel host <id> <port>` (singular) is a different command: it gives a sandbox's port a URL.

## Turn it on

**Self-hosted:** set `KANTEL_ACCOUNT_HOSTS=experimental` in `deploy/compose/.env`, along with `KANTEL_PUBLIC_URL` (or `KANTEL_COMPUTE_PUBLIC_URL`), the address hosts can reach. See [Install](/self-hosting/install/). Direct and private-network hosts that the super-admin joins keep working as before, and they're the shared hosts in the table above.

**On Cloudflare (`apps/cloudflare`):** set the Worker variables `KANTEL_ACCOUNT_HOSTS=experimental` and `KANTEL_PUBLIC_URL`, the origin hosts dial. That can be the Worker's public origin, which has no Cloudflare Access in front (the same variable turns on email-code sign-in when `KANTEL_SIGN_IN_FROM` is set too; with account hosts on, it can be set without it). With an origin behind Access, note that hosts can't sign in to Access, so the Access application needs a bypass for these paths: `/v1/hosts/register`, `/v1/hosts/connect`, `/v1/hosts/images/*` and `/v1/hosts/tunnel/*` (and `/v1/hosts/desktop/*` to open a desktop's URL outside a browser signed in to Access). Each one checks its own token, credential or ticket. On the Worker the shared "host" is a stub kept in the Worker's memory, so it stays for members of the deployment's own organisation. Someone who signs up on the public origin can add and use hosts of their own, but their sandboxes never go on the stub, and they can't use a sandbox that is there. That holds for their API keys too, including after account hosts are turned off. A member of the deployment's organisation, including someone with a role on just one of its projects, keeps the stub. SSH to a sandbox on your own host works (`kantel ssh`), and a tunnel opened under an email sign-in ends when that sign-in does. A microVM's [desktop and browser](/sandboxes/desktop-and-browser/) are served the same way, in the console and through their URLs: the desktop's page and stream, watch-only included, and the browser's CDP URL. So are its [exposed ports](/sandboxes/public-ports/), at `https://{port}-{subdomain}.kantel.run` on Kantel's hosted service, pages and WebSockets alike. In an organisation with [end-to-end encryption](/e2e/) on, the host refuses the desktop and browser to the control plane, and the console says so; use `kantel e2e ssh` there.

## API

The routes are in the API reference under [Your hosts](/api/reference/account-hosts/): `POST /v1/hosts/join-tokens`, `GET /v1/hosts`, and `GET`, `PATCH` and `DELETE /v1/hosts/{hostId}`. A host's `accountId` says which account it belongs to. A host the super-admin joined has no `accountId`.
