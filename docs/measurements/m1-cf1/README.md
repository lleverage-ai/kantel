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

#17's target is **≤100 ms p50 and ≤300 ms p95**, measured as in M0 (50 runs, a new session each).

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

**Verdict: the backend isn't what misses the target; D1's location is.**

- **The two backends take the same time.** Server p50 1,496 ms on Dynamic Workers against 1,533 ms in process. Each
  run is a new session, so each loads a new Dynamic Worker (`isolate.cold` was 1 in all 50), and the call into it
  (`isolate.call`: load, the RPC both ways and the command, with its manifest read over the port) took **128 / 212 ms**
  p50 / p95. The other ~0.9 s of `isolate` is the same storage round trips the in-process backend waits on.
- **D1's primary is in North America; the object is in London.** All four placement probes answered: object `LHR`, D1
  region `ENAM`, colo `ORD`, `served_by_primary` true. The edge was `LHR` or `AMS`, wherever brwsr's browser came in.
- **Each D1 query costs about 120 ms, nearly all of it the Atlantic.** The 20 `SELECT 1` round trips took 120 ms p50
  (107–256 ms); D1 reported at most 0.38 ms of SQL in any of them. That confirms the inference below of about 100 ms
  a query: sign-in's ~370 ms is its three D1 queries, and the rest of the server time is a handful more.

So with the object and D1 together (either moved), each of those round trips would be a few milliseconds, and
isolate-ready would be the Dynamic Worker call plus the object's own work. Which to move is a decision for #17, not
taken here: D1's location is set when a database is created (a location hint), so moving it means a new database and
its data copied, and the object's is set on its first use, so moving it means a new object name with a location hint.

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

1. **D1's location, then fewer D1 round trips.** The `harbour` database's primary is in `ENAM` (`ORD`) and the object
   in `LHR`, about 120 ms a query (above). Putting them together, read replicas, or keeping the identity rows the
   object reads on every request in its own SQLite, would cut every call.
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
