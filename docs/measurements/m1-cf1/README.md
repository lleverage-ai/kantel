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

**Latest: after D1 and R2 moved to `weur`, a warm session takes 114 / 172 ms p50 / p95 on the server (in-process),
so the p95 target is met and p50 misses by 14 ms** ([After the move to weur](#after-the-move-to-weur-28-oct-2026-2236-utc)).
Everything above that section was measured with D1 in North America.

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
`harbour-workspaces` bucket are untouched.

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
3. **Audit off the critical path.** Append after the answer (`ctx.waitUntil`), not before it, both in the measured
   steps and in the close.
4. **Then the M0 levers:** the workspace head and manifest in Durable Object storage instead of R2. A pool of
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
`signIn`, `call` and `cold` per run, and `placement` on the warm-up and `after`.

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
