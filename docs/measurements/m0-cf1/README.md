# M0-CF1 cold-start measurements (Cloudflare)

Three runs, 50 per row, recorded 27 Oct 2026 against the deployed `harbour-m0-cf1` Worker with [`spikes/cloudflare/scripts/bench.ts`](../../../spikes/cloudflare/scripts/bench.ts):

- [`cold-start-2026-10-27T13-27-45-912Z.json`](cold-start-2026-10-27T13-27-45-912Z.json): **current**, on the PR's final code (Worker version `0dc880a5`), after the review fixes: the container agent scans before every sync with background jobs paused, and the lease bookkeeping is stricter.
- [`cold-start-2026-10-27T12-00-58-435Z.json`](cold-start-2026-10-27T12-00-58-435Z.json): "contracts", after the spike was moved onto M0-BE1's contracts (`ObjectStoreWorkspaces`, `CloudflareSandboxes`), before the review fixes.
- [`cold-start-2026-10-27T09-42-17-084Z.json`](cold-start-2026-10-27T09-42-17-084Z.json): the first run, on the spike's draft contracts.

## Results against the plan's targets (table 6)

| Row | Target p50 / p95 | Current p50 / p95 (min–max) | Contracts run p50 / p95 | First run p50 / p95 | Verdict |
| --- | --- | --- | --- | --- | --- |
| Isolate session ready, workspace listed | 100 ms / 300 ms | **1,208 ms / 2,055 ms** (810–2,329) | 1,246 ms / 2,969 ms, 49 of 50 runs | 1,011 ms / 2,025 ms | Misses by about 10× |
| Container on the same workspace version, warm image | 3 s / 8 s | **2,983 ms / 3,601 ms** (2,434–13,996), 49 of 50 runs | 2,694 ms / 3,619 ms | 2,384 ms / 3,169 ms | Meets at p50 (narrowly) and p95; one run took 14 s |
| Small repo worktree, large monorepo, dependencies | — | Not measured here: M0-BE2 (#5) owns these rows | — | — |

Warm references (not plan rows):

| Row | Current p50 / p95 | Contracts run | First run |
| --- | --- | --- | --- |
| Next command in an already-loaded isolate (client wall time, includes the round trip from Sal's host) | 125 ms / 297 ms | 110 ms / 224 ms | 56 ms / 104 ms |
| Next command in a running container, same version (server) | 33 ms / 54 ms | 43 ms / 138 ms | 41 ms / 57 ms |

In the current file, one container run failed with `Network connection lost.` between the SessionDO and the container (listed under `failures`), and one took 14.0 s, almost all of it in `ctx.container.start()` (11.1 s): a start on a host without the image, presumably. The p50 rose by about 0.3 s against the contracts run, mostly in the request (full sync and exec, now with a scan before the sync). Both stay inside the 3 s / 8 s target, but p50 is close to it. In the contracts file, one isolate run failed with a Cloudflare 1101 error page. Runs fired back to back create many new SessionDOs within a minute; twice, while benchmarking, new SessionDOs then failed on their first SQLite statement with `out of memory: SQLITE_NOMEM` until the load stopped for a few minutes. Production session creation would not look like this, but it is worth knowing before a pool of pre-created objects is tried.

## Where the time goes

**Isolate session ready.** Phases from the contracts run (p50 1,246 ms); the current run's are within 50 ms of these at p50 (first contact 455, setup 216, list 507). Timed in the routing Worker around three calls to a Durable Object that has never existed:

| Phase | p50 | p95 |
| --- | --- | --- |
| First contact with a new SessionDO (placement and creation, no storage work) | 467 | 1,773 |
| Setup: workspace lookup in R2 (113), Pi Durable `Harness.open` on empty SQLite, create conversation | 201 | 371 |
| List: load a Dynamic Worker never seen before (1.25 MiB just-bash bundle), read the head and manifest from R2 through the workspace binding (201), run `ls -1R` | 513 | 1,207 |

The contracts version reads the head and then the manifest (two R2 reads where the draft read one), which accounts for most of the difference from the first run. Pi Durable itself is cheap. The cost is a brand-new Durable Object (about a third to a half), then R2 round trips. Ways to get near the target, not tried here: pre-create session objects (a pool of named, idle SessionDOs, so a new session never pays for creation), keep the workspace head and manifest in Durable Object storage instead of R2 (read locally, passed to the isolate with the call), and leave only blobs in R2. Whether to change the target or build these is an open decision.

**Container ready (current p50 2,983 ms).** Timed in the SessionDO around the call to a container Durable Object never used before:

| Phase | Current p50 | Current p95 | Contracts run p50 / p95 |
| --- | --- | --- | --- |
| `ctx.container.start()` plus turning on egress interception | 312 | 478 | 238 / 358 |
| Agent listening on port 8080 | 393 | 582 | 311 / 563 |
| Request: scan, full sync of the 61-file workspace read from R2 and sent over the port (base64), exec of `cat marker.txt && git --version`, change scan | 1,721 | 2,033 | 1,589 / 2,318 |
| New container Durable Object, lease and RPC (the remainder) | about 560 | — | about 550 |

Every successful run saw the isolate's write from the version before (49 of 49 current, 50 of 50 contracts). After a deploy with a new image digest, the first starts take 5–12 s (image not yet on the host), so "warm image" matters: the image must be distributed before sessions need it.

## Method

- **Isolate row:** `POST /bench/isolate-ready` (spikes/cloudflare/src/index.ts). Each run uses a new session ID (new SessionDO, empty storage) and a new Worker Loader ID (an isolate never loaded before), over one shared 61-file workspace `harbour-m0-bench`.
- **Container row:** in one bench session, the isolate writes `marker.txt` (a new workspace version), then a container under a new name runs on that version, then the lease is released and the container destroyed. Instance `standard-1`, `durable_object` scheduling policy, image built from `spikes/cloudflare/container/Dockerfile` (Debian, bun, git, python3, curl, jq).
- A failed run is recorded under `failures` and left out of the percentiles; runs are not retried. (The first run's script stopped at the first error; it had none.)
- Server timings come from inside Cloudflare (Worker or Durable Object), so they leave out the round trip from where the script runs. Client wall times are in the raw files.
- **Caveat:** Workers clocks only advance on I/O, so phases that are pure CPU (just-bash running `ls`, a warm isolate call that does no I/O) read 0 ms server-side. The cold isolate row is not affected (every phase does I/O); the warm isolate row is reported from the client.
- The script ran from Sal's host against the `lleverage` workers.dev subdomain; Durable Objects were created near the receiving colo.
