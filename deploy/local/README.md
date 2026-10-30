# Partan on your own machine

One command installs Partan and starts it, on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | sh
```

It opens the console at <http://127.0.0.1:8470/> when it's done (and prints the address, for a machine with no
browser). The first visit to a fresh install starts the console's onboarding, where you connect models and connectors;
their credentials go to Partan's vault, never into a file.

While the repository is private, `curl` can't fetch it. If you're signed in to the GitHub CLI, this does the same with
your login:

```sh
gh api -H 'Accept: application/vnd.github.raw' repos/tvdavies/harbour/contents/install.sh | sh
```

From a checkout, `sh install.sh` installs that checkout instead of downloading one.

## What you need

- **Docker with Compose v2.** On Linux, Docker Engine and its Compose plugin
  (<https://docs.docker.com/engine/install/>), with your user allowed to use it. On macOS, Docker Desktop or OrbStack.
  Rootless Docker works. gVisor isn't needed: Partan runs on Docker's default runtime.
- **curl and tar**, which nearly every system has.
- About 6 GB of disk for the images, and a few minutes for the first build.

Node.js, pnpm and Bun aren't needed: everything builds and runs in containers. The installer checks for each of these and
says how to get anything that's missing.

## Options

Options go after `sh -s --`, or in the environment with `env`. Both forms work in bash, zsh and fish:

```sh
curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | sh -s -- --port 9470 --no-open
curl -fsSL https://raw.githubusercontent.com/tvdavies/harbour/main/install.sh | env PARTAN_PORT=9470 PARTAN_NO_OPEN=1 sh
```

| Option | Environment | Default | |
|---|---|---|---|
| `--port N` | `PARTAN_PORT` | 8470 | The console's port, on 127.0.0.1 |
| `--mail-port N` | `PARTAN_MAIL_PORT` | port + 1 | The local mailbox, where sign-in codes arrive |
| `--email ADDRESS` | `PARTAN_ADMIN_EMAIL` | admin@partan.localhost | The first admin, invited when Partan starts |
| `--home DIR` | `PARTAN_HOME` | ~/.partan | Where the install lives |
| `--ref REF` | `PARTAN_REF` | main | The branch, tag or commit to install |
| `--source DIR` | `PARTAN_SOURCE` | | Install a checkout instead of downloading |
| `--tarball URL` | `PARTAN_TARBALL` | | Install from a .tar.gz (URL or file) instead of GitHub |
| `--upgrade` | `PARTAN_UPGRADE=1` | | Download the source again even if it's there |
| `--no-browser` | `PARTAN_BROWSER=off` | | Leave out Partan's own browsers |
| `--no-start` | `PARTAN_NO_START=1` | | Set up, but don't build or start |
| `--no-open` | `PARTAN_NO_OPEN=1` | | Don't open the console in a browser |

Nothing asks a question, so the same command works on a headless machine or in CI. Settings are kept in
`~/.partan/partan.env`, so running the installer again with no options keeps them, and with an option changes just that.

## Signing in

Partan is invite-only and signs people in with a one-time code by email. A local install sends mail to its own mailbox
instead of the internet: sign in as `admin@partan.localhost` (or your `--email`), then read the code at
<http://127.0.0.1:8471/>.

## Afterwards

The installer puts a `partan` command in `~/.partan/bin` (and links it into `~/.local/bin` when that's on your `PATH`):

```sh
~/.partan/bin/partan status      # what's running, and the console's address
~/.partan/bin/partan stop        # stop it; it stays stopped until you start it
~/.partan/bin/partan start
~/.partan/bin/partan open        # open the console
~/.partan/bin/partan logs gateway
~/.partan/bin/partan upgrade     # fetch the latest, rebuild and restart; your data is kept
~/.partan/bin/partan uninstall   # remove it and all its data (asks first; --yes to skip, --keep-data to keep it)
```

Running the installer again is safe: it skips what's done (the source, the keys) and rebuilds and restarts only what
changed. Partan runs as the Docker Compose project `partan`, and the Docker daemon restarts it after a reboot unless you
stopped it.

On a machine you reach over SSH, forward the console's port: `ssh -L 8470:127.0.0.1:8470 <host>`, then open
<http://127.0.0.1:8470/> on your own machine.

## What runs

[compose.yaml](compose.yaml) and [browser.yaml](browser.yaml), as the compose project `partan`:

| Service | What it is | On the host |
|---|---|---|
| `gateway` | The APIs and the console (`apps/selfhosted`) | 127.0.0.1:8470 |
| `postgres` | Sessions, identity, audit, the vault, skills and memory | none |
| `minio` | Workspace files and skill files | none |
| `mailpit` | The local mailbox for sign-in codes | 127.0.0.1:8471 |
| `browser-host` | Starts one Chromium container per browser through the Docker socket; keeps profiles and recordings, sealed | none |

The passwords and keys (Postgres, MinIO, the vault's cipher key and the browser host's keys) are generated for each
install and kept in `~/.partan/partan.env`, readable by you only. Keep that file: the vault and the browsers' profiles
are sealed with its keys.

The browser image is linux/amd64 only (Chrome for Testing's headless shell has no arm64 build). On an Apple silicon Mac,
Docker Desktop and OrbStack run it under emulation; on an arm64 Linux machine without qemu's binfmt handlers, install
with `--no-browser`.

For development and CI, `deploy/compose` has the full self-hosted stack, with the M0 session hosts and fixtures.
