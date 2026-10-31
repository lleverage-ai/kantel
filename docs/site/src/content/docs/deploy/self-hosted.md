---
title: Self-hosted
description: Run Partan's self-hosted gateway with Docker Compose, Postgres and S3 storage, and set up sign-in, the vault, models and browsers.
---

Self-hosted Partan is one gateway process on Bun, built from `apps/selfhosted/Dockerfile`. It serves the console and the API, keeps its state in Postgres, and keeps workspace and skill files in an S3-compatible bucket. `deploy/compose` runs it on one machine with Postgres, MinIO and Mailpit. For how it compares with Cloudflare, see the [deployment overview](/deploy/overview/).

Package and variable names still use the old name, `harbour`.

## Start it with Docker Compose

From the repository root:

```bash
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

The console is at `http://127.0.0.1:58090/` (`HARBOUR_GATEWAY_PORT` moves it). Every port is bound to 127.0.0.1, so on a remote machine forward it first: `ssh -L 58090:127.0.0.1:58090 <host>`. Mailpit, which catches sign-in codes, is at `http://127.0.0.1:58025/`.

To stop the stack and delete all its state:

```bash
docker compose -f deploy/compose/compose.yaml down -v
```

:::caution
`deploy/compose` is the repository's development and test stack. Its Postgres and MinIO passwords are fixed development values in `compose.yaml`, and it also starts services from an earlier prototype (`host-a`, `host-b`, `isolate-host`, `vault-proxy`, `research-site`) that the gateway doesn't use. Two of them, and the browser host, mount the Docker socket, which is root on the machine. There is no production compose file yet.
:::

The gateway itself depends only on `postgres`, `minio` and `mailpit`.

## First start

On its first start the gateway creates an organisation, a project and an operator API key (`hbr_…`) on that project. It writes their IDs and the key to `/var/lib/harbour/bootstrap.json` (mode 0600) in its volume. On later starts it reads the file back and keeps the same deployment while the key still works.

```bash
docker compose -f deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
```

It also creates two agent profiles: `echo`, which always answers with the echo model, and `assistant`, on the `default` model route, when real models are set up. Both start with no prompt layers. Partan adds no system prompt of its own: the prompt is what the profile's prompt layers and the prompt rules give it, plus recall and the skills listing.

`HARBOUR_PROJECTS` takes more project names, comma-separated. Each is made once and put on the operator key. Naming a new one later issues a new key over them all and revokes the old one.

## Sign-in and API keys

People sign in with a one-time code sent by email. Partan is invite-only: the gateway invites `HARBOUR_ADMIN_EMAIL` (default `admin@harbour.localhost`) as an organisation admin at start, and nobody else can sign in until invited.

Codes go out through `HARBOUR_SMTP_URL` from `HARBOUR_MAIL_FROM`:

| `HARBOUR_SMTP_URL` | Transport |
| --- | --- |
| `smtps://user:password@host:port` | TLS from the start |
| `smtp://user:password@host:port` | STARTTLS required |
| `smtp://host:port?starttls=off` | In the clear, for a relay on a private network |

Compose sends codes to Mailpit by default. Without `HARBOUR_SMTP_URL` the sign-in routes answer 503, and a malformed value stops the gateway at start. Codes last 10 minutes and a signed-in session (`hbs_…`) lasts 12 hours. The gateway allows 30 sign-in requests per client address per 15 minutes. Behind a reverse proxy every client shares one address, so limit there instead.

Set `HARBOUR_PUBLIC_URL` (an origin, such as `https://partan.example.com`) when people reach the console through a TLS proxy. Passkeys are made for that origin, and without it the gateway uses the request's own origin, which is `http:` behind a proxy.

Host apps use the bootstrap's operator key, or keys made on the console's `/keys` page. See [Authentication](/api/authentication/). Host tool callbacks must be `https:` unless `HARBOUR_CALLBACK_ORIGINS` allows others, such as `http://127.0.0.1:*`.

## Postgres and storage

`HARBOUR_DATABASE_URL` points the gateway at Postgres. Every table goes in one schema, `HARBOUR_GATEWAY_SCHEMA` (default `harbour_m1`), and the vault in `<schema>_vault`. Without a database URL the gateway keeps everything in memory.

With a database URL the gateway also needs `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` (`S3_REGION` is optional). Workspace files go under `HARBOUR_GATEWAY_S3_PREFIX` (default `m1/workspaces/`) and skill files under `HARBOUR_SKILLS_S3_PREFIX` (default `m1/skills/`).

Sessions left mid-run resume when the gateway starts again.

## The vault

`HARBOUR_VAULT_CIPHER_KEY` is the vault's 256-bit key, base64 (`openssl rand -base64 32`). It seals every item's value in Postgres. Without it a gateway on Postgres has no vault, `/v1/vault` isn't served, and real models can't run, since their key is kept in the vault. `compose.yaml` doesn't set one.

:::caution
Keep the cipher key. Values sealed with it can't be read with any other.
:::

## Models

With `HARBOUR_CPA_URL` (CLIProxyAPI's API root with its `/v1`, such as `http://127.0.0.1:8317/v1`) and `HARBOUR_CPA_API_KEY` (at least 16 characters), sessions go through Partan's model gateway in the gateway's process. Set both or neither. The `default` route serves `HARBOUR_DEFAULT_MODEL` (default `claude-sonnet-5-5`), and every other model CLIProxyAPI lists is offered as `default:<model>`.

At start the gateway checks the key and model with CLIProxyAPI and logs what to change if they fail; otherwise a wrong one shows only as `no_model` on every session. Without CLIProxyAPI, sessions use the echo model.

`compose.yaml` doesn't pass these variables to the gateway. Add them in an override file (see [Your own settings](#your-own-settings)).

## Commands in sessions

A session's `read`, `write`, `edit` and `ls` work on its workspace directly. `bash` leases an isolate, a just-bash shell in the gateway's own process, on its first command. There is no container tier yet, so commands that need one (`git`, `node`, `python` and the like) are refused as `unavailable`.

Because the isolate runs in the gateway's process, gVisor doesn't apply to it. `HARBOUR_ISOLATE_RUNTIME` and `HARBOUR_SANDBOX_RUNTIME` in `compose.yaml` set the runtime of the prototype's services only.

## Browsers

`deploy/compose/browser.yaml` adds a browser host that runs one Chromium container per browser through the Docker socket:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/browser.yaml up -d --build --wait
```

The gateway then uses `HARBOUR_BROWSER_PROVIDER=harbour`. An agent asks before it opens any site, and a person allows or declines it in the console. The overlay's keys are development defaults: anywhere else, set `HARBOUR_BROWSER_HOST_TOKEN`, `HARBOUR_BROWSER_VIEW_KEY` and `HARBOUR_BROWSER_SEAL_KEY` to random values of 32 characters or more (`openssl rand -hex 32`). Set `HARBOUR_EMBED_ORIGINS` when another app frames the viewer.

`HARBOUR_BROWSER_RUNTIME` picks the browser containers' runtime: `runc` by default, or `runsc` or `runsc-kvm` to put Chromium under gVisor. Set it for the `browser-host` service. [Install gVisor](https://gvisor.dev/docs/user_guide/install/) and register it with Docker first:

```bash
sudo runsc install
sudo runsc install --runtime runsc-kvm -- --platform=kvm
sudo systemctl reload docker
```

The repository's measurements recommend `runsc-kvm` on bare metal with `/dev/kvm`, and `runsc` inside a VM. The second command is only for bare metal.

To use brwsr.dev instead, set `HARBOUR_BRWSR_API_KEY` on the gateway. Without a browser host or a brwsr key, sessions have no browser.

## Kubernetes

`deploy/kubernetes/browser-host` runs the browser host on Kubernetes, with a Pod per browser and no Docker socket (`HARBOUR_BROWSER_DRIVER=kubernetes`). `HARBOUR_BROWSER_RUNTIME_CLASS` sets a RuntimeClass, such as gVisor's. Its manifests build with `kubectl kustomize` but haven't run on a cluster yet. Point the gateway at it with `HARBOUR_BROWSER_HOST_URL=http://harbour-browser-host.harbour-browsers.svc:8790` and the same host token and view key.

:::note[Not yet merged]
Kubernetes manifests for the gateway and its stores are in a draft pull request (#174) and aren't in main.
:::

## Usage

The gateway writes one row per model call to `usage_calls` in its schema. `HARBOUR_USAGE=off` turns it off. With `deploy/compose/analytics.yaml` on top, it also ships the rows to ClickHouse (`HARBOUR_CLICKHOUSE_URL`) every 15 seconds.

## Your own settings

`compose.yaml` reads `HARBOUR_ADMIN_EMAIL`, `HARBOUR_SMTP_URL`, `HARBOUR_MAIL_FROM` and `HARBOUR_PROJECTS` from your environment. Everything else goes in an override file of your own, for example `partan.yaml`:

```yaml
services:
  gateway:
    environment:
      HARBOUR_ADMIN_EMAIL: you@example.com
      HARBOUR_SMTP_URL: smtps://user:password@smtp.example.com
      HARBOUR_MAIL_FROM: Partan <partan@example.com>
      HARBOUR_PUBLIC_URL: https://partan.example.com
      HARBOUR_VAULT_CIPHER_KEY: <output of openssl rand -base64 32>
      HARBOUR_CPA_URL: http://cliproxyapi.example.internal:8317/v1
      HARBOUR_CPA_API_KEY: <CLIProxyAPI client key>
```

```bash
docker compose -f deploy/compose/compose.yaml -f partan.yaml up -d --build --wait
```

Pass the same `-f` files to every later `docker compose` command, or compose recreates services with their defaults.

## Check it

`/healthz` needs no credentials. `/v1/deployment` lists what backs each part (Postgres, S3, the vault, the model gateway, the sandboxes) and where mail goes, never the credentials. It is self-hosted only and not in the OpenAPI document (see [Unlisted routes](/api/reference/unlisted/)):

```bash
curl -s "$PARTAN_URL/healthz"
curl -s "$PARTAN_URL/v1/deployment" -H "authorization: Bearer $PARTAN_API_KEY"
```

`PARTAN_URL` is `http://127.0.0.1:58090` for the compose stack. `/v1/deployment` isn't in the SDK; for a call that is:

```ts
import { createHarbourClient } from "@harbour/api/sdk";

const client = createHarbourClient({
  baseUrl: `${process.env.PARTAN_URL}/v1`,
  token: process.env.PARTAN_API_KEY,
});

const page = await client.listSessions();
console.log(page.items.length);
```

<!-- Sources (8584d5b): deploy/compose/README.md:1-160, deploy/compose/README.md:213-265, deploy/compose/README.md:266-302, deploy/compose/README.md:315-389, deploy/compose/compose.yaml:1-322, deploy/compose/browser.yaml:1-81, deploy/compose/egress-vault.yaml:1-74, deploy/compose/next-to-sal.yaml:1-66, deploy/compose/analytics.yaml:1-46, apps/selfhosted/Dockerfile:1-22, apps/selfhosted/package.json:1-12, apps/selfhosted/src/gateway/main.ts:1-263, apps/selfhosted/src/gateway/gateway.ts:1-120, apps/selfhosted/src/gateway/mail.ts:1-50, apps/selfhosted/src/gateway/models.ts:1-60, apps/selfhosted/src/gateway/models.ts:157-220, apps/selfhosted/src/gateway/durable.ts:1-40, apps/selfhosted/src/gateway/durable.ts:224-272, apps/selfhosted/src/gateway/components.ts:471-560, apps/selfhosted/src/gateway/sandboxes.ts:1-27, apps/selfhosted/src/gateway/browser.ts:1-15, apps/selfhosted/src/gateway/usage.ts:1-30, apps/selfhosted/src/browser/host.ts:1-25, apps/selfhosted/src/browser/docker.ts:1-12, deploy/kubernetes/browser-host/README.md:1-68, targets/selfhosted/sandbox/README.md:1-20, docs/measurements/m0-sh1-selfhosted/README.md:1-20, packages/api/generated/sdk.ts:1966-1980, packages/api/generated/sdk.ts:2516-2520 -->
