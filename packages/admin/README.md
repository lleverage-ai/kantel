# @kantel/admin

`kantel-admin` is for whoever runs a self-hosted Kantel: it installs and upgrades the control plane, changes its
settings, and adds, drains and revokes the Linux machines that run sandboxes. Using sandboxes is the `kantel`
command's job (`npx kantel help`).

```sh
npx @kantel/admin install --email you@example.com      # the control plane, with Docker Compose
npx @kantel/admin compute enable --public-url https://kantel.example.com --apply   # for hosts on other machines
npx @kantel/admin bootstrap-key --save                  # sign in with the deployment's first compute key
npx @kantel/admin host add --name builder-1             # prints the command to run on the new machine
sudo npx -y @kantel/admin host join --url https://kantel.example.com --token kth_...   # on that machine
npx @kantel/admin host list
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
| `host join --url URL --token kth_…` | On the new machine, as root: runs `@kantel/host`'s `kantel-host install`. |
| `host run -- doctor` | Any other `kantel-host` command on this machine. |
| `host drain <id> [--undo]`, `host revoke <id> --yes` | Stop new sandboxes on a host, or revoke its credential. |

The API commands take the same settings as `kantel`: `--url` and `--key`, `KANTEL_URL` and `KANTEL_API_KEY`, or the
file `kantel login` writes. `--home` (or `KANTEL_HOME`) says where Kantel is installed, `~/.kantel` by default, and
`--json` prints JSON.

The host agent itself is `@kantel/host`, a Go binary in per-platform npm packages; `kantel-admin` only runs it.
