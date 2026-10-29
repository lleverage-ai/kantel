# Isolate readiness on runsc-kvm with the pre-loaded pool (M1-SH1), 29 October 2026

Issue #9's target is an isolate session ready (workspace listed) in 100 ms p50 and 300 ms p95. M0 measured
169–174 / 197–219 ms on gVisor's KVM platform ([m0-sh1-selfhosted](../m0-sh1-selfhosted/README.md#gvisor-kvm-platform-runsc-kvm-rows-27-october-2026)),
the recommended self-hosted runtime, with one Dynamic Worker loaded per session. Since then the isolate host has
gained a pool of isolates loaded ahead of time (#112, `ISOLATE_POOL_SIZE`, default 4;
[design](../../design/isolate-readiness.md)). These runs measure that pool on runsc-kvm.

**Result: with the pool, a new session is ready in 11.7 / 19.4 ms and 12.4 / 16.5 ms (p50 / p95, two rounds of
50), so the target holds on runsc-kvm with a wide margin**, as long as the pool has a moment to refill between new
sessions. Sessions started back to back with no pause empty the pool after four, and the rest load their own
isolate (187 / 226 ms).

## Results (50 runs per batch, session host's wall clock)

| Batch | Isolate host | Between runs | Ready p50 / p95 | Ready min–max | Pool hits | load1 before → after (range) |
|---|---|---|---|---|---|---|
| Pool, round 1 | runsc-kvm, pool of 4 | 1 s pause | **11.7 / 19.4 ms** | 8.5–20.5 | 50 of 50 | 26.8 → 17.9 (18.0–26.8) |
| Pool, round 2 | runsc-kvm, pool of 4 | 1 s pause | **12.4 / 16.5 ms** | 8.6–18.3 | 50 of 50 | 13.9 → 15.8 (13.9–16.7) |
| Pool off | runsc-kvm, `ISOLATE_POOL_SIZE=0` | 1 s pause | 181.5 / 214.2 ms | 143.7–227.0 | none | 15.9 → 15.0 (13.6–15.9) |
| Pool, back to back | runsc-kvm, pool of 4 | none | 186.6 / 226.0 ms | 16.4–250.3 | the first 2 of 50 | 40.2 → 34.0 (32.6–40.2) |

The other rows from the same batches:

| Batch | First command on a new session (`ls -R \| wc -l`) | A further command, same isolate | Session open (host side) |
|---|---|---|---|
| Pool, round 1 | 116.0 / 149.8 ms | 56.6 / 87.5 ms | 148.2 / 174.7 ms |
| Pool, round 2 | 115.6 / 153.3 ms | 58.0 / 80.2 ms | 169.8 / 287.9 ms |
| Pool off | 274.3 / 325.0 ms | 59.5 / 90.6 ms | 157.7 / 204.3 ms |
| Pool, back to back | 292.9 / 344.7 ms | 63.1 / 86.6 ms | 155.8 / 426.8 ms |

Pool hits are counted from the ready times: a hit is under 25 ms and a load over 140 ms, and no run fell between.

## What the numbers say

- **The pool closes the p50 gap on runsc-kvm.** A pooled session is ready in about 12 ms, against 182 ms when it
  loads its own isolate: the load, not the listing, was the time, as M1-BE1 found on a bare workerd
  ([m1-be1-isolate](../m1-be1-isolate/README.md)), and gVisor makes the load longer (182 ms here against 131–140 ms
  there) but leaves a pooled hand-out about as cheap (12 against 7 ms).
- **Pool off reproduces M0.** 182 / 214 ms against M0's 169–174 / 197–219 ms on the same runtime, so these runs are
  comparable with M0's, with load1 at 14–16 here against 5–10 then.
- **The pool needs quiet to refill.** It loads a new isolate only after no call has been in flight for 25 ms
  (`images/isolate-host/src/pool.ts`), because a load holds workerd's one thread. With a 1 s pause after each run
  (standing in for a model call, or M0's container start between runs) it refilled every time. With no pause at
  all it emptied after four new sessions (the warm-up and the first run and a half) and every later session
  loaded its own. Real sessions start far less often than once every 300 ms on one host, but a burst of new
  sessions larger than the pool will see the unpooled time, which still meets the p95 target.
- **The first command is faster with the pool** (116 against 274 ms), because the session's first `exec` also
  finds its isolate already loaded. A further command in a loaded isolate is the same either way (57–60 ms;
  M0: 69–71 ms).

## Method

- Host: bare metal, 48 threads, `/dev/kvm` present, kernel 7.2.7, Docker 29.8.1, **runsc release-20261019.0**
  registered as `runsc-kvm` with `runtimeArgs: ["--platform=kvm"]` (the same runtime as M0's rows).
- Stack: the compose stack (`deploy/compose/compose.yaml`) under its own project name beside the M0 stack, with
  `HARBOUR_ISOLATE_RUNTIME=runsc-kvm`. Before each batch `docker inspect` showed the isolate host on `runsc-kvm`
  and `ISOLATE_POOL_SIZE` as stated. Pool off used a local compose override setting `ISOLATE_POOL_SIZE: "0"` on
  the isolate host, since compose doesn't pass it through.
- Command, in the session host:
  `docker compose -f deploy/compose/compose.yaml exec -T host-a bun src/measure.ts --runs 50 --no-container --gap-ms 1000`
  (back to back: no `--gap-ms`). The workspace is M0's: 300 files of 4 KiB in nested directories, 381 entries.
  Each run is a new session for the ready row and another for the first command; one warm-up session first.
- `--no-container` leaves out M0's container row. On this host the M0 stack's sandbox janitor shares the Docker
  daemon and removed the measured containers mid-run (`409 can not get logs from container which is dead or
  marked for removal`), and the container row isn't what this measures. `--gap-ms` puts back a pause in its
  place: in M0's script the container start (about 1 s) sat between runs, which is when the pool refilled.
- Load: `/proc/loadavg` before, every 5 s during, and after each batch, in `raw/*.load.txt`. The host was shared
  with CI and other stacks; load1 was 13.6–40.2 on 48 threads, highest in the back-to-back batch.
- Raw results: `raw/pool-gap1s-round1.json`, `raw/pool-gap1s-round2.json`, `raw/pool-off-gap1s.json` and
  `raw/pool-back-to-back.json`, each with every run's times in `raw`.
