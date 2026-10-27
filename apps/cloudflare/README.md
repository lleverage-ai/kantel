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

Status: step 1 of #17. The gateway runs in `wrangler dev` over each package's in-memory implementation, hosted in one
Durable Object (`HarbourStack`) so a deployment has one consistent state. Step 2 replaces it binding by binding:
SessionDO over the runtime, R2 workspaces, D1 for the directory and audit, VaultDO, and the `vpc_services` binding to
CLIProxyAPI. Until then sessions run on an echo model (`src/echo-model.ts`) and nothing survives the object restarting.

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

`--env dev` runs `src/dev.ts`: the deployed Worker plus a mock Access issuer (its keys are local; the gateway still
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
| `HARBOUR_HOSTNAME` | variable | The one hostname, `harbour.myslop.app`, attached as the Worker's custom domain |
| `HARBOUR_ACCESS_TEAM_DOMAIN` | variable | The Access team domain, such as `<team>.cloudflareaccess.com` |
| `HARBOUR_ACCESS_AUD` | variable | The AUD tag of the Access application on `HARBOUR_HOSTNAME` |
| `HARBOUR_MODELS_VPC_SERVICE_ID` | variable | The Workers VPC service to CLIProxyAPI through the `sal-app` tunnel, bound as `MODELS` |
| `HARBOUR_ADMIN_EMAIL` | variable | The first admin, invited by email; Access's verified email links them on first sign-in |

Until the secret and every variable exist, and on every pull request, the workflow only runs `wrangler deploy
--dry-run`, with placeholders for what's unset; that never contacts Cloudflare. Once they all exist, a run on main:

1. writes `wrangler.deploy.json`: `wrangler.jsonc` with the account, the custom domain, the Access vars, the admin
   email and the `MODELS` VPC service filled in (`scripts/deploy-config.ts`; it refuses a missing or malformed value,
   and a base config that could serve on workers.dev or a preview URL);
2. runs the dry run, then `wrangler deploy`. On the first deploy wrangler creates the D1 database `harbour` and the
   R2 bucket `harbour-workspaces` (its automatic provisioning, by name); later deploys find them by name;
3. checks that an anonymous request to the console, a deep link, `/v1/sessions` and `/healthz` is redirected to
   `https://<team domain>/cdn-cgi/access/login/…` (`scripts/check-access.ts`), and fails otherwise.

The custom domain makes its own DNS record, and wrangler refuses to replace an existing one, so nothing else should
create a DNS record for `HARBOUR_HOSTNAME`.

### The deploy token's permissions

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy the Worker, its Durable Objects and its static assets |
| Account | D1: Edit | Create the `harbour` database on the first deploy and look it up by name after |
| Account | Workers R2 Storage: Edit | Create the `harbour-workspaces` bucket on the first deploy and look it up by name after |
| Account | Connectivity Directory: Bind | Bind the existing Workers VPC service (`MODELS`) |
| Zone (myslop.app) | Workers Routes: Edit | Attach the custom domain `HARBOUR_HOSTNAME` |

Cloudflare documents Workers Routes edit as what a custom domain needs; DNS edit isn't listed, so it shouldn't be
needed. Later steps of #17 may add more, such as Containers for the container tier; each will be listed here.

## Checks

`pnpm --filter @harbour/cloudflare test` runs the gateway over the in-memory stack in Node: Access tokens for the right
team domain and AUD sign the invited person in; another AUD, another team domain, an expired token, a service token or
an uninvited email are 401; API keys work on every API; and each API is mounted where its client expects it.
`test/deploy.test.ts` checks the deploy config (every variable to deploy, placeholders for a dry run, malformed
values refused, the dev environment dropped) and the Access sign-in check.
