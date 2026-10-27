# Self-hosted cold starts and takeover (M0-SH1), 27 October 2026

Measured on the compose stack (`deploy/compose`) on one shared machine:
AMD EPYC 7401P (48 threads), 135 GB RAM, Linux 7.2.7, Docker 29.8.1, load
average about 10–12 from other work. Cold starts were re-measured after the
review fixes (each container command now gets its own network). **The first
tables below are runc**: the host had no gVisor then, so the isolate host and
the sandbox containers ran without the hardening the plan requires. The same
rows on gVisor (runsc), measured later the same day, are in
[gVisor (runsc) rows](#gvisor-runsc-rows-27-october-2026), and on gVisor's
KVM platform in [gVisor KVM rows](#gvisor-kvm-platform-runsc-kvm-rows-27-october-2026).

**Recommended self-hosted default: `runsc-kvm` for both the isolate host and
sandbox containers** on bare metal with `/dev/kvm`, and `runsc` (systrap)
inside a VM or without `/dev/kvm`. KVM takes about 50 ms off a new isolate
against systrap (p50 170 against 220 ms; runc 140 ms), so the 100 ms isolate
p50 still does not hold, and makes real container work about 30% faster, with
container starts unchanged.

## Cold-start table, self-hosted rows (50 runs each)

| Step (plan Table 6) | Target p50 / p95 | Measured p50 / p95 | min–max |
|---|---|---|---|
| Isolate session ready, workspace listed | 100 ms / 300 ms | **137 ms / 164 ms** | 114–166 ms |
| Container on the same workspace version, warm image | 3 s / 8 s | **1.05 s / 1.24 s** | 0.95–1.55 s |
| Small repo worktree off a warm mirror | 1 s / 3 s | not measured here: M0-BE2 (#5) | |
| Large monorepo checkout ready | 10 s / 25 s | not measured here: M0-BE2 (#5) | |
| Dependencies ready from a cached layer | 15 s / 40 s | not measured here: M0-BE2 (#5) | |

Reference rows (same runs):

| Step | p50 / p95 |
|---|---|
| New session's first command (`ls -R \| wc -l`, 381 entries) | 189 ms / 209 ms |
| A further command in the same, loaded isolate | 39 ms / 43 ms |
| Session open: lease, Pi schema and migrations, Harness open | 138 ms / 162 ms |

The isolate-ready p50 misses the 100 ms target by about a third. Most of it
is loading a new Dynamic Worker for a session that has never run (the
workerLoader compiles the just-bash bundle); a pool of pre-loaded isolates,
or one isolate per workspace rather than per session, are the obvious next
steps. The first command after it reads no file bodies (lazy reads: 0).

Container phases (p50, cumulative from the start of the call): tar of the
workspace 61 ms, its own network ready 105 ms (created alongside the tar),
`create` 156 ms, copy-in 293 ms, `start` 513 ms, command finished 637 ms,
workspace read back 761 ms; removing the container and its network takes
most of the rest. The per-sandbox network costs about 0.15 s against the
earlier shared-network sample (0.90 s / 1.15 s); `start` and copy-in/copy-out
of the 1.2 MB workspace are still most of it.

Earlier 50-run samples the same day, before the review fixes: isolate ready
134/161 ms and 141/159 ms; container 0.90/1.15 s, and 1.57/2.75 s under
heavier load. The container row is sensitive to host load; the isolate row
is not.

## Takeover after the owner dies mid tool call

Lease TTL 10 s, renewed every 2.5 s, takeover poll 500 ms. Every run is the
full scripted task with `--crash` and passed all of its checks.

| How the owner died | Runs | Kill to resumed on the other host, p50 / max | Of which: kill to lease acquired | lease acquired to session resumed |
|---|---|---|---|---|
| `docker kill` (process gone, Postgres connection drops) | 10 | **0.99 s / 2.53 s** | p50 0.53 s | p50 0.45 s |
| `docker pause` (process frozen, connection stays up) | 5 | **10.9 s / 12.2 s** | p50 10.1 s (the TTL) | p50 0.98 s |

"Kill" times include the `docker compose kill` command itself (p50 0.74 s).
After a kill the lease is free as soon as Postgres drops the dead host's
advisory lock, so the TTL does not matter; after a pause only the TTL frees
it, and the new owner acquires it 8–38 ms after expiry. Opening the session
on the new owner includes removing the dead owner's still-running sandbox
container, which is most of the 0.35–2.15 s spread.

## Method

- `apps/selfhosted/src/measure.ts`, run inside `host-a` so it uses the same
  clients as the session host: a seeded workspace of 300 files of 4 KB in 81
  directories (381 entries), one warm-up of each row not recorded, then 50
  runs. Each isolate run uses a new session ID, so the workerLoader loads a
  new Dynamic Worker; each container run starts a new container. Wall clock
  from the session host.
- `deploy/compose/scripts/takeover.sh kill 10` and `pause 5`: the scripted
  task with `--crash`, timing from just before the kill command to the new
  owner's `resumedAt` (both clocks on this machine).
- Raw numbers: `raw/cold-start-2026-10-27.json`, `raw/takeover-kill-2026-10-27.jsonl`,
  `raw/takeover-pause-2026-10-27.jsonl`.
- M0-CF1's shared scenario (`spikes/scenario/run.ts`) against this stack:
  `raw/cf1-scenario-2026-10-27.json` (17/17 checks, 5.7 s) and
  `raw/cf1-scenario-kill-after-exec-2-2026-10-27.json` (20/20 checks, 5.5 s;
  `reopen` on host-b 301 ms after the `kill` event), both re-run on the
  final branch (an earlier run: 4.4 s and 4.3 s, reopen after 110 ms).
- Takeover timings were measured before the review fixes; the fixes do not
  touch the lease or takeover path, and the crash run on the final branch
  took over in 2.2 s.

## gVisor (runsc) rows, 27 October 2026

The same rows, method and run counts with both `HARBOUR_ISOLATE_RUNTIME` and
`HARBOUR_SANDBOX_RUNTIME` set to `runsc`: **runsc release-20261019.0** (spec
1.2.1), from gVisor's `gvisor.tar.zstd` release, which puts `runsc` and
`containerd-shim-runsc-v1` in `/usr/local/bin` and the sentry
(`gvisor_sentry`) and its helpers in `/usr/local/bin/gvisor-bin/`. It is
registered with Docker by `runsc install` with no extra flags, so it runs on
the defaults: platform `systrap`, `network=sandbox`, `overlay2=root:self`.
Same machine, Docker 29.8.1.

The host is shared and its load moves, so the cold starts were measured in
pairs: runsc, then runc, then runsc, then runc, 50 runs each, on the same
stack and code (this branch), load average 8–17 throughout. Every runsc run
checked that the isolate host's container and the session hosts' sandbox
setting were really `runsc` before and after.

| Step (plan Table 6) | Target p50 / p95 | runc p50 / p95 (pair 1, pair 2) | **runsc p50 / p95** (pair 1, pair 2) | runsc min–max |
|---|---|---|---|---|
| Isolate session ready, workspace listed | 100 ms / 300 ms | 141 / 168 ms, 139 / 154 ms | **220 / 249 ms, 228 / 250 ms** | 162–270 ms |
| Container on the same workspace version, warm image | 3 s / 8 s | 1.06 / 1.11 s, 1.06 / 1.23 s | **1.07 / 1.23 s, 1.06 / 1.19 s** | 0.98–1.31 s |
| New session's first command (`ls -R \| wc -l`) | | 181 / 203 ms, 184 / 199 ms | 377 / 408 ms, 374 / 426 ms | 288–432 ms |
| A further command in the same, loaded isolate | | 38 / 42 ms, 38 / 44 ms | 84 / 116 ms, 82 / 102 ms | 48–138 ms |
| Session open (host side, not sandboxed) | | 137 / 154 ms, 143 / 171 ms | 138 / 159 ms, 137 / 154 ms | 116–246 ms |

**Overhead against runc:** about +85 ms on a new isolate (p50 220–228 against
139–141 ms) and roughly twice the time for every isolate command, but nothing
measurable on a container start (1.06 s either way; `start` itself is about
25 ms slower). The container target (3 s / 8 s) still holds with a wide margin.
The isolate p95 target (300 ms) holds, with about 50 ms to spare; the p50
target (100 ms) was already missed on runc and is now missed by more than
twice.

Where the isolate time goes (phase p50s of the first command, runsc against
runc): file system 30 against 11 ms, exec 121 against 50 ms. That is workerd
itself paying gVisor's system-call cost (systrap) while it loads and runs a
new Dynamic Worker, not the workspace or the network. Container phases are
within 25 ms of runc at every step (tar 74, network 119, create 177,
copy-in 286, start 534, run 657, copy-out 764 ms).

An earlier runsc run under much heavier load (load average rose from 14 to 42
while other jobs ran) gave isolate ready 258 / 304 ms and container
1.52 / 1.77 s: the isolate p95 target is only just met, and under load it is
not. It is kept as `raw/cold-start-runsc-loaded-2026-10-27.json` but left out
of the table.

Takeover, scenario and suites on runsc:

| Check | runsc result | runc (above) |
|---|---|---|
| `docker kill` takeover, 10 runs | **0.95 s p50 / 1.24 s max**; kill to lease acquired p50 0.43 s, lease to resumed p50 0.48 s; 10/10 passed | 0.99 / 2.53 s |
| `docker pause` takeover, 5 runs | **10.6 s p50 / 11.9 s max**; lease acquired 19–75 ms after expiry; 5/5 passed | 10.9 / 12.2 s |
| Conformance, `--target=selfhosted` | spike suite 11/11, Pi storage, lease and workspace tests 45/45 | same |
| Scripted task, and its `--crash` run | 9/9 (2.8 s); 12/12, taken over in 0.91 s | same |
| M0-CF1's shared scenario | 17/17 (5.5 s); `--kill-after-exec 2` 20/20 (5.4 s), reopen on host-b 161 ms after the kill | 17/17, 20/20 |
| Canary check | absent from service logs, Postgres and MinIO | same |

Takeover does not change: the session hosts are not sandboxed, and the lease
path does not touch the isolate or a container.

### What broke on gVisor, and the fixes on this branch

- **Docker's embedded DNS.** On a user-defined network a container resolves
  names through 127.0.0.11, which runsc's own network stack cannot reach
  (gVisor FAQ, "DNS doesn't work on a Docker user defined bridge network").
  The isolate host failed every vault and MinIO request (`DNS lookup failed.
  host = vault-proxy`), and sandboxes could not resolve `vault-proxy`. Now
  `minio` and `vault-proxy` have fixed addresses on `control`
  (`HARBOUR_CONTROL_PREFIX`, default `10.250.89`) and the isolate host gets
  them through `extra_hosts`. Each sandbox gets the vault's address on its own
  network as an `/etc/hosts` entry (`ExtraHosts`), read back from the network
  after the vault is connected. On runc both work as before.
- **Container writes lost.** gVisor keeps writes to the root filesystem inside
  the sandbox (`overlay2=root:self`), so the archive API read back the files
  as they were before the command, and the conformance suite caught
  `echo two >> d/f.txt` coming back unchanged. `/workspace` is now an anonymous
  volume per container, removed with it (`DELETE ...?force=1&v=1`); gVisor
  writes volumes through to the host, where the archive API reads them. No
  host path is shared with the sandbox. On runc the container row is the
  same as before (1.06 s p50).

Not tried, because each needs a change to Docker's daemon config:

- **The KVM platform** (`runtimeArgs: ["--platform=kvm"]`). The host has
  `/dev/kvm`, and the isolate overhead is system-call cost, which is what KVM
  is for. Measured later the same day: see the next section.
- **`--overlay2=none`**, which would make root filesystem writes visible to
  the host without the volume. The volume works on the defaults, so it isn't
  needed.

Raw numbers: `raw/cold-start-runsc-pair1-2026-10-27.json`,
`raw/cold-start-runc-pair1-2026-10-27.json`,
`raw/cold-start-runsc-pair2-2026-10-27.json`,
`raw/cold-start-runc-pair2-2026-10-27.json`,
`raw/cold-start-runsc-loaded-2026-10-27.json`,
`raw/takeover-kill-runsc-2026-10-27.jsonl`,
`raw/takeover-pause-runsc-2026-10-27.jsonl`,
`raw/cf1-scenario-runsc-2026-10-27.json` and
`raw/cf1-scenario-kill-after-exec-2-runsc-2026-10-27.json`.

## gVisor KVM platform (runsc-kvm) rows, 27 October 2026

The same rows, method and run counts on gVisor's KVM platform: **runsc
release-20261019.0** (the same binary as the runsc rows), registered with
Docker as a second runtime, `runsc-kvm`, with `runtimeArgs:
["--platform=kvm"]`; `runsc` stays on systrap. Same machine (bare metal,
`/dev/kvm` present), Docker 29.8.1, load average 4.8–10.1 (mostly 6–8).

The cold starts were measured in rounds on one stack, 50 runs each, from
16:14 to 16:27 UTC: runsc-kvm, runsc, runc, then the mixed config (isolate
on runsc-kvm, containers on runsc), twice, then one more runsc-kvm run. So the
runsc and runc columns here are new runs beside the KVM ones, not the earlier
pairs. Before and after every run the script checked the isolate host's
runtime, the `--platform=kvm` flag on its `runsc-sandbox` process, and the
session host's sandbox setting.

| Step (plan Table 6) | Target p50 / p95 | runc p50 / p95 (round 1, 2) | runsc systrap (round 1, 2) | **runsc-kvm** (round 1, 2, 3) | runsc-kvm min–max |
|---|---|---|---|---|---|
| Isolate session ready, workspace listed | 100 ms / 300 ms | 139 / 157, 141 / 161 ms | 216 / 248, 224 / 247 ms | **174 / 205, 170 / 197, 169 / 219 ms** | 138–238 ms |
| Container on the same workspace version, warm image | 3 s / 8 s | 1.04 / 1.12, 1.06 / 1.13 s | 1.12 / 1.31, 1.10 / 1.19 s | **1.23 / 1.70, 1.09 / 1.17, 1.08 / 1.21 s** | 0.99–2.24 s |
| New session's first command (`ls -R \| wc -l`) | | 178 / 193, 178 / 189 ms | 366 / 415, 370 / 409 ms | 290 / 346, 279 / 342, 278 / 334 ms | 208–385 ms |
| A further command in the same, loaded isolate | | 37 / 41, 37 / 43 ms | 77 / 95, 88 / 110 ms | 71 / 89, 71 / 94, 69 / 95 ms | 41–125 ms |
| Session open (host side, not sandboxed) | | 137 / 161, 133 / 153 ms | 138 / 153, 137 / 151 ms | 140 / 152, 150 / 194, 139 / 156 ms | 116–246 ms |

The mixed config (isolate on runsc-kvm, containers on runsc) gave the same
isolate rows as runsc-kvm (ready 171 / 210 and 170 / 194 ms, warm command
69 / 103 and 67 / 91 ms) and the same container row as runsc (1.07 / 1.39
and 1.06 / 1.13 s), as it should: each row depends on one runtime only.

**Overhead against runc, KVM against systrap:** a new isolate costs about
+30 ms on KVM against +80 ms on systrap (p50 170 against 220 against
140 ms), and an isolate command still takes about twice as long as on runc
(warm 70 ms against 77–88 on systrap and 37 on runc). The first command's
phases show where KVM helps: file system 17–23 ms (systrap 30, runc 11),
exec 89–97 ms (systrap 121, runc 49). The isolate p95 target (300 ms) now
holds with about 80–100 ms to spare; **the p50 target (100 ms) still does
not hold** on any runtime, and needs the pre-loaded isolate pool or one
isolate per workspace, not a faster platform. Container starts are the same
on every runtime (1.04–1.12 s p50; rounds 2 and 3 on KVM 1.08–1.09 s). KVM's
round 1, the first run after the stack came up, was slower (1.23 / 1.70 s,
`create` and `start` about 70 and 85 ms slower) while the load average rose
from 4.8 to 7.9; it is kept in the table and the raw file.

A container that does real work is where KVM pays off. One `docker run` of
`harbour-sandbox:dev` with no network, five runs per runtime interleaved:
`git init`, write 1,000 files in 20 directories, `git add -A` and commit,
200 `fork`/`exec`s of `/bin/true`, and `find / -xdev -type f`, timed inside
the container from `/proc/uptime`:

| Runtime | Work, median (min–max) | Whole `docker run`, median |
|---|---|---|
| runc | 1.23 s (1.19–1.29) | 1.80 s |
| runsc (systrap) | 6.24 s (5.98–6.30) | 6.75 s |
| runsc-kvm | **4.32 s** (4.20–4.52) | 4.85 s |

KVM is about 30% faster than systrap on it, though still about 3.5 times
runc. The shared scenario shows the same: its two container commands (git and
curl) took 1.00–1.18 s on runsc-kvm against 1.12–1.38 s with containers on
runsc, and the whole scenario 4.4 s against 5.4–5.5 s.

Takeover, scenario and suites on runsc-kvm. The cold starts and takeover ran
on main at 5a1f5ac; the suites and scenarios were re-run after
rebasing onto #51 (fixed isolate host address), on both runsc-kvm and the
mixed config. A process watcher saw every `runsc-sandbox` during the suite
run with `--platform=kvm` (15 sandboxes), and in the mixed run one KVM
sandbox (the isolate host) and 17 systrap ones.

| Check | runsc-kvm result | Mixed (isolate runsc-kvm, containers runsc) | runsc systrap (above) |
|---|---|---|---|
| `docker kill` takeover, 10 runs | **0.99 s p50 / 1.27 s max**; kill to lease acquired p50 0.47 s, lease to resumed p50 0.53 s; 10/10 passed | not run | 0.95 / 1.24 s |
| `docker pause` takeover, 5 runs | **10.6 s p50 / 10.7 s max**; lease acquired 30–36 ms after expiry; 5/5 passed | not run | 10.6 / 11.9 s |
| Conformance, `--target=selfhosted` | spike suite 11/11, Pi storage, lease and workspace tests 45/45 | same | same |
| Scripted task, and its `--crash` run | 9/9 (2.8 s); 12/12, taken over in 1.0 s | 9/9; 12/12, taken over in 1.3 s | same |
| M0-CF1's shared scenario | 17/17 (4.4 s); `--kill-after-exec 2` 20/20 (4.4 s), reopen on host-b 237 ms after the kill | 17/17 (5.5 s); 20/20 (5.4 s), reopen after 444 ms | 17/17, 20/20 |
| Canary check | absent from service logs, Postgres and MinIO | same | same |

Nothing broke on KVM that had not already broken on systrap: the fixed
addresses and the `/workspace` volume work unchanged, and no other change was
needed. KVM needs `/dev/kvm`, and gVisor recommends it for bare metal and
systrap inside a VM, where nested virtualisation often makes KVM slower
(https://gvisor.dev/docs/architecture_guide/platforms/). So keep `runsc` as
the fallback, and measure before choosing KVM on a cloud VM. CI stays on
runc.

**Recommendation:** run both the isolate host and sandbox containers on
`runsc-kvm` on a bare-metal host with `/dev/kvm`. It is the fastest gVisor config
on every row, and one runtime is simpler than two. A mixed config gains
nothing: containers start no slower on KVM and do real work faster.

Raw numbers: `raw/cold-start-runsc-kvm-round1-2026-10-27.json`,
`raw/cold-start-runsc-kvm-round2-2026-10-27.json`,
`raw/cold-start-runsc-kvm-round3-2026-10-27.json`,
`raw/cold-start-runsc-round1-2026-10-27.json`,
`raw/cold-start-runsc-round2-2026-10-27.json`,
`raw/cold-start-runc-round1-2026-10-27.json`,
`raw/cold-start-runc-round2-2026-10-27.json`,
`raw/cold-start-mixed-round1-2026-10-27.json`,
`raw/cold-start-mixed-round2-2026-10-27.json`,
`raw/container-work-2026-10-27.jsonl`,
`raw/takeover-kill-runsc-kvm-2026-10-27.jsonl`,
`raw/takeover-pause-runsc-kvm-2026-10-27.jsonl`,
`raw/cf1-scenario-runsc-kvm-2026-10-27.json`,
`raw/cf1-scenario-kill-after-exec-2-runsc-kvm-2026-10-27.json`,
`raw/cf1-scenario-mixed-2026-10-27.json` and
`raw/cf1-scenario-kill-after-exec-2-mixed-2026-10-27.json`.
