# @kantel/cloudflare

Kantel on Cloudflare. One Worker, `kantel`, on one hostname behind Cloudflare Access. It serves the console and the
identity and audit APIs. The maintainers' deployment is `harbour.myslop.app`, signed in with One-time PIN.

```
browser ── Access (OTP) ── Worker kantel ─┬─ /v1/*      ─► KantelStack DO ─► gateway (src/gateway.ts)
host app ── API key ────────┘              │                                     ├─ /v1/me, /v1/projects, /v1/keys, members, invites
                                           │                                     ├─ /v1/audit/…   audit query API
                                           │                                     └─ any other /v1/…  404
                                           ├─ /healthz
                                           └─ anything else ─► console (apps/console/dist, single-page app)
```

Kantel is a compute plane now. This Worker used to host the agent plane too: sessions, workspaces, models, the vault,
connections, rules and approvals, skills, memory, schedules, sharing, tool server tunnels, Kantel's own browsers and
the sandbox tiers. That code was removed and is kept in git history on the `agent-plane-archive` branch and the
`agent-plane-archive-2026-11-03` tag (commit `e496aeb2817595f5fae5b0cdb919dbc94a5505f5`).

The Worker doesn't serve the compute API. The hosted console shows its compute pages (`/compute`) with sample data, as
it does whenever the compute API isn't there; a self-hosted gateway (`apps/selfhosted`) serves the real one.

`src/route.ts` decides which part answers. It reads a `POST /v1/keys` or `/v1/invites` body (up to its small limit)
before the stack object sees it.

The stack is durable and hosted in one Durable Object (`KantelStack`):

| Part | Where it lives | From |
| --- | --- | --- |
| Identity directory | D1 `DB` | `@kantel/identity/sql` |
| Audit store | D1 `DB` | `@kantel/audit/sql` |
| The bootstrap's organisation, project and admin | `KantelStack`'s storage | `src/stack.ts` |
| Audit outbox: events queue here and drain to D1 after the answer (`ctx.waitUntil`, retried, and again on start); reads drain it first | `KantelStack`'s own SQLite | `src/audit-outbox.ts` |

Migrations run on every start of the object; each is idempotent. The bootstrap saves each step as it completes, so a
restart finds the same organisation rather than making another.

## What the agent plane left behind

Nothing the agent plane stored was deleted, and nothing reads it now:

- **Durable Objects.** `KantelVault` (`HarbourVault`), `HarbourBrowser`, `HarbourSandbox`, `KantelTunnel` and
  `KantelSession` are still bound and exported, as inert classes (`src/retired.ts`) that answer 410 and arm no alarm.
  Removing a class needs a `deleted_classes` migration, which deletes its objects and their storage; that is a
  separate decision. `KantelStack`'s own SQLite still holds the session runtime's tables.
- **D1 and R2.** The session, schedule, skills, memory, sharing, connection and tool-server tables stay in `DB`, and
  workspaces, attachments and browser recordings stay in `WORKSPACES`.
- **Config.** `wrangler.jsonc`'s bindings (`VAULTS`, `BROWSERS`, `SANDBOXES`, `TUNNELS`, `SESSIONS`, `LOADER`, `AI`,
  `MODELS`), vars and container apps are unchanged, and the deploy still writes the vault's secrets when they are set.

## Who gets in

Every API call authenticates with `createAuthenticator` from `@kantel/identity`:

- People: the Access application token in `Cf-Access-Jwt-Assertion`, verified by `cloudflareAccessProvider` against
  `KANTEL_ACCESS_TEAM_DOMAIN` and `KANTEL_ACCESS_AUD` (RS256, issuer `https://<team domain>`, keys from
  `/cdn-cgi/access/certs`). Kantel is invite-only: the bootstrap invites `KANTEL_ADMIN_EMAIL` as the organisation's
  admin, and Access's verified email links them on first sign-in. Anyone else Access lets through is still 401 here.
- Host apps: `Authorization: Bearer ktk_…`, an API key scoped to projects.

The team domain and AUD come as a pair; one without the other is refused (503) rather than served with sign-in off.

Static assets are served before the Worker runs, so only Access guards the console's files. `workers_dev` and
`preview_urls` are off, because those URLs would bypass Access.

## Local

```sh
pnpm --filter @kantel/cloudflare dev          # builds the console, then wrangler dev --env dev
curl localhost:8787/__dev/access-token          # { header, token } from a mock Access issuer for the dev admin
curl localhost:8787/__dev/api-key               # { secret, projectId }: an operator key for the default project
```

`wrangler dev` keeps D1, R2 and the object's SQLite in `.wrangler/state`, so local state survives a restart; delete
that directory to start afresh. `--env dev` runs `src/dev.ts`: the deployed Worker plus a mock Access issuer (its keys
are local; the gateway still verifies with the real provider) and the two `/__dev/` routes. It is never the deployed
entry point, and `test/gateway.test.ts` checks that no other module imports it. Add `--enable-containers=false` to
skip building the retired classes' container images.

`pnpm --filter @kantel/cloudflare deploy:dry-run` builds the console and bundles the deployed Worker into `dist/`
without contacting Cloudflare.

## Deploy

CI deploys, never a person or an agent: `.github/workflows/cloudflare-deploy.yml`, called by
`.github/workflows/main.yml` on every push to main that changes more than Markdown (or a manual run of it from main).
Pull requests are gated only on `CI`'s install, typecheck and lint; main runs the heavy checks once it has settled,
and the deploy runs only once they have all passed on that same commit (main.yml has the details). A pull request that
changes the Worker can dry-run it on demand with `gh workflow run cloudflare-deploy.yml --ref <branch>`. The account
side (the token, the Access application, the VPC service and the IDs) is set up by hand in the Cloudflare account
before the first deploy. CI reads:

| Name | Kind | What it is |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | The deploy token, with the permissions below |
| `CLOUDFLARE_ACCOUNT_ID` | variable | The account to deploy to |
| `KANTEL_HOSTNAME` | variable | The one hostname (`harbour.myslop.app` on the maintainers' deployment), served by the zone route `<hostname>/*` on its parent zone (`myslop.app` there) |
| `KANTEL_ACCESS_TEAM_DOMAIN` | variable | The Access team domain, such as `<team>.cloudflareaccess.com` |
| `KANTEL_ACCESS_AUD` | variable | The AUD tag of the Access application on `KANTEL_HOSTNAME` |
| `KANTEL_MODELS_VPC_SERVICE_ID` | variable | The Workers VPC service bound as `MODELS`. Nothing uses it now; the deploy config still requires it |
| `KANTEL_ADMIN_EMAIL` | variable | The first admin, invited by email; Access's verified email links them on first sign-in |
| `KANTEL_D1_DATABASE_NAME` with `KANTEL_D1_DATABASE_ID` | optional variables | Another D1 database for `DB`, bound by name and ID, so one that doesn't exist fails the deploy. Unset: `harbour-weur`, by name |
| `KANTEL_R2_BUCKET` | optional variable | Another bucket for `WORKSPACES`. Unset: `harbour-workspaces-weur` |
| `KANTEL_LOCATION_HINT` | optional variable | The location hint the stack object is created with (`src/route.ts`). Unset: `weur`, from `wrangler.jsonc` |

Until the secret and every variable exist, and on any run other than main.yml's on main, the workflow only runs
`wrangler deploy --dry-run`, with placeholders for what's unset; that never contacts Cloudflare. Once they all exist,
a run on main:

1. writes `wrangler.deploy.json`: `wrangler.jsonc` with the account, the zone route, the Access vars, the admin
   email and the `MODELS` VPC service filled in (`scripts/deploy-config.ts`; it refuses a missing or malformed value,
   and a base config that could serve on workers.dev or a preview URL);
2. runs the dry run, then `wrangler deploy`. Deploys find the D1 database `harbour-weur` and the R2 bucket
   `harbour-workspaces-weur` by name;
3. checks that an anonymous request to the console, a deep link, an API path and `/healthz` is redirected to
   `https://<team domain>/cdn-cgi/access/login/…` (`scripts/check-access.ts`), and fails otherwise.

The stack object takes `KANTEL_LOCATION_HINT` only when it's first created: the existing `m1` object stays where it
is, whatever it says, and renaming it would start it empty.

Kantel is served on a zone route, not a custom domain. On the maintainers' deployment that is `harbour.myslop.app/*`
with `zone_name: "myslop.app"`. The `myslop.app` zone already has a `*.myslop.app/*` route to the `myslop-apps`
Worker; between routes the most specific pattern wins, so `harbour.myslop.app/*` beats the wildcard
([Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). A route makes no DNS record of its
own: the zone's proxied wildcard record (`*.myslop.app`) already resolves the hostname.

### The deploy token's permissions

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy the Worker, its Durable Objects and its static assets |
| Account | D1: Edit | Look up the `harbour-weur` database by name |
| Account | Workers R2 Storage: Edit | Look up the `harbour-workspaces-weur` bucket by name |
| Account | Connectivity Directory: Bind | Bind the existing Workers VPC service (`MODELS`) |
| Zone (myslop.app) | Workers Routes: Edit | Add the zone route `KANTEL_HOSTNAME/*` |

## Checks

`pnpm --filter @kantel/cloudflare test` runs the gateway over the in-memory stack in Node: Access tokens for the right
team domain and AUD sign the invited person in; another AUD, another team domain, an expired token, a service token or
an uninvited email are 401; API keys work on the identity and audit APIs; and the agent plane's routes are 404.
`test/audit-outbox.test.ts` runs the audit outbox over SQLite. `test/deploy.test.ts` checks the deploy config and the
Access sign-in check, and `test/durable-object-rename.test.ts` that every class the migrations leave live is bound and
exported.
