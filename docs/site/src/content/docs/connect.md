---
title: Kantel Connect
description: Enrol a Linux machine of your own into your personal account or an organisation, so that account's sandboxes run on it, through a hosted or self-hosted Kantel with no inbound port.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental and off by default]
A deployment serves Kantel Connect only with `KANTEL_CONNECT=experimental`. Otherwise its routes answer `not_supported`. The commands and the API may still change.
:::

Kantel Connect lets you bring your own machines. You enrol a Linux machine into your personal account or an organisation you administer. From then on, that account's new sandboxes run on it, and no other account's sandboxes ever do. The machine runs `kantel-host` (see [Hosts](/hosts/)), which dials out to Kantel over a WebSocket and keeps that connection open. It needs no inbound port, so it can sit behind NAT, at home or on a private network.

It works the same way on a self-hosted control plane and on a hosted one. The CLI talks to the Kantel API, and the API acts as the gateway to your hosts over the connections they opened.

## Enrol a machine

You need `account:admin` in the account: you own your personal account, and an organisation's owners and admins have it. You don't need to be the deployment's super-admin.

```sh
kantel connect enrol my-laptop                  # into your personal account
kantel connect enrol build-box --account acc_…  # into an organisation
```

It prints a one-line command with a one-use `kth_…` token that is valid for an hour (`--expires <minutes>` changes this). Run that command on the machine as root:

```sh
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_…
```

It checks the machine, installs `kantel-host` and the sandbox images, registers with the token and starts the service. The token works once. If someone else tries to use it, they get a 403.

## Where sandboxes go

| The account has… | Its new sandboxes go on |
| --- | --- |
| an online host of its own | its own hosts, by the usual [placement](/hosts/#where-sandboxes-go) (labels, capacity) |
| no online host of its own (none enrolled, all drained, or all offline) | the deployment's shared hosts, those the super-admin joined, if it has any |

Another account's hosts never qualify. A sandbox stays on the host it started on, and so do its snapshots: starting, resuming, recovering or forking it uses that host even after the account enrols another (a drained host still takes back what it holds). When its host can't be used, the call fails with `unavailable` rather than moving the sandbox elsewhere on an empty disk. That includes switching Connect off: a host's sandboxes wait for it to come back.

## Look after your hosts

```sh
kantel connect list               # your account's hosts, revoked ones included
kantel connect info host_…        # one of them: state, version, capacity, sandboxes
kantel connect drain host_…       # no new sandboxes there; running ones carry on
kantel connect drain host_… --off # take new sandboxes again
kantel connect rm host_…          # revoke its credential and close its connection
```

Asking for a host in another account gives `not_found`, so nobody can learn whether a host exists. Once a host is removed, `kantel-host` stops and doesn't retry.

## Turn it on

**Self-hosted:** set `KANTEL_CONNECT=experimental` in `deploy/compose/.env`, along with `KANTEL_PUBLIC_URL` (or `KANTEL_COMPUTE_PUBLIC_URL`), the address hosts can reach. See [Install](/self-hosting/install/). Direct and private-network hosts that the super-admin joins keep working as before, and they're the shared hosts in the table above.

**On Cloudflare (`apps/cloudflare`):** set the Worker variables `KANTEL_CONNECT=experimental` and `KANTEL_PUBLIC_URL`, the Worker's own origin. Hosts can't sign in to Cloudflare Access, so the Access application needs a bypass for these paths: `/v1/hosts/register`, `/v1/hosts/connect`, `/v1/hosts/images/*` and `/v1/hosts/tunnel/*`. Each one checks its own token, credential or ticket. On the Worker, SSH to a Connect sandbox works (`kantel ssh`). Desktops, a browser's live view and CDP, and public ports are not served there yet.

## API

The routes are in the API reference under [Connect](/api/reference/connect/): `POST /v1/connect/enrolments`, `GET /v1/connect/hosts`, and `GET`, `PATCH` and `DELETE /v1/connect/hosts/{hostId}`. A host's `accountId` says which account it belongs to. A host the super-admin joined has no `accountId`.
