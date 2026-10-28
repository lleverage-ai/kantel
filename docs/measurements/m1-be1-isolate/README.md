# Isolate readiness on the self-hosted isolate host (M1-BE1), 27 October 2026

Issue #9 asks for an isolate session ready (workspace listed) in 100 ms p50 and 300 ms p95 on both targets.
M0 measured 137 / 164 ms self-hosted ([m0-sh1-selfhosted](../m0-sh1-selfhosted/README.md)) and 1,208 / 2,055 ms
on Cloudflare ([m0-cf1](../m0-cf1/README.md)). These runs model the alternatives on a local workerd, with the
same workspace and method as M0. The design that follows from them is in
[docs/design/isolate-readiness.md](../../design/isolate-readiness.md).

## Results (50 runs per batch, client wall clock)

Every run is a new session ID. Load is `/proc/loadavg` on a 48-thread host (nproc 48), before and after the
batch, with the highest of the samples taken every 10 runs.

| Variant | What a new session does | Batch | p50 / p95 | min–max | load1 before → after (max) |
|---|---|---|---|---|---|
| a | today: loads a new Dynamic Worker, lists | round 1 | **136.9 / 162.2 ms** | 122.8–171.3 | 25.5 → 24.1 (25.5) |
| | | round 2 | **140.0 / 151.9 ms** | 122.5–152.2 | 26.3 → 24.2 (26.3) |
| | | re-run | **130.5 / 140.1 ms** | 116.3–146.5 | 22.5 → 22.9 (22.9) |
| b | one isolate per workspace, already loaded | round 1 | **4.3 / 6.5 ms** | 3.5–9.5 | 24.1 → 24.1 (24.1) |
| | | round 2 | **4.5 / 6.6 ms** | 3.5–8.5 | 24.2 → 24.2 (24.2) |
| c | pre-loaded pool, scope per call (50 of 50 pool hits) | round 1 | **7.1 / 9.3 ms** | 5.6–11.0 | 24.1 → 22.3 (24.1) |
| | | round 2 | **7.2 / 11.0 ms** | 6.0–12.3 | 24.2 → 23.4 (24.2) |
| d | as a, timed in phases | round 1 | 130.6 / 150.9 ms | 119.8–169.3 | 22.3 → 21.9 (22.3) |
| | | round 2 (out of line, re-run) | 151.0 / 207.6 ms | 134.4–239.7 | 23.4 → 26.5 (26.9) |
| | | re-run | 130.1 / 151.3 ms | 115.4–160.8 | 22.9 → 22.2 (22.9) |
| e | a new Dynamic Worker with a 135-byte bundle | round 1 | 8.8 / 10.6 ms | 7.8–11.7 | 21.9 → 21.9 (21.9) |
| | | round 2 | 9.9 / 13.4 ms | 8.8–14.8 | 26.5 → 26.5 (26.5) |
| f | as a, with just-bash imported on the first exec | round 1 (out of line, re-run) | 90.6 / 115.3 ms | 62.9–122.5 | 21.9 → 25.2 (25.2) |
| | | round 2 | 70.8 / 107.4 ms | 62.0–119.7 | 26.5 → 25.9 (26.5) |
| | | re-run | 67.7 / 75.8 ms | 59.4–77.5 | 22.2 → 20.6 (22.2) |
| g | as c, but the refill starts before the response | round 1 | 143.6 / 176.4 ms | 123.6–206.2 | 25.2 → 26.3 (26.3) |
| | | round 2 | 135.1 / 162.2 ms | 123.6–192.1 | 25.9 → 24.7 (25.9) |

Phase p50s from the host's own clock:

| Variant | Manifest read from MinIO | Loading the Dynamic Worker | Listing in the loaded isolate | Host total |
|---|---|---|---|---|
| a | 3 ms | (in the total) | (in the total) | 130–138 ms |
| b | 2 ms | none | 1–2 ms | 3–4 ms |
| c | 3 ms | none | 3 ms (with the per-call scope) | 6 ms |
| d | 3 ms | **123–124 ms** (round 2: 144) | 2–3 ms | 129 ms |
| e | none | 8–9 ms | none | 8–9 ms |
| g | 3 ms | none | 3 ms | 6–7 ms (the client waits about 130 ms more) |

The session's first command (`ls -R | wc -l`, no file bodies read) after readiness, timed apart from it:

| Variant | First command p50 / p95 |
|---|---|
| a | 79.4 / 103.5, 79.9 / 98.2, re-run 73.8 / 92.1 ms |
| f | 123.4 / 191.7, 109.8 / 161.5, re-run 97.5 / 111.0 ms |

## What the numbers say

- **Variant a reproduces M0.** 131–140 ms p50 on a bare workerd against M0's 137 ms on runc in compose, so
  these runs and M0's are comparable.
- **(d) Loading is the time, not the listing.** Of a's 130 ms, 123 ms is loading the Dynamic Worker, 3 ms is the
  manifest read and 2–3 ms is the listing itself. A new isolate with a trivial bundle (e) costs 9 ms, so about
  115 ms of the load is compiling and running the 1.28 MB just-bash bundle.
- **Lazy import only halves it.** With just-bash present but imported on the first exec (f), a new isolate is ready
  in 68–71 ms: about 60 ms is having the 1.28 MB module in the isolate at all. The first command then takes
  about 25 ms longer than in a.
- **An isolate that is already loaded is ready in 4–7 ms** whether it is the workspace's (b) or one from the pool
  (c). Passing the workspace scope with the call costs about 3 ms.
- **A load blocks the host.** When the pool's refill starts before the response is written (g), the session waits
  for that whole load (135–144 ms p50). The refill has to start after the response, as in c, and any load
  (today's too) holds up the other sessions on the same workerd process for about 125 ms.

## Re-runs

The skew rule in `harness/run.ts` (load1 above 0.75 per thread at any sample, or a change of more than 0.25
per thread across the batch) flagged nothing: load1 stayed between 20.6 and 26.9 on 48 threads, against 8–17
in M0. Two batches were out of line with their pairs anyway: round 2 of d (151 / 208 ms against 131 / 151 in
round 1, while load1 rose from 23.4 to 26.9) and round 1 of f (91 / 115 ms against 71 / 107, load1 21.9 to
25.2). a, d and f were re-run together (`--variants a,d,f --rounds 1`, file `21-09-39`): d came back at
130 / 151 ms and f at 68 / 76 ms, so both outliers came from the shared host, not the variant. Both stay in
the raw file and in the table, marked.

## Method

- `harness/run.ts`, run by hand with Bun: `bun docs/measurements/m1-be1-isolate/harness/run.ts` (defaults:
  `--runs 50 --rounds 2 --variants a,b,c,d,e,f,g --pool-size 4`). Not part of `pnpm check` or CI, and not a
  workspace package.
- It builds `images/isolate-host/src/sandbox.ts` and `loader.ts` unchanged, with `harness/bench-host.ts`,
  `pooled-sandbox.ts`, `lazy-sandbox.ts` and `trivial-sandbox.ts`, into `harness/dist/` (git-ignored), and serves
  them with the image's own workerd binary (`workerd 2026-10-27`, from `images/isolate-host`) and
  `harness/config.capnp`, which has the image's bindings and compatibility date.
- Variant a is `POST /list` through `loader.ts`'s own handler. The others are `/bench/*` routes on the same
  host; each reads the manifest from MinIO as `loader.ts` does.
- Workspace: as `apps/selfhosted/src/measure.ts` seeds it, 300 files of 4 KB in 81 directories (381 entries),
  written to the compose stack's MinIO (127.0.0.1:59100, bucket `harbour`) under the key prefix
  `m1-be1-isolate/`. Every object was deleted afterwards (301 per run; the prefix is empty). Since these runs
  the harness deletes only its own run's workspace (`m1-be1-isolate/workspaces/bench-<uuid>-ws/`), also on
  SIGINT or SIGTERM, and refuses to start when `CI` is set.
- Each batch gets a fresh workerd, one warm-up not recorded (for b, it loads the workspace's isolate; for c and
  g, the pool is filled first), then 50 runs. For c and g the next session arrives once the pool is full again,
  which is the case for any arrival rate below the refill rate.
- Host: AMD EPYC 7401P, 48 threads, shared with other lanes. workerd ran on the host itself, not in a container:
  neither runc nor gVisor is in these numbers.
- Raw: `raw/isolate-ready-2026-10-27T21-07-50.json` (two rounds of a–g) and
  `raw/isolate-ready-2026-10-27T21-09-39.json` (the re-run of a, d and f). Every run, with its server phases,
  the load samples and the bundle sizes.

## The pool as built (`harness/pool.ts`), 27 October 2026

The pre-loaded pool is now in `images/isolate-host` (on unless `ISOLATE_POOL_SIZE=0`). `harness/pool.ts` builds
the image's own `src/` and `config.capnp` unchanged, runs them on the image's workerd with a fake vault proxy, and
measures as M0's `apps/selfhosted/src/measure.ts` does. Each run is: a new session's `/list` (isolate.ready),
another new session's first `ls -R | wc -l` (isolate.first), then that session's second (isolate.warm). As in
M0 and `IsolateRunner`, `/list` fetches the manifest and `/exec` is sent it. There is one warm-up, not recorded,
then 50 runs. Load1 is read before every run, and the batch's minimum and maximum are
below.

It measures two cadences:

- **Paced:** each new session arrives once the pool is full again. The pool refills only in quiet spells: 25 ms
  with no `/list` or `/exec` in flight from any session. Pi's sessions leave such gaps, because a model call sits
  between commands, but this batch doesn't test how often they come with many sessions running.
- **Back-to-back:** every request follows the last at once, a burst with no quiet time, so the pool empties after
  its four isolates.

| Mode | Cadence | Round | ready p50 / p95 (min–max) | first p50 / p95 | warm p50 / p95 | pool hits | load1 (min–max) |
|---|---|---|---|---|---|---|---|
| off (`0`) | back-to-back | 1 | 118.4 / 129.8 ms (109.5–135.9) | 184.2 / 207.4 | 37.0 / 42.4 | | 8.07–9.24 |
| | | 2 | 120.9 / 137.4 ms (112.0–150.0) | 181.7 / 203.0 | 36.6 / 49.6 | | 7.46–8.08 |
| pool (4) | paced | 1 | **6.2 / 7.4 ms** (5.2–9.2) | 69.7 / 80.2 | 36.8 / 40.6 | 50 of 50 | 7.65–8.56 |
| | | 2 | **6.4 / 7.4 ms** (5.1–9.1) | 71.0 / 79.1 | 37.3 / 48.9 | 50 of 50 | 7.50–8.14 |
| pool (4) | back-to-back | 1 | 118.2 / 134.5 ms (6.1–143.5) | 183.1 / 198.5 | 36.5 / 39.5 | 2 of 50 | 8.07–8.78 |
| | | 2 | 121.4 / 137.9 ms (6.6–154.5) | 184.6 / 199.4 | 37.0 / 46.9 | 2 of 50 | 7.45–8.25 |

All times are in ms. None of the batches was flagged as skewed: load1 stayed below 36 (three quarters of the 48
threads) and moved by less than 6 within each batch. The two rounds agree, so nothing was re-run. An earlier run
of the same build, without the manifest on `/exec` and at load1 10–19, gave paced 6.4–6.5 / 7.9–10.0 ms. It was
not kept.

What the numbers show:

- **Paced, the target is met with room to spare:** 6.2–6.4 ms p50 and 7.4 ms p95, against 100 / 300 ms.
  A new session's first command also gets faster, 70–71 ms against about 183 ms, because its isolate is
  already loaded. Commands in a session that already has its isolate cost the same in both modes.
- **Back-to-back, the pool is no worse than off.** The pool's first hand-outs hit, then it is empty and each
  session loads its own isolate, as today. Every load still holds workerd's one thread for about 125 ms, so one
  process sustains about eight new sessions a second, with or without a pool. A larger `ISOLATE_POOL_SIZE`
  absorbs a bigger burst.
- **Refilling in quiet spells was chosen after measuring.** An earlier build refilled 20 ms after each hand-out.
  Back-to-back, it kept ready at 6 ms, but every command arriving during a refill load waited for it: warm rose
  from 40 to 293 ms p50. That build wasn't committed, and its raw data wasn't kept.

The behaviour checks run with `--check`, 22 of them, all passing in both modes:

- listing;
- lazy reads, and writes into the session's own workspace;
- each session's own ID on egress to the vault;
- a blob name that isn't a SHA-256 digest is refused;
- the pool refills after a hand-out;
- every value of the switch.

Raw: `raw/pool-2026-10-27T22-21-38.json`. Unit tests for the pool's bookkeeping (hand-out, idle expiry with no
other call, the quiet spell, single-flight refill) are in `images/isolate-host/test/pool.test.ts` and run with
`pnpm test`.

## What can't be measured here

- **Cloudflare.** Every Cloudflare number in the design doc comes from M0-CF1. SessionDO creation, R2 round
  trips, a pool of pre-created SessionDOs and whether Worker Loader keeps an isolate warm need a deployed
  Worker, which this lane may not create. A local `wrangler dev` runs the same workerd as these runs, so it would
  add nothing.
- **gVisor.** No Docker of our own, so no runsc or runsc-kvm. M0 found a new isolate costs about 30 ms more on
  runsc-kvm and 80 ms more on systrap, and a call into a loaded isolate about twice as long. For b and c the load
  is off the critical path; their 4–7 ms would roughly double.
- **Concurrent sessions.** Every run here is one session at a time. How a pool drains under a burst larger than
  the pool, and how much a load stalls other sessions' commands, are inferred from g rather than measured.
- **Memory** held by idle pooled isolates was not measured.
