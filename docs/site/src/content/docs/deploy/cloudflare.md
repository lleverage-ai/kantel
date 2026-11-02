---
title: Cloudflare
description: Deploy your own copy of Kantel to a Cloudflare account, with its Durable Objects, D1, R2, Access sign-in, secrets and deploy workflow.
---

Kantel on Cloudflare is one Worker, `kantel`, on one hostname behind Cloudflare Access. It serves the console as static assets and the API under `/v1/`. This page covers deploying it to your own account. For how it compares with self-hosting, see the [deployment overview](/deploy/overview/).

The Worker, its Durable Object classes, its database and bucket keep `harbour` in their names from before the rename. Settings named `HARBOUR_*` (GitHub variables and secrets, Worker secrets) still work when the `KANTEL_*` one isn't set.

The repository is set up for the maintainers' deployment at `harbour.myslop.app`. Where a setting belongs to that deployment, this page says what to change for yours.

## What the Worker binds

`apps/cloudflare/wrangler.jsonc` declares the Worker and its bindings. The deploy step (`scripts/deploy-config.ts`) adds the account, the route, the Access settings and the VPC service when it writes `wrangler.deploy.json`.

| Binding | Kind | What it holds |
| --- | --- | --- |
| `ASSETS` | Static assets | The console build (`apps/console/dist`); the Worker answers a miss with the console page, or a 404 under `/assets/` |
| `STACK` | Durable Object `KantelStack` | Every session, its history and alarm, workspace heads, the audit outbox and the scheduler. One object, named `m1` |
| `VAULTS` | Durable Object `KantelVault` | Every vault record, in its own SQLite. One object, named `vault` |
| `BROWSERS` | Durable Object `KantelBrowser` | Kantel's own browsers, one object per browser, used only with `KANTEL_BROWSER_PROVIDER=kantel` |
| `SANDBOXES` | Durable Object `KantelSandbox` | The container tier, one object per session |
| `DB` | D1 | The identity directory, audit, schedules, skills, memory, prompt rules and sharing |
| `WORKSPACES` | R2 | Workspace files under `workspaces/`, and skill files under `skills/` |
| `LOADER` | Worker Loader | Dynamic Workers for code mode and the `dynamic-worker` isolate |
| `MODELS` | Workers VPC service | The route to CLIProxyAPI, added at deploy time |

The D1 database and R2 bucket are named, not given IDs: `harbour-weur` and `harbour-workspaces-weur`. A deploy finds them by name, and wrangler's automatic provisioning creates either one if it is missing. To use your own, set `KANTEL_D1_DATABASE_NAME` with `KANTEL_D1_DATABASE_ID` (both or neither; bound by ID too, so a wrong one fails the deploy) and `KANTEL_R2_BUCKET`. Create the bucket first, or wrangler creates it wherever it likes.

`workers_dev` and `preview_urls` are off, because those URLs would bypass Access. The deploy step refuses a config that turns them on.

### Containers

The container tier and Kantel's own browsers are Cloudflare Containers. Neither is deployed unless you ask:

- `KANTEL_SANDBOX_CONTAINERS=on` adds the sandbox app (`images/sandbox`, 1 vCPU, 3 GiB, 8 GB disk, at most 10 instances) and lets commands escalate to it. Without it, `python`, `npm`, `git` writes and similar commands are refused as `unavailable`.
- `KANTEL_BROWSER_CONTAINERS=on` adds the browser app (`images/browser`, 1 vCPU, 3 GiB, 4 GB disk, at most 3 instances). Pair it with `KANTEL_BROWSER_PROVIDER=kantel`.

Both apps are held to the `WEUR` region in `scripts/deploy-config.ts` (`constraints: { regions: ["WEUR"] }`). To run them elsewhere, edit those constants.

## Sign-in with Cloudflare Access

Access signs people in before any request reaches the Worker. The Worker then checks the Access token in `Cf-Access-Jwt-Assertion` against two settings:

- `KANTEL_ACCESS_TEAM_DOMAIN`: your Access team domain, such as `<team>.cloudflareaccess.com`.
- `KANTEL_ACCESS_AUD`: the AUD tag of the Access application on your hostname.

Set both or neither: one without the other is refused (503). A token for another team domain or AUD, an expired token, or a service token is refused (401).

Kantel is invite-only. On first start it invites `KANTEL_ADMIN_EMAIL` as the organisation's admin, and Access's verified email links that person on their first sign-in. Anyone else Access lets through is still refused until they are invited. The maintainers' Access application uses One-time PIN; the Worker only reads the verified email from the token.

Access stands in front of every path, `/v1/` included. Host apps aren't let through Access yet: the repository's own remote check sends a signed-in browser's `CF_Authorization` cookie along with the API key.

Share links (`/shared/<token>`) ask Kantel for no sign-in, but Access still guards them. For anyone with a link to open it, add a Bypass policy on `<hostname>/shared/*` to the Access application.

The client ID metadata document (`/v1/connections/oauth/client-metadata.json`) is public too: an MCP server's authorisation server fetches it to identify Kantel's OAuth client (CIMD). To use CIMD, add an Access application on exactly `<hostname>/v1/connections/oauth/client-metadata.json` with one Bypass policy (Include: Everyone), then set the repository variable `KANTEL_CONNECTIONS_CIMD=on` and redeploy. Without both, Kantel tries dynamic client registration instead.

## Secrets

Secrets are Worker secrets, never vars; the deploy step refuses them in `wrangler.jsonc`. The workflow sets each one that exists as a repository secret of the same name, and leaves out the rest. Wrangler's secrets file is additive, so a deploy never removes one.

| Secret | Format | Without it |
| --- | --- | --- |
| `KANTEL_VAULT_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`) | The vault answers every call `unavailable` (503) |
| `KANTEL_VAULT_MODEL_GATEWAY_TOKEN` | At least 16 characters, no spaces | The model gateway's HTTP calls to the vault are refused (403) |
| `KANTEL_VAULT_EGRESS_GATEWAY_TOKEN` | At least 16 characters, no spaces | The egress gateway's calls to the vault are refused (403) |
| `KANTEL_CPA_API_KEY` | CLIProxyAPI's client key, at least 16 characters | Sessions run on the echo model |
| `KANTEL_BRWSR_API_KEY` | A brwsr.dev project key | No browser with the `brwsr` provider |
| `KANTEL_BROWSER_VIEW_KEY`, `KANTEL_BROWSER_SEAL_KEY` | At least 32 characters each | No browser with the `kantel` provider |

The CLIProxyAPI key is kept as a platform item in the vault, so real models need `KANTEL_VAULT_KEY` too.

:::caution
Don't change `KANTEL_VAULT_KEY` once the vault holds a value. Values sealed under the old key no longer open, and there is no key rotation yet.
:::

## Models through Workers VPC

The model gateway runs inside `KantelStack` and calls CLIProxyAPI through the `MODELS` Workers VPC service, so CLIProxyAPI needs no public route. The maintainers' service goes through a Cloudflare Tunnel; yours needs a VPC service that reaches your own CLIProxyAPI. The deploy step requires its ID in `KANTEL_MODELS_VPC_SERVICE_ID`.

The `default` route serves `KANTEL_DEFAULT_MODEL` (`claude-sonnet-5-5` in `wrangler.jsonc`), and every other model CLIProxyAPI lists is offered as `default:<model>`. `KANTEL_IMAGE_MODEL`, if you add it, gives an `images` route.

CLIProxyAPI is the Worker's only connector, deliberately: the model gateway's only way out is the `MODELS` VPC service, so a connector at another address can't be reached, and the Worker opens no other egress for one. It ignores the self-hosted gateway's `KANTEL_MODEL_CONNECTORS`, logging a warning if it is set. For LiteLLM or another provider, run the [self-hosted gateway](/deploy/self-hosted/#connectors-of-any-preset).

The default agent profile, `assistant`, starts with no prompt layers. Kantel adds no system prompt of its own: the prompt is what the profile's prompt layers and the prompt rules give it, plus recall and the skills listing.

## Other settings

These vars live in `wrangler.jsonc`. The deploy step leaves them as they are, so edit the file to change them.

| Var | Value in the repository | What it does |
| --- | --- | --- |
| `KANTEL_ISOLATE_BACKEND` | `in-process` | `dynamic-worker` runs each session's shell in a Dynamic Worker instead |
| `KANTEL_CODEMODE` | `on` | `off` removes the `codemode` tool |
| `KANTEL_PRESENT_FILES` | `on` | `off` removes `present_files` |
| `KANTEL_SUBAGENTS` | `on` | Anything but `on` removes the `subagent` tool |
| `KANTEL_RECALL_RENDERER` | `default` | `sal` renders recall as the `examples/sal-worker` bundle's local worker does |
| `KANTEL_SESSION_WEBSOCKET` | `on` | `off` serves session events as server-sent events only |
| `KANTEL_USAGE` | `on` | `off` stops writing usage rows |
| `KANTEL_LOCATION_HINT` | `weur` | Where the stack and vault objects are created. The deploy can override it |
| `KANTEL_BROWSER_PROVIDER` | `brwsr` | `kantel` uses Kantel's own browsers. The deploy can override it |

`KANTEL_LOCATION_HINT` applies only when an object is first created: an existing `m1` or `vault` object stays where it is. A D1 database's and an R2 bucket's location is fixed when you create them.

## Deploying

`.github/workflows/cloudflare-deploy.yml` deploys from main, called by `.github/workflows/main.yml` once the `CI`, `self-hosted` and `Sandbox image` checks pass on the same commit. Until the secret and every required variable exist, and on any other run, it only runs `wrangler deploy --dry-run`, which never contacts Cloudflare.

For your own copy, set these on your repository:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | The deploy token (below) |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Your 32-character account ID |
| `KANTEL_HOSTNAME` | Variable | Your hostname, such as `kantel.example.com` |
| `KANTEL_ACCESS_TEAM_DOMAIN` | Variable | Your Access team domain |
| `KANTEL_ACCESS_AUD` | Variable | Your Access application's AUD tag |
| `KANTEL_MODELS_VPC_SERVICE_ID` | Variable | Your Workers VPC service's ID |
| `KANTEL_ADMIN_EMAIL` | Variable | The first admin's email |

The optional variables are `KANTEL_D1_DATABASE_NAME`, `KANTEL_D1_DATABASE_ID`, `KANTEL_R2_BUCKET`, `KANTEL_LOCATION_HINT`, `KANTEL_BROWSER_CONTAINERS`, `KANTEL_BROWSER_PROVIDER`, `KANTEL_SANDBOX_CONTAINERS`, `KANTEL_EMBED_ORIGINS` (`https://` origins that may frame a browser's embed page) and `KANTEL_CONNECTIONS_PERSONAL` (`on` for a deployment with one person, so their personal connections work in all their sessions). The secrets are listed above.

The repository's workflows run on the maintainers' self-hosted runners (`runs-on: [self-hosted, harbour]`, and `[self-hosted, harbour, gvisor]` for the sandbox image). Change `runs-on` to runners you have, or the deploy never starts.

A deploy run:

1. Builds the console (`pnpm --filter @kantel/cloudflare build:console`) and the isolates (`pnpm --filter @kantel/cloudflare build:isolate`).
2. Writes `wrangler.deploy.json` with `node scripts/deploy-config.ts --mode deploy`. It refuses a missing or malformed value.
3. Checks the secrets with `node scripts/vault-secrets.ts` and writes the ones that are set to a file.
4. Runs `wrangler deploy --dry-run`, then `wrangler deploy --config wrangler.deploy.json --secrets-file <file>`.
5. With `KANTEL_BROWSER_CONTAINERS=on`, adds an R2 lifecycle rule that deletes browser recordings after 8 days.
6. Checks that anonymous requests to `/`, `/projects`, `/v1/sessions` and `/healthz` are sent to `https://<team domain>/cdn-cgi/access/login/…`, and fails otherwise.

The Worker is served on a zone route, `<hostname>/*`, on the hostname's parent zone. The hostname must be a direct subdomain of a zone in your account (`kantel.example.com` on `example.com`). A route makes no DNS record, so the zone needs a proxied record that resolves the hostname; the maintainers use the zone's wildcard record. The deploy step always writes a zone route, not a custom domain, because the maintainers' zone has a wildcard route to another Worker that would shadow a custom domain.

### The deploy token's permissions

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Deploy the Worker, its Durable Objects and its assets |
| Account | D1: Edit | Find the database by name, or create it |
| Account | Workers R2 Storage: Edit | Find the bucket by name, or create it |
| Account | Connectivity Directory: Bind | Bind the Workers VPC service |
| Zone (yours) | Workers Routes: Edit | Add the zone route |

The repository's list doesn't yet name a permission for Containers.

## Before you deploy

Run it locally first. `wrangler dev --env dev` uses a mock Access issuer, local D1, R2 and SQLite in `.wrangler/state`, and a fixed, public dev vault key. It also builds `images/sandbox` and `images/browser` and runs their containers in local Docker, so you need Docker:

```bash
pnpm install
pnpm --filter @kantel/cloudflare dev
curl localhost:8787/__dev/api-key
```

The last command returns an operator API key for the default project. `pnpm --filter @kantel/cloudflare deploy:dry-run` bundles the deployed Worker without contacting Cloudflare.

## After you deploy

Check the API with an API key. Because Access is in front, add a signed-in browser's `CF_Authorization` cookie:

```bash
curl -s "$KANTEL_URL/v1/sessions" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "cookie: CF_Authorization=<value from a signed-in browser>"
```

```ts
import { createKantelClient } from "@kantel/api/sdk";

const client = createKantelClient({
  baseUrl: `${process.env.KANTEL_URL}/v1`,
  token: process.env.KANTEL_API_KEY,
  headers: () => ({ cookie: `CF_Authorization=${process.env.CF_AUTHORIZATION}` }),
});

const page = await client.listSessions();
console.log(page.items.length);
```

See [Authentication](/api/authentication/) for API keys.

## Cost

The repository's estimate (27 October 2026, one person and one host app's tasks) is about $0 a month beyond the account's $5 Workers Paid minimum, as long as the account's other Workers leave enough of the included usage. Workers VPC is free during its open beta. The container tier, an open console and many `dynamic-worker` sessions move it most; the [deployment overview](/deploy/overview/#cost) explains each. Access adds one seat to your Zero Trust organisation.

<!-- Sources (8584d5b): apps/cloudflare/README.md:1-48, apps/cloudflare/README.md:73-100, apps/cloudflare/README.md:214-288, apps/cloudflare/README.md:288-410, apps/cloudflare/wrangler.jsonc:1-167, apps/cloudflare/scripts/deploy-config.ts:1-375, apps/cloudflare/scripts/vault-secrets.ts:1-77, apps/cloudflare/scripts/check-access.ts:1-45, apps/cloudflare/package.json:1-16, .github/workflows/cloudflare-deploy.yml:1-213, .github/workflows/main.yml:1-160, apps/cloudflare/src/route.ts:1-60, apps/cloudflare/src/config.ts:1-40, apps/cloudflare/src/models.ts:1-80, apps/cloudflare/src/vault.ts:1-60, apps/cloudflare/src/vault.ts:130-165, apps/cloudflare/src/stack-object.ts:305-325, apps/cloudflare/src/stack.ts:136-152, apps/cloudflare/src/stack.ts:660-690, apps/cloudflare/src/browser.ts:1-110, apps/cloudflare/test/remote/deployed.test.ts:1-35, packages/api/generated/sdk.ts:1966-1980, packages/api/generated/sdk.ts:2516-2520 -->
