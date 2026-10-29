# @harbour/cloudflare

M1-CF1, issue [#17](https://github.com/tvdavies/harbour/issues/17): Harbour M1 on Cloudflare. One Worker, `harbour`, on
one hostname (`harbour.myslop.app`) behind Cloudflare Access with One-time PIN. It serves the console and the gateway.

```
browser ── Access (OTP) ── Worker harbour ─┬─ /v1/egress/decisions, /v1/connector-credentials ─► HarbourVault DO (VaultDO)
host app ── API key ────────┘              ├─ /v1/*      ─► HarbourStack DO ─► gateway (src/gateway.ts)
                                           │                                     ├─ POST /v1/workspaces  create a seeded workspace, operators only
                                           │                                     ├─ /v1/workspaces/…  workspace read API (#58)
                                           │                                     ├─ /v1/audit/…       audit query API (#60)
                                           │                                     └─ /v1/…             session API (#61)
                                           ├─ /healthz
                                           └─ anything else ─► console (apps/console/dist, single-page app)
```

`src/route.ts` decides which part answers. It reads a `POST /v1/workspaces` body (up to 16 MiB) before the stack
object sees it, as it does for the vault's, since the stack refuses a caller before it reads the seed.

A seed's git source is fetched from GitHub as a tarball (`createGitHubTarballFetcher`, #81) with the Worker's own
`fetch`, so only public repositories seed for now; private ones wait for the vault's egress `fetch`.

Status: step 2 of #17, in part. The stack is durable and hosted in one Durable Object (`HarbourStack`):

| Part | Where it lives | From |
| --- | --- | --- |
| Identity directory | D1 `DB` | `@harbour/identity/sql` |
| Audit store | D1 `DB` | `@harbour/audit/sql` |
| Workspaces | R2 `WORKSPACES`, under `workspaces/`; each head also kept in `HarbourStack`'s storage, in front of R2 | `@harbour/cloudflare-workspace` (`src/workspace-heads.ts`) |
| Session directory, profiles, host registrations, each session's Pi storage; the alarm that resumes a run an eviction cut off | `HarbourStack`'s own SQLite and alarm | `SessionRuntimeDurableObjectCore` (`@harbour/runtime-cloudflare`) |
| The bootstrap's organisation, project and admin | `HarbourStack`'s storage | `src/stack.ts` |
| Vault records (items with sealed values, policies, proposals, grants, uses) | `HarbourVault`'s own SQLite | `@harbour/vault-cloudflare` |
| Vault audit events | D1 `DB`, in the same audit store | `@harbour/audit/sql` |
| Sandboxes: #94's tiers, leases, the TTL sweep and session-end release; the isolate on `HARBOUR_ISOLATE_BACKEND` | `HarbourStack`, leases in memory | `@harbour/sandbox` (`src/sandboxes.ts`) |

Migrations run on every start of the object; each is idempotent. The bootstrap saves each step as it completes, so a
restart finds the same organisation rather than making another. Sessions run on the model gateway when the Worker has
`MODELS` and `HARBOUR_CPA_API_KEY`, and on an echo model (`src/echo-model.ts`) otherwise.

## Decisions

**One Durable Object for every session in M1** (28 Oct 2026). `HarbourStack` is M1's SessionDO: the runtime lane's
`SessionRuntimeDurableObjectCore` (#98) runs every session in its one SQLite, with its alarm.

- Why: in M0, first contact with a brand-new SessionDO alone took 467 ms p50 and 1,773 ms p95
  ([M0-CF1 measurements](../../docs/measurements/m0-cf1/README.md), "Where the time goes"), against #17's target of
  100 ms p50 for the whole of isolate-ready. A warm, shared object pays none of it.
- What it costs: every session shares one single-threaded object, so one session's CPU-heavy work (an in-process
  isolate command, a large commit) delays every other session's requests, and the object's memory and request rate
  bound how many sessions run at once.
- What replaces it: per-session objects taken from a pool of pre-created, idle objects (so a new session never pays
  creation), with a session directory in D1 so the gateway routes each session to its object. Not built yet.

**Workspace heads are kept in the object, in front of R2** (29 Oct 2026). Every workspace call starts by reading the
workspace's head, and a sandbox run makes two: about 55 ms each from the object to R2, most of a warm isolate-ready
run's server time ([m1-cf1 measurements](../../docs/measurements/m1-cf1/README.md)). `HarbourStack` keeps each head's
document and etag in its own storage (`ctx.storage.kv`, `src/workspace-heads.ts`), and the R2 store reads it from there.
R2 stays the source of truth: a write drops the cached head before it starts and puts back only what it wrote, and a
load that overlapped a write caches nothing. It relies on the decision above: every write to the workspaces goes
through the one object. A write made anywhere else is seen once a write here fails its conditional put on it.

**The isolate backend is a switch** (28 Oct 2026). `HARBOUR_ISOLATE_BACKEND` picks where the isolate tier runs, so
the isolate-ready measurement can run on each and the target is set with real numbers. `in-process` (the default)
runs #94's just-bash shell inside `HarbourStack`. `dynamic-worker`, the plan's isolate, runs the same shell in a
Dynamic Worker per session through the `LOADER` (`worker_loaders`) binding, as the M0 spike ran it
(`src/dynamic-worker.ts`). The measurement can run on either, whichever one sessions use. The container tier is not on
Cloudflare yet: a command routed to it is refused `unavailable`.

How `dynamic-worker` works:

- **One isolate per session and workspace.** The loader ID names the organisation, session, workspace and a digest
  of the isolate's code, so a session's later commands reuse its warm isolate, sessions never share one, and a deploy
  that changes the isolate never reuses an old one.
- **The workspace crosses as a capability.** The isolate (`src/isolate/entry.ts`, bundled by
  `scripts/build-isolate.ts` into `generated/isolate.bundle.txt`) has no bindings and no network
  (`globalOutbound: null`, so `curl` fails). Each command passes it a `WorkspacePort`, an RPC target in
  `HarbourStack`, that lists a version and reads bodies and mounts with the caller's context, which the isolate never
  sees. It can't write: what a command changed comes back in the result, and the tiered sandboxes commit it before the
  tool call returns, as for `in-process`.
- **Cancellation:** an `AbortSignal` can't cross RPC, so while a cancellable command runs the isolate asks the port
  every 50 ms whether the caller has cancelled, and aborts the shell when it has; the shell stops at its next
  statement, as in process. The caller's call rejects `aborted` at once, and anything the isolate answers later is
  dropped, so nothing is committed.

## Measuring isolate-ready

`POST /v1/measurements/isolate-ready`, body `{ "backend"?: "in-process" | "dynamic-worker", "placement"?: true }`
(`src/measure.ts`), signed in like any API call. Each run creates a new session on a 61-file measurement workspace
(made once per object start), runs `ls -1R` in the session's isolate, answers `{ backend, exitCode, listed, timings }`
(server milliseconds for `signIn`, `session`, `isolate` and `total`, plus the sandbox's own phases; `total` leaves out
`signIn`), and closes the session. On `dynamic-worker`, `isolate.call` is the round trip into the isolate and
`isolate.cold` is 1 when the command loaded it. Run it 50 times and take p50 and p95 of the client's wall time and of
`timings.total`.

With `"placement": true` the answer adds `placement`, probed after the run: `objectColo` (the colo the stack object's
own subrequest to Cloudflare's `/cdn-cgi/trace` reaches, so where the object runs), `edgeColo` (`request.cf.colo`),
and D1's `region`, `colo` and `primary` from its query `meta` (`served_by_region`, `served_by_colo`,
`served_by_primary`), with five `SELECT 1` round trips and D1's own `sql_duration_ms` for each, and `r2`: five
round trips (`head` of a key that doesn't exist) to the workspace bucket, which says nothing else of where it is.

## The vault (VaultDO)

`HarbourVault` (`src/vault-object.ts`) is a thin wrapper over `VaultDurableObjectCore` from
`@harbour/vault-cloudflare`, as the vault contract (`packages/vault/CONTRACT.md`) intends. One object, named `vault`,
holds every organisation's records and the platform's items, in its own SQLite (migration `v2`). Its audit events go to
the stack's D1 audit store, so the audit view shows them.

It serves the vault's egress decision API (`@harbour/vault/egress-api`), both `POST`:

| Route | Caller |
| --- | --- |
| `/v1/egress/decisions` | the egress gateway, which asks what to inject on a sandbox's outbound request |
| `/v1/connector-credentials` | the model gateway (#100), which reads a connector's key |

These are worker calls: each component authenticates with its own shared key, and the vault refuses anyone else,
people and agents included. On the deployed hostname Access is in front of them too; a Worker with a service binding
to `harbour` reaches them without Access. The same two calls are RPC methods on the object for code in this Worker.
The human side of the vault (the console's vault page deciding requests) has no HTTP API yet.

Its secrets are Worker secrets, never vars (`scripts/deploy-config.ts` refuses them in `wrangler.jsonc`):

| Secret | What it is | Without it |
| --- | --- | --- |
| `HARBOUR_VAULT_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`): the AES-256-GCM key item values are sealed with | the vault answers every call `unavailable` (503) |
| `HARBOUR_VAULT_MODEL_GATEWAY_TOKEN` | the model gateway's shared key, at least 16 characters | the model gateway is refused (403) |
| `HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN` | the egress gateway's shared key, at least 16 characters | the egress gateway is refused (403) |

The deploy sets each one that exists as a repository secret of the same name (`scripts/vault-secrets.ts`, then
`wrangler deploy --secrets-file`). Wrangler's secrets file is additive, so a deploy never removes one. Don't change
`HARBOUR_VAULT_KEY` once the vault holds a value: values sealed under the old key no longer open, and there is no
rotation yet. `wrangler dev --env dev` has a fixed, public dev key and model gateway token in its vars; they seal
nothing but local state.

## Who gets in

Every API call authenticates with `createAuthenticator` from `@harbour/identity`:

- People: the Access application token in `Cf-Access-Jwt-Assertion`, verified by `cloudflareAccessProvider` against
  `HARBOUR_ACCESS_TEAM_DOMAIN` and `HARBOUR_ACCESS_AUD` (RS256, issuer `https://<team domain>`, keys from
  `/cdn-cgi/access/certs`). Harbour is invite-only: the bootstrap invites `HARBOUR_ADMIN_EMAIL` as the organisation's
  admin, and Access's verified email links them on first sign-in. Anyone else Access lets through is still 401 here.
- Host apps: `Authorization: Bearer hbr_…`, an API key scoped to projects.

The team domain and AUD come as a pair; one without the other is refused (503) rather than served with sign-in off.
Project access asks identity for the caller's role on every item a list returns, and each answer is two or three D1
queries, so the runtime's directory looks a role up once per request (`src/role-memo.ts`): memoised per signed-in
actor object, which the authenticator makes afresh for each request, and for at most 1 s.

Static assets are served before the Worker runs, so only Access guards the console's files. `workers_dev` and
`preview_urls` are off, because those URLs would bypass Access.

## Local

```sh
pnpm --filter @harbour/cloudflare dev          # builds the console, then wrangler dev --env dev
curl localhost:8787/__dev/access-token          # { header, token } from a mock Access issuer for the dev admin
curl localhost:8787/__dev/api-key               # { secret, projectId }: an operator key for the default project
```

`wrangler dev` keeps D1, R2 and the object's SQLite in `.wrangler/state`, so local state survives a restart; delete
that directory to start afresh. `--env dev` runs `src/dev.ts`: the deployed Worker plus a mock Access issuer (its keys are local; the gateway still
verifies with the real provider) and the two `/__dev/` routes. It is never the deployed entry point, and
`test/gateway.test.ts` checks that no other module imports it.

`pnpm --filter @harbour/cloudflare deploy:dry-run` builds the console and the dynamic-worker isolate and bundles the
deployed Worker into `dist/` without contacting Cloudflare. `wrangler dev` runs the Worker Loader locally too, so
`HARBOUR_ISOLATE_BACKEND=dynamic-worker` (or the measurement's `backend`) works on a laptop.

## Deploy

CI deploys, never a person or an agent: `.github/workflows/cloudflare-deploy.yml`, on a push to main that touches the
Worker, the console or a package, or a manual run from main. The account side (the token, the Access application, the
VPC service and the IDs) is made by Tom's setup runbook (#17, Account setup). CI reads:

| Name | Kind | What it is |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | The deploy token, with the permissions below |
| `CLOUDFLARE_ACCOUNT_ID` | variable | The account to deploy to |
| `HARBOUR_HOSTNAME` | variable | The one hostname, `harbour.myslop.app`, served by the zone route `<hostname>/*` on its parent zone (`myslop.app`) |
| `HARBOUR_ACCESS_TEAM_DOMAIN` | variable | The Access team domain, such as `<team>.cloudflareaccess.com` |
| `HARBOUR_ACCESS_AUD` | variable | The AUD tag of the Access application on `HARBOUR_HOSTNAME` |
| `HARBOUR_MODELS_VPC_SERVICE_ID` | variable | The Workers VPC service to CLIProxyAPI through the `sal-app` tunnel, bound as `MODELS` |
| `HARBOUR_ADMIN_EMAIL` | variable | The first admin, invited by email; Access's verified email links them on first sign-in |
| `HARBOUR_D1_DATABASE_NAME` with `HARBOUR_D1_DATABASE_ID` | optional variables | Another D1 database for `DB`, bound by name and ID, so one that doesn't exist fails the deploy. Unset: `harbour-weur`, by name |
| `HARBOUR_R2_BUCKET` | optional variable | Another bucket for `WORKSPACES`. Unset: `harbour-workspaces-weur`. It must exist first: wrangler would otherwise create it by name, wherever it likes |
| `HARBOUR_LOCATION_HINT` | optional variable | The location hint the stack and vault objects are created with (`src/route.ts`). Unset: `weur`, from `wrangler.jsonc` |
| `HARBOUR_VAULT_KEY`, `HARBOUR_VAULT_MODEL_GATEWAY_TOKEN`, `HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN` | optional secrets | The vault's key and the components' shared keys (see The vault above); each is set on the Worker when it exists, and the deploy goes ahead without them |

Until the secret and every variable exist, and on every pull request, the workflow only runs `wrangler deploy
--dry-run`, with placeholders for what's unset; that never contacts Cloudflare. Once they all exist, a run on main:

1. writes `wrangler.deploy.json`: `wrangler.jsonc` with the account, the zone route, the Access vars, the admin
   email and the `MODELS` VPC service filled in (`scripts/deploy-config.ts`; it refuses a missing or malformed value,
   and a base config that could serve on workers.dev or a preview URL);
2. runs the dry run, then `wrangler deploy`, with `--secrets-file` for the vault secrets that are set. Deploys find the D1 database `harbour-weur` and the R2 bucket
   `harbour-workspaces-weur` by name; wrangler's automatic provisioning would create either if it were missing;
3. checks that an anonymous request to the console, a deep link, `/v1/sessions` and `/healthz` is redirected to
   `https://<team domain>/cdn-cgi/access/login/…` (`scripts/check-access.ts`), and fails otherwise.

**Where the data lives.** The optional variables above exist so a database and bucket made in another region can be
swapped in without a code change. Cloudflare places by region hint, never by city or colo: `weur` (western Europe)
holds Amsterdam and London alike. A D1 database's location is fixed when it's created (`--location`), so moving it
means a new database with the data copied in; an R2 bucket's the same. The objects take `HARBOUR_LOCATION_HINT` only
when they're first created: the existing `m1` stack object and `vault` object stay where they are, whatever it says,
and renaming one would start it empty.

Harbour is served on a zone route, `harbour.myslop.app/*` with `zone_name: "myslop.app"`, not a custom domain. The
`myslop.app` zone already has a `*.myslop.app/*` route to the `myslop-apps` Worker, and Cloudflare gives a route
precedence over a custom domain on the same hostname, so a custom domain would be shadowed. Between routes the most
specific pattern wins, so `harbour.myslop.app/*` beats the wildcard
([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). A route makes no DNS record of its
own: the zone's proxied wildcard record (`*.myslop.app`) already resolves the hostname, so none is needed for it. The
zone is the hostname's parent, so `HARBOUR_HOSTNAME` must be a direct subdomain of its zone.

The first three deploys (27 Oct 2026, before #92) attached `harbour.myslop.app` as a custom domain. Wrangler only
manages the trigger kinds a config names, so the routes-only deploys since have left it in place. The route takes
precedence over it, so it does no harm; removing it is an account change (the Worker's Domains & Routes in the
dashboard), not something the deploy does.

### The deploy token's permissions

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy the Worker, its Durable Objects and its static assets |
| Account | D1: Edit | Look up the `harbour-weur` database by name (and create it if it were missing) |
| Account | Workers R2 Storage: Edit | Look up the `harbour-workspaces-weur` bucket by name (and create it if it were missing) |
| Account | Connectivity Directory: Bind | Bind the existing Workers VPC service (`MODELS`) |
| Zone (myslop.app) | Workers Routes: Edit | Add the zone route `HARBOUR_HOSTNAME/*` |

A zone route needs only Workers Routes edit on the zone; it makes no DNS record, so DNS edit isn't needed. Later steps of #17 may add more, such as Containers for the container tier; each will be listed here.

## Cost estimate

M1 as deployed (27 Oct 2026): one Worker with static assets, one Durable Object (`HarbourStack`), D1, R2 and a
Workers VPC service, for one person and Sal's tasks. Prices are Cloudflare's published rates
(https://developers.cloudflare.com/workers/platform/pricing/,
https://developers.cloudflare.com/workers-vpc/reference/pricing/), checked 27 Oct 2026.

| Part | Included each month on Workers Paid | M1 use, roughly | Cost |
| --- | --- | --- | --- |
| Workers Paid plan | | | $5 minimum per account, shared with everything else on it |
| Worker requests and CPU | 10 M requests, 30 M CPU ms | ~0.3 M requests, ~3 M CPU ms (console open 8 h a day) | $0 |
| Static assets (console) | free and unlimited | | $0 |
| Durable Object requests | 1 M | ~0.3 M (console open 8 h a day) | $0 |
| Durable Object duration | 400,000 GB-s | ~108,000 GB-s (console open 8 h a day) | $0, see below |
| Durable Object SQLite | 25 bn rows read, 50 M written, 5 GB | well under | $0 |
| D1 (identity, audit) | 25 bn rows read, 50 M written, 5 GB | well under | $0 |
| R2 (workspaces) | 10 GB-month, 1 M class A, 10 M class B | < 1 GB, < 0.1 M ops | $0 |
| Workers VPC (`MODELS`) | free during the open beta | | $0 |
| Dynamic Workers (`dynamic-worker` backend, added 28 Oct 2026) | 1,000 unique Dynamic Workers a month; requests and CPU count as Workers' | one per session and workspace on each day it runs a command; 51 per 50-run measurement | $0 while sessions use `in-process`; past 1,000 a month, $0.002 each per day |
| Model tokens | | through CLIProxyAPI on Sal's host | not billed by Cloudflare |

Estimate: **about $0 a month on top of the account's $5 Workers Paid minimum**, as long as the account's other
Workers leave enough of the included usage (it is per account, not per Worker). Access sign-in adds one seat
to the account's existing Zero Trust organisation; whether that costs anything depends on that plan.

What would move it:

- **An open console.** It polls the session list every 3 s (`LIST_POLL_MS` in `apps/console/src/api/http.ts`), and
  an open event stream (`GET /v1/sessions/:id/events`) holds a request open, so `HarbourStack` stays active, billed at
  128 MB, for as long as a console is open: about 324,000 GB-s and 0.9 M requests for one tab left open all month,
  inside the 400,000 GB-s and 1 M requests included. Every tab reaches the same object, so a second tab adds
  requests (another 0.9 M, about $0.11 past the allowance at $0.15 per million), not duration.
- **A SessionDO per session.** Then each session with an open stream is its own active object, and duration adds up
  per object: each one held open all month is about 324,000 GB-s, or about $4 at $12.50 per million GB-s once past
  the allowance.
- **The container tier**, when it lands: Containers bill per instance-second, so it will dominate. It gets its own
  line here with that step.
- **Workers VPC** pricing after its beta.
- **Sessions on `dynamic-worker`.** Cloudflare counts a Dynamic Worker per loader ID and code version per day
  (https://developers.cloudflare.com/dynamic-workers/pricing/), and Harbour's loader ID is per session and workspace,
  so the count is the sessions that run a command each day, plus one per deploy for each session still in use. At
  M1's scale that is well inside 1,000 a month; 100 sessions a day would be about 3,000 a month, about $4 past the
  allowance. Each command is one request into the isolate, and its startup CPU (parsing the 1.25 MB bundle) is billed
  as Workers CPU.

The VaultDO adds a second object, active only while it answers an egress decision or a key read, so its duration
stays far inside the allowance.

#17's definition of done checks this against the first week's bill.

## Checks

`pnpm --filter @harbour/cloudflare test` runs the gateway over the in-memory stack in Node: Access tokens for the right
team domain and AUD sign the invited person in; another AUD, another team domain, an expired token, a service token or
an uninvited email are 401; API keys work on every API; and each API is mounted where its client expects it.
`test/durable.test.ts` runs the stack over SQLite and an in-memory object store, restarts it, and finds the same
organisation, sessions with their transcripts, workspaces and audit; and resumes a bootstrap that stopped half way.
`test/deploy.test.ts` checks the deploy config (every variable to deploy, placeholders for a dry run, malformed
values refused, the dev environment dropped) and the Access sign-in check. `test/vault.test.ts` builds the VaultDO's
core over SQLite, restarts it, and reads a connector's key over the egress decision API with the model gateway's
shared key, with no value in its rows or the audit store; refuses callers without a key; won't start without a vault
key; routes only the two vault paths to the vault object; and checks the vault's secrets in the deploy.
