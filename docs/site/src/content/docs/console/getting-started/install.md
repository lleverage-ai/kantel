---
title: Install Kantel locally
description: Run Kantel on your own machine, with the self-hosted Docker Compose stack or the Cloudflare target under wrangler, and open the console.
---

Kantel runs on Cloudflare or on your own machines. To try it locally you have two ways in: the self-hosted stack, which Docker Compose starts in one command, or the Cloudflare target, which `wrangler dev` runs on your laptop.

Settings named `HARBOUR_*` from before the rename still work when the `KANTEL_*` one isn't set.

## What you need

| For | You need |
| --- | --- |
| Either way | Git, and a checkout of the repository (`lleverage-ai/kantel`) |
| The self-hosted stack | Docker with the Compose plugin. The images install everything else, the console included |
| The Cloudflare target | Node.js 22.19.0 or later and pnpm (the repository pins pnpm 10.34.9), plus Docker, because local development runs the sandbox and browser containers in it |

Your umask must let Docker read the build context: a umask of `077` breaks the image builds. If you hit `EACCES` while building, run `chmod -R go+rX` on the checkout.

The Cloudflare target's local containers start beside workerd's egress interceptor, which needs the `socket` match of iptables' nf_tables in the host kernel. Where that match is missing, every container fails to start.

## Run the self-hosted stack

From the repository root:

```sh
docker compose -f deploy/compose/compose.yaml up -d --build --wait
```

This builds the images and starts the stack: among others, Postgres, MinIO, the gateway (which serves the API and the console), Mailpit for sign-in emails, a browser host for the sessions' browsers, and two session hosts. Ports are bound to `127.0.0.1` only. The first build takes a few minutes; the browser image, with Chromium and its fonts, is the largest.

A session started from the console has the same tools as one on Cloudflare: the file tools and `bash` on a workspace of its own, `present_files` and `create_document`, `codemode`, `save_program` (with the programs API at `/v1/programs`), the connection tools, and `generate_image` once you pick an image model. `GET /v1/deployment` lists them under `codemode`, `programs`, `presentFiles` and `connections`. To take one away, start the stack with `KANTEL_CODEMODE=off`, `KANTEL_PROGRAMS=off`, `KANTEL_PROGRAM_WAITS=off`, `KANTEL_PRESENT_FILES=off` or `KANTEL_CONNECTIONS=off`.

A session behind this gateway runs its commands in an isolate. The gateway has no container tier yet, so a command that needs one (`git`, `node`, `python`) is refused.

Connections send a person back from an OAuth sign-in to `http://127.0.0.1:58090` (`KANTEL_CONNECTIONS_ORIGIN`, which follows `KANTEL_GATEWAY_PORT`). Behind a TLS proxy, set `KANTEL_PUBLIC_URL` to the console's address instead.

### Upgrade

To upgrade an existing stack, update the checkout and run the same command again: `git pull`, then `docker compose -f deploy/compose/compose.yaml up -d --build --wait`. The volumes keep your data, and the gateway adds the new tools to the bootstrap's `echo` and `assistant` profiles as it starts, keeping their prompts, skills, memory scopes and image model. Sessions created before the upgrade keep the tools they had; start a new session for the new ones.

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

The key (`ktk_…`) is what a host app sends as a bearer token. With `KANTEL_URL` set to `http://127.0.0.1:58090` and `KANTEL_API_KEY` set to that key, list your sessions:

```sh
curl -s "$KANTEL_URL/v1/sessions" -H "authorization: Bearer $KANTEL_API_KEY"
```

### Real models

Until you connect a model, sessions answer with an echo model (`Echo: …`). The first time you sign in, the console asks you to connect one: choose CLI Proxy API, LiteLLM, Cloudflare AI Gateway or OpenRouter, enter its address and key, select **Test connection**, pick the default model and select **Save**. See [First steps](/console/getting-started/first-steps/#1-connect-models).

The key goes into the gateway's vault. `compose.yaml` keeps the vault's key in `/var/lib/harbour/vault-cipher.key` on the gateway's volume (`KANTEL_VAULT_CIPHER_KEY_FILE`), made at the first start; `docker compose down -v` deletes it with everything else. A provider running on the same machine, outside Docker, is `http://host.docker.internal:<port>/v1` from the gateway, such as `http://host.docker.internal:8317/v1` for CLIProxyAPI or `http://host.docker.internal:4000/v1` for LiteLLM. It must listen on an address Docker's bridge reaches, not only on `127.0.0.1`.

The deployment can also configure models itself, through CLIProxyAPI with `KANTEL_CPA_URL`, `KANTEL_CPA_API_KEY` and `KANTEL_VAULT_CIPHER_KEY`. `compose.yaml` doesn't pass these; the `deploy/compose/next-to-sal.yaml` overlay does. It is made for a host app on the same machine that serves host tools on a loopback port, and puts the gateway on the host's network. See [Models](/console/models/) for what each variable does.

### Browsers

Sessions get a browser that Kantel runs itself, with nothing to set: the stack's `browser-host` starts a Chromium container for each browser through Docker, and the gateway is set up to use it. When an agent asks for a browser, **Allow** or **Decline** it above the composer. Once allowed, the session's browser panel shows the page live while the agent works, and its replay after the browser closes. See [Browsers](/console/browsers/).

An install from before browsers were part of the stack gets them when you run the installer again with `--upgrade`, or `docker compose -f deploy/compose/compose.yaml up -d --build --wait` from a newer checkout. Its data stays.

The browser keys in `compose.yaml` are development defaults. Anywhere but your own machine, set `KANTEL_BROWSER_HOST_TOKEN`, `KANTEL_BROWSER_VIEW_KEY` and `KANTEL_BROWSER_SEAL_KEY` to random values of 32 characters or more, and keep the seal key: profiles sealed with one key don't open with another. To start the stack without browsers, set `KANTEL_BROWSER_PROVIDER=off`. `deploy/compose/browser.yaml`, the overlay that used to add them, is now empty and can be left out.

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

Once you are signed in, see [First steps](/console/getting-started/first-steps/). To deploy to your own Cloudflare account, see [Deploy on Cloudflare](/deploy/cloudflare/).

<!-- Sources (8584d5b): package.json:7-9, apps/cloudflare/package.json:11,60, apps/cloudflare/README.md:88-98,271-286, apps/cloudflare/src/dev.ts:1-20,128-175, apps/cloudflare/src/dev-browser-model.ts:1-12, apps/cloudflare/src/stack-object.ts:305-320, apps/cloudflare/wrangler.jsonc:102-165, apps/console/README.md:6-15, apps/console/src/api/identity.ts:1-9, deploy/compose/README.md:1-7,26-92,94-132,213-264,370-389, deploy/compose/compose.yaml:224-291, deploy/compose/next-to-sal.yaml:49-58, apps/selfhosted/Dockerfile:1-23, packages/ui/src/identity/sign-in.tsx:130-262 -->
