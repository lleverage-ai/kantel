# kantel-admin

`kantel-admin` is for whoever runs a self-hosted Kantel: it installs and upgrades the control plane, changes its
settings, and adds, drains and revokes the Linux machines that run sandboxes. Using sandboxes is the `kantel`
command's job (`kantel help`).

It isn't on npm. Each of Kantel's [GitHub Releases](https://github.com/lleverage-ai/kantel/releases) carries it as one
file, `kantel-admin.js`, which needs Node.js 22 or later. These lines work in bash, zsh and fish:

```sh
sudo curl -fsSLo /usr/local/bin/kantel-admin https://github.com/lleverage-ai/kantel/releases/latest/download/kantel-admin.js
sudo chmod 755 /usr/local/bin/kantel-admin
kantel-admin version
```

`curl -fsSL https://kantel.dev/cli.sh | sh -s -- --admin` installs it with `kantel`, for you alone in `~/.local/bin` (which `sudo` doesn't search, so use the lines above for `sudo kantel-admin`).
`SHA256SUMS` in the same release has its SHA-256, and the release's attestations say which workflow run built it
(`gh attestation verify /usr/local/bin/kantel-admin --repo lleverage-ai/kantel`).

```sh
kantel-admin install --email you@example.com      # the control plane, with Docker Compose
kantel-admin compute enable --public-url https://kantel.example.com --apply   # for hosts on other machines
kantel-admin bootstrap-key --save                  # sign in with the deployment's first compute key
kantel-admin host add --name builder-1             # prints the command to run on the new machine
sudo kantel-admin host join --url https://kantel.example.com --token kth_...   # or run that command on the machine
kantel-admin host list
```

| Command | What it does |
| --- | --- |
| `install`, `upgrade` | Run [kantel.dev/install.sh](https://kantel.dev/install.sh) (with `--upgrade`), passing on `--email`, `--ref`, `--repo`, `--tarball`, `--no-open` and anything after `--`. |
| `apply` | Restart the stack with its current settings (`docker compose up -d --wait`), downloading nothing. |
| `status` | Whether the console answers, how many services run, and the compute settings. |
| `config list`, `config set KEY=value…`, `config unset KEY…` | Read and change `~/.kantel/src/deploy/compose/.env`; `--apply` runs `apply` after the change. Secrets show as `(set)`. |
| `compute enable [--public-url URL] [--apply]` | Runs sandboxes on your hosts (the default): drops `KANTEL_COMPUTE_BACKEND=stub` and the old `KANTEL_COMPUTE` switch, and sets `KANTEL_PUBLIC_URL` for hosts on other machines. |
| `bootstrap-key [--save]` | Prints the deployment's first compute key (it has `hosts:admin`), or saves it in `kantel`'s config. |
| `host list`, `host info <id>` | The machines that have joined. |
| `host add [--name] [--label k=v] [--expires-minutes n] [--ssh user@machine]` | A one-use join token and its command; `--ssh` runs it on the machine for you. |
| `host join --url URL --token kth_…` | On the new machine, as root: runs the host installer (`install.sh`) from Kantel's latest release, which downloads `kantel-host`, checks its SHA-256 and runs `kantel-host install`. `KANTEL_HOST_INSTALLER_URL` runs another copy. |
| `host run -- doctor` | Any other `kantel-host` command on this machine. |
| `host drain <id> [--undo]`, `host revoke <id> --yes` | Stop new sandboxes on a host, or revoke its credential. |

The API commands take the same settings as `kantel`: `--url` and `--key`, `KANTEL_URL` and `KANTEL_API_KEY`, or the
file `kantel login` writes. `--home` (or `KANTEL_HOME`) says where Kantel is installed, `~/.kantel` by default, and
`--json` prints JSON.

The host agent itself is `kantel-host`, a Go binary in `apps/host`; releases carry it for Linux x86_64 and arm64.
In this repository the package is `@kantel/admin` (private); `pnpm --filter @kantel/admin build` writes
`dist/kantel-admin.js`.
