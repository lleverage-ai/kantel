---
title: Install Kantel
description: Install Kantel's control plane on your own machine with one command, sign in to the console, find your first API key, add a host to run sandboxes on, and upgrade or remove it later.
---

The control plane is Kantel's console and API. It runs as a Docker Compose stack on one machine, and the installer sets it up for you.

## What you need

- Linux or macOS, with Docker and its Compose v2 plugin, and the Docker daemon running. On a Mac, Docker Desktop or OrbStack.
- `curl` and `tar`.
- A few gigabytes of disk for the images. The first build takes a few minutes.
- Optionally, [gVisor](https://gvisor.dev/docs/user_guide/install/) registered with Docker as `runsc`. Sessions' sandbox containers run on it when Docker has it, and on `runc` otherwise. The installer says which it found.

You don't need Node.js or pnpm: everything builds and runs in containers.

## Install

```sh
curl -fsSL https://kantel.dev/install.sh | sh
```

The command works the same from bash, zsh and fish, because the script always runs under `sh`. It:

1. checks for Docker, Compose, `curl` and `tar`, and tells you how to get anything that's missing;
2. downloads Kantel's source from GitHub into `~/.kantel/src`;
3. builds and starts the stack, and waits until the console answers. The stack includes Kantel's own browser host and the sandbox image: sessions can open web pages, which the console shows live, and run `git`, `node`, `python3` and the like in a container of their own (tier 2), started through Docker's socket;
4. prints where everything is, and opens the console in your browser when it can.

Pass options after `sh -s --`:

```sh
curl -fsSL https://kantel.dev/install.sh | sh -s -- --email you@example.com --no-open
```

| Option | What it does |
| --- | --- |
| `--email ADDRESS` | The first admin, who signs in. Without it, `admin@harbour.localhost` |
| `--upgrade` | Download the source again and rebuild the stack with it. See [Upgrade](#upgrade) |
| `--ref REF` | Install a branch, tag or commit instead of `main` |
| `--repo OWNER/NAME` | Install from another repository, such as your fork. A private one downloads through your `gh` login |
| `--tarball PATH\|URL` | Install from a `.tar.gz` of the source instead of GitHub |
| `--home DIR` | Where Kantel lives, instead of `~/.kantel` |
| `--no-open` | Don't open the console in a browser |

Each option also reads an environment variable (`KANTEL_REPO`, `KANTEL_REF`, `KANTEL_TARBALL`, `KANTEL_HOME`, `KANTEL_ADMIN_EMAIL`, `KANTEL_NO_OPEN=1`). `sh -s -- --help` lists them.

If the image build fails with `EACCES`, your umask is too tight for Docker to read the source (`077` does this). Run `chmod -R go+rX ~/.kantel/src` and install again.

## Sign in

The console is at <http://127.0.0.1:58090/>. Every port is bound to `127.0.0.1`, so on a remote machine forward the ports over SSH first:

```sh
ssh -L 58090:127.0.0.1:58090 -L 58025:127.0.0.1:58025 your-server
```

Kantel is invite-only, and the installer invites one address as the admin. To sign in with it:

1. Enter the address and select **Email me a code**.
2. Open the mailbox at <http://127.0.0.1:58025/>, where the stack catches its own email, and copy the six-digit code.
3. Enter the code. The console signs you in once all six digits are in.

A code lasts 10 minutes, and a sign-in 12 hours. To send codes to real inboxes, see [Your own settings](#your-own-settings).

## Your first API key

On its first start the control plane makes an API key and writes it to a file in its container. Read it with:

```sh
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json
```

The key starts `ktk_`. Send it as a bearer token, and check the control plane answers:

```sh
export KANTEL_URL=http://127.0.0.1:58090
export KANTEL_API_KEY=ktk_...
curl -s "$KANTEL_URL/healthz"
curl -s "$KANTEL_URL/v1/me" -H "authorization: Bearer $KANTEL_API_KEY"
```

`/healthz` answers `{"ok":true}` without a key. `/v1/me` answers with who the key acts as.

In fish, set the variables with `set -x KANTEL_URL http://127.0.0.1:58090` instead of `export`.

## The compute API

The console is the compute console, and the control plane always serves the compute API behind it: [sandboxes](/sandboxes/lifecycle/), [snapshots](/snapshots/history/), [organisations](/accounts/organisations/), [scoped keys](/accounts/api-keys/), [webhooks](/monitoring/webhooks/) and [OpenTelemetry](/monitoring/opentelemetry/). There is nothing to turn on. Its shapes may still change.

The compute API has keys of its own, which start `ksk_`. Its first one holds every scope, and the control plane writes it to the same file as `computeKey`:

```sh
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml exec -T gateway cat /var/lib/harbour/bootstrap.json | jq -r .computeKey
```

Use it as `KANTEL_API_KEY`, and check it answers:

```sh
export KANTEL_API_KEY=ksk_...
curl -s "$KANTEL_URL/v1/whoami" -H "authorization: Bearer $KANTEL_API_KEY"
```

[`kantel-admin`](/self-hosting/admin-cli/) reads it for you: `npx @kantel/admin bootstrap-key --save` saves the key for `kantel` too.

That key can manage the deployment's hosts too, so keep it to yourself: give scripts and agents [keys of their own](/accounts/api-keys/#create-a-key) with only the scopes they need.

The compute API keeps its records in memory for now, so sandboxes, snapshots, organisations and the keys you make are gone when the control plane restarts; only `computeKey` stays the same.

### Add a host

Sandboxes run on hosts you add. Until one joins, the console's **Sandboxes** page says so and its **Add a host** button opens the join command on the **Hosts** page.

A host is a Linux machine with `/dev/kvm` that runs `kantel-host`: Firecracker microVMs and workerd isolates. It dials out to the control plane over a WebSocket, so it needs no open port. A host on the control plane's own machine joins at `http://127.0.0.1:58090`, which the stack uses by default. For hosts on other machines, set where they reach the control plane and upgrade:

```sh
echo 'KANTEL_PUBLIC_URL=https://kantel.example.com' >> ~/.kantel/src/deploy/compose/.env
curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade
```

Then select **Add a host** in the console, or make a join token with the `computeKey`, and run its `command` on the host as root:

```sh
curl -s -X POST "$KANTEL_URL/v1/admin/hosts/join-tokens" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"name": "box-1"}' | jq -r .command
```

```text
sudo npx -y @kantel/host@latest install --url https://kantel.example.com --token kth_...
```

Or with [`kantel-admin`](/self-hosting/admin-cli/#add-hosts): `npx @kantel/admin host add --name box-1`, which prints that command (or runs it over SSH with `--ssh root@box-1`). `kantel-admin host list`, `drain` and `revoke` look after them later.

The host shows up in `GET /v1/admin/hosts` once it connects, and new sandboxes go on it. Its desktop, browser and SSH are reached through short-lived signed URLs on the control plane, which `openDesktop`, `openBrowser` and `openSsh` answer: the desktop link opens it in a browser tab, and `cdpUrl` works with Playwright's `connectOverCDP`. Sandboxes have no address of their own: nothing on the internet, your network or another sandbox can reach one except through these URLs.

To try the API with no host at all, set `KANTEL_COMPUTE_BACKEND=stub`: every sandbox then runs on a built-in stand-in, a shell over files held in memory with no isolation between sandboxes. Commands and files work, but the microVM features (SSH, desktop, browser and pausing) answer with addresses that lead nowhere. Use it to try the API, not to run work.

To let sandboxes [expose ports](/sandboxes/public-ports/), give them a domain of their own and point a wildcard DNS name and TLS certificate for it at the control plane, the same way as `KANTEL_PUBLIC_URL`:

```sh
echo 'KANTEL_COMPUTE_PORTS_DOMAIN=kantel-ports.example' >> ~/.kantel/src/deploy/compose/.env
```

A port is then at `https://3000-<subdomain>.kantel-ports.example`. Use a registrable domain that isn't the console's or a parent of it, so a page a sandbox serves can't set cookies the console reads; the control plane refuses the console's own name and its parents. Without the setting, sandboxes expose no ports.

An account's proxy settings (`PUT /v1/proxy`) reach its sandboxes on hosts, including running ones: allow and deny rules always, and the upstream proxy only on hosts installed with `--proxy-data-path`. The host adds the upstream's headers and token itself, so they never enter a sandbox. To have the host sign the `Kantel-Sandbox` and `Kantel-Account` headers it sends upstream, set `KANTEL_EGRESS_ATTRIBUTION_KEY` to a shared secret your proxy checks.

## Your own settings

The stack reads its settings from `~/.kantel/src/deploy/compose/.env`, which upgrades keep. The ones you're most likely to want:

| Setting | What it does |
| --- | --- |
| `KANTEL_ADMIN_EMAIL` | The address invited as the first admin |
| `KANTEL_SMTP_URL` | Where sign-in codes go: `smtps://user:password@host:port` for TLS from the start, `smtp://user:password@host:port` for STARTTLS. Without it they go to the built-in mailbox |
| `KANTEL_MAIL_FROM` | The sender of sign-in codes, such as `Kantel <kantel@example.com>` |
| `KANTEL_PUBLIC_URL` | The console's address when people reach it through a TLS proxy, such as `https://kantel.example.com` |
| `KANTEL_GATEWAY_PORT` | The console's port on `127.0.0.1`, instead of `58090` |
| `KANTEL_SANDBOX_RUNTIME` | The runtime of sessions' sandbox containers, such as `runsc` or `runc`. Without it, `runsc` when Docker has gVisor, else `runc` |
| `KANTEL_SANDBOX_CONTAINERS` | `off` runs no sandbox containers: sessions' `git`, `node`, `python3` and the like are refused |
| `KANTEL_BROWSER_PROVIDER` | `off` gives sessions no browser. `brwsr`, with `KANTEL_BRWSR_API_KEY`, uses brwsr.dev instead of the stack's own browsers |
| `KANTEL_SUBAGENTS` | `off` takes away the `subagent` tool, which hands a task to a child session |
| `KANTEL_COMPUTE_BACKEND` | `stub` runs sandboxes on a built-in stand-in instead of your hosts. See [Add a host](#add-a-host) |

For example:

```sh
cat >> ~/.kantel/src/deploy/compose/.env <<'EOF'
KANTEL_ADMIN_EMAIL=you@example.com
KANTEL_PUBLIC_URL=https://kantel.example.com
EOF
curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade
```

## Upgrade

Run the installer again with `--upgrade`:

```sh
curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade
```

It downloads the latest source, keeps `deploy/compose/.env`, and rebuilds and restarts the stack. Your data stays in its Docker volumes. An install from before the compute console opens on it at `/` after the upgrade; a `KANTEL_COMPUTE=experimental` line left in `.env` does nothing now and can go (`npx @kantel/admin config unset KANTEL_COMPUTE`), and old `/compute/...` links still work. An install from before the browser host, the sandbox containers or subagents gets them with its upgrade, and the installer's summary says which are on. Without `--upgrade`, running the installer again keeps the copy you have and starts it.

## Stop or remove it

```sh
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml down      # stop it and keep the data
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml down -v   # stop it and delete all its data
```

:::caution
Parts of the stack mount the Docker socket, which is root on the machine. Install it on a machine you control.
:::

<!-- Compute API (675e554a): apps/selfhosted/src/gateway/compute.ts:1-74, apps/selfhosted/src/gateway/main.ts:360-382, deploy/compose/compose.yaml:325-328 -->

<!-- Sources (e496aeb): apps/site/public/install.sh:1-25,40-95,196-290,300-370, deploy/compose/compose.yaml:250-330,415-430, apps/selfhosted/src/gateway/gateway.ts:1-30,390-400, apps/selfhosted/src/gateway/main.ts:1-40,130-160, deploy/compose/README.md:1-60. Sandbox containers, browsers and subagents (7492f92): deploy/compose/compose.yaml:22-45,296-328, apps/site/public/install.sh:10-25,255-285 -->
