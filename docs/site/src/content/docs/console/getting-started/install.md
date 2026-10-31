---
title: Install Kantel locally
description: Run Kantel on your own machine, with the self-hosted Docker Compose stack or the Cloudflare target under wrangler, and open the console.
---

Kantel runs on Cloudflare or on your own machines. To try it locally you have two ways in today: the self-hosted stack, which Docker Compose starts in one command, or the Cloudflare target, which `wrangler dev` runs on your laptop. A one-command installer is in review.

Package and variable names still use the old name, `harbour`.

:::note[Not yet merged]
The one-command installer is in pull request #389, open and not merged. The next section describes it as that pull request has it, and may change before it merges. Everything after it works today.
:::

## The one-command installer

The installer is one command, which works in bash and fish on Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | sh
```

It needs only Docker with Compose v2, `curl` and `tar`: everything else builds and runs in containers. It:

1. Checks for Docker, a running daemon you may use, `curl` and `tar`, and says how to get whatever is missing on your OS.
2. Downloads the source to `~/.kantel` and sets up the self-hosted target as the Compose project `kantel`: the gateway and console, Postgres, MinIO, Mailpit for sign-in codes, and Kantel's own browsers.
3. Generates the database, storage, vault and browser host keys into `~/.kantel/kantel.env` (mode 600). It asks for no model or connector credentials.
4. Starts the stack, waits for it to be healthy and opens the console at <http://127.0.0.1:8470/>. On a machine with no display it prints the URL and an `ssh -L` hint instead.

Sign in as `admin@kantel.localhost` (change it with `--email`) with the code from the local mailbox at <http://127.0.0.1:8471/>. Options go after `sh -s --`, such as `… | sh -s -- --port 9470 --no-open`, or in `KANTEL_*` environment variables. Running it again is safe and keeps your data.

It also installs a `kantel` command, in `~/.kantel/bin`, with `status`, `start`, `stop`, `restart`, `open`, `logs`, `upgrade` and `uninstall`.

In that pull request, the installer has been tested on Linux but not on macOS. The browser image is amd64 only, so on Apple silicon it runs under emulation, if at all; `--no-browser` leaves browsers out.

A fresh install is intended to open on [onboarding](/console/getting-started/onboarding/), where you connect models and services, but onboarding isn't merged either: the console opens on sign-in. Credentials you enter in onboarding will go to the vault, not into files.

## What you need today

| For | You need |
| --- | --- |
| Either way | Git, and a checkout of the repository (`tvdavies/harbour`) |
| The self-hosted stack | Docker with the Compose plugin. The images install everything else, the console included |
| The Cloudflare target | Node.js 22.19.0 or later and pnpm (the repository pins pnpm 10.34.9), plus Docker, because local development runs the sandbox and browser containers in it |

Your umask must let Docker read the build context: a umask of `077` breaks the image builds. If you hit `EACCES` while building, run `chmod -R go+rX` on the checkout.

The Cloudflare target's local containers start beside workerd's egress interceptor, which needs the `socket` match of iptables' nf_tables in the host kernel. Where that match is missing, every container fails to start.

## Run the self-hosted stack

From the repository root:

```sh
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

This builds the images and starts the stack: among others, Postgres, MinIO, the gateway (which serves the API and the console), Mailpit for sign-in emails, and two session hosts. Ports are bound to `127.0.0.1` only.

A session behind this gateway runs its commands in an isolate. The gateway has no container tier yet, so a command that needs one (`git`, `node`, `python`) is refused.

### Open the console and sign in

Open <http://127.0.0.1:58090/>. On a remote machine, forward the port first: `ssh -L 58090:127.0.0.1:58090 <host>`.

Kantel is invite-only. On its first start the gateway invites `admin@harbour.localhost` as the organisation's admin. To invite another address, start the stack with `env KANTEL_ADMIN_EMAIL=you@example.com docker compose …`. Sign in with that address:

1. Enter the email and select **Email me a code**.
2. Open Mailpit at <http://127.0.0.1:58025/> and copy the six-digit code.
3. Enter it under **Check your email**. The console signs you in when all six digits are in.

Codes last 10 minutes and a sign-in lasts 12 hours. To send codes through a real mail relay, set `KANTEL_SMTP_URL` and `KANTEL_MAIL_FROM`.

### Your API key

On its first start the gateway also creates an organisation, a project and an operator API key on that project, and writes them to a bootstrap file in the container:

```sh
docker compose -f deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
```

The key (`hbr_…`) is what a host app sends as a bearer token. With `KANTEL_URL` set to `http://127.0.0.1:58090` and `KANTEL_API_KEY` set to that key, list your sessions:

```sh
curl -s "$KANTEL_URL/v1/sessions" -H "authorization: Bearer $KANTEL_API_KEY"
```

### Real models

By default, sessions answer with an echo model (`Echo: …`). The gateway reaches real models through CLIProxyAPI when it has `KANTEL_CPA_URL`, `KANTEL_CPA_API_KEY` and `KANTEL_VAULT_CIPHER_KEY` (the key the vault seals values with). `compose.yaml` doesn't pass these to the gateway yet, so with it alone sessions stay on the echo model. Only the `deploy/compose/next-to-sal.yaml` overlay passes them, and it is made for running beside Sal: it puts the gateway on the host's network. See [Models](/console/models/) for what each variable does.

### Browsers

To give sessions a browser that Kantel runs itself, add the browser overlay:

```sh
docker compose -f deploy/compose/compose.yaml -f deploy/compose/browser.yaml up -d --build --wait
```

The overlay's keys are development defaults. Anywhere but your own machine, set `KANTEL_BROWSER_HOST_TOKEN`, `KANTEL_BROWSER_VIEW_KEY` and `KANTEL_BROWSER_SEAL_KEY` to random values of 32 characters or more. See [Browsers](/console/browsers/).

:::caution
The session hosts and the browser host mount the Docker socket, which is root on the machine. Keep this stack on a machine you control.
:::

### Stop it

```sh
docker compose -f deploy/compose/compose.yaml down        # stop, keep the data
docker compose -f deploy/compose/compose.yaml down -v     # stop and delete all state
```

## Run the Cloudflare target locally

Install the workspace, then start the Worker:

```sh
pnpm install
pnpm --filter @kantel/cloudflare dev
```

This builds the console and runs `wrangler dev --env dev` on <http://localhost:8787>. The dev entry point is the deployed Worker plus a mock Cloudflare Access issuer and a few routes under `/__dev/`, which never ship in a deployed bundle:

| Route | What it gives you |
| --- | --- |
| `GET /__dev/access-token` | `{ header, token }`: a token from the mock Access issuer for the dev admin |
| `GET /__dev/api-key` | `{ secret, projectId }`: an operator API key for the default project |
| `POST /__dev/vault-seed` | Sample vault requests for the vault page |

Deployed, Cloudflare Access signs people in at the edge. Locally there is no Access in front, so open the console through the console's dev server, which signs each call in as the dev admin with a token from the mock issuer. In a second terminal:

```sh
pnpm --filter @kantel/console dev
```

Then open <http://127.0.0.1:5173/>.

For the API, take a key from the dev route:

```sh
curl -s localhost:8787/__dev/api-key
```

With `KANTEL_URL` set to `http://localhost:8787` and `KANTEL_API_KEY` set to the `secret` it returned:

```sh
curl -s "$KANTEL_URL/v1/sessions" -H "authorization: Bearer $KANTEL_API_KEY"
```

`wrangler dev` keeps D1, R2 and the Durable Objects' storage in `apps/cloudflare/.wrangler/state`, so local state survives a restart. Delete that directory to start afresh.

Locally, sessions run on the echo model, because the dev environment has no `MODELS` binding to reach a model provider through. Its dev model also answers a few test messages: `browse <url>` asks for a browser and opens the URL once you allow it in the console, `bash <command>` runs a command with the agent's `bash` tool, and `codemode <script>` runs a script with the code mode tool. Anything else is echoed.

To deploy to your own Cloudflare account, see [Deploy on Cloudflare](/deploy/cloudflare/).

<!-- Sources (8584d5b): package.json:7-9, apps/cloudflare/package.json:11,60, apps/cloudflare/README.md:88-98,271-286, apps/cloudflare/src/dev.ts:1-20,128-175, apps/cloudflare/src/dev-browser-model.ts:1-12, apps/cloudflare/src/stack-object.ts:305-320, apps/cloudflare/wrangler.jsonc:102-165, apps/console/README.md:6-15, apps/console/src/api/identity.ts:1-9, deploy/compose/README.md:1-7,26-92,94-132,213-264,370-389, deploy/compose/compose.yaml:224-291, deploy/compose/next-to-sal.yaml:49-58, apps/selfhosted/Dockerfile:1-23, packages/ui/src/identity/sign-in.tsx:130-262 -->
