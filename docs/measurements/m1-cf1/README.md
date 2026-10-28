# M1-CF1 isolate-ready on the deployed stack (Cloudflare)

Three batches of 50 runs, each after one warm-up call, recorded 28 Oct 2026 against `https://harbour.myslop.app`, the M1
stack as CI deploys it (`apps/cloudflare`, one `HarbourStack` Durable Object, D1 for identity and audit, R2 for
workspaces). The isolate backend is `in-process` (#94's just-bash inside the object), the only one built so far. The
measurement is `POST /v1/measurements/isolate-ready` (`apps/cloudflare/src/measure.ts`). Each run creates a new session
on the 61-file measurement workspace, runs `ls -1R` in that session's isolate (68 lines: 61 files and 7 directories),
answers its timings and closes the session. The runs came from a signed-in page (Cloudflare Access) in brwsr, Sal's
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
- The third batch is after #133 (one role lookup per request). Runs 42 to 44 took 2.8, 6.2 and 4.3 s on the server
  and set its p95. The other 47 took 0.97 to 2.0 s, in two clusters around 1.0 and 1.3 s.
- The server times are Worker timers, which on Cloudflare
  ["only advance or increment after I/O occurs"](https://developers.cloudflare.com/workers/runtime-apis/performance/).
  So `total` is time spent waiting on storage and other I/O, and the shell's own CPU doesn't show: the smoke test's
  call reported `isolate.exec` and `isolate.scan` as 0 ms.

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
- **Every signed-in API call costs about 0.6 s before it does any work.** Sign-in resolves the Access identity to a user
  and checks membership in D1, and the access check reads the role from D1 (`roleOf`: a scope check, then the role
  bindings). That is about six D1 queries at roughly 100 ms each.
- **The session list was O(sessions) in D1 round trips.** Project access asked `roleOf` for each session listed, and
  the console polls that list every 3 s. #133 memoises the role per request in `apps/cloudflare`, which took it from
  12.3 s to 0.64 s, and took about 0.6 s off isolate-ready.
- **Isolate-ready still makes a series of sequential storage round trips.** The session's create, the tiered
  sandboxes' acquire (workspace lookup, session check, lease, audit append to D1), the manifest read from R2 and the
  close (lease release and session-end audit, both D1 writes) each wait on storage in turn. The isolate itself is
  free: just-bash runs in-process, and its files are lazy.

What would get near the target, roughly in order of payoff:

1. **D1's location, then fewer D1 round trips.** About 100 ms per query suggests the `harbour` database's primary
   isn't next to the object. Read replicas, or keeping the identity rows the object reads on every request in its own
   SQLite, would cut every call. Seeing where `harbour` lives is a read in the Cloudflare dashboard (D1 → `harbour`),
   not done here.
2. **Sign-in once per token, not once per request.** A short cache keyed on the Access JWT would save about 0.3 s a
   call. That's the identity lane's authenticator.
3. **Audit off the critical path.** Append after the answer (`ctx.waitUntil`), not before it.
4. **Then the M0 levers:** the workspace head and manifest in Durable Object storage instead of R2. A pool of
   pre-created SessionDOs measured 79 / 170 ms ready in option (a)
   ([m1-cf1-ready-preload](../m1-cf1-ready-preload/README.md)), but only once storage round trips are out of the
   path.

## Cost estimate

The estimate in [`apps/cloudflare/README.md`](../../../apps/cloudflare/README.md#cost-estimate) stands: **about $0 a
month on top of the account's $5 Workers Paid minimum**. These batches add nothing material: 150 measurement sessions
and a few hundred API calls, well inside every included allowance. What today's numbers add:

- An open console polls the session list every 3 s. That is about 0.9 M requests a month for a tab left open, and
  after #133 about six D1 queries a poll, so about 5 M D1 queries a month. Each reads a handful of rows, far inside the
  25 bn rows read included.
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
const backend = "in-process"; // later also "dynamic-worker"
const call = async () => {
  const t0 = performance.now();
  const r = await fetch("/v1/measurements/isolate-ready", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend }),
  });
  const j = await r.json();
  return { status: r.status, wall: performance.now() - t0, server: j.timings?.total, session: j.timings?.session,
           isolate: j.timings?.isolate, exit: j.exitCode, listed: j.listed };
};
await call(); // warm-up: the first call after an object start seeds the measurement workspace
const runs = [];
for (let i = 0; i < 50; i++) runs.push(await call());
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1];
({ ok: runs.filter((x) => x.status === 200 && x.exit === 0).length,
   wallP50: q(runs.map((x) => x.wall), 0.5), wallP95: q(runs.map((x) => x.wall), 0.95),
   serverP50: q(runs.map((x) => x.server), 0.5), serverP95: q(runs.map((x) => x.server), 0.95) });
```

Each file holds that script's output, `runs` included: `status`, `wall` (client ms), `server` (`timings.total`),
`session`, `isolate`, `exit` and `listed` per run, plus the warm-up and the summary.
