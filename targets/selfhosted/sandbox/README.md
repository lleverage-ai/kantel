# @harbour/selfhosted-sandbox

The self-hosted container tier for Sandboxes v1 (#10): a `ContainerBackend` for `@harbour/sandbox/tiered` that runs
each container lease in its own long-lived Docker container on gVisor (`runsc-kvm` by default), over the Docker Engine
API on a unix socket. Ported from `apps/selfhosted/src/sandbox` (Docker API, archive copy, gVisor findings) and the
Cloudflare spike's container tier (re-base, fences, pending stamps, dirty tracking).

```ts
import { createTieredSandboxes } from "@harbour/sandbox/tiered";
import { createInProcessIsolateBackend } from "@harbour/sandbox/isolate";
import { createDockerContainerBackend } from "@harbour/selfhosted-sandbox";

const container = createDockerContainerBackend({ workspaces, image: "harbour-sandbox:dev" });
const sandboxes = createTieredSandboxes({ workspaces, isolate, container, clock, audit, access });
// At start-up, and now and then: remove containers a previous host process left behind.
await container.reapExpired();
```

Options: `socketPath` (default `/var/run/docker.sock`), `runtime` (default `runsc-kvm`; `runsc` inside a VM without
nested KVM, `runc` only for development), `memoryBytes`, `nanoCpus`, `network` (`{ name, proxyUrl }`: an existing
internal network whose only exit is the vault proxy; absent means `NetworkMode: none`), `labelPrefix` (default
`harbour`), `clock`, `execTimeoutMs` (default 120 s) and `maxOutputBytes` (default 1 MiB per stream).

## How it works

- **One container per lease**, created on the lease's first command and removed, with its volumes, when the lease ends.
  Its labels (`<prefix>.lease`, `.session`, `.workspace`, `.expires-at`, `.role`) let `reapExpired` remove what a
  restarted host left behind. A lease that reaches a host with no record of its container gets a fresh one from the
  head; whatever the old one had not committed is lost, as when a container dies.
- **No host path is shared.** `/workspace` is an anonymous volume (gVisor keeps root filesystem writes inside the
  sandbox, where the archive API cannot see them, but writes volumes through to the host:
  `docs/measurements/m0-sh1-selfhosted`). Files go in through the archive API; changes come out through scripts run
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
  in both directions, as in the spike.
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
HARBOUR_TEST_DOCKER=1 pnpm --filter @harbour/selfhosted-sandbox test
```

They run the sandbox conformance suite (with project access) over `createTieredSandboxes` with this backend and the
in-process isolate, plus focused cases: both directions of visibility, the executable bit, cwd/env/stdin, timeouts,
truncation, read-only `/project`, removal on `ended`, `reapExpired`, `git --version` and `uname -a` (gVisor reports
its own kernel), no import of the working copy's Python modules, head files owned by user 1000 with their modes,
unreadable paths skipped, and background jobs killed before the final snapshot. Optional: `HARBOUR_TEST_SANDBOX_IMAGE` (default `harbour-sandbox:dev`), `HARBOUR_TEST_SANDBOX_RUNTIME`
(default `runsc-kvm`) and `HARBOUR_TEST_DOCKER_SOCKET`. Every case labels what it creates with its own
`harbour-test-<random>` prefix and removes it afterwards.

## Known gaps

- Every scan hashes every file; a size and mtime cache (as the spike's agent keeps) is the next step for large trees.
- Background jobs are not paused during the scans and re-bases of ordinary commands, so a job writing at that moment
  can race them (the spike stops their process groups first); the race stays within what user 1000 can do. Only the
  final `pending` kills them.
- With `network`, sandboxes share the given network rather than getting one each, and requests carry no per-sandbox
  proxy token.
- A lease's `expires-at` label is its expiry when the container was created; renewals do not update it. The janitor
  never reaps a lease the running backend serves or is creating a container for, so this matters only after a restart.
