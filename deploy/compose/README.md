# Kantel self-hosted on one machine

One command starts the self-hosted stack, as the installer (`kantel.dev/install.sh`) does:

```bash
docker compose -f deploy/compose/compose.yaml up -d --build --wait --remove-orphans
```

Then, from the repo root (needs Bun 1.3 and `pnpm install`):

```bash
bun apps/selfhosted/test/gateway/stack.ts     # the end-to-end test CI runs against the stack
bun apps/selfhosted/test/bindings.ts          # the real implementations against the stack's Postgres and Mailpit
docker compose -f deploy/compose/compose.yaml down -v   # stop and delete all state
```

## What runs

| Service | What it is | Host port |
|---|---|---|
| `gateway` | The console, the compute plane's API, the hosts' endpoint, sign-in, identity and audit (`apps/selfhosted/src/gateway`) | 127.0.0.1:58090 (`KANTEL_GATEWAY_PORT`) |
| `postgres` | Identity, sign-in codes, audit and the registry of hosts, in the `harbour_m1` schema | 127.0.0.1:55432 (`KANTEL_PG_PORT`) |
| `mailpit` | Where sign-in codes go; its web UI and API read them | 127.0.0.1:58025 (`KANTEL_MAILPIT_PORT`), SMTP on 58125 (`KANTEL_SMTP_PORT`) |

Sandboxes don't run in this stack: they run on hosts, Linux machines running the Kantel host agent (`kantel-host`),
which you add from the console's **Hosts** page (**Add a host**) or with `kantel-admin host join`. A host dials out to
the gateway, so it needs no open port. Hosts on this machine join at `http://127.0.0.1:58090`; hosts elsewhere need
`KANTEL_PUBLIC_URL`, the address they reach the gateway at (see [Hosts](../../docs/site/src/content/docs/hosts.md)).
Until a host joins, the console says so and offers **Add a host**.

## The gateway

The gateway serves, behind the authenticator (`@kantel/identity/authenticator`), which takes an API key or a session
from email one-time PIN sign-in:

| Path | What |
|---|---|
| `/auth/otp/start`, `/auth/otp/verify`, `/auth/session/end` | Email one-time PIN sign-in (`@kantel/identity/otp/http`), no credentials |
| `/v1/sandboxes`, `/v1/snapshots`, `/v1/api-keys`, `/v1/webhooks`, `/v1/admin/hosts`, `/v1/whoami`, … | The compute plane's API (`@kantel/compute`; `packages/api` documents it) |
| `/v1/hosts/...` | The hosts' endpoint: joining, the hosts' WebSocket and their images |
| `/v1/me`, `/v1/projects`, `/v1/organisations`, `/v1/members`, `/v1/invites`, `/v1/keys` | Identity: organisations, projects, members, invites and operator keys |
| `/v1/audit/events`, `/v1/audit/event` | Audit queries (`@kantel/audit/http`) |
| `/v1/deployment` | Which implementation backs each contract |
| `/healthz` | Liveness, no credentials |
| any other `/v1/...` path | 404 |
| anything else | The console (`apps/console`) |

Open the console at <http://127.0.0.1:58090/>. On a remote machine, forward the ports first:
`ssh -L 58090:127.0.0.1:58090 -L 58025:127.0.0.1:58025 <host>`.

Organisation admins are the compute plane's super-admins: they see and manage every host and pool. On its first start
the gateway creates an organisation, a project and an operator API key, and writes their IDs and the key (and the
compute plane's super-admin key) to `/var/lib/harbour/bootstrap.json` in the container, on the `gatewaystate` volume.
On later starts it reads the file back and, while the key still works, keeps that deployment:

```bash
docker compose -f deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
```

The compute plane's own records (sandboxes, snapshots, scoped keys and webhooks) are in the gateway's memory for now,
so they go when it restarts; the registry of hosts is in Postgres, so hosts stay joined. `KANTEL_COMPUTE_BACKEND=stub`
runs sandboxes on a stand-in with no hosts, as the in-process tests do. Without `KANTEL_DATABASE_URL` the gateway keeps
everything in memory.

### Signing in, and mail

Sign-in is by email one-time PIN (the flow in `packages/identity/CONTRACT.md`). Kantel is invite-only: the gateway
invites `KANTEL_ADMIN_EMAIL` (default `admin@harbour.localhost`) as an organisation admin at start, unless someone can
already sign in with that email. To sign in as them:

```bash
curl -s -X POST http://127.0.0.1:58090/auth/otp/start -H 'content-type: application/json' \
  -d '{"email":"admin@harbour.localhost"}'                      # 202, whoever the email is
# read the code at http://127.0.0.1:58025/, then:
curl -s -X POST http://127.0.0.1:58090/auth/otp/verify -H 'content-type: application/json' \
  -d '{"email":"admin@harbour.localhost","code":"123456"}'      # 200 {token: "kts_…", user, organisationIds}
curl -s http://127.0.0.1:58090/v1/whoami -H "authorization: Bearer kts_…"
```

Codes last 10 minutes and sessions 12 hours, both on Postgres (`identity_otp_codes`, `identity_sessions`). Sign-in and
sign-out are audited. Beside the identity package's limit of 5 codes per email an hour, the gateway allows 30 sign-in
requests per client address per 15 minutes (429 past it). Behind a reverse proxy every client shares its address, so
limit there instead.

The gateway sends codes through `KANTEL_SMTP_URL` from `KANTEL_MAIL_FROM`: `smtps://` (TLS from the start),
`smtp://` (STARTTLS required), or `smtp://…?starttls=off` (in the clear, for a relay on a private network),
credentials in the URL if the relay needs them. In compose both default to Mailpit
(`smtp://mailpit:1025?starttls=off`, `Kantel <harbour@harbour.localhost>`); set them to use a real relay. Without
`KANTEL_SMTP_URL` the sign-in routes answer 503. The gateway refuses to start on a malformed value, and
`/v1/deployment` shows the server and From address, never the credentials.

People can also sign in with GitHub or Google (`@kantel/identity/oauth`) once `KANTEL_PUBLIC_URL` is set and a
provider's `KANTEL_GITHUB_CLIENT_ID` and `KANTEL_GITHUB_CLIENT_SECRET` (or `KANTEL_GOOGLE_CLIENT_ID` and
`KANTEL_GOOGLE_CLIENT_SECRET`) are. Register `$KANTEL_PUBLIC_URL/auth/oauth/github/callback` (or `.../google/callback`)
as the client's callback. It is invite-only as codes are: the provider's verified email must match an invite or a user,
and it shares the per-address limit. The [install guide](../../docs/site/src/content/docs/self-hosting/install.md#sign-in-with-github-or-google)
has the steps.

### On the host's network

The `next-to-sal.yaml` overlay runs the gateway on the host's network, listening on 127.0.0.1 only, reaching Postgres
and Mailpit through the ports `compose.yaml` publishes:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/next-to-sal.yaml up -d --build --wait --remove-orphans
```

### Projects

The bootstrap makes one project per name in `KANTEL_PROJECTS` (comma-separated) besides the first, once, and puts
every one on its operator key. Naming another project later makes it on the next start and issues a new operator key
over them all, revoking the old one.

### Bindings: the real implementations against the stack

`bun apps/selfhosted/test/bindings.ts` runs each real implementation the self-hosted deployment binds against its
contract's conformance suite, on this stack's Postgres and Mailpit, and prints which pass. CI's `selfhosted` job runs
it and puts the table in the job summary. A suite that skips for want of its service counts as a failure.

| Contract | Implementation | Suite |
|---|---|---|
| Audit | SQL audit store and outbox on Postgres | `packages/audit/test/sql.conformance.test.ts` |
| Identity | SQL identity directory on Postgres | `packages/identity/test/sql.conformance.test.ts` |
| Email one-time PIN | OTP sign-in, mail through Mailpit | `packages/identity/test/otp.mailpit.test.ts` |
| Gateway | identity, audit and the hosts' registry behind the gateway, across a restart | `apps/selfhosted/test/gateway/durable.stack.test.ts` |

Each suite works in its own fresh schema and drops it afterwards, so running it against a shared stack is safe. Pass
`--postgres-url`, `--smtp-url` and `--mailpit-url` for a second stack.

## Upgrading from the agent plane

Versions before November 2026 ran Kantel's agent plane in this stack as well: sessions, agent profiles, models and
inference, connections, the vault and its egress proxy, Kantel's own browsers, skills, memory and usage analytics,
with session hosts, an isolate host, MinIO and a browser host beside the gateway. They were removed; the compute plane
is the product.

`curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade` moves an install to this version. It keeps
`deploy/compose/.env` and the `pgdata` and `gatewaystate` volumes, so the same organisation, project, keys and sign-ins
carry over, and runs `up --remove-orphans`, which stops and removes the old services' containers. What they kept stays
where it was:

- **Postgres**: the agent plane's tables (sessions, submissions, profiles, workspaces, the vault, usage) stay in the
  `harbour_m1` and `kantel` schemas, unread. Nothing drops or migrates them, so going back to an older version finds
  them as they were.
- **Volumes**: `miniodata` (workspaces' files), `vaultca` and `browserdata` stay until you remove them. To see them:
  `docker volume ls --filter label=com.docker.compose.project=harbour` (or your `COMPOSE_PROJECT_NAME`).
- **Containers the old gateway started** (sandboxes of the container tier, browsers) aren't Compose's, so
  `--remove-orphans` doesn't see them. List them with `docker ps -a --filter label=harbour.stack` and
  `docker ps -a --filter label=harbour.browser-host`, and remove them with `docker rm -f` once you're sure they're
  that stack's.
- **Settings** the agent plane read (`KANTEL_CPA_URL`, `KANTEL_DEFAULT_MODEL`, `KANTEL_VAULT_CIPHER_KEY`,
  `KANTEL_SUBAGENTS`, `KANTEL_BROWSER_PROVIDER`, `KANTEL_SANDBOX_RUNTIME`, `KANTEL_DOCKER_SOCKET_PATH` and the like) are
  ignored if they are still in `.env`.

The agent plane's `/v1/sessions`, `/v1/profiles`, `/v1/models`, `/v1/connections` and the rest now answer 404, so an
app that drove sessions through this gateway must stay on an older version. The last version with the agent plane is
the `agent-plane-archive-2026-11-03` tag (and the `agent-plane-archive` branch):

```bash
curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade --ref agent-plane-archive-2026-11-03
```

## Running a second stack

Other work may already be using a stack named `harbour` on the default ports. A second one on the same machine needs
its own project name, ports, `control` subnet and image tag. Every `docker compose` command follows
`COMPOSE_PROJECT_NAME`:

```bash
export COMPOSE_PROJECT_NAME=kantel-second KANTEL_IMAGE_TAG=second \
  KANTEL_PG_PORT=56432 KANTEL_GATEWAY_PORT=58190 \
  KANTEL_MAILPIT_PORT=58225 KANTEL_SMTP_PORT=58226 \
  KANTEL_CONTROL_PREFIX=10.250.91
docker compose -f deploy/compose/compose.yaml up -d --build --wait --remove-orphans
```

The tests take the matching URLs: `--base-url` and `--mailpit-url` for the gateway test, and `--postgres-url`,
`--smtp-url` and `--mailpit-url` for `apps/selfhosted/test/bindings.ts`.
