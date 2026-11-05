# @kantel/cloudflare

Kantel on Cloudflare. One Worker, `kantel`, on one hostname behind Cloudflare Access. It serves the console and the
compute, identity and audit APIs. The maintainers' deployment is `harbour.myslop.app`, signed in with One-time PIN.

```
browser ── Access (OTP) ── Worker kantel ─┬─ /v1/*      ─► KantelStack DO ─► gateway (src/gateway.ts)
host app ── API key ────────┘              │                                     ├─ /v1/me, /v1/projects, /v1/keys, members, invites
                                           │                                     ├─ compute API (src/compute.ts): sandboxes, commands, files, ksk_ keys…
                                           │                                     ├─ /v1/audit/…   audit query API
                                           │                                     └─ any other /v1/…  404
                                           ├─ /healthz
                                           └─ anything else ─► console (apps/console/dist, single-page app)
```

Kantel is a compute plane now. This Worker used to host the agent plane too: sessions, workspaces, models, the vault,
connections, rules and approvals, skills, memory, schedules, sharing, tool server tunnels, Kantel's own browsers and
the sandbox tiers. That code was removed and is kept in git history on the `agent-plane-archive` branch and the
`agent-plane-archive-2026-11-03` tag (commit `e496aeb2817595f5fae5b0cdb919dbc94a5505f5`).

The compute API is `@kantel/compute`'s, as a self-hosted gateway (`apps/selfhosted`) serves it, so the console at `/`
works here as it does there (`src/compute.ts`):

- Its records (accounts, sandboxes, commands, snapshots, keys, webhooks) are the compute store over SQL
  (`@kantel/compute/sql`, the same store the self-hosted gateway keeps in Postgres), in `KantelStack`'s own SQLite,
  table `compute_api_records`. One object answers every request, so there is one writer.
- Sandboxes run on the stub backend (`@kantel/compute/stub`, a just-bash shell over in-memory files), as a self-hosted
  gateway with no hosts does. When the object is evicted or a deploy replaces it, the records stay and each sandbox
  gets a fresh, empty machine on its next call.
- Port URLs are named under `kantel.run`, Kantel's hosted ports domain (`HOSTED_PORTS_DOMAIN` in `src/config.ts`), or
  the deployment's own with the `KANTEL_COMPUTE_PORTS_DOMAIN` variable: `https://{port}-{subdomain}.kantel.run`. It is
  a separate registrable domain from the console's (`app.kantel.dev`), so a port's page is never the same site as the
  console. It isn't on the Public Suffix List, so port names are one site to each other and cookies aren't private
  between sandboxes. Account hosts' microVMs' ports are served there over HTTP (see "Exposed ports" below); the stub
  only names its URLs. `GET /v1/whoami` names the domain (`sandboxDomain`), and the console shows each sandbox's
  address under it (`keen-newt-a8gdig.kantel.run`), not under its own host.
- Account hosts (experimental, `KANTEL_ACCOUNT_HOSTS=experimental` with `KANTEL_PUBLIC_URL`; off by default, and the
  deploy sets it from the repository variable of the same name): people add machines of their own (`POST /v1/hosts/join-tokens`). A host registers at
  `POST /v1/hosts/register` and keeps a WebSocket to `GET /v1/hosts/connect` open on `KantelStack`, which holds the
  hub (`@kantel/hosts`), and its registry is in the object's SQLite. An account with an online host of its own gets
  its sandboxes there (`createRoutedBackend`); everyone else keeps the stub. SSH to them is served
  (`/v1/hosts/tunnel/{ticket}`), and so are their exposed ports' pages; desktops, browsers and WebSockets to exposed
  ports aren't yet. Hosts dial `KANTEL_PUBLIC_URL`: the
  public origin, with no Access in front, needs nothing more (with account hosts on, it may be set without
  `KANTEL_SIGN_IN_FROM`, leaving email sign-in off, and so may `KANTEL_ACCOUNT_HOSTS=off`). Someone who signs up there
  may add and use hosts of their own, but never the stub, which stays the deployment organisation's. Hosts can't sign
  in to Access, so an origin behind it needs a bypass for `/v1/hosts/register`, `/v1/hosts/connect`,
  `/v1/hosts/images/*` and `/v1/hosts/tunnel/*`, each of which checks its own token, credential or ticket. See
  `docs/site/src/content/docs/own-hosts.md`.
- The person Access signs in is a compute person under their Kantel user ID; an admin of the deployment's organisation
  is the compute super-admin. The console sends no credential behind Access, so the gateway gives the compute API
  Access's token as the bearer it asks for. The compute API's own `ksk_` keys work as on self-hosted; an identity
  `ktk_` key is not a compute caller.
- The webhook and telemetry timers run only while requests come, so they never keep the object awake.

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

### The public origin

With `KANTEL_PUBLIC_URL` and `KANTEL_SIGN_IN_FROM` set (repository variables, written into the Worker's vars by the
deploy), the Worker also answers on a public origin with no Access in front, such as `https://app.kantel.dev`:

- People sign in there with an email code (`POST /auth/otp/start`, `/auth/otp/verify`, `/auth/session/end`), which the
  console asks for when `GET /v1/me`'s 401 names `email_otp`. The session (`kts_…`, 12 hours) is a bearer.
- Sign-up is open (`src/sign-up.ts`): someone new gets a user of their own and a personal space, an organisation named
  Personal that they administer, with a Default project. Someone with a pending invite joins the inviting organisation
  instead, as self-hosted. Administering a personal space doesn't make anyone the compute plane's super-admin: only an
  admin of the deployment's own organisation (the bootstrap's) is.
- Codes and invites go out from `KANTEL_SIGN_IN_FROM` through the `SIGN_IN_MAIL` binding (Cloudflare Email Sending, a
  `send_email` binding limited to that sender). At most `KANTEL_SIGN_IN_DAILY_CAP` (default 100) a UTC day, counted in
  the stack object's storage; past it a start is 503 until the next day. Each client address may make 30 sign-in
  requests per 15 minutes, and each email gets at most 5 codes an hour.
- The sign-in routes are 404 on any other hostname, and a 401 anywhere else still names Access.

The sender's domain must be onboarded for Email Sending first. The origin itself is a Workers custom domain attached
once outside the deploy (the deploy's token edits routes on `myslop.app` only), for example:

```sh
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  -d '{"hostname":"app.kantel.dev","service":"harbour","environment":"production","zone_id":"<kantel.dev zone>"}'
```

A deploy that names no custom domain leaves it in place. No Access application covers it, and none should.

### Sign in with GitHub and Google

On the public origin people can also sign in with GitHub or Google (`@kantel/identity/oauth`): OAuth's authorisation
code flow with PKCE, under `/auth/oauth/<provider>/start` and `/callback`, with the same open sign-up, sessions and
per-address limit as email codes. The directory links a provider's account to the person who already signs in with its
verified email (`IdentityDirectory.signIn`), so they keep one user and one Personal space. Each provider is on once its
client ID and secret are both Worker secrets, set by the deploy from the repository secrets of the same names
(`scripts/vault-secrets.ts`; a pair half set fails the run):

| Provider | Repository secrets | Callback URL to register | Scopes |
| --- | --- | --- | --- |
| GitHub (an OAuth app) | `KANTEL_GITHUB_CLIENT_ID`, `KANTEL_GITHUB_CLIENT_SECRET` | `https://app.kantel.dev/auth/oauth/github/callback` | `read:user`, `user:email` |
| Google (a Web application client) | `KANTEL_GOOGLE_CLIENT_ID`, `KANTEL_GOOGLE_CLIENT_SECRET` | `https://app.kantel.dev/auth/oauth/google/callback` | `openid`, `email`, `profile` |

The callback is `KANTEL_PUBLIC_URL` with the path above, so another deployment registers its own origin's. GitHub must
have a verified primary email for the account. Google must say `email_verified` for an address it is authoritative for:
a Gmail address, or a Google Workspace account's (`hd` set). A consumer Google account on another address was verified
only when it was made, and the address may have changed hands since, so it never links, joins an invite or signs up by
that email (it signs in only once linked). Anyone turned back sees why on the sign-in page. A user's first sign-in, any
of the three ways, makes them with the email code's subject, so first sign-ins that race make one user. Unset, the provider's routes are 404 and the 401 doesn't name it. They are never served on
the Access hostname (harbour.myslop.app), which signs in with Access as before. Removing a repository secret doesn't
remove the Worker secret (the secrets file is additive): `wrangler secret delete` does.

### Protected variables and secret files

Environments' protected variables and secret files, and bucket sources' credentials, are sealed in the stack object's
SQLite with `KANTEL_SECRETS_KEY`, by the same sealer as a self-hosted install's (`@kantel/compute/secrets`). An
account host fetches its sandboxes' values over its connection, and its egress proxy swaps them in for the
placeholders the sandbox sees, as a self-hosted install's hosts do. The key is 32 random bytes in base64, a Worker
secret set once by an operator (the deploy never writes it):

```sh
# Generate the key and keep a copy in the password manager first: the Worker never shows it again, and losing or
# changing it loses every value sealed with it.
openssl rand -base64 32

# From apps/cloudflare, with wrangler signed in to the account (or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
# set). It prompts for the value; setting a secret deploys a new version of the Worker at once.
pnpm exec wrangler secret put KANTEL_SECRETS_KEY --name harbour
```

Unset, protected values and secret files are refused with `not_supported` ("This deployment doesn't support protected
variables or secret files"), `GET /v1/whoami` says `protectedValues: false` so the CLI and console say so before
anything is written, plain variables still work, and the stack object logs at start that the key is missing. A key
that isn't 32 bytes of base64 stops the object starting, naming the setting and never its value. The deploy's secrets
file is additive, so a deploy keeps the key.

### Exposed ports

With `KANTEL_COMPUTE_PORTS_DOMAIN` set (the repository variable; `kantel.run` for Kantel's own), the deploy routes
`*.{domain}/*` to the Worker, and `src/route.ts` sends every request on a name under it to the stack object, whatever
its path: the sandbox's page answers there, never the console or the API (`servePort` in `src/compute.ts`, over
`@kantel/hosts/ports`, the self-hosted gateway's router). The Worker runs first for every path (`run_worker_first:
true`), so a sandbox's `/` or `/assets/…` is never the console's file; the console's files are served through the
`ASSETS` binding. A port's name is one label under the domain, so the zone's Universal SSL wildcard covers it. Ports
need the token in their URL unless exposed public, as on a self-hosted install. WebSockets to them (a dev server's
hot reload) answer 501 for now.

The names also need proxied wildcard DNS records, added once outside the deploy (Workers routes only match traffic
that reaches Cloudflare's proxy): an `A` and an `AAAA`, so IPv4-only clients resolve them too. For example:

```sh
for record in '"type":"A","content":"192.0.2.1"' '"type":"AAAA","content":"100::"'; do
  curl -X POST "https://api.cloudflare.com/client/v4/zones/<kantel.run zone>/dns_records" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
    -d "{$record,\"name\":\"*.kantel.run\",\"proxied\":true,\"comment\":\"Kantel exposed ports\"}"
done
```

No Access application covers the ports domain, and none should: each port checks its own token.

The Worker runs first for every path and serves the console's files through the `ASSETS` binding, so on the Access
hostname only Access guards them, as before. `workers_dev` and `preview_urls` are off, because those URLs would bypass
Access.

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
`test/compute.test.ts` runs the compute API on the gateway: the Access person signs in (the organisation's admin as
the super-admin), creates a sandbox and runs a command, uses a `ksk_` key, and finds the records after a restart.
`test/audit-outbox.test.ts` runs the audit outbox over SQLite. `test/deploy.test.ts` checks the deploy config and the
Access sign-in check, and `test/durable-object-rename.test.ts` that every class the migrations leave live is bound and
exported.
