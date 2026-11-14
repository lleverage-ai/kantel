---
title: Install Kantel
description: Install Kantel's control plane on your own machine with one command, sign in to the console, find your first API key, add a host to run sandboxes on, and upgrade or remove it later.
---

The control plane is Kantel's console and API. It runs as a Docker Compose stack on one machine, and the installer sets it up for you.

## What you need

- Linux or macOS, with Docker and its Compose v2 plugin, and the Docker daemon running. On a Mac, Docker Desktop or OrbStack.
- `curl` and `tar`.
- A few gigabytes of disk for the images. The first build takes a few minutes.

Sandboxes don't run in the stack: they run on [hosts](/hosts/), Linux machines with `/dev/kvm` that you add once you're signed in. The control plane's own machine can be one.

You don't need Node.js or pnpm: everything builds and runs in containers.

## Install

```sh
curl -fsSL https://kantel.dev/install.sh | sh
```

The command works the same from bash, zsh and fish, because the script always runs under `sh`. It:

1. checks for Docker, Compose, `curl` and `tar`, and tells you how to get anything that's missing;
2. downloads Kantel's source from GitHub into `~/.kantel/src`;
3. builds and starts the stack (the gateway, which serves the console and the API, Postgres, and a mailbox for sign-in codes), and waits until the console answers;
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

### Sign in with GitHub or Google

The sign-in page can also offer **Sign in with GitHub** and **Sign in with Google**. Each needs an OAuth client you make with the provider, and `KANTEL_PUBLIC_URL` set to the HTTPS address people reach the console at, since the provider sends people back there. Kantel stays invite-only: someone signs in when the provider's verified email matches an invite or someone who already signs in. A person who signs in more than one way, with the same email, is one user.

1. Make the clients, with these callback URLs, where `https://kantel.example.com` is your `KANTEL_PUBLIC_URL`:
   - **GitHub**: in **Settings → Developer settings → OAuth Apps → New OAuth App**, set the **Homepage URL** to `https://kantel.example.com` and the **Authorization callback URL** to `https://kantel.example.com/auth/oauth/github/callback`. Kantel asks for the `read:user` and `user:email` scopes, and uses the account's primary email only once GitHub has verified it.
   - **Google**: in the Google Cloud console, under **Google Auth Platform**, set up the consent screen with the `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile` scopes. Then make a client of type **Web application**, with the **Authorized redirect URI** `https://kantel.example.com/auth/oauth/google/callback`. Kantel accepts an email only where Google vouches for it: a verified Gmail address, or a Google Workspace account's. Someone whose Google account uses another address signs in with an email code.
2. Add each client's ID and secret to `~/.kantel/src/deploy/compose/.env`, and run the installer with `--upgrade`:

   ```sh
   cat >> ~/.kantel/src/deploy/compose/.env <<'EOF'
   KANTEL_PUBLIC_URL=https://kantel.example.com
   KANTEL_GITHUB_CLIENT_ID=...
   KANTEL_GITHUB_CLIENT_SECRET=...
   KANTEL_GOOGLE_CLIENT_ID=...
   KANTEL_GOOGLE_CLIENT_SECRET=...
   EOF
   curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade
   ```

A provider is on only when both its ID and secret are set. Leave a pair out and its button doesn't appear. Without SMTP for codes, the page offers only the providers.

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

[`kantel-admin`](/self-hosting/admin-cli/) reads it for you: `kantel-admin bootstrap-key --save` saves the key for `kantel` too.

That key can manage the deployment's hosts too, so keep it to yourself: give scripts and agents [keys of their own](/accounts/api-keys/#create-a-key) with only the scopes they need.

The compute API keeps its records in memory for now, so sandboxes, snapshots, organisations and the keys you make are gone when the control plane restarts; only `computeKey` stays the same.

### Add a host

Sandboxes run on hosts you add. Until one joins, the console's **Sandboxes** page says so and its **Add a host** button opens the join command on the **Hosts** page.

A host is a Linux machine with `/dev/kvm` that runs `kantel-host`: Firecracker microVMs and V8 isolates. It dials out to the control plane over a WebSocket, so it needs no open port. [Self-host quick start](/self-hosting/quickstart/) joins one on the control plane's own machine, and [Hosts](/hosts/) covers it in full. A host on the control plane's own machine joins at `http://127.0.0.1:58090`, which the stack uses by default. For hosts on other machines, set where they reach the control plane and upgrade:

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
curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token kth_...
```

That downloads `kantel-host` from Kantel's latest GitHub Release, checks it against the release's `SHA256SUMS` and runs its `install`, as [Hosts](/hosts/#get-kantel-host-and-the-images) explains. The kernel and sandbox images are published, and the installer fetches them on its own.

Or with [`kantel-admin`](/self-hosting/admin-cli/#add-hosts): `kantel-admin host add --name box-1`, which prints that command. `kantel-admin host list`, `drain` and `revoke` look after hosts later.

The host shows up in `GET /v1/admin/hosts` once it connects, and new sandboxes go on it. Its desktop, browser and SSH are reached through short-lived signed URLs on the control plane, which `openDesktop`, `openBrowser` and `openSsh` answer: the desktop link opens it in a browser tab, and `cdpUrl` works with Playwright's `connectOverCDP`. Sandboxes have no address of their own: nothing on the internet, your network or another sandbox can reach one except through these URLs.

To try the API with no host at all, set `KANTEL_COMPUTE_BACKEND=stub`: every sandbox then runs on a built-in stand-in, a shell over files held in memory with no isolation between sandboxes. Commands and files work, but the microVM features (SSH, desktop, browser and pausing) answer with addresses that lead nowhere. Use it to try the API, not to run work.

To let sandboxes [expose ports](/sandboxes/public-ports/), give them a domain of their own and point a wildcard DNS name and TLS certificate for it at the control plane, the same way as `KANTEL_PUBLIC_URL`:

```sh
echo 'KANTEL_COMPUTE_PORTS_DOMAIN=kantel-ports.example' >> ~/.kantel/src/deploy/compose/.env
```

A port is then at `https://3000-<subdomain>.kantel-ports.example`, and the console shows the sandbox's address as `<subdomain>.kantel-ports.example`. Use a domain of your own, not `kantel.run`, which is Kantel's hosted service's. Use a registrable domain that isn't the console's or a parent of it, so a page a sandbox serves can't set cookies the console reads; the control plane refuses the console's own name and its parents. To keep sandboxes' pages apart from each other too, add the domain to the Public Suffix List, as [Security model](/self-hosting/security/#the-ports-domain) explains. Without the setting, sandboxes expose no ports.

Desktop, browser, SSH and port URLs, and who may still use them, are kept in the database, so they keep working when the control plane restarts. With the database, you can run several gateways behind one load balancer: give each the same settings, and `KANTEL_REPLICA_URL`, the address on your private network where the others reach it (by default its first IPv4 address and port). A host connects to whichever gateway the balancer picks, and the others pass its sandboxes' requests on to that one. [Security model](/self-hosting/security/#several-gateways) says what they trust in each other.

An account's [proxy settings](/sandboxes/egress-proxy/) (`PUT /v1/proxy`) reach its sandboxes on hosts, including running ones: allow and deny rules always, and the upstream proxy only on hosts installed with `--proxy-data-path`. The host adds the upstream's headers itself, so they never enter a sandbox. To have the host sign the `Kantel-Sandbox` and `Kantel-Account` headers it sends upstream, set `KANTEL_EGRESS_ATTRIBUTION_KEY` to a shared secret your proxy checks.

[Environments](/sandboxes/environments/) keep protected variables' values and secret files encrypted in the database, with a key you give the control plane, `KANTEL_SECRETS_KEY`: 32 random bytes in base64. Make one and add it to your settings:

```sh
echo "KANTEL_SECRETS_KEY=$(openssl rand -base64 32)" >> ~/.kantel/src/deploy/compose/.env
```

Then run the installer with `--upgrade`, as in [Your own settings](#your-own-settings), to restart with it. Without the key, an install that keeps its data in a database refuses protected values and secret files, and plain variables still work. Keep a copy of the key somewhere safe, apart from the database's backups: without it, the protected values and secret files can't be read, and you have to set them again. Changing the key isn't supported yet, so set it once.

With [sticky disks](/sandboxes/sticky-disks/) on, the control plane also keeps the key it signs hosts' disk fetch grants with sealed with `KANTEL_SECRETS_KEY`. To replace that grant key, if you think it has leaked, run `kantel-admin grant-key rotate` (or `POST /v1/admin/grant-key/rotate`): connected hosts get the new key at once, it signs grants from 3 minutes later, and hosts accept the old one for 16 minutes after that, so fetches under way finish. If the secrets key changes, the first gateway that can't open the grant key as it signs a grant replaces it, with a new key that signs at once; change the secrets key on every gateway together, as gateways with different secrets keys can't sign with each other's grant keys. Update the control plane before hosts: a host on an older kantel-host holds one key, takes the new one when it begins signing, and asks again for a grant only for a fetch already under way.

## Your own settings

The stack reads its settings from `~/.kantel/src/deploy/compose/.env`, which upgrades keep. The ones you're most likely to want:

| Setting | What it does |
| --- | --- |
| `KANTEL_ADMIN_EMAIL` | The address invited as the first admin |
| `KANTEL_SMTP_URL` | Where sign-in codes and invites go: `smtps://user:password@host:port` for TLS from the start, `smtp://user:password@host:port` for STARTTLS. Without it they go to the built-in mailbox |
| `KANTEL_MAIL_FROM` | The sender of sign-in codes, such as `Kantel <kantel@example.com>` |
| `KANTEL_PUBLIC_URL` | The console's address when people reach it through a TLS proxy, such as `https://kantel.example.com` |
| `KANTEL_GITHUB_CLIENT_ID`, `KANTEL_GITHUB_CLIENT_SECRET` | A GitHub OAuth app's client, for **Sign in with GitHub**. See [Sign in with GitHub or Google](#sign-in-with-github-or-google) |
| `KANTEL_GOOGLE_CLIENT_ID`, `KANTEL_GOOGLE_CLIENT_SECRET` | A Google OAuth client, for **Sign in with Google**. See [Sign in with GitHub or Google](#sign-in-with-github-or-google) |
| `KANTEL_GATEWAY_PORT` | The console's port on `127.0.0.1`, instead of `58090` |
| `KANTEL_ACCOUNT_HOSTS` | `experimental` lets people add machines of their own to their account or organisation. See [Your own hosts](/own-hosts/) |
| `KANTEL_MOUNTS` | `experimental` turns on read-only [mounts](/api/reference/mounts/) (bundles and bucket prefixes), signed file URLs and archive extraction. Bundles are kept in the gateway's volume, or in `KANTEL_BUNDLES_DIR` when it's set. That's a path inside the gateway's container, so a directory elsewhere also needs a volume mounted there (a Compose override). Gateway replicas sharing one database must share one bundle directory; a gateway with a directory of its own refuses to upload, serve or delete bundles (503) |
| `KANTEL_TEMPLATES` | `experimental` turns templates on: microVM profiles (image, size, variables, setup, egress) Kantel builds once and restores from a snapshot |
| `KANTEL_SNAPSHOT_EXPIRY` | `on` deletes automatic snapshots past their `expiresAt` (7 days), on hosts that keep a saved snapshot's own copy. Off by default. A gateway with it on waits 15 minutes after it starts before its first pass. With several gateways on one database, turn it on only once every gateway runs this version: an older one doesn't coordinate its creates and forks with expiry |
| `KANTEL_COMPUTE_BACKEND` | `stub` runs sandboxes on a built-in stand-in instead of your hosts. See [Add a host](#add-a-host) |
| `KANTEL_COMPUTE_IMAGES` | An http(s) URL with the kernel and images hosts install from, instead of Kantel's published ones, or `off`. See [Hosts](/hosts/#get-kantel-host-and-the-images) |
| `KANTEL_COMPUTE_PORTS_DOMAIN` | The domain sandboxes' [public ports](/sandboxes/public-ports/) are served under. The console shows sandboxes' addresses under it too (`<subdomain>.<domain>`); without it, under the console's own host |
| `KANTEL_EGRESS_ATTRIBUTION_KEY` | The secret hosts sign the [`Kantel-Sandbox` and `Kantel-Account` headers](/sandboxes/egress-proxy/#send-traffic-through-your-own-proxy) with |
| `KANTEL_SECRETS_KEY` | 32 random bytes in base64 (`openssl rand -base64 32`) that environments' [protected values and secret files](/sandboxes/environments/) are encrypted with, and, with sticky disks on, the key the control plane signs hosts' disk fetch grants with. Without it, an install with a database refuses protected values and signs no grants. Losing it loses them, and changing it isn't supported yet |
| `KANTEL_REPLICA_URL` | With several gateways, where the others reach this one on your private network, such as `http://10.0.3.7:8080` |
| `KANTEL_HOST_VERSION`, `KANTEL_HOST_UPDATE_URL` | The `kantel-host` version hosts should run, and where they get it. See [Update a host](/hosts/#update-a-host) |
| `KANTEL_HOST_RELEASES` | Where the latest `kantel-host` release is read, to mark out-of-date hosts in the console. Default Kantel's latest GitHub Release; `off` reads none. See [Update a host](/hosts/#update-a-host) |
| `KANTEL_RELEASE_CHECK_TOKEN` | A secret of 32 characters or more (`openssl rand -hex 32`) that `POST /v1/hosts/releases/check` takes as its bearer, to read the latest release now rather than within the hour. Unset, those calls are refused. See [Check for updates now](/hosts/#check-for-updates-now) |

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

It downloads the latest source, keeps `deploy/compose/.env`, and rebuilds and restarts the stack. Your data stays in its Docker volumes, and your organisation, projects, keys and sign-ins carry over. Without `--upgrade`, running the installer again keeps the copy you have and starts it.

An install from before the compute console opens on it at `/` after the upgrade. A `KANTEL_COMPUTE=experimental` line left in `.env` does nothing now and can go (`kantel-admin config unset KANTEL_COMPUTE`), and old `/compute/...` links still work.

### From a version with sessions

Versions before November 2026 also ran Kantel's agent plane: sessions, agent profiles, models, connections, the vault, Kantel's own browsers, skills and memory. They were removed, and the upgrade stops and removes their services (session hosts, the isolate and browser hosts, MinIO and the vault proxy) with `docker compose up --remove-orphans`. It deletes no data:

- their tables stay in Postgres, unread, and their volumes (`miniodata`, `vaultca`, `browserdata`) stay until you remove them with `docker volume rm`;
- sandbox and browser containers the old gateway started aren't Compose's, so they stay too: list them with `docker ps -a --filter label=harbour.stack` and `docker ps -a --filter label=harbour.browser-host`;
- settings only the agent plane read, such as `KANTEL_CPA_URL`, `KANTEL_DEFAULT_MODEL`, `KANTEL_SUBAGENTS` and `KANTEL_BROWSER_PROVIDER`, are ignored.

The session API (`/v1/sessions` and the rest) now answers 404. If you still need it, stay on, or go back to, the last version that has it, the `agent-plane-archive-2026-11-03` tag:

```sh
curl -fsSL https://kantel.dev/install.sh | sh -s -- --upgrade --ref agent-plane-archive-2026-11-03
```

## Stop or remove it

```sh
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml down      # stop it and keep the data
docker compose -f ~/.kantel/src/deploy/compose/compose.yaml down -v   # stop it and delete all its data
```

`down -v` deletes the volumes this version's stack declares. An upgraded install's older volumes (`miniodata`, `vaultca`, `browserdata`) go with `docker volume rm`.

<!-- Compute only (TASK-4705): deploy/compose/compose.yaml, deploy/compose/README.md (Upgrading from the agent plane), apps/site/public/install.sh (run_compose) -->

<!-- Compute API (675e554a): apps/selfhosted/src/gateway/compute.ts:1-74, apps/selfhosted/src/gateway/main.ts:360-382, deploy/compose/compose.yaml:325-328 -->

<!-- Sources (e496aeb): apps/site/public/install.sh:1-25,40-95,196-290,300-370, deploy/compose/compose.yaml:250-330,415-430, apps/selfhosted/src/gateway/gateway.ts:1-30,390-400, apps/selfhosted/src/gateway/main.ts:1-40,130-160, deploy/compose/README.md:1-60. Sandbox containers, browsers and subagents (7492f92): deploy/compose/compose.yaml:22-45,296-328, apps/site/public/install.sh:10-25,255-285 -->
