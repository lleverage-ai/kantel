# @harbour/cloudflare

M1-CF1, issue [#17](https://github.com/tvdavies/harbour/issues/17): Harbour M1 on Cloudflare. One Worker, `harbour`, on
one hostname (`harbour.myslop.app`) behind Cloudflare Access with One-time PIN. It serves the console and the gateway.

```
browser ── Access (OTP) ── Worker harbour ─┬─ /v1/*      ─► HarbourStack DO ─► gateway (src/gateway.ts)
host app ── API key ────────┘              │                                     ├─ /v1/workspaces/…  workspace read API (#58)
                                           │                                     ├─ /v1/audit/…       audit query API (#60)
                                           │                                     └─ /v1/…             session API (#61)
                                           ├─ /healthz
                                           └─ anything else ─► console (apps/console/dist, single-page app)
```

Status: step 2 of #17, in part. The stack is durable and hosted in one Durable Object (`HarbourStack`):

| Part | Where it lives | From |
| --- | --- | --- |
| Identity directory | D1 `DB` | `@harbour/identity/sql` |
| Audit store | D1 `DB` | `@harbour/audit/sql` |
| Workspaces | R2 `WORKSPACES`, under `workspaces/` | `@harbour/cloudflare-workspace` |
| Session directory, profiles, each session's Pi storage | `HarbourStack`'s own SQLite | `@harbour/runtime/sql` |
| The bootstrap's organisation, project and admin | `HarbourStack`'s storage | `src/stack.ts` |

Migrations run on every start of the object; each is idempotent. The bootstrap saves each step as it completes, so a
restart finds the same organisation rather than making another. Still to come: a SessionDO per session, VaultDO, and
the models binding to CLIProxyAPI (`MODELS`, already bound by the deploy); until then sessions run on an echo model
(`src/echo-model.ts`).

## Who gets in

Every API call authenticates with `createAuthenticator` from `@harbour/identity`:

- People: the Access application token in `Cf-Access-Jwt-Assertion`, verified by `cloudflareAccessProvider` against
  `HARBOUR_ACCESS_TEAM_DOMAIN` and `HARBOUR_ACCESS_AUD` (RS256, issuer `https://<team domain>`, keys from
  `/cdn-cgi/access/certs`). Harbour is invite-only: the bootstrap invites `HARBOUR_ADMIN_EMAIL` as the organisation's
  admin, and Access's verified email links them on first sign-in. Anyone else Access lets through is still 401 here.
- Host apps: `Authorization: Bearer hbr_…`, an API key scoped to projects.

The team domain and AUD come as a pair; one without the other is refused (503) rather than served with sign-in off.
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

`pnpm --filter @harbour/cloudflare deploy:dry-run` builds the console and bundles the deployed Worker into `dist/`
without contacting Cloudflare.

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

Until the secret and every variable exist, and on every pull request, the workflow only runs `wrangler deploy
--dry-run`, with placeholders for what's unset; that never contacts Cloudflare. Once they all exist, a run on main:

1. writes `wrangler.deploy.json`: `wrangler.jsonc` with the account, the zone route, the Access vars, the admin
   email and the `MODELS` VPC service filled in (`scripts/deploy-config.ts`; it refuses a missing or malformed value,
   and a base config that could serve on workers.dev or a preview URL);
2. runs the dry run, then `wrangler deploy`. On the first deploy wrangler creates the D1 database `harbour` and the
   R2 bucket `harbour-workspaces` (its automatic provisioning, by name); later deploys find them by name;
3. checks that an anonymous request to the console, a deep link, `/v1/sessions` and `/healthz` is redirected to
   `https://<team domain>/cdn-cgi/access/login/…` (`scripts/check-access.ts`), and fails otherwise.

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
| Account | D1: Edit | Create the `harbour` database on the first deploy and look it up by name after |
| Account | Workers R2 Storage: Edit | Create the `harbour-workspaces` bucket on the first deploy and look it up by name after |
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

#17's definition of done checks this against the first week's bill.

## Checks

`pnpm --filter @harbour/cloudflare test` runs the gateway over the in-memory stack in Node: Access tokens for the right
team domain and AUD sign the invited person in; another AUD, another team domain, an expired token, a service token or
an uninvited email are 401; API keys work on every API; and each API is mounted where its client expects it.
`test/durable.test.ts` runs the stack over SQLite and an in-memory object store, restarts it, and finds the same
organisation, sessions with their transcripts, workspaces and audit; and resumes a bootstrap that stopped half way.
`test/deploy.test.ts` checks the deploy config (every variable to deploy, placeholders for a dry run, malformed
values refused, the dev environment dropped) and the Access sign-in check.
