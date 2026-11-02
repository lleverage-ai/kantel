# Kantel self-hosted on one machine

One command starts the whole self-hosted target:

```bash
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

Then, from the repo root (needs Bun 1.3):

```bash
bun spike/conformance/run.ts --target=selfhosted          # conformance suite, Pi storage and lease tests
bun spike/scenario/run.ts                                  # the scripted research task
bun spike/scenario/run.ts --crash \
  --kill-cmd "docker compose -f deploy/compose/compose.yaml kill host-a" \
  --fallback http://127.0.0.1:58082                        # kill the owner mid tool call
deploy/compose/scripts/check-canary.sh                     # canary in no log, row or object
# The scenario shared with the Cloudflare target (spikes/scenario), needs internet:
KANTEL_SPIKE_TOKEN=unused KANTEL_CANARY=harbour-canary-0000 \
  bun spikes/scenario/run.ts --base-url http://127.0.0.1:58081 --kill-after-exec 2
docker compose -f deploy/compose/compose.yaml down -v      # stop and delete all state
```

`apps/selfhosted/test` needs the workspace installed first (`pnpm install` at the repo root).

## The gateway and the console

`gateway` serves the public APIs behind the authenticator (`@kantel/identity/authenticator`), which takes an API key
or a Kantel session from email one-time PIN sign-in, and the console's build (`apps/console`) on every other path:

| Path | API |
|---|---|
| `/auth/otp/start`, `/auth/otp/verify`, `/auth/session/end` | Email one-time PIN sign-in (`@kantel/identity/otp/http`), no credentials |
| `/v1/sessions`, `/v1/profiles`, `/v1/hosts` | Session API (`@kantel/runtime/http`, see `packages/runtime/HTTP.md`) |
| `/v1/workspaces/:id/...` | Workspace read API (`@kantel/workspace/read-api`) |
| `/v1/audit/events`, `/v1/audit/event` | Audit query API (`@kantel/audit/http`) |
| `/v1/programs/...` | Saved programs (`@kantel/programs/http`), unless `KANTEL_PROGRAMS=off` |
| `/v1/connections/...` | Connections (`@kantel/connections`), unless `KANTEL_CONNECTIONS=off` |
| `/v1/deployment` | Which implementation backs each contract |
| `/healthz` | Liveness, no credentials |
| anything else | The console |

Open the console at <http://127.0.0.1:58090/> (`KANTEL_GATEWAY_PORT` moves it). On a remote machine, forward the
port first: `ssh -L 58090:127.0.0.1:58090 <host>`. The console runs on the gateway's session API by default;
`?source=recorded` shows recorded sessions with no backend instead.

The components behind the gateway are the real implementations (`apps/selfhosted/src/gateway/durable.ts`): the
runtime's SQL session store and Pi Durable tables, the SQL audit store and identity directory, all on this Postgres in
the `harbour_m1` schema (`KANTEL_GATEWAY_SCHEMA`; the session hosts keep `kantel`), and workspaces with their trees
in MinIO under `m1/workspaces/`. Every session has a workspace, as on Cloudflare: one started without a repository
gets its own, empty (a host app's profile that names no skills is the exception, so its host's file tools stay its
own). Its session gets the tools of Cloudflare's default profile:

| Tool | What it does | Switch |
|---|---|---|
| `read`, `write`, `edit`, `ls` | Work on the workspace directly | |
| `bash` | Leases an isolate (a just-bash shell, in the gateway's process) on its first command only; closing or aborting the session releases it | |
| `present_files`, `create_document` | Show files, and write documents, as cards the console opens | `KANTEL_PRESENT_FILES=off` |
| `codemode` | Runs a script that calls the session's other tools, in a QuickJS VM on a worker thread of the gateway, one per script | `KANTEL_CODEMODE=off` |
| `save_program` | Saves a code mode program that `/v1/programs/{id}/runs` runs with no model; programs can pause for input or an agent's answer | `KANTEL_PROGRAMS=off`, `KANTEL_PROGRAM_WAITS=off` |
| `connections_list`, `connection_tools`, `connection_call`, `connection_request` | Call the outside services and MCP servers people connect in the console | `KANTEL_CONNECTIONS=off` |
| `generate_image` | Makes images, for a profile whose image model (the console's Models page) a connector lists as making images | |
| `memory_search`, `memory_read` | Recall, for a profile with memory scopes | |

Connections need an origin for OAuth to come back to: `compose.yaml` sets `KANTEL_CONNECTIONS_ORIGIN` to
`http://127.0.0.1:58090` (following `KANTEL_GATEWAY_PORT`); behind a TLS proxy set `KANTEL_PUBLIC_URL` instead. The
browser's tools come with the browser overlay (below).

A `bash` command routed to the container tier (`git` writes, `node`, `python3`, the rest of `DEFAULT_TIER_ROUTES`,
or any program the isolate lacks) runs in a container of `harbour-sandbox` that the gateway starts through the Docker
socket, one per lease, on an internal network of its own whose only other member is `vault-proxy`; its changes,
`.git` included (only `node_modules` stays in the container), are committed to the workspace after every command. The
runtime is `KANTEL_SANDBOX_RUNTIME`, `auto` for the gateway: `runsc` when the daemon has it, else `runc`. With
`KANTEL_SANDBOX_CONTAINERS=off`, or a daemon the gateway can't reach, such commands are refused. Without a model
connector (see below), sessions answer with an `echo` model. Without `KANTEL_DATABASE_URL` the gateway runs everything
in memory instead, as its in-process tests do.

On its first start the gateway creates an organisation, a project and an operator API key on the project, and writes
their IDs and the key to `/var/lib/harbour/bootstrap.json` in the container. On later starts it reads the file back
and, while the key still works, keeps that deployment, its sessions and audit trail; it ensures the `echo` agent
profile and a workspace with a README every time:

```bash
docker compose -f deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
bun apps/selfhosted/test/gateway/stack.ts     # the end-to-end test CI runs against the stack
```

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
curl -s http://127.0.0.1:58090/v1/audit/events -H "authorization: Bearer kts_…"
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
`/v1/deployment` shows the server and From address, never the credentials. Read what was sent at
<http://127.0.0.1:58025/> or through Mailpit's API (`/api/v1/search?query=to:"…"`), which is how the end-to-end tests
read codes.

### Next to a host app: host tools on a loopback callback

A host app on the same machine can serve its host tools on `http://127.0.0.1:<port>`, a port the OS picks for each
run, and register that URL with the session API. The API calls only `https:` callbacks unless the deployment says
otherwise, and inside compose's bridge network 127.0.0.1 is the gateway's own container. So the `next-to-sal.yaml`
overlay runs the gateway on the host's network, listening on 127.0.0.1 only, with
`KANTEL_CALLBACK_ORIGINS=http://127.0.0.1:*`:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/next-to-sal.yaml up -d --build --wait
```

The host app's session API URL is then `http://127.0.0.1:58090/v1`. With the overlay the gateway reaches Postgres,
MinIO and Mailpit through the ports `compose.yaml` publishes on 127.0.0.1. `KANTEL_CALLBACK_ORIGINS` takes origins
(`https://app.example`) and origins with any port (`http://127.0.0.1:*`), comma-separated; the gateway refuses to
start on anything else. With `*`, any operator key on the gateway can make it POST signed tool calls to any port on
that host, so use it only where the keys are the host app's own.

Host registrations are kept in Postgres with their callback URL and secret, so after a restart of the gateway the
host's tools still answer and a call cut off mid-way is rerun (replay-safe tools) or reported interrupted, without the
host registering again.

### Real models: CLIProxyAPI through the model gateway

Without further setup, sessions answer with the echo model (`Echo: …`) until an admin connects a model provider in
the console's first-run setup (CLI Proxy API, LiteLLM, Cloudflare AI Gateway or OpenRouter), its key in the gateway's
vault. `compose.yaml` gives the gateway a vault key of its own (`KANTEL_VAULT_CIPHER_KEY_FILE`, written at the first
start on the `gatewaystate` volume) and `host.docker.internal` for a provider on this machine. With `KANTEL_CPA_URL` and
`KANTEL_CPA_API_KEY`, the gateway runs `@kantel/model-gateway` in its process with one CLIProxyAPI connector and a
`default` route to `KANTEL_DEFAULT_MODEL` (default `claude-sonnet-5-5`), as the Cloudflare target does. CPA's key is
kept as a platform item in the gateway's vault, which records each use, so a gateway on Postgres also needs
`KANTEL_VAULT_CIPHER_KEY` (`openssl rand -base64 32`, kept: the vault's values are sealed with it). The first start
makes the item and records it in the bootstrap file; a new key makes a new item. The bootstrap adds an `assistant`
profile on `default` beside `echo`, which stays on the echo model. With the host-tools overlay:

```bash
KANTEL_CPA_URL=http://<cpa-host>:8317/v1 KANTEL_CPA_API_KEY=... KANTEL_VAULT_CIPHER_KEY=... \
  docker compose -f deploy/compose/compose.yaml -f deploy/compose/next-to-sal.yaml up -d --build --wait
```

Give CPA's address as the gateway sees it: with the overlay the gateway is on the host's network, so 127.0.0.1 is the
host itself. `next-to-sal.yaml` passes these four variables to the gateway; with `egress-vault.yaml` as well, set
`KANTEL_VAULT_CIPHER_KEY` yourself, as `next-to-sal.yaml` passes it on empty otherwise.

### Projects, skills and memory

Kantel generates project IDs (`prj_…`), so the bootstrap makes one project per name in `KANTEL_PROJECTS`
(comma-separated), once, finds them by name on later starts, and puts all of them on its operator key.
`KANTEL_PROJECTS` lists the projects to create, such as `KANTEL_PROJECTS=research,support`: the gateway makes none
beyond its own by default, with or without `next-to-sal.yaml`. They are listed by `GET /v1/projects`, and the bootstrap file names
their IDs:

```bash
docker compose -f deploy/compose/compose.yaml -f deploy/compose/next-to-sal.yaml exec -T gateway \
  cat /var/lib/harbour/bootstrap.json | jq '{organisationId, projects}'
```

Naming another project later makes it on the next start and issues a new operator key over them all, revoking the
old one.

Skills and memory are on the gateway's Postgres, with skill files' bodies in MinIO under `KANTEL_SKILLS_S3_PREFIX`
(default `m1/skills/`). The gateway serves `/v1/skills` and `/v1/memory`: reads for any key or person, and imports
and new memory spaces for the organisation's admin only (a host adapter signed in as the invited admin). On a
session's first prompt the gateway pins the skills it may see, lists the ones its profile names in a user message
before the prompt, and recalls its profile's `memoryScopes` (memory space IDs) into the same message; the system
prompt stays the profile's own. A session created without a workspace whose profile names skills gets a workspace of
its own with them mounted read-only at `/skills`, so `read /skills/<name>/SKILL.md` works. A session whose profile
names no skills gets no workspace, so a host's own `read`, `write`, `edit` and `ls` stay the host's.

### Usage: one row per model call

The gateway on Postgres writes one row per model call (tokens with the cache split, reasoning, cost, status, the
session, agent, model, provider and connector) to `usage_calls` in its schema
([results and usage](../../docs/site/src/content/docs/api/results-and-usage.md)). `KANTEL_USAGE=off` turns it off.
One session's totals:

```bash
docker compose -f deploy/compose/compose.yaml exec -T postgres psql -U kantel -c \
  "SELECT count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens)
   FROM harbour_m1.usage_calls WHERE session_id = '<session>'"
```

With `analytics.yaml` on top, the gateway also ships the rows to ClickHouse every 15 seconds, with an hourly rollup
by model, provider and connector (`harbour.usage_hourly`); its header has the commands, with the host-tools overlay
included.

### Bindings: the real implementations against the stack

`bun apps/selfhosted/test/bindings.ts` runs each real implementation the self-hosted deployment binds against its
contract's conformance suite, on this stack's Postgres, MinIO and Mailpit, and prints which pass. CI's `selfhosted`
job runs it and puts the table in the job summary. A suite that skips for want of its service counts as a failure.

| Contract | Implementation | Suite |
|---|---|---|
| Session runtime | SQL session store and Pi Durable tables on Postgres | `apps/selfhosted/test/gateway/runtime-postgres.conformance.test.ts` |
| Audit | SQL audit store and outbox on Postgres | `packages/audit/test/sql.conformance.test.ts` |
| Identity | SQL identity directory on Postgres | `packages/identity/test/sql.conformance.test.ts` |
| Email one-time PIN | OTP sign-in, mail through Mailpit | `packages/identity/test/otp.mailpit.test.ts` |
| Workspaces | Postgres and S3 (MinIO), keyed | `targets/selfhosted/workspace/test/conformance.stack.test.ts` |
| Gateway | all of the above behind the gateway, across a restart | `apps/selfhosted/test/gateway/durable.stack.test.ts` |
| Vault | engine on the Postgres vault store | `targets/selfhosted/vault/test/postgres.conformance.test.ts` |

Each suite works in its own fresh schema (and object prefix) and drops it afterwards, so running it against a shared
stack is safe. Pass `--postgres-url`, `--s3-endpoint`, `--smtp-url` and `--mailpit-url` for a second stack.

## Running a second stack

Other work may already be using a stack named `harbour` on the default ports. A second one on the same machine needs
its own project name, ports, `control` subnet, vault container name, sandbox and browser networks and image tag. Every
`docker compose` command, and the scripts here, follow `COMPOSE_PROJECT_NAME`:

```bash
export COMPOSE_PROJECT_NAME=kantel-second KANTEL_IMAGE_TAG=second \
  KANTEL_PG_PORT=56432 KANTEL_S3_PORT=59100 KANTEL_ISOLATE_PORT=58180 \
  KANTEL_HOST_A_PORT=58181 KANTEL_HOST_B_PORT=58182 KANTEL_GATEWAY_PORT=58190 \
  KANTEL_MAILPIT_PORT=58225 KANTEL_SMTP_PORT=58226 \
  KANTEL_CONTROL_PREFIX=10.250.91 KANTEL_VAULT_CONTAINER=kantel-second-vault-proxy \
  KANTEL_SANDBOX_NETWORK=kantel-second-sbx KANTEL_BROWSER_NETWORK=kantel-second-browsers
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

The tests take the matching URLs: `KANTEL_DATABASE_URL`, `S3_ENDPOINT`, `--base` for the `spike/` scripts and
`--base-url` and `--mailpit-url` for the gateway test, and `--postgres-url`, `--s3-endpoint`, `--smtp-url` and
`--mailpit-url` for `apps/selfhosted/test/bindings.ts`.

## What runs

| Service | What it is | Host port |
|---|---|---|
| `host-a`, `host-b` | Session hosts (Bun). Pi Durable 1.4.0 on Postgres, one Harness per session, Postgres session leases. Each also serves the API the `spike/` scripts drive and forwards requests for sessions it does not own. | 58081, 58082 |
| `isolate-host` | workerd from npm with a `workerLoader` binding: one Dynamic Worker per session running just-bash over the lazy MinIO workspace. Its `globalOutbound` is the vault. | 58080 |
| `vault-proxy` | Stub vault: default-deny forward proxy. Injects a header per route (`vault-policy.json`), redacts the secret from responses, audits every decision. Intercepts container HTTPS with its own CA. | none |
| `postgres` | Session directory, leases, workspace heads and history, audit, and one schema per session for Pi Durable. | 55432 |
| `minio` | Content-addressed workspace blobs and manifests. | 59000 |
| `research-site` | The page the scripted task fetches. Answers only with the injected credential. | none |
| `sandbox-image` | Builds `harbour-sandbox:dev`, the container tier's warm image, and exits. | none |
| `gateway` | The gateway (Bun): session, workspace read and audit query APIs behind the authenticator, email one-time PIN sign-in, and the console. | 58090 |
| `mailpit` | The SMTP server sign-in codes go to. Keeps messages in memory and relays nothing; web UI and API on 58025, SMTP on 58125. | 58025, 58125 |

Networks: `control` (everything but sandboxes and the fixture) and `upstream`
(vault and fixture: the outside world). Each sandbox container gets its own
`internal` network for the length of its command (`harbour-sbx-<token>`), and
the session host connects the vault (container `harbour-vault-proxy`) to it as
`vault-proxy`. A sandbox has no other route out (`curl --noproxy '*'` to a
public IP fails) and cannot reach another sandbox (the conformance suite
probes for peers). Docker's default address pools allow about 30 such
networks at once, which caps concurrent container commands on one daemon;
widen `default-address-pools` in the daemon config to raise it.

Ports are bound to 127.0.0.1 and can be moved with `KANTEL_PG_PORT`,
`KANTEL_S3_PORT`, `KANTEL_ISOLATE_PORT`, `KANTEL_HOST_A_PORT`,
`KANTEL_HOST_B_PORT`, `KANTEL_GATEWAY_PORT`, `KANTEL_MAILPIT_PORT` and
`KANTEL_SMTP_PORT`.

## Kantel's own browsers

`compose.yaml` gives the gateway's sessions a browser that Kantel runs itself, with no brwsr.dev and nothing to set.
`browser.yaml`, the overlay that used to add it, is now empty: a `COMPOSE_FILE` that still names it works as before.

- `browser-image` builds `images/browser` (Chromium and its agent) and exits; `browser-host` starts one container of it
  per browser through the Docker socket, on the `harbour-browsers` network, and keeps profiles and recordings on its
  volume, sealed with `KANTEL_BROWSER_SEAL_KEY`.
- The gateway gets `KANTEL_BROWSER_PROVIDER=kantel` and the host's URL and token. An agent asks before it opens any
  site; a person allows or declines it in the console, then watches it live and plays it back from the session.
- The live view and replay stay on the gateway's origin (`/browser/<browser>#<token>`); the gateway passes them on to
  the host only with a valid view token. Set `KANTEL_PUBLIC_URL` and `KANTEL_EMBED_ORIGINS` when another app frames
  them through the embed API.
- Like the session hosts, `browser-host` holds the Docker socket, which is root on the machine. On Kubernetes, use
  `deploy/kubernetes/browser-host` instead: a Pod per browser and no socket.
- The keys are development defaults. Anywhere else, set `KANTEL_BROWSER_HOST_TOKEN`, `KANTEL_BROWSER_VIEW_KEY` and
  `KANTEL_BROWSER_SEAL_KEY` to random values of 32 characters or more (`openssl rand -hex 32`), and keep the seal key.
- `KANTEL_BROWSER_PROVIDER=off` starts the gateway without a browser; `brwsr` with `KANTEL_BRWSR_API_KEY` uses
  brwsr.dev. `apps/selfhosted/test/gateway/compose-browser.test.ts` checks this file's browser wiring.

## Egress decisions from the gateway's vault (experimental)

The vault proxy decides from `vault-policy.json` by default (`KANTEL_EGRESS_SOURCE=static`). With
`deploy/compose/egress-vault.yaml` on top of `compose.yaml` it asks the gateway's vault instead
(`KANTEL_EGRESS_SOURCE=vault`), once per request, for that request's session:

```sh
export COMPOSE_FILE=deploy/compose/compose.yaml:deploy/compose/egress-vault.yaml
export KANTEL_RESEARCH_URL=https://research-site/   # for spike/scenario/run.ts
docker compose up -d --build --wait
```

Set `COMPOSE_FILE` for every later compose command too; `scripts/check-canary.sh` and `scripts/takeover.sh` read
it. CI's `selfhosted` job runs this way when dispatched with `-f egress_source=vault`; on `main` it stays on `static`.

- The gateway keeps a vault on its Postgres (schema `harbour_m1_vault`, values sealed with
  `KANTEL_VAULT_CIPHER_KEY`, a base64 256-bit key) and serves `POST /v1/egress/decisions` and
  `GET /v1/egress/scope` behind `KANTEL_EGRESS_KEY`, which the proxy also holds. The connection request page's API is
  at `/v1/connection-approvals` (deprecated alias `/v1/vault`).
- On its first start the gateway imports `vault-policy.json`'s routes that inject a credential (`research-site`,
  `echo`) as vault items and policies for its bootstrap organisation and project, reading the secrets they name from
  its own environment. It records the import in its bootstrap file and never imports again: from then on the vault
  page owns those items and policies, so one revoked there stays revoked. A later change to the file is logged, not
  imported (importing is additive, so a narrowed route would keep its old policy); change the grants on the vault
  page, or start from an empty database. Sessions on the session hosts (`host-a`, `host-b`) belong to no
  organisation: the proxy decides for the bootstrap organisation and project and passes the session along, and the
  vault records each use against it.
- Routes without a credential (`example`) stay the proxy's own and are allowed without asking: the vault has no
  policy that allows a request without injecting one.
- The vault injects only over https, so it decides only https requests on port 443. The research fixture answers
  over https too, with a self-signed certificate (made by the `fixture-tls` service) that only the proxy trusts.
- A denial carries the vault's reason and how to fix it, such as `No active grant or policy allows GET
  api.github.com/zen. Ask for a secret for api.github.com: no vault item is bound to it yet.`
- It fails closed: without `KANTEL_EGRESS_KEY` (or with one under 16 characters) the proxy reports unhealthy and
  refuses everything but the open routes, saying why; when the gateway can't be reached it refuses with `the vault
  could not be asked: ...`. It never falls back to the policy file's credentials.

## Timing container seeds

The stack gives you Postgres (`postgres://harbour:harbour@127.0.0.1:55432/harbour`),
MinIO (`http://127.0.0.1:59000`, user `harbour`, password `harbour-dev-secret`,
bucket `harbour`) and the warm sandbox image `harbour-sandbox:dev`. To time a
container seed the way the container tier starts one, create an internal
network, connect `harbour-vault-proxy` to it with the alias `vault-proxy`, run
on it with `--runtime "${KANTEL_SANDBOX_RUNTIME:-runc}"` and the vault as
`HTTP(S)_PROXY`; the vault refuses everything not in
`vault-policy.json`, so add a route (for example `github.com`, `tunnel: true`)
for git over HTTPS.

## Runtimes: runc or gVisor

`KANTEL_ISOLATE_RUNTIME` (the workerd container) and `KANTEL_SANDBOX_RUNTIME`
(sandbox containers) both default to `runc` for the session hosts. The
gateway's container tier reads `KANTEL_SANDBOX_RUNTIME` too, but defaults to
`auto`: `runsc` when the daemon has it registered, `runc` otherwise. workerd is not a hardened
sandbox, so production must run it under gVisor or in a microVM. To switch,
on the host:

```bash
# 1. Install gVisor (https://gvisor.dev/docs/user_guide/install/). Since release
#    20260831.0 it ships as one gvisor.tar.zstd: runsc and
#    containerd-shim-runsc-v1, plus the sentry in a gvisor-bin/ directory
#    beside them. Then register it:
sudo runsc install            # adds "runsc" to /etc/docker/daemon.json
# On bare metal with /dev/kvm, also register the KVM platform:
sudo runsc install --runtime runsc-kvm -- --platform=kvm
sudo systemctl reload docker  # or restart
# 2. Start the stack on it (runsc-kvm on bare metal, runsc in a VM):
KANTEL_ISOLATE_RUNTIME=runsc-kvm KANTEL_SANDBOX_RUNTIME=runsc-kvm \
  docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

`runsc` uses gVisor's default platform, systrap. `runsc-kvm` is the same
binary with `--platform=kvm`: on bare metal it is the fastest gVisor config
for both tiers, so it is the recommended self-hosted default where the host
has `/dev/kvm`. Inside a VM, gVisor recommends systrap.

The session host passes the runtime name to the Docker API for every sandbox
container. Keep both variables exported for every later `docker compose`
command (including `up host-a` after a kill): compose recreates a service whose
runtime differs, so a bare `up` quietly puts it back on runc.

Two things work differently under gVisor, and the stack allows for both:

- **No Docker DNS.** runsc's network stack cannot reach Docker's embedded DNS
  (127.0.0.11) on a user-defined network
  (https://gvisor.dev/docs/user_guide/faq/). So `minio` and `vault-proxy` have
  fixed addresses on `control` (`KANTEL_CONTROL_PREFIX`, default
  `10.250.89`, giving `10.250.89.0/24`; change it if that clashes with a
  network you have), the isolate host gets them through `extra_hosts`, and
  each sandbox gets the vault's address as an `/etc/hosts` entry. Anything new
  that runs under runsc must find its peers the same way.
- **Root filesystem writes stay in the sandbox** (`overlay2=root:self`), out
  of reach of Docker's archive API. `/workspace` is an anonymous volume per
  container, so the session host can read the command's changes back.

The isolate host has a fixed address as well (`.12`), on any runtime. The
session hosts run on Bun, which caches DNS answers for 30 s, so an isolate host
recreated on a new address would leave a session host that wasn't recreated
with it calling the old one, its isolate commands failing with "Unable to
connect" until the cache expired. Docker allocates every other address on
`control` from `.128` up, so nothing else can take a fixed one.

## Development shortcuts (not the production shape)

- The gateway and the session hosts mount the Docker socket to start sandboxes. Anything with
  that socket is root on the machine. Production should put container starts
  behind a small runner with a narrow API, or use Kubernetes with a
  RuntimeClass.
- Secrets are fixed development values in `compose.yaml`; the canary is
  overridable with `KANTEL_CANARY_SECRET` and is random per run in CI.
- HTTPS: the isolate's requests reach the vault in proxy form (the full
  `https://` URL), so the vault makes the TLS connection itself. A
  container's HTTPS arrives as CONNECT; the vault answers it, terminates TLS
  with a certificate from its own CA (made on first start, kept in the
  `vaultca` volume, served at `http://vault-proxy:3128/ca.crt`), and applies
  the same per-request policy inside. The session host copies that CA into
  each container and points `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
  `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` at it. A
  client that pins certificates needs a `tunnel: true` route (raw TLS, no
  injection). The CA key never leaves the vault container; production wants
  it in a KMS or HSM and short-lived.
- Your umask must let Docker read the build context (`077` breaks the image
  builds with EACCES; `chmod -R go+rX` the checkout).
