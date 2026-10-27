# M0-CF1 cold-start measurements (Cloudflare)

Raw numbers: [`cold-start-2026-10-27T09-42-17-084Z.json`](cold-start-2026-10-27T09-42-17-084Z.json), 50 runs per row, recorded 27 Oct 2026 against the deployed `harbour-m0-cf1` Worker. Script: [`spikes/cloudflare/scripts/bench.ts`](../../../spikes/cloudflare/scripts/bench.ts).

## Results against the plan's targets (table 6)

| Row | Target p50 / p95 | Measured p50 / p95 (min–max) | Verdict |
| --- | --- | --- | --- |
| Isolate session ready, workspace listed | 100 ms / 300 ms | **1,011 ms / 2,025 ms** (718–4,007) | Misses by about 10× |
| Container on the same workspace version, warm image | 3 s / 8 s | **2,384 ms / 3,169 ms** (1,750–9,391) | Meets |
| Small repo worktree, large monorepo, dependencies | — | Not measured here: M0-BE2 (#5) owns these rows | — |

Warm references (not plan rows):

| Row | p50 / p95 |
| --- | --- |
| Next command in an already-loaded isolate (client wall time, includes the round trip from Sal's host) | 56 ms / 104 ms |
| Next command in a running container, same version (server) | 41 ms / 57 ms |

## Where the time goes

**Isolate session ready (p50 1,011 ms).** Timed in the routing Worker around three calls to a Durable Object that has never existed:

| Phase | p50 | p95 |
| --- | --- | --- |
| First contact with a new SessionDO (placement and creation, no storage work) | 470 | 1,331 |
| Setup: workspace exists check in R2 (58), Pi Durable `Harness.open` on empty SQLite (60), create conversation | 205 | 473 |
| List: load a Dynamic Worker never seen before (1.25 MiB just-bash bundle), read the manifest from R2 through the workspace binding (134), run `ls -1R` | 304 | 771 |

Pi Durable itself is cheap (60 ms to open). The cost is a brand-new Durable Object (about half), then R2 round trips. To get near the target: pre-create session objects (a pool of named, idle SessionDOs, so a new session never pays for creation), keep the workspace head and manifest in Durable Object storage instead of R2 (read locally, passed to the isolate with the call), and leave only blobs in R2. An estimate, not measured: 150–250 ms p50.

**Container ready (p50 2,384 ms).** Timed in the SessionDO around the call to a container Durable Object never used before:

| Phase | p50 | p95 |
| --- | --- | --- |
| `ctx.container.start()` plus turning on egress interception | 362 | 617 |
| Agent listening on port 8080 | 425 | 596 |
| Full sync of the 61-file workspace from R2 (parallel reads, base64 over the port) | 848 | 1,337 |
| Exec (`cat marker.txt && git --version`) and change scan | 127 | 209 |
| New container Durable Object and RPC (the remainder) | about 600 | — |

One run in 50 took 9.4 s: its start phase was 7.5 s. The first runs after each new image digest took 8–12 s (image not yet on the host), so "warm image" matters: the image must be distributed before sessions need it. All 50 runs saw the isolate's write from the version before.

## Method

- **Isolate row:** `POST /bench/isolate-ready` (spikes/cloudflare/src/index.ts). Each run uses a new session ID (new SessionDO, empty storage) and a new Worker Loader ID (an isolate never loaded before), over one shared 61-file workspace `harbour-m0-bench`.
- **Container row:** in one bench session, the isolate writes `marker.txt` (a new workspace version), then a container under a new name runs on that version, then the container is destroyed. Instance `standard-1`, `durable_object` scheduling policy, image built from `spikes/cloudflare/container/Dockerfile` (Debian, bun, git, python3, curl, jq).
- Server timings come from inside Cloudflare (Worker or Durable Object), so they leave out the round trip from where the script runs. Client wall times are in the raw file.
- **Caveat:** Workers clocks only advance on I/O, so phases that are pure CPU (just-bash running `ls`, a warm isolate call that does no I/O) read 0 ms server-side. The cold isolate row is not affected (every phase does I/O); the warm isolate row is reported from the client.
- The script ran from Sal's host against the `lleverage` workers.dev subdomain; Durable Objects were created near the receiving colo.
