# #17 option (a): a pre-loaded isolate per SessionDO (Cloudflare)

Seven batches, 270 sessions, recorded 28 Oct 2026 between 07:52 and 08:16 UTC against the temporary Worker
`harbour-ready-spike` ([spikes/ready-preload](../../../spikes/ready-preload/README.md)), deleted afterwards. The bench
ran from Sal's host in Germany; every request reached the Worker in FRA. Cloudflare placed the Durable Objects in FRA or
AMS (counts below). The analysis is in [isolate-readiness.md](../../design/isolate-readiness.md#measured-option-a-28-october-2026).

"Ready" is M0-CF1's: the session is set up and the workspace (61 files) listed by `ls -1R /workspace | wc -l` in the
session's own isolate, timed in the routing Worker. Runs are sequential and paced 1 s apart; no run failed.

| File | What each run does | n | Ready p50 / p95 (ms) | Isolate loaded at hand-out | DOs placed |
| --- | --- | --- | --- | --- | --- |
| [`cold.json`](cold.json) | Today's path, as a lean rebuild of M0-CF1's bench (no leases; two R2 reads in the listing where M0-CF1 makes four): new SessionDO, setup (R2 head ×2, `Harness.open`, conversation), list (R2 head and manifest, new isolate) | 50 | **1,046 / 1,404** | — | FRA 16, AMS 34 |
| [`hot.json`](hot.json) | Warm a pool object, hand it out 1 s later; manifest from the WorkspaceDO | 50 | **79 / 170** | 50 of 50 | FRA 20, AMS 30 |
| [`hot-r2.json`](hot-r2.json) | As `hot`, with the head and manifest read from R2 | 20 | 272 / 421 | 20 of 20 | FRA 13, AMS 7 |
| [`idle-60s.json`](idle-60s.json) | Hand out after 60 s idle (every object was a new instance: hibernated or evicted) | 50 | 225 / 417 | 23 of 50 | FRA 20, AMS 30 |
| [`idle-15m.json`](idle-15m.json) | Hand out after 15 min idle, no keep-alive | 40 | 321 / 569 | 0 of 40 | FRA 12, AMS 28 |
| [`idle-15m-timer.json`](idle-15m-timer.json) | 15 min, a 20 s `setTimeout` chain pinging the isolate (object pinned in memory) | 30 | 168 / 510 | 14 of 30 | FRA 11, AMS 19 |
| [`idle-15m-alarm.json`](idle-15m-alarm.json) | 15 min, a 20 s alarm pinging the isolate (object may hibernate between) | 30 | 106 / 328 | 20 of 30 | FRA 14, AMS 16 |

Split by whether the hand-out found a loaded isolate:

| Batch | Loaded: ready p50 / p95 (n) | Reloaded at hand-out: ready p50 / p95 (n) |
| --- | --- | --- |
| `idle-60s` | 86 / 231 (23) | 265 / 417 (27) |
| `idle-15m-timer` | 89 / 315 (14) | 182 / 534 (16) |
| `idle-15m-alarm` | 98 / 290 (20) | 257 / 444 (10) |

Phases (p50 / p95, ms):

| Batch | Phase | |
| --- | --- | --- |
| `cold` | First contact with a new SessionDO | 415 / 567 |
| | Setup (in the DO: R2 workspace lookup 202 / 341) | 258 / 419 |
| | List (in the DO: R2 head and manifest 204 / 286, isolate load 72 / 126) | 325 / 442 |
| `hot` | Claim from the pool directory (bare round trip 8 / 16) | 24 / 81 |
| | Hand-out call (bare round trip 11 / 15; manifest from the WorkspaceDO 19 / 101) | 53 / 130 |
| all pool batches | Warm one object (Harness, conversation, isolate load and one `ls`), off the critical path | 501–598 / 744–933 |

How to read the files:

- `isolate.reused` is true when the isolate `warm()` loaded is still the one answering. "Loaded at hand-out" counts
  `isolate.calls > 2`: the isolate had answered calls before the hand-out's list and `ls` (warm's, or a keep-alive
  ping's after a reload), so the hand-out did not load it. `who.codeFetches` counts loader callbacks in the object's
  current instance (warm, pings and hand-out): in the timer batch some objects ran it 44 times against 44 pings.
- `doInMemory` is false when the object's instance changed since `warm()` (hibernated or evicted); `harnessInMemory`
  likewise for Pi Durable's Harness, which the hand-out then reopens in parallel with the listing.
- In-DO timings (`timings`, `setup`, `list`) read 0 for CPU-only work and for calls into the Dynamic Worker, because
  Workers clocks advance only on I/O. The Worker-side `readyMs` and `phases` are the measurements; `rtt` is a bare
  round trip to each object taken after ready, not part of it.
- `hot-r2` has one outlier: slot `hot-r2-7`'s claim took 8.3 s (ready 8,661 ms). With 20 runs the p95 rank falls on
  the next value down, 421 ms.
