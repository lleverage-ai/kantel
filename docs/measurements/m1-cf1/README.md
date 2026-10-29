# M1-CF1 isolate-ready on the deployed stack (Cloudflare)

Three batches of 50 runs, each after one warm-up call, recorded 28 Oct 2026 against `https://harbour.myslop.app`, the M1
stack as CI deploys it (`apps/cloudflare`, one `HarbourStack` Durable Object, D1 for identity and audit, R2 for
workspaces). The first three batches use the `in-process` isolate backend (#94's just-bash inside the object); the two
later ones compare it with `dynamic-worker` (#135) and record where the object and D1 run (below). The
measurement is `POST /v1/measurements/isolate-ready` (`apps/cloudflare/src/measure.ts`). Each run creates a new session
on the 61-file measurement workspace, runs `ls -1R` in that session's isolate (68 non-empty output lines), answers its
timings and closes the session. Server `total` runs from the session's create to the end of the command. It leaves
out sign-in, which happens before, and the close, which happens after; the client's wall time includes both. The runs came from a signed-in page (Cloudflare Access) in brwsr, Sal's
cloud browser (the round-trip probes below reached Cloudflare in LHR, AMS and CDG). Runs are sequential, and none failed (50 of 50 answered
200 with exit code 0 in every batch).

#17's target is **≤100 ms p50 and ≤300 ms p95**, for a **warm session** (Tom, 28 Oct 2026): one session, warmed up,
then 50 runs on it ([Warm session](#warm-session-28-oct-2026-2031-utc), below). The batches before that section are
**cold**: 50 runs, a new session each, as in M0.

**Latest: with the workspace head cached in the object and the audit append queued off the path, a warm run's server
time is 0 ms on both backends in all 50 runs: the Worker timers didn't advance at all. On that measure the target is
met. The client sees 104 / 142 ms p50 / p95 for the whole request, which also covers the trip from the browser, sign-in
and the session lookup** ([After the head cache and audit outbox](#after-the-head-cache-and-audit-outbox-29-oct-2026-0727-utc)).
The cold runs' timing anomaly is the Workers clock itself, not a slow step: see that section.

**Isolate on demand (#196): a session on a workspace gets file tools that work on R2 directly and lease nothing, and
`bash` leases its isolate on the first command (0 leases before it in all 50 runs). Warm, `read` takes 72 ms p50 and
`write` 899 ms (#218). Cold session create got slower, 788 to 1,715 ms p50, because it grows with every session held
(#216), not because of this change**
([Session ready, time to first token and first bash](#session-ready-time-to-first-token-and-first-bash-isolate-on-demand-196-29-oct-2026)).

Everything above
[After the move to weur](#after-the-move-to-weur-28-oct-2026-2236-utc) was measured with D1 in North America.

## Definition of done (#17)

| Item | State |
| --- | --- |
| Isolate-ready ≤100 ms p50 / ≤300 ms p95 on the deployed stack | **Met**, warm: 0 / 0 ms on the server in all 100 warm runs ([below](#after-the-head-cache-and-audit-outbox-29-oct-2026-0727-utc)). The issue's text still says "50 runs, a new session each"; Tom set the target to a warm session on 28 Oct 2026, and the issue hasn't been edited to match |
| The conformance suite passes against the deployed stack | **Met** (Tom, 29 Oct 2026; see below) |
| A real Sal research task runs end to end | Open: waits on Sal's placement reaching the deployed stack ([below](#a-real-sal-research-task)) |
| Monthly cost estimate checked against the first week's bill | Open: due around 4 Nov 2026 ([Cost estimate](#cost-estimate)) |

**Conformance.** On 29 Oct 2026 Tom decided that two things together count as "the conformance suite passes against
the deployed stack". The first is the deployed-stack check, which passed 6 of 6 against `https://harbour.myslop.app`
on `b5d74be`, a real-model session included
([Checks against the deployed stack](#checks-against-the-deployed-stack-29-oct-2026-0732-utc)). It ran from Sal's
host, not CI, because it needs a signed-in Access cookie; the test is `apps/cloudflare/test/remote/deployed.test.ts`
(https://github.com/tvdavies/harbour/pull/207). The second is the shared conformance suites from `@harbour/testing`
passing on the Cloudflare implementations in CI on the same commit: `targets/cloudflare/runtime` 34 tests,
`targets/cloudflare/vault` 68 and `targets/cloudflare/workspace` 108, in
https://github.com/tvdavies/harbour/actions/runs/40830185542. There is no HTTP adapter that runs `@harbour/testing`
against a URL, and none is planned for M1.

### A real Sal research task

Sal's placement on Harbour (#14) is in tvdavies/sal behind `experimental.harbour`, off by default, and has been
tested only against Harbour's HTTP server inside Sal's own tests. Running a Sal task on this deployment needs, outside this lane:

- **Callbacks Harbour can reach.** Sal's worker serves its host tools on `http://<callbackHost>:<ephemeral port>`.
  The gateway accepts only `https:` callback URLs, and a Worker can't reach Sal's loopback, so the worker needs a
  public HTTPS route to a fixed port (for example a hostname on the `sal-app` tunnel). That's a change in Sal and in
  the tunnel's ingress.
- **A way through Access for Sal.** Sal calls with an API key only, and Access turns away a request with no
  `CF_Authorization` cookie. #17's Sign-in section leaves a service-token policy for when #14 needs it; Sal's client
  would then send the service token's headers as well as its key.
- **Sal's configuration**: `experimental.harbour` pointing at `https://harbour.myslop.app/v1`, and a key with operator
  on the projects named after Sal's Docket workspaces (the deployed-stack check's key is operator on `Default` only).

The remaining placement gaps are tracked in #113.

## Results

| Batch | Deployed `main` | Client wall p50 / p95 (min–max), ms | Server `total` p50 / p95 | `session` p50 / p95 | `isolate` p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| [`isolate-ready-2026-10-28T15-39-39Z-console-open.json`](isolate-ready-2026-10-28T15-39-39Z-console-open.json) | `fcfd39c` | 2,987 / 3,299 (2,787–3,774) | 1,938 / 2,274 | 392 / 476 | 1,542 / 1,824 |
| [`isolate-ready-2026-10-28T16-19-49Z.json`](isolate-ready-2026-10-28T16-19-49Z.json) | `ad074d8`, then `34b072e` from 16:21:19 | 3,008 / 3,454 (2,815–9,507) | 1,950 / 2,149 | 396 / 442 | 1,543 / 1,670 |
| [`isolate-ready-2026-10-28T16-49-26Z-role-memo.json`](isolate-ready-2026-10-28T16-49-26Z-role-memo.json) | `c4b69fc` (#133) | **2,113 / 3,968** (1,704–12,566) | **1,320 / 2,821** | 435 / 1,054 | 889 / 1,729 |

**Verdict: misses the target by about 13× at p50 on the server and 21× in the client's wall time.** That is about where
M0-CF1 was (1,208 / 2,055 ms, [M0-CF1](../m0-cf1/README.md)), but for a different reason (below).

- The first batch ran from the console's home page, which polls the session list every 3 s into the same object. The
  second ran from `/healthz`, a page with no app on it, and came out the same, so the console's polling didn't
  inflate the numbers.
- The third batch is after #133 (one role lookup per request). The runs at zero-based indexes 42 to 44 took 2.8, 6.2
  and 4.3 s on the server and set its p95. The other 47 took 0.97 to 2.0 s, in two clusters around 1.0 and 1.3 s.
- The server times are Worker timers, which on Cloudflare
  ["only advance or increment after I/O occurs"](https://developers.cloudflare.com/workers/runtime-apis/performance/).
  So `total` is mostly time spent waiting on storage and other I/O. CPU-only work isn't measured: the smoke test's
  call reported `isolate.exec` and `isolate.scan` as 0 ms, which says nothing about their CPU cost.

## Dynamic Workers, and where D1 runs (28 Oct 2026, 18:21 UTC)

Two more batches of 50, one per backend, back to back from `/healthz`, after #135 deployed the `dynamic-worker`
backend. Each warm-up and a call after the 50 runs also asked for `placement` (probed after the run, so it adds nothing
to its times): the object's colo, the edge's, D1's region and colo, and five `SELECT 1` round trips from the object.

| Batch | Deployed `main` | Client wall p50 / p95 (min–max), ms | Server `total` p50 / p95 | `session` p50 / p95 | `isolate` p50 / p95 | Sign-in p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| [`…T18-21-23Z-dynamic-worker.json`](isolate-ready-2026-10-28T18-21-23Z-dynamic-worker.json) | `7f0b931` (#135) | 2,329 / 2,700 (2,138–2,980) | **1,496 / 1,910** | 426 / 501 | 1,065 / 1,405 | 363 / 427 |
| [`…T18-23-40Z-in-process-placement.json`](isolate-ready-2026-10-28T18-23-40Z-in-process-placement.json) | `367388b` (#137) | 2,442 / 2,991 (1,726–4,334) | **1,533 / 1,885** | 480 / 616 | 1,031 / 1,382 | 378 / 442 |

50 of 50 answered 200 with exit code 0 in both. The in-process batch ran on the next deploy (#137, API keys), which
changed neither backend.

**Verdict: switching backend changed nothing measurable; the remote D1 round trips are most likely the bulk of the
miss.** Neither batch measured a co-located object and D1, so what that would reach is an expectation, not a result.

- **The two backends take the same time.** Server p50 1,496 ms on Dynamic Workers against 1,533 ms in process. Each
  run is a new session, so each loads a new Dynamic Worker (`isolate.cold` was 1 in all 50), and the call into it
  (`isolate.call`: load, the RPC both ways and the command, with its manifest read over the port) took **128 / 212 ms**
  p50 / p95. That call alone is already over the 100 ms p50 target, with a cold load every time. The other ~0.9 s
  of `isolate` is the same storage round trips the in-process backend waits on.
- **D1's primary is in North America; the object is in London.** All four placement probes answered: object `LHR`, D1
  region `ENAM`, colo `ORD`, `served_by_primary` true. The edge was `LHR` or `AMS`, wherever brwsr's browser came in.
- **Each D1 query costs about 120 ms from the object, almost none of it SQL.** The 20 `SELECT 1` round trips took
  120 ms p50 (107–256 ms); D1 reported at most 0.38 ms of SQL in any of them. These probes don't separate the
  network from D1's own overhead, but the distance (London to Chicago) fits. They agree with the inference below of
  about 100 ms a query: sign-in's ~370 ms matches its three D1 queries.

With the object and D1 together (either moved), those round trips should shrink to a few milliseconds each, leaving
the Dynamic Worker call and the object's own work; that needs measuring again before it counts. The cold Dynamic
Worker load (128 ms p50) would then be the next thing in the way. Which to move is a decision for #17, not taken
here: D1's location is set when a database is created (a location hint), so moving it means a new database and
its data copied, and the object's is set on its first use, so moving it means a new object name with a location hint.

## Warm session (28 Oct 2026, 20:31 UTC)

One batch per backend on `6514df8` (#139), from `/healthz`. Each opens one session with a cold run that keeps it open
(`keep: true`, with `placement`), runs `ls -1R` 50 times on that session (`sessionId`), probes placement once more on
it, then closes it (`POST /v1/sessions/:id/close`, 204 in both). Server `total` is the run on the open session: its
lease and the backend's isolate are already there. It leaves out the measurement's own session lookup (`lookup`).

| Batch | Kind | Client wall p50 / p95 (min–max), ms | Server `total` p50 / p95 (min–max) | Target p50 / p95 |
| --- | --- | --- | --- | --- |
| [`…T18-23-40Z-in-process-placement.json`](isolate-ready-2026-10-28T18-23-40Z-in-process-placement.json) | in-process, cold | 2,442 / 2,991 | 1,533 / 1,885 | 100 / 300 |
| [`…T20-33-46Z-warm-in-process.json`](isolate-ready-2026-10-28T20-33-46Z-warm-in-process.json) | in-process, **warm** | 925 / 1,091 (859–1,203) | **285 / 405** (216–497) | 100 / 300 |
| [`…T18-21-23Z-dynamic-worker.json`](isolate-ready-2026-10-28T18-21-23Z-dynamic-worker.json) | dynamic-worker, cold | 2,329 / 2,700 | 1,496 / 1,910 | 100 / 300 |
| [`…T20-34-56Z-warm-dynamic-worker.json`](isolate-ready-2026-10-28T20-34-56Z-warm-dynamic-worker.json) | dynamic-worker, **warm** | 979 / 1,134 (846–1,152) | **288 / 470** (240–505) | 100 / 300 |

50 of 50 warm runs answered 200 with exit code 0 on the warm-up's session in both batches. Sign-in, before each
run, was 356 / 401 ms and 354 / 457 ms p50 / p95.

**Verdict: a warm session is about 5× faster than a new one, and still misses: about 2.9× at p50 and 1.4–1.6× at
p95 on the server.** Both backends take the same time again.

- **The command and the isolate cost nothing measurable when warm.** On `dynamic-worker`, `isolate.cold` was 0 and
  `isolate.call` 0 ms in all 50 (the warm-up's cold `isolate.call` was 312 ms). The sandbox's own phases (`isolate.manifest`,
  `isolate.exec`, `isolate.scan`) were 0 ms in a 10-run batch that kept every run's timings
  ([`…T20-36-13Z-warm-in-process-timings.json`](isolate-ready-2026-10-28T20-36-13Z-warm-in-process-timings.json)).
  Worker timers only move on I/O, so the ~285 ms is most likely the run's I/O: the sandbox layer's workspace,
  session and lease checks and its audit. `total` doesn't break that down by call.
- **Those round trips are still remote.** All six placement probes (warm-up and after, three batches) said what
  they did at 18:21: object `LHR`, D1 `ENAM` (`ORD`, primary). From the object, `SELECT 1` took 122 ms p50 (46–313,
  30 queries) and an R2 `head` 133 ms p50 (73–199, 30); R2 doesn't report its location. Two or three such round trips
  would add up to the ~285 ms. The measurement's own
  lookup of the session took 227 ms p50 (195–366) on top, outside `total`.
- **The client's ~0.9 s wall time** is sign-in (~360 ms), the lookup (~230 ms) and the run (~285 ms), plus the trip
  from brwsr's browser to the edge.

So the remaining gap most likely comes from where D1 and R2 are rather than the isolate, but that is an inference
until it is measured: the next step is moving them to `weur`, next to the object (#140 lets CI bind a new database
and bucket), and running these batches again.

## After the move to weur (28 Oct 2026, 22:36 UTC)

The same four batches again, warm then cold, both backends, back to back from `/healthz`, after D1 and R2 moved to
`weur`. The new database `harbour-weur` and bucket `harbour-workspaces-weur` were created with the `weur` location
hint and the data copied over; CI binds them through `HARBOUR_D1_DATABASE_NAME`, `HARBOUR_D1_DATABASE_ID` and
`HARBOUR_R2_BUCKET` (#140). The deployed `main` was `9495b62` (#145, a console change only), whose deploy log reads
`env.DB (harbour-weur)` and `env.WORKSPACES (harbour-workspaces-weur)`. The old `harbour` database and
`harbour-workspaces` bucket were deleted at 23:22 UTC, after a full export and a backfill of the 12 audit events
written to the old database between the copy and the switch; `wrangler.jsonc` now names the weur pair as its defaults.
Worker versions from before 22:24 UTC bind the deleted database, so they're no longer rollback targets.

| Batch | Kind | Client wall p50 / p95 (min–max), ms | Server `total` p50 / p95 (min–max) | Sign-in p50 / p95 | Before the move, server p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| [`…T22-36-03Z-weur-warm-in-process.json`](isolate-ready-2026-10-28T22-36-03Z-weur-warm-in-process.json) | in-process, **warm** | 216 / 290 (182–315) | **114 / 172** (48–243) | 41 / 54 | 285 / 405 |
| [`…T22-36-22Z-weur-warm-dynamic-worker.json`](isolate-ready-2026-10-28T22-36-22Z-weur-warm-dynamic-worker.json) | dynamic-worker, **warm** | 241 / 310 (188–346) | **134 / 223** (63–256) | 39 / 47 | 288 / 470 |
| [`…T22-36-41Z-weur-in-process.json`](isolate-ready-2026-10-28T22-36-41Z-weur-in-process.json) | in-process, cold | 897 / 1,069 (743–1,212) | 437 / 1,746 (237–2,174) | 58 / 106 | 1,533 / 1,885 |
| [`…T22-37-37Z-weur-dynamic-worker.json`](isolate-ready-2026-10-28T22-37-37Z-weur-dynamic-worker.json) | dynamic-worker, cold | 1,231 / 1,419 (1,001–1,501) | 690 / 1,733 (412–1,908) | 56 / 98 | 1,496 / 1,910 |

50 of 50 answered 200 with exit code 0 in every batch; both warm batches stayed on the warm-up's session (`warm: true`
in all 50) and closed it with 204. Target: ≤100 / ≤300 ms, warm.

**Verdict: the move cut the warm server time by 60% (285 → 114 ms p50). The p95 target is met on both backends; p50
misses by 14 ms in process and 34 ms on Dynamic Workers.**

- **D1 now runs next to the object.** All eight placement probes (warm-up and after, four batches) said object
  `LHR`, D1 region `WEUR`, colo `LHR`, primary. `SELECT 1` from the object took 15 ms p50 (4–35 ms, 40 queries),
  against 122 ms before. An R2 `head` took 57 ms p50 (12–350 ms, 40), against 133 ms.
- **Sign-in and the session lookup shrank with it.** Sign-in went from ~360 ms to ~40 ms p50, and the warm runs'
  session lookup from 227 ms to ~26 ms. That puts the client's warm wall time at 216 ms p50, against 925 ms.
- **What's left in a warm run** is still I/O: the sandbox layer's workspace, session and lease checks and its audit
  append, now about 10–15 ms per D1 query and ~55 ms per R2 call. The isolate itself still shows no measurable elapsed
  time with these timers when warm (`isolate.call` 0 ms and `isolate.cold` 0 in all 50 on `dynamic-worker`); its CPU
  time isn't measured. The cheapest remaining levers are the
  audit append off the critical path and the workspace head out of R2 ([below](#where-the-time-goes), items 3 and 4).
- **Dynamic Workers cost about 20 ms more warm, and more cold.** Cold, every run loads a new Dynamic Worker
  (`isolate.cold` 1 in all 50), and that call took 189 / 322 ms p50 / p95, a large share of a cold run on that backend
  (the rest of the run isn't broken down by call, so whether it's the largest single item isn't known).
- **The cold batches' server p95 is not trustworthy.** In 20 of the 100 cold runs (9 in process, 11 on Dynamic
  Workers) the server's `total` was longer than the client's whole wall time for the same call, which can't be real
  latency. In 12 of them the `session` step alone was (up to 2.1 s against a wall time of 0.8–1.3 s). None of the
  100 warm runs, and none of the 360 runs before the move, did this. The cause isn't found; the server's start mark
  looks stale in those runs. Without those 20 runs the cold
  server time is 411 / 709 ms (in process) and 638 / 825 ms (Dynamic Workers). The client wall times have no such
  outliers, so read cold p95 from those.
- **Placement is fixed per object.** The stack object was already in `LHR` and stays there; a location hint only
  places a new object, so existing objects keep where they are and new ones get `weur` (#140).

## After the head cache and audit outbox (29 Oct 2026, 07:27 UTC)

The same four batches again, from `/healthz`, on `b5d74be`. That deploy includes the following changes:

- #172: `wrangler.jsonc`'s defaults now point at the weur pair.
- #188: the workspace heads are kept in the stack object, in front of R2.
- #198: the audit appends queue in the object's SQLite and drain to D1 in the background.
- #206: each run also answers its marks as Unix milliseconds (`clock`), and the client records `sentAt` and
  `receivedAt` beside them.

The deploy log reads `env.DB (harbour-weur)` and `env.WORKSPACES (harbour-workspaces-weur)`. An anonymous request
still gets a 302 to Access sign-in. All eight placement probes said object `LHR`, D1 `WEUR` (`LHR`, primary).

| Batch | Kind | Client wall p50 / p95 (min–max), ms | Server `total` p50 / p95 (min–max) | Sign-in p50 / p95 | Before, server p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| [`…T07-27-02Z-final-warm-in-process.json`](isolate-ready-2026-10-29T07-27-02Z-final-warm-in-process.json) | in-process, **warm** | 104 / 142 (95–163) | **0 / 0** (0–0) | 42 / 61 | 114 / 172 |
| [`…T07-27-20Z-final-warm-dynamic-worker.json`](isolate-ready-2026-10-29T07-27-20Z-final-warm-dynamic-worker.json) | dynamic-worker, **warm** | 104 / 133 (92–161) | **0 / 0** (0–0) | 44 / 58 | 134 / 223 |
| [`…T07-27-37Z-final-in-process.json`](isolate-ready-2026-10-29T07-27-37Z-final-in-process.json) | in-process, cold | 1,098 / 1,344 (1,011–1,396) | 38 / 465 (20–730) | 60 / 99 | 437 / 1,746 |
| [`…T07-28-48Z-final-dynamic-worker.json`](isolate-ready-2026-10-29T07-28-48Z-final-dynamic-worker.json) | dynamic-worker, cold | 1,441 / 1,732 (1,277–1,777) | 1,332 / 2,449 (200–2,737) | 49 / 89 | 690 / 1,733 |

In every batch, all 50 runs answered 200 with exit code 0. Both warm batches stayed on the warm-up's session and closed
it with 204. Target: ≤100 / ≤300 ms, warm.

**Verdict: the warm target is met on the measure it's defined on, the server's `total`. That is 0 ms in all 100 warm
runs, and the Date.now marks agree (`started` to `ran` 0 ms in all 100).** With the head cached and the audit append
queued, the warm run no longer waits on an R2 head read or a D1 audit write (#188, #198), and none of its remaining
steps moved the clock. Even the client's whole request is 104 ms
p50, and that includes the browser's round trip, Access, sign-in and the session lookup.

- **0 ms means the clock didn't advance, not that no time passed or no I/O happened.** Worker timers only move on
  some I/O. The run's CPU time (the listing and the bash command) isn't in these numbers, and neither is anything
  that doesn't refresh the clock: on Dynamic Workers, the warm run still awaits an RPC into the loaded isolate
  (`isolate.call`, also 0 ms). The bound on it is what the client sees. In process, a warm request's server marks
  run as follows, p50 / p95: `entered` to `signedIn` 42 / 61 ms, the lookup (`looking` to `started`) 28 / 37 ms, and the
  run (`started` to `ran`) 0 / 0 ms. With the trip from brwsr's browser (about 15–25 ms to the edge, in the
  [round trips](#where-the-time-goes)), that accounts for nearly all of the 104 ms wall time.
- **The two backends take the same time warm.** On Dynamic Workers, `isolate.cold` was 0 and `isolate.call` 0 ms in
  all 50.
- **The cold runs got slower in the client's wall time, and not in the measured steps.** In process, the wall time
  went from 897 to 1,098 ms p50, while the server's span from `entered` to `ran` is 96 ms p50. So about 1 s isn't
  accounted for by the recorded server spans. The session close, which the request awaits after `ran` (lease
  release, the session's end), and time outside the Worker are the candidates. These marks don't place it, though:
  there's no mark after the close, and a stale clock hides time before `ran` too. 17 commits from several lanes landed between the two measurements (runtime changes included), so the cause isn't
  attributed here. **Known gap, not investigated:** cold runs aren't #17's target, so this extra ~1 s is left as it is
for M1.

### The cold timing anomaly: the Workers clock, not a slow step

The cold batches again have server times longer than the client's whole request. That happened in 22 of 50 runs
on Dynamic Workers (`created` to `ran` up to 2.1 s, against a wall time of 1.3–1.8 s), and in none in process this
time. #206's `clock` marks let a stale mark be told from a slow step, and it's a stale mark:

- **The server's entry mark jumps.** If the server's clock were live when a request arrives, the step in `entered`
  from one run to the next would track the step in the client's `sentAt`, give or take the network. In the warm
  batches it does, within 60 ms either way (p95 26 ms in process, 35 ms on Dynamic Workers). In the cold batches it doesn't. The server's step was up to
  1.3 s (Dynamic Workers) and 1.6 s (in process) longer than the client's, and in other runs up to 1.1 s shorter. A
  clock that's 1.1–1.6 s behind at one entry and caught up at the next gives exactly that.
- **No single clock offset fits the runs.** In real time, each request enters the Worker after the client sends it,
  and its last mark comes before the client receives the answer. So every run bounds the server's clock offset from
  the client's. In all four batches those bounds contradict each other: the spread is about 0.2–0.3 s warm, and
  0.7–1.3 s cold. The client's clock is a browser's, so the server's marks are the ones that are off.
- **So it's the platform, not Harbour's code.** On Cloudflare,
  [`Date.now()` and `performance.now()` are the same frozen clock](https://developers.cloudflare.com/workers/runtime-apis/performance/),
  and they advance only on I/O. A span that starts at a stale mark is inflated by however far behind the mark is.
  Cold runs do much more synchronous work (a new isolate, a Dynamic Worker load) than warm ones, and that is most
  likely what leaves a mark behind (an inference: the platform doesn't say when it refreshes the clock).

In short, read cold latency from the client's wall time, and treat a server span as the I/O waits inside it, not as
elapsed time. The warm figures are unaffected, because a warm run's steps are 0 ms whichever mark they start from.

## Session ready, time to first token and first bash: isolate on demand (#196, 29 Oct 2026)

From #196 on, the headline measurement isn't isolate-ready but three separate ones. Each is timed from the client, in a
signed-in page on `/healthz` in brwsr, and is 50 runs after one warm-up:

- **Session ready to take a prompt.** Cold is `POST /v1/sessions` until its 201. Warm is an open session's event
  socket (`GET /v1/sessions/:id/events`, upgraded) until its snapshot frame.
- **Time to first token (TTFT).** From sending `POST …/prompt` to the first streamed token on the socket (a `text` op,
  thinking or text). Cold is a new session's first prompt. Warm is a second prompt on the same session, after
  reopening its socket. The prompt is "Reply with the single word: ok", on the default `assistant` profile.
- **First bash call.** `POST /v1/measurements/isolate-ready`, whose `isolate` step is a session's first `ls -1R`
  through the tiered sandboxes, lease acquisition included. Cold is a new session each run; warm is 50 more commands
  on one open session.

The scripts are in [`harness/`](harness/). `session-ready.js` and `first-bash.js` run in the page through
`run-in-page.mjs`, and each JSON file holds every run and the summary. As #213 explains above, the server's own
spans stand still during synchronous work, so **cold latency here is the client's wall time**.

**What #196 changed:**

- **#197:** `SessionRuntimeOptions.environment`, built once when a session opens and cleaned up on abort and close.
- **#199:** a size limit on direct file operations, enforced before the body is fetched.
- **#202:** on Cloudflare, a session on a workspace now gets `read`, `write`, `edit`, `ls` and `bash`; before, it had
  host tools only. The file tools work on the workspace in R2 directly, as the session's agent, and lease nothing.
  `bash` leases the session's isolate on its first command, and abort and close release only that session's lease.
  Nothing is acquired or prefetched when a session is created or opened.

Before was main `39eae68`, on 28 Oct at 23:25 UTC. After was main `14f964b` (#202), Worker version `65881cd0`,
deployed 07:35 UTC on 29 Oct and measured from 07:45. Placement both times: object `LHR`, D1 `WEUR` (primary, `LHR`);
edge `CDG` or `LHR`. Every run answered (50 of 50 in each batch, exit code 0).

| Measurement, ms p50 / p95 | Before (`39eae68`) | After (`14f964b`) |
| --- | --- | --- |
| Session ready, cold (create → 201) | 788 / 1,027 | 1,715 / 1,979 |
| Session ready, warm (socket → snapshot) | 92 / 314 | 112 / 311 |
| TTFT, cold | 1,337 / 1,912 | 1,468 / 5,619 |
| TTFT, warm | 1,338 / 1,774 | 1,437 / 3,700 |
| First bash, cold: client wall (create, command, close) | 912 / 1,058 | 1,639 / 1,864 |
| First bash, warm: client wall | 179 / 236 | 117 / 154 |
| First bash, warm: server `total` | 89 / 150 | 0 / 0 |

Files:

- Before: [`session-ready-…-before.json`](session-ready-2026-10-28T23-27-05Z-before.json) and
  [`first-bash-…-before.json`](first-bash-2026-10-28T23-25-47Z-before.json).
- After: [`session-ready-…-after.json`](session-ready-2026-10-29T07-49-59Z-after.json) and
  [`first-bash-…-after.json`](first-bash-2026-10-29T07-48-22Z-after.json).

**Verdict: the warm paths got faster, and the cold create got slower because of the number of sessions, not because
of #196.**

- **Warm first bash: 179 → 117 ms p50 in the client.** This is mostly #188's head cache and #198's audit outbox,
  which landed between the batches.
- **Warm readiness and TTFT p50 barely moved; TTFT p95 rose because of a tail.** Before, the slowest cold TTFT was
  1,941 ms. After, 8 of 50 cold runs and 4 of 50 warm runs took over 3 s, the slowest 13.3 s.
  - Harbour's own part, accepting the prompt, didn't slow: 145 / 176 ms against 150 / 216 ms before.
  - The tail is between acceptance and the first token, which is the model gateway and the model.
  - These sessions have no workspace, so #196's changes don't reach them. The tail isn't attributed here.
- **Cold readiness doubled, and #196 isn't why.**
  - The default project held 428 sessions at the before batch and 670 at the after batch
    ([count](session-count-2026-10-29T07-57-59Z.json)). Each session adds its own Pi Durable schema to the object's
    SQLite, and a create's migration rewrites the whole schema. So the create cost grows with every session ever
    held (#216).
  - The sessions in the readiness batch have no workspace, so #202 gives them no tools and no environment.
  - Interleaved creates with and without a workspace cost the same, 1,979 / 2,233 ms against 2,043 / 2,163 ms
    ([A/B](create-ab-2026-10-29T07-59-54Z.json), 15 + 15).
  - Creates kept getting slower during the session (1.7 s at 07:50, 2.0 s at 08:00) as the batches added sessions.
- **The first bash's cold wall time is the same create plus a command.**

### The file tools on the workspace, and a lease only for bash

[`first-bash-…-after-tools.json`](first-bash-2026-10-29T07-45-23Z-after-tools.json) runs `tools: true`. Each cold
run creates a session, runs its file tools through the environment its tools get (read one file, list `src`, write
`scratch/measure.txt`), checks its leases, then runs its first command.

- **No lease before the first command: `leasedBeforeBash` was 0 in all 50 runs.** The command then leased one isolate
  and exited 0. The smoke test below shows the release on close in the audit.
- **The cold runs' file-tool spans aren't the tools' own time.** They measured read 989 / 1,921 ms, `ls` 0 / 0 and
  write 1,107 / 1,666 ms. Read and write together came to 2,033 / 2,817 ms, about a cold create (1.7–2.0 s at the
  time) plus a little, while the session's own span before them was 31 ms.
  - The new session's harness opens synchronously, schema included, and a Worker's clock stands still through it, so
    that time lands in whichever later span does I/O next.
  - #214 adds `tools` to warm runs, on a session that's already open, as it is when a real session's tool runs.

**On an open session, the tools' own times**
([`first-bash-…-after-warm-tools.json`](first-bash-2026-10-29T08-47-39Z-after-warm-tools.json), main `57f2284`, Worker
version `f1b7ab53`; 50 of 50, on one warmed-up session):

| Tool, ms p50 / p95 (min–max) | Warm |
| --- | --- |
| `read` (one 19-byte file) | 72 / 146 (16–172) |
| `ls` (`src`, 30 entries) | 0 / 0 (0–0) |
| `write` (`scratch/measure.txt`) | 899 / 1,334 (451–1,470) |
| The command after them (`isolate`) | 0 / 0 |

- **`leasedBeforeBash` was 1 in every run.** That's the warm-up's lease: the file tools took none of their own.
- **`read` is one R2 blob read.**
- **`ls` shows 0 ms because no I/O moved the clock.** That fits the head and tree being served from the object's
  cache (#188).
- **A write is a workspace commit, and that's slow.** It makes four R2 writes, each after the one before: the blob,
  the tree, the previous version's archive record, then the conditional head put. At about 225 ms each, from the
  object in `LHR` to the weur bucket, that's the ~900 ms (from the code; the steps aren't timed separately). #218 has
  the options. Writing the first three at the same time halves it, and the object's storage could become the commit
  point.

**Smoke test through the model** ([`tools-smoke-…json`](tools-smoke-2026-10-29T07-58-38Z.json)): a session on the
measurement workspace was asked to read `src/file-00.txt` and then run `ls src | wc -l`.

- The model called `read`, then `bash`, and answered "measurement file 0" and 30.
- The session's audit shows no lease after its create, `sandbox.lease.acquired` by the agent during the run, and
  `sandbox.lease.released` when it was closed.

A deploy reached the measurement route about five minutes after `wrangler deploy` finished: the first probes after
the `57f2284` deploy still got the old code's answer. Probe before measuring a new deploy.

### Self-hosted

Not measured in this change. The M0 self-hosted stack (`apps/selfhosted`) already acquires lazily:

- `bash` calls the isolate host per command, and its `read` and `write` tools work on MinIO directly.
- The isolate's `list` call is only in its measurement script.

Wiring and measuring the comparable M1-SH1 stack is that lane's work. The runtime seam (#197) and the sandbox
environment's size limit (#199) are target-neutral, in `packages/`.

### Deferred

- **#216: cold create grows with the number of sessions held.** This is the largest cold cost now, and it grows with
  every measurement batch.
- **#218: a workspace write takes ~900 ms**, four sequential R2 writes per commit. `write` and `edit` are now a
  session's slowest tools.
- **A session's directory row kept in the object instead of read from D1, and a cold session's D1 row written in the
  background.** Neither is needed for the warm target, which is met (above), and the cold path is dominated by #216.
- **A warm isolate pool.** None is added: a pooled isolate would have to be blank until bound and never reused across
  sessions (#196).

## Where the time goes

Round trips from the same signed-in page (15 calls each for the first three rows; 5, 3, 5 and 5 for the API rows), p50 in ms:

| Call | Before #133 (about 55 sessions) | After #133 (about 160 sessions) |
| --- | --- | --- |
| `/cdn-cgi/trace` (Cloudflare's edge only) | 14 | 14 |
| `/healthz` (Access and the Worker, no Durable Object) | 24 | 22 |
| `/` (the console's static assets) | 38 | 45 |
| `GET /v1/profiles` (sign-in, one role check, the object's SQLite) | 599 | 613 |
| `GET /v1/audit/events?limit=5` | 1,156 | 1,189 |
| `GET /v1/sessions?limit=1` | **12,316** | **635** |

- **Access and the edge cost almost nothing** (about 20 ms). Everything else is behind the Worker.
- **A signed-in API call costs about 0.6 s with almost no work in it.** For a person already linked, sign-in makes three
  D1 queries (the Access subject, the organisation, membership) and the access check two more (`roleOf`: the scope,
  then the role bindings). `GET /v1/profiles` is little else besides one read of the object's SQLite. So, as an
  inference rather than a measured breakdown, each D1 query takes about 100 ms from the object.
- **The session list was O(sessions) in D1 round trips.** Project access asked `roleOf` for each session listed, and
  the console polls that list every 3 s. #133 memoises the role in `apps/cloudflare` (per request, for at most
  1 s), which took it from 12.3 s to 0.64 s, and took about 0.6 s off isolate-ready's server `total`.
- **Isolate-ready's server time is still a series of storage round trips.** The session's create (with its access
  check and audit append) and the tiered sandboxes' run (workspace lookup, session check, lease and its audit append
  to D1, the workspace head) each wait on storage in turn. The manifest is read from R2 only on the first run: after
  that the in-process backend's listing cache answers for the unchanged measurement workspace. The client's wall time
  adds sign-in before and the close after (lease release and the session-end audit, both D1 writes). There is no
  worker to start and no file body to read for this listing, because just-bash runs in-process and its files are
  lazy. Its CPU time isn't measured here.

What would get near the target, roughly in order of payoff:

1. **D1's location, then fewer D1 round trips.** Done on 28 Oct 2026: D1 and R2 are now in `weur`, next to the object
   ([After the move to weur](#after-the-move-to-weur-28-oct-2026-2236-utc)), and a query now takes about 15 ms instead
   of 120. Before that, the `harbour` database's primary was in `ENAM` (`ORD`) and the object in `LHR`. Fewer
   round trips, such as keeping the identity rows the object reads on every request in its own SQLite, would still
   cut every call.
2. **Sign-in once per token, not once per request.** A short cache keyed on the Access JWT would save about 0.3 s a
   call. That's the identity lane's authenticator.
3. **Audit off the critical path.** Done in `apps/cloudflare/src/audit-outbox.ts` (#198): appends queue in the
   object's SQLite and drain to D1 in the background. Measured on 29 Oct 2026, with item 4's head cache: a warm run now
   shows 0 ms on the server ([above](#after-the-head-cache-and-audit-outbox-29-oct-2026-0727-utc)).
4. **Then the M0 levers:** the workspace head in Durable Object storage instead of R2 (done, #188). A pool of
   pre-created SessionDOs measured 79 / 170 ms ready in option (a)
   ([m1-cf1-ready-preload](../m1-cf1-ready-preload/README.md)), but only once storage round trips are out of the
   path.

## Cost estimate

The estimate in [`apps/cloudflare/README.md`](../../../apps/cloudflare/README.md#cost-estimate) stands: **about $0 a
month on top of the account's $5 Workers Paid minimum**. These batches add nothing material: 150 measurement sessions
and a few hundred API calls, well inside every included allowance. What today's numbers add:

- An open console polls the session list 3 s after each poll completes, 100 sessions a page, following every cursor.
  As a one-page approximation, that is up to about 0.9 M requests a month for a tab left open, and after #133 about
  five D1 queries a request, so about 4.5 M D1 queries a month. More sessions mean more pages per poll (two at
  today's 160), each a request with its own sign-in. Each query reads a handful of rows, far inside the 25 bn rows
  read included.
- The single object is active (and billed at 128 MB) for as long as a console is open, as the README already counts.
  Slow requests don't add duration beyond that while a console is open anyway.

#17's definition of done checks this against the first week's bill, around 4 Nov 2026.

## Smoke test (28 Oct 2026, 15:38 UTC)

From the same signed-in brwsr context:

- **The console loads** on `https://harbour.myslop.app/`, title "Harbour", signed in through Access One-time PIN.
  An anonymous request still gets a 302 to `lleverage-ai.cloudflareaccess.com`.
- **A new session gets a real model reply through CLIProxyAPI, not echo.** `POST /v1/sessions` answered 201 and
  `POST …/prompt` answered 202. The prompt "Reply with one short sentence that contains the word lighthouse." got
  "The lighthouse beam swept across the dark water to guide the ships home." in about 6 s, with a thinking block.
  The audit view shows "assistant model call" for the session.
- **The workspace view responds.** `GET /v1/workspaces/:id/files` answered 200 with `docs`, `src` and `test`, and the
  console's Files page lists them.
- **The audit view responds.** `GET /v1/audit/events` answered 200, and the console's Audit log page showed 16 events
  for the last 24 hours (sessions started and stopped, sandbox leases acquired and released, the model call).

## Checks against the deployed stack (29 Oct 2026, 07:32 UTC)

The test is `apps/cloudflare/test/remote/deployed.test.ts` (#207), run on `b5d74be` from Sal's host. It uses a project
API key issued from the signed-in console: "Sal deployed-stack check (TASK-3461)", prefix `hbr_Wf-WW9AS`, operator on
the Default project, expiring 28 Nov 2026. It also uses that page's Access cookie, because host apps aren't let
through Access yet.

**Result: 6 of 6 passed.** The test checked that:

- an anonymous request is sent to Access sign-in;
- a bad key is refused even with the cookie;
- the key's projects, profiles and sessions are listed;
- a session's workspace can be read through the workspace read API;
- the audit query API answers newest first;
- one labelled session runs to a real model answer (4.0 s), with its audit events, and is closed.

The shared conformance suites in `@harbour/testing` take in-process implementations and fakes, so they run on the
Cloudflare implementations in `targets/cloudflare` (runtime, vault and workspace) in CI, not against the hostname. The
`apps/cloudflare` README says how to run this check again.

## How to run it again

From a signed-in page on the hostname, such as `/healthz` (not the console, which polls into the same object):

```js
const backend = "in-process"; // or "dynamic-worker"
const call = async (placement = false) => {
  const t0 = performance.now();
  const r = await fetch("/v1/measurements/isolate-ready", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(placement ? { backend, placement: true } : { backend }),
  });
  const j = await r.json();
  return { status: r.status, wall: performance.now() - t0, server: j.timings?.total, session: j.timings?.session,
           isolate: j.timings?.isolate, signIn: j.timings?.signIn, call: j.timings?.["isolate.call"],
           cold: j.timings?.["isolate.cold"], exit: j.exitCode, listed: j.listed,
           ...(placement ? { placement: j.placement } : {}) };
};
const warmup = await call(true); // the first call after an object start seeds the measurement workspace
const runs = [];
for (let i = 0; i < 50; i++) runs.push(await call());
const after = await call(true);
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1];
({ ok: runs.filter((x) => x.status === 200 && x.exit === 0).length,
   wallP50: q(runs.map((x) => x.wall), 0.5), wallP95: q(runs.map((x) => x.wall), 0.95),
   serverP50: q(runs.map((x) => x.server), 0.5), serverP95: q(runs.map((x) => x.server), 0.95) });
```

Each file holds that script's output, `runs` included: `status`, `wall` (client ms), `server` (`timings.total`),
`session`, `isolate`, `exit` and `listed` per run, plus the warm-up and the summary. The two later files add
`signIn`, `call` and `cold` per run, and `placement` on the warm-up and `after`. The `final` files (29 Oct) add
`sentAt` and `receivedAt` (the client's `Date.now()` around each call) and the response's `clock` per run.

The warm batch runs on one session, which it closes whatever happens (in a fresh page, not after the script above):

```js
const backend = "in-process"; // or "dynamic-worker"
const call = async (body) => {
  const t0 = performance.now();
  const r = await fetch("/v1/measurements/isolate-ready", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend, ...body }),
  });
  const j = await r.json();
  return { status: r.status, wall: performance.now() - t0, sessionId: j.sessionId, warm: j.warm,
           server: j.timings?.total, timings: j.timings, exit: j.exitCode,
           ...(body.placement ? { placement: j.placement } : {}) };
};
const warmup = await call({ keep: true, placement: true }); // a cold run that leaves its session open
const runs = [];
let after;
try {
  for (let i = 0; i < 50; i++) runs.push(await call({ sessionId: warmup.sessionId }));
  after = await call({ sessionId: warmup.sessionId, placement: true });
} finally {
  await fetch(`/v1/sessions/${warmup.sessionId}/close`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
}
```

The same `q` gives the percentiles. The warm
files hold `warmup`, `runs`, `after`, `closed` (the close's status) and `summary`; the `-timings` file keeps every
run's whole `timings`. A run answers 409 if the session is closed, and 400 if it isn't a measurement session on that
backend. Right after a deploy, wait until the object has restarted on the new code: a warm-up answered by the old
code closes its session, and the batch fails with 409s.

The [isolate-on-demand batches](#session-ready-time-to-first-token-and-first-bash-isolate-on-demand-196-29-oct-2026)
use the scripts in [`harness/`](harness/). Each `.js` file is the body of an async function that `run-in-page.mjs` runs
in a signed-in page on `/healthz` through brwsr, writing what it returns to a JSON file:

```sh
node harness/run-in-page.mjs harness/session-ready.js session-ready.json '{"runs":50}'
node harness/run-in-page.mjs harness/first-bash.js first-bash.json '{"runs":50}'                 # cold and warm
node harness/run-in-page.mjs harness/first-bash.js first-bash-tools.json '{"runs":50,"tools":true}'
node harness/run-in-page.mjs harness/first-bash.js first-bash-warm-tools.json '{"runs":50,"warmTools":true}'
node harness/run-in-page.mjs harness/create-ab.js create-ab.json '{"runs":15,"workspaceId":"ws_…"}'
node harness/run-in-page.mjs harness/probe-measure.js probe.json   # 404 (no session) once a deploy is live, not 400
```
