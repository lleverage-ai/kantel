# @kantel/selfhosted-sandbox

The self-hosted container tier: a `ContainerBackend` for `@kantel/sandbox/tiered` that runs each container lease in
its own long-lived Docker container on gVisor (`runsc-kvm` by default), over the Docker Engine API on a unix socket.

```ts
import { createTieredSandboxes } from "@kantel/sandbox/tiered";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import { createDockerContainerBackend } from "@kantel/selfhosted-sandbox";

const container = createDockerContainerBackend({ workspaces, image: "harbour-sandbox:dev" });
const sandboxes = createTieredSandboxes({ workspaces, isolate, container, clock, audit, access });
// At start-up, and now and then: remove containers a previous host process left behind.
await container.reapExpired();
```

Options: `socketPath` (default `/var/run/docker.sock`), `runtime` (default `runsc-kvm`; `runsc` inside a VM without
nested KVM, `runc` only for development), `memoryBytes`, `nanoCpus`, `network` (the vault proxy, below; absent means
`NetworkMode: none`), `proxyCredentials` (below), `labelPrefix` (default `harbour`), `clock`, `execTimeoutMs`
(default 120 s) and `maxOutputBytes` (default 1 MiB per stream).

`network` is `{ name, proxyUrl, isolation?, proxyContainer?, subnetPool? }`:

- `isolation: "shared"` (the default): `name` is an existing internal network whose only exit is the proxy, and every
  lease's container joins it. Sandboxes on it can reach each other.
- `isolation: "per-lease"`: each lease gets an internal network of its own, `<name>-<random>`, created with its
  container, removed with it (or by the janitor) and labelled like it. The proxy's container (`proxyContainer`,
  default the proxy URL's host) is connected to it under the proxy URL's host name, so the proxy is the sandbox's only
  peer and no sandbox can reach another. `proxyUrl` must name the proxy by host name. `subnetPool` (such as
  `10.248.0.0/16`) gives each lease's network a free /28 of that range; without it Docker's default address pools
  apply, which hold only about 30 networks on a default daemon.

`proxyCredentials` is `{ issue({ ctx, lease }), revoke(leaseId) }`. `issue` returns the token the vault proxy knows the
lease by, each time the lease's container is created; it goes into `HTTP(S)_PROXY` as `http://sbx:<token>@<proxy>`, so
every request the sandbox sends through the proxy carries it as `Proxy-Authorization: Basic`, and the proxy resolves it
to the lease's organisation, project, agent and session for the vault's egress decision. `revoke` is called before the
lease's container and network are removed (`ended`, a fresh container for the lease, or `reapExpired`), and must be
safe to repeat: a failure fails that call and leaves the lease's resources in place, so a retry or the janitor revokes it
again rather than leaving a live token behind. Before `issue`, the backend creates an empty volume labelled with the
lease (`<prefix>.role=credentials`), so the janitor finds a lease whose container never came up even where nothing
else was labelled with it. The janitor revokes and removes in the lease's turn, after checking again that no command
has started a container for it since it listed. Needs `network`.

## How it works

- **One container per lease**, created on the lease's first command and removed, with its volumes, when the lease ends.
  Its labels (`<prefix>.lease`, `.session`, `.workspace`, `.expires-at`, `.role`) let `reapExpired` remove what a
  restarted host left behind. A lease that reaches a host with no record of its container gets a fresh one from the
  head; whatever the old one had not committed is lost, as when a container dies.
- **No host path is shared.** `/workspace` is an anonymous volume (gVisor keeps root filesystem writes inside the
  sandbox, where the archive API cannot see them, but writes volumes through to the host). Files go in through the archive API; changes come out through scripts run
  inside the container.
- **Nothing runs as root on `/workspace`.** Scan, collection and re-base all run as user 1000, from `/`, with Python in
  isolated mode (`python3 -I -S`), so a `hashlib.py` or `json.py` in the working copy is never imported. Background
  jobs survive between commands and can swap a directory for a symlink at any moment; as user 1000, following one
  reaches nothing the user could not reach anyway. The Docker daemon extracts archives as root and follows symlinks, so
  head files are never extracted into `/workspace`: they go into `/var/harbour-stage/<random>`, a root-owned (0755)
  volume the user can read but not write, and a script run as user 1000 copies them into place with their modes; root
  then removes the stage.
- **Re-base before every command.** The diff between the version the container last synced and the head is applied
  (through the stage, as above, for added and changed files; removed by user 1000 for deleted ones), except for paths
  the container itself changed since, which win, and never through a symlink at the path itself (a background job can
  still swap a parent directory mid-way, which only redirects the write to somewhere user 1000 could already write).
  So the container sees the isolate's last
  write. A path user 1000 cannot change (it made it unwritable) is reported on the script's stderr and left as it is:
  the working copy misses that part of the head and never reverts it.
- **Change detection.** After every command (and before every re-base) a Python script inside the container hashes
  every file under `/workspace` (SHA-256, the workspace's own digest) with its mode, without following symlinks, and the
  host compares that with what it last synced or saw. What user 1000 cannot read (a file or directory it made
  unreadable) is skipped, reported on the scan's stderr, and taken as unchanged: the command does not fail, an
  unreadable new file is not collected, and the files under an unreadable directory are not taken as deleted. A GET of the whole archive would move the working copy over the
  socket twice per command; hashing in place moves only digests. `.git` and `node_modules` stay local to the container
  in both directions by default (`localOnly`); the self-hosted gateway keeps only `node_modules` local, so a
  repository is synced like any other files and outlives its container.
- **Commit on release.** `pending` re-bases, scans and returns the container's changes (puts with content and mode,
  deletes) with a stamp; `committed(stamp)` folds exactly those into the synced state; `pending({ final: true })` fences
  the lease, so any later command on it is refused with `expired`, and kills every process of user 1000 in the container
  before its snapshot, so no background job can change the working copy after it.
- **Commands** run as user 1000 under `timeout` (SIGTERM at the deadline, SIGKILL 5 s later, exit code 124), in the
  requested `cwd` under `/workspace`, with the request's env and stdin. Output goes through files outside `/workspace`,
  so a background job still holding stdout cannot keep a call waiting, and is cut at `maxOutputBytes` (`truncated`).
- **Mounts** (`/project`, ...) are copied at create into a named volume each (through a never-started staging
  container) and mounted read-only, so reads work and writes fail with "Read-only file system". They are pinned for the
  container's life: a remount during a lease is seen by the next lease.
- **Network**: none by default. With `network`, the container joins it, the proxy's address goes into `/etc/hosts`
  (gVisor cannot use Docker's DNS on user networks), `HTTP(S)_PROXY` point at the proxy, and the vault's CA
  (`<proxyUrl>/ca.crt`) is installed at `/etc/harbour/ca.crt` for every common TLS client.

The image needs `sh`, coreutils (`timeout`, `head`, `rm`), `python3` and user 1000: `images/sandbox` has them.

## Tests

`pnpm test` runs the tar and stream tests; the Docker tests are skipped unless asked for:

```sh
docker build -t harbour-sandbox:dev images/sandbox
KANTEL_TEST_DOCKER=1 pnpm --filter @kantel/selfhosted-sandbox test
```

They run the sandbox conformance suite (with project access) over `createTieredSandboxes` with this backend and the
in-process isolate, plus focused cases: both directions of visibility, the executable bit, cwd/env/stdin, timeouts,
truncation, read-only `/project`, removal on `ended`, `reapExpired`, `git --version` and `uname -a` (gVisor reports
its own kernel), no import of the working copy's Python modules, head files owned by user 1000 with their modes,
unreadable paths skipped, and background jobs killed before the final snapshot. With per-lease networks and a stand-in
proxy: each lease's own network holds only it and the proxy, its proxied requests carry its own token, one lease cannot
reach another's address, and ending or reaping a lease removes its network and revokes its token (these need the host
to resolve `.localhost` names, as systemd-resolved does, and are skipped where it does not). Optional: `KANTEL_TEST_SANDBOX_IMAGE` (default `harbour-sandbox:dev`), `KANTEL_TEST_SANDBOX_RUNTIME`
(default `runsc-kvm`), `KANTEL_TEST_DOCKER_SOCKET` and `KANTEL_TEST_LABEL_PREFIX` (default `harbour-test`). Every case
labels what it creates with its own `<KANTEL_TEST_LABEL_PREFIX>-<random>` prefix and removes it afterwards; CI sets a
per-run base so it can also remove what a cancelled run left behind. None of it carries `harbour.owner`, so a Kantel
stack's sandbox janitor on the same daemon never sees it.

## Limits

- Every scan hashes every file, so scans take longer on large trees.
- Background jobs are not paused during the scans and re-bases of ordinary commands, so a job writing at that moment
  can race them; the race stays within what user 1000 can do. Only the final `pending` kills them.
- With `isolation: "per-lease"`, the proxy joins each lease's network when its container is created. A proxy container
  that is recreated (not just restarted) leaves those networks, so live leases lose their way out until their next
  container; recreate the proxy only with the sandboxes.
- With `network` and the default `isolation: "shared"`, sandboxes share the given network rather than getting one
  each; and without `proxyCredentials` requests carry no per-lease proxy token. Both are opt-in.
- A lease's `expires-at` label is its expiry when the container was created; renewals do not update it. The janitor
  never reaps a lease the running backend serves or is creating a container for, so this matters only after a restart,
  and when several deployments share one Docker daemon: one's janitor would reap the other's renewed leases. Give each
  deployment on a daemon its own `labelPrefix`.
