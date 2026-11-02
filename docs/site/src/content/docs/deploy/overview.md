---
title: Deployment overview
description: Compare Kantel's Cloudflare and self-hosted targets, where each part runs, how people sign in, what each needs and which features each has today.
---

Kantel runs on two targets: your own Cloudflare account, or your own machines. Both serve the same console and the same public API, and both keep sessions, workspaces, audit and the vault durably. They differ in where each part lives, how people sign in, and which features are ready today.

Packages are `@kantel/*` and settings `KANTEL_*`, such as `KANTEL_DATABASE_URL`. Deployed names keep `harbour` from before the rename, such as the `harbour` Worker, and a setting named `HARBOUR_*` still works when its `KANTEL_*` one isn't set.

## The two targets

**Cloudflare** is one Worker, `kantel`, on one hostname behind Cloudflare Access. It serves the console as static assets and the API under `/v1/`. Durable Objects hold the sessions and the vault, D1 holds the directory and audit, and R2 holds workspace files. See [Cloudflare](/deploy/cloudflare/).

**Self-hosted** is one gateway process on Bun, built from `apps/selfhosted/Dockerfile`, which serves the console and the API. It keeps everything in Postgres, with workspace files in an S3-compatible bucket. `deploy/compose` runs it with Postgres, MinIO and Mailpit on one machine. See [Self-hosted](/deploy/self-hosted/).

## Where each part lives

| Part | Cloudflare | Self-hosted |
| --- | --- | --- |
| Console | Worker static assets | Served by the gateway |
| Sessions and their history | The `KantelStack` Durable Object's SQLite, with its alarm resuming cut-off runs | Postgres: the session store and each session's Pi Durable tables |
| Workspaces | R2, with each head also kept in `KantelStack` | Postgres for heads and versions, the S3 bucket for files |
| Identity, API keys, passkeys | D1 | Postgres |
| Audit | D1, queued first in `KantelStack` and drained after each answer | Postgres |
| Skills, memory, prompt rules, sharing | D1, skill files in R2 | Postgres, skill files in the S3 bucket |
| Vault | The `KantelVault` Durable Object, values sealed with `KANTEL_VAULT_KEY` | Postgres, values sealed with `KANTEL_VAULT_CIPHER_KEY` |
| Usage rows | `KantelStack`, then `usage_calls` in D1 | `usage_calls` in Postgres, optionally shipped to ClickHouse |
| Command isolate | just-bash in `KantelStack` (`in-process`), or a Dynamic Worker per session (`dynamic-worker`) | just-bash in the gateway's own process |
| Container tier | A `KantelSandbox` object and container per session, when deployed with `KANTEL_SANDBOX_CONTAINERS=on` | None yet |
| Browsers | brwsr.dev (`KANTEL_BRWSR_API_KEY`), or Kantel's own in `KantelBrowser` containers | Kantel's own, on a browser host running Docker (in the Compose stack by default) or Kubernetes, or brwsr.dev |
| Models | CLIProxyAPI through a Workers VPC service (`MODELS`) and `KANTEL_CPA_API_KEY` | CLIProxyAPI at `KANTEL_CPA_URL` with `KANTEL_CPA_API_KEY`, or connectors of any preset from `KANTEL_MODEL_CONNECTORS` |

On both targets, model calls go through Kantel's model gateway, which reads the connector's key from the vault. CLIProxyAPI is the default connector. Self-hosted, the connectors config can replace it with others, such as a LiteLLM gateway at any address the gateway reaches; Cloudflare reaches only CLIProxyAPI, through its VPC service. Without a connector, sessions answer with an echo model.

On both targets, a session's `read`, `write`, `edit` and `ls` work on its workspace directly. `bash` leases an isolate on its first command. Commands the isolate can't run (`python`, `npm`, `git` writes and similar) need the container tier. Without it they are refused as `unavailable`.

## Signing in

On Cloudflare, Cloudflare Access signs people in before any request reaches the Worker. The Worker verifies the Access token against `KANTEL_ACCESS_TEAM_DOMAIN` and `KANTEL_ACCESS_AUD`. Kantel is invite-only: the deployment invites `KANTEL_ADMIN_EMAIL` as the first admin, and Access's verified email links them on first sign-in. Anyone else Access lets through is still refused by Kantel.

Self-hosted, people sign in with a one-time code sent by email. The gateway sends codes through `KANTEL_SMTP_URL` from `KANTEL_MAIL_FROM`; without an SMTP URL, sign-in answers 503. It invites `KANTEL_ADMIN_EMAIL` as the first admin. Codes last 10 minutes and a signed-in session (an `kts_…` token) lasts 12 hours.

On both, host apps use API keys (`Authorization: Bearer ktk_…`), and approving a vault request needs the person's passkey once they have one. See [Authentication](/api/authentication/).

## What each needs

Cloudflare needs:

- A Workers Paid account and one hostname that is a direct subdomain of a zone in it.
- A Cloudflare Access application on that hostname.
- A D1 database and an R2 bucket.
- A Workers VPC service to a CLIProxyAPI for real models. The deploy script refuses to deploy without its ID (`KANTEL_MODELS_VPC_SERVICE_ID`); a local `wrangler dev` runs on an echo model without it.
- Optional: Containers for the container tier or Kantel's own browsers, and a brwsr.dev key.
- Worker secrets for the vault: its sealing key and the model and egress gateways' shared keys.

The repository's deploy configuration names the maintainers' hostname and resources (`harbour.myslop.app`, the `harbour-weur` D1 database, the `harbour-workspaces-weur` bucket). A deployment of your own sets its own; [Cloudflare](/deploy/cloudflare/) lists them.

Self-hosted needs:

- Docker, or another way to run the gateway image.
- Postgres (`KANTEL_DATABASE_URL`) and an S3-compatible bucket (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`). Without a database URL the gateway keeps everything in memory.
- An SMTP relay for sign-in codes.
- `KANTEL_VAULT_CIPHER_KEY` for a vault. Without it a gateway on Postgres has none, and real models need one.
- Optional: CLIProxyAPI, a browser host, and ClickHouse for usage.
- `KANTEL_PUBLIC_URL` when the console is served behind a TLS proxy, since passkeys are made for that origin.

The self-hosted gateway runs commands in its own process and has no container tier yet, so gVisor matters today only for browsers. The self-hosted measurements recommend `runsc-kvm` on bare metal with `/dev/kvm`, and `runsc` inside a VM. The Docker browser host takes the runtime for its browser containers as `KANTEL_BROWSER_RUNTIME` (the default is `runc`; `runsc` or `runsc-kvm` put Chromium under gVisor). On Kubernetes it is a RuntimeClass (`KANTEL_BROWSER_RUNTIME_CLASS`).

`deploy/kubernetes` has manifests for the browser host only. They build with `kubectl kustomize` but haven't run on a cluster yet. There are no Kubernetes manifests for the gateway and its stores.

## Features on each target today

| Feature | Cloudflare | Self-hosted |
| --- | --- | --- |
| Sessions, agent profiles, host tools | Yes | Yes |
| Workspace reads | Yes | Yes |
| New workspace from a repository (`POST /v1/workspaces`), branch picker | Yes, public GitHub repositories | No |
| Prompt attachments (`/v1/attachments`) | Yes | No |
| Container tier | When deployed with it | No |
| `codemode`, `present_files`, `create_document`, `save_program` tools | Yes, each behind its own variable | Yes, each on unless its variable is `off` |
| Saved programs (`/v1/programs`) | Yes | Yes |
| `subagent` tool | Yes, with `KANTEL_SUBAGENTS` | No |
| Browsers | Yes | Yes |
| Vault and approvals | Yes, with `KANTEL_VAULT_KEY` | Yes, with `KANTEL_VAULT_CIPHER_KEY` |
| Model connectors API (`/v1/connectors`) | Yes | No |
| Connections to outside services (`/v1/connections`) | Yes, on once `KANTEL_HOSTNAME` is set | Yes, with `KANTEL_PUBLIC_URL` (or `KANTEL_CONNECTIONS_ORIGIN`, which `compose.yaml` sets) and a vault |
| `generate_image` tool | For a profile with an image model | For a profile with an image model |
| Skills, memory, prompt rules, sharing | Yes | Yes |
| Schedules | Yes | No |
| Audit log, API keys, members | Yes | Yes |
| File share links | Yes | No |
| Usage rows | D1 | Postgres, and ClickHouse if set |
| `/v1/deployment` (what backs each part) | No | Yes |

## Cost

For Cloudflare, the repository's estimate (27 October 2026, one person and one host app's tasks) is about $0 a month beyond the account's $5 Workers Paid minimum. That holds as long as the account's other Workers leave enough of the included usage. What moves it most:

- The container tier, billed per instance-second while a container runs: from a session's first command that needs one until 10 minutes after its last call.
- A console left open, which keeps `KantelStack` active. One tab open all month stays inside the included Durable Object duration and requests.
- Sessions on the `dynamic-worker` isolate, past 1,000 Dynamic Workers a month.

Model tokens are billed by your model provider, not Cloudflare. Cloudflare Access adds one seat to the account's Zero Trust organisation.

The repository has no cost estimate for self-hosting. You pay for the machines, Postgres, storage and mail relay you run it on.

<!-- Sources (8584d5b): README.md:1-3, apps/cloudflare/README.md:1-125, apps/cloudflare/README.md:214-270, apps/cloudflare/README.md:288-410, apps/cloudflare/wrangler.jsonc:1-140, apps/cloudflare/src/gateway.ts:1-36, apps/cloudflare/src/stack.ts:1-30, apps/cloudflare/src/stack.ts:366-502, apps/cloudflare/src/models.ts:1-60, apps/cloudflare/src/connectors.ts:1-40, apps/cloudflare/src/browser.ts:1-60, apps/cloudflare/src/audit-outbox.ts:1-15, apps/cloudflare/src/usage.ts:1-10, apps/selfhosted/Dockerfile:1-25, apps/selfhosted/src/gateway/main.ts:1-80, apps/selfhosted/src/gateway/gateway.ts:1-27, apps/selfhosted/src/gateway/gateway.ts:237-254, apps/selfhosted/src/gateway/durable.ts:230-265, apps/selfhosted/src/gateway/sandboxes.ts:1-27, apps/selfhosted/src/browser/docker.ts:1-10, apps/selfhosted/src/browser/host.ts:10-25, deploy/compose/README.md:1-260, deploy/compose/browser.yaml:1-20, deploy/compose/analytics.yaml:1-16, deploy/kubernetes/browser-host/README.md:1-80, targets/selfhosted/runtime/README.md:1-30, targets/selfhosted/workspace/README.md:1-20, targets/selfhosted/sandbox/README.md:1-10, images/sandbox/README.md:1-10, packages/usage/src/clickhouse.ts -->
