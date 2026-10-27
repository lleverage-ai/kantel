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

## Checks

`pnpm --filter @harbour/cloudflare test` runs the gateway over the in-memory stack in Node: Access tokens for the right
team domain and AUD sign the invited person in; another AUD, another team domain, an expired token, a service token or
an uninvited email are 401; API keys work on every API; and each API is mounted where its client expects it.
