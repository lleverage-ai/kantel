# Isolate readiness: a pre-loaded pool, not an isolate per workspace

Issue #9: an isolate session is ready (workspace listed) in 100 ms p50 and 300 ms p95 on both targets. The
self-hosted numbers here are from [m1-be1-isolate](../measurements/m1-be1-isolate/README.md) (local workerd, 50
runs a batch, M0's workspace); the Cloudflare numbers are M0-CF1's, since this lane can't deploy.

## Where the M0 time goes

**Self-hosted, 137 / 164 ms (runc; runsc-kvm 170 / 205).** Of a new session's 130 ms here, 123 ms is loading
its Dynamic Worker, 3 ms is reading the manifest from MinIO and 2–3 ms is the listing. A Dynamic Worker with a
trivial bundle loads in 9 ms, so about 115 ms is compiling and running the 1.28 MB just-bash bundle. The
listing itself is not the problem.

**Cloudflare, 1,208 / 2,055 ms.** Three phases (p50, M0-CF1's contracts run):

| Phase | p50 | What it is |
|---|---|---|
| First contact with a new SessionDO | 467 ms (p95 1,773) | placement and creation |
| Setup | 201 ms | R2 workspace lookup (113), `Harness.open`, conversation |
| List | 513 ms | R2 head and manifest (201), then a new Dynamic Worker (about 310) |

## What props give us today

Bindings and props are fixed when a Dynamic Worker loads. Today each session's isolate gets `WS`, a
`Workspace` entrypoint whose props name one workspace, and a `globalOutbound` `Egress` whose props name the
session, so the vault sees a session header the isolate cannot forge. Nothing the isolate says is trusted, and
no two sessions share a heap. Every option below is judged by what replaces those two props.

## Options

### One isolate per workspace

`LOADER.get` keyed by workspace. A new session on a loaded workspace is ready in **4.3–4.5 ms p50,
6.5–6.6 ms p95**.

Isolation cost:

- Every session on a workspace shares one isolate and one heap. A just-bash escape in one session reaches the
  others: their in-flight state, and whatever capabilities their calls hold.
- Egress can only carry the workspace. Per-session tagging would need a per-call egress capability, with
  `globalOutbound` denying everything; in a shared heap concurrent sessions' capabilities sit side by side, so
  the vault's per-session decisions and audit rest on code all the workspace's sessions share.
- One session's runaway command blocks the others, and a workspace's first session still pays the full load.

The workspace scope is unchanged: every session in the isolate is on that workspace.

### A pre-loaded pool

The host loads isolates before anyone owns them. A new session takes one, and it is that session's alone for
its life: an isolate is never returned to the pool. Ready in **7.1–7.2 ms p50, 9.3–11.0 ms p95**, with
50 of 50 pool hits.

What replaces the props:

- **Workspace.** The isolate has no `WS` binding. With every call the host passes a scope: an `RpcTarget` it
  builds for that session's workspace. The isolate can use only what it is handed; keeping the stub gains it
  nothing, as it is its own workspace. About 3 ms a call. This confinement holds only if the scope checks what
  it forwards: today's `Workspace.read(sha)` in `images/isolate-host/src/loader.ts` puts the identifier into a
  URL unchecked, so `../` segments could reach another workspace's blobs. That gap is inherited, not the pool's,
  but the scope (and `Workspace` itself) must accept only 64-hex-digit SHA-256 digests.
- **Egress.** Its `globalOutbound` carries only a slot ID. The host writes slot to session once, at hand-out,
  and the egress entrypoint looks the session up there. Before hand-out it refuses (the harness returns 403).

Security cost: the session the vault sees depends on host bookkeeping, not load-time immutability, so the map
must be written once per slot, never reassigned, and dropped when the session ends. Isolation between sessions
is unchanged: one isolate per session, and no user code runs in one before hand-out.

Operational limits:

- **Refill after the response.** A load holds the workerd process: a refill started before the response delays
  that session by a whole load (135–144 ms p50), and any load stalls the process's other sessions for about
  125 ms, as today.
- **Refill rate.** One process refills about 8 isolates a second; a burst bigger than the pool pays today's cost.
- **Memory.** Idle isolates hold memory (not measured). Size the pool to the arrival rate.

### Smaller or precompiled bundles

The bundle is about 90% of a load. Importing just-bash only on the first exec (still shipped in the isolate)
makes a new isolate ready in **68–71 ms p50**, 76–107 ms p95, and the first command about 25 ms slower; on
runsc-kvm (+30 ms per load in M0) that is about 100 ms, not enough alone. Trimming just-bash to the commands we
use would cut every load (the fallback, pool refills, Cloudflare's 310 ms) with today's isolation. The loader
takes module source; this lane found no way to give it a V8 code cache and measured none.

### Cloudflare

- **R2 round trips.** Keep the workspace head and manifest hot: in the session's or the workspace's Durable
  Object storage, passed to the isolate with the call. Only blobs stay in R2. This removes about 300 ms p50
  (113 + about 200). It doesn't change isolation.
- **SessionDO creation.** Pre-create SessionDOs: Harbour mints a session's ID from a pool of named objects
  that already exist, have opened Pi Durable, and have created a conversation. This takes the 467 ms p50
  (1,773 p95) of first contact, and most of setup, off the path. M0 hit `SQLITE_NOMEM` creating many objects
  quickly, so fill the pool steadily; idle objects hibernate, and waking one is unmeasured.
- **The isolate.** The same pool model, inside each pre-created SessionDO: it loads its own isolate with a slot
  ID, the scope goes with each call, and the slot-to-session map is the DO's own state. Worker Loader's cache is
  best-effort and per machine, so this pays only if the isolate stays loaded where the object runs. A
  Worker-wide pool can't choose the machine at all.
- **Listing off the critical path.** The listing is manifest metadata. The SessionDO could return it without the
  isolate and load the isolate in parallel, so the first command pays the load. That would meet the target on
  both targets with today's isolation, but "ready" would no longer mean the isolate is loaded. **That is a
  decision for the plan's owner.** It is not recommended here.

## Recommendation

**Self-hosted: the pre-loaded pool, now built (next section).** It meets the target with a wide margin. In
the model it was 7 / 11 ms, and as built it is 6.4 / 7.4 ms, against 100 / 300. On gVisor the hand-out call would
roughly double. It keeps one isolate per session.

One isolate per workspace is 3 ms faster, but it makes the workspace, not the session, the isolation unit, and
it loses per-session egress. The pool's own security cost, host bookkeeping for the egress tag, is narrow and
testable.

Trim just-bash for refill rate and the fallback, and run more than one workerd process if concurrent loads
stall commands.

## Built: the self-hosted pool (`images/isolate-host`)

The pool is on by default. `ISOLATE_POOL_SIZE` sets the number of idle isolates (default 4, at most 64), and `0`
restores one Dynamic Worker loaded per session, as in M0. Any other value turns the pool off and logs a warning.
The HTTP interface (`/list`, `/exec`, `/healthz`) is unchanged. It adds a `pool` object to `/healthz` and an
`x-harbour-isolate` response header.

- **One isolate per session.** A slot (`pool:<n>`) is loaded with no `WS` binding and no session. A session's
  first call takes one, and it is never handed out again. After 30 minutes idle the session loses its slot, its
  next call gets a fresh one, and the old slot's egress is refused. Egress checks this itself, and health checks
  clear idle sessions, so it doesn't wait for another session's call. Calls carry no state between them, so this is
  safe.
- **Workspace per call.** Each call passes a `WorkspaceScope` (an `RpcTarget`) for the request's workspace, and
  it is revoked when the call ends. `Workspace` and the scope both accept only 64-hex-digit SHA-256 blob names, so
  the `../` gap noted above is closed in both modes.
- **Egress.** `PooledEgress` has only the slot in its props. It looks up the session in the slot-to-session map,
  which is written once at hand-out, and refuses anything sent before then with a 403. The headers the vault sees
  are unchanged.
- **Refill in quiet spells.** A refill loads one isolate at a time, and only once no `/list` or `/exec` has been
  in flight for 25 ms. The first `/healthz` after start fills the pool.

Measured as M0 measured, on 48 threads with load1 between 7 and 10 ([the pool as
built](../measurements/m1-be1-isolate/README.md#the-pool-as-built-harnesspoolts-27-october-2026)):

| | ready p50 / p95 | first command p50 |
|---|---|---|
| Pool, each new session arriving with the pool full | **6.2–6.4 / 7.4 ms** | 70–71 ms |
| Off (`ISOLATE_POOL_SIZE=0`) | 118.4–120.9 / 129.8–137.4 ms | 182–184 ms |
| Pool, back-to-back burst | 118–121 / 135–138 ms (2 of 50 hits) | 183–185 ms |

Self-hosted meets the target when a new session finds an isolate ready. Two things must hold for that. New
sessions must arrive slower than one process can load isolates, about eight a second. And the process must have
quiet spells, 25 ms with no call in flight from any session, often enough to refill. A burst larger than the pool,
or sessions running commands back to back, pays today's cost and no more. gVisor, the cost of concurrent bursts and the
memory held by idle isolates are still unmeasured.

## What #17 needs to do on Cloudflare

Nothing was deployed here.

1. **Deploy a measurement Worker** that runs M0-CF1's loop (50 new sessions, workspace listed), with phase
   timings and load recorded. Without it, every Cloudflare number here is an estimate.
2. **Keep the manifest hot.** Keep the workspace head and manifest in Durable Object storage, and pass them to
   the isolate with the call, so only blobs come from R2. This saves about 300 ms p50.
3. **Pre-create SessionDOs.** Keep a pool of named objects that have already opened Pi Durable and created a
   conversation, and hand one out as a new session's ID.
   - This saves about 470 ms p50 (1.8 s p95) of first contact.
   - Fill the pool steadily: M0 hit `SQLITE_NOMEM`.
   - Measure the cost of waking a hibernated object.
4. **Pre-load the isolate inside each pre-created SessionDO,** with the self-hosted slot model: a slot ID in
   props, the scope passed per call, and the slot-to-session map kept as the object's state.

Even with 2 and 3, the estimate is about 400 ms p50 (`Harness.open` plus an isolate load), which **misses the
≤100 ms target**. Step 4 is the only part of this design that could close the gap, and only if Worker Loader
keeps the isolate loaded where the object runs, which nobody has measured.

The options for closing the gap, which are the plan owner's to choose:

- **(a)** Measure step 4. If it holds, the hand-out is one call into a loaded isolate.
- **(b)** Trim the just-bash bundle. It is about 90% of a load, so trimming cuts every miss.
- **(c)** Redefine "ready". The SessionDO would return the listing from the manifest while the isolate loads in
  parallel, and the first command would pay the load. That meets the target on both targets with today's
  isolation, but ready would no longer mean the isolate is loaded. It is not built here.
- **(d)** Accept a Cloudflare figure above 100 ms p50.

**Cloudflare: hot manifest, then pre-created SessionDOs that each hold a pre-loaded isolate, measured in that
order.** Removing R2 (about 300 ms) and creation (about 470 ms p50, 1.8 s p95) leaves roughly
`Harness.open` plus the isolate load: about 400 ms p50. Opening the harness and loading the isolate ahead of
time could bring the hand-out to one call into a loaded isolate; whether it does depends on hibernation and
Worker Loader's cache. Until a measurement Worker is deployed, the 100 ms p50 on Cloudflare is not shown to be
reachable; the alternative is deciding that "ready" may exclude the isolate load.

## Measured: option (a) (28 October 2026)

Option (a) was chosen on 28 October 2026. The spike [`spikes/ready-preload`](../../spikes/ready-preload/README.md)
built steps 2–4 in a temporary Worker (`harbour-ready-spike`, deleted afterwards) and measured them next to today's
cold path. The raw files and phase tables are in
[m1-cf1-ready-preload](../measurements/m1-cf1-ready-preload/README.md).

**Answer: ≤100 ms p50 is reachable this way, but only when the hand-out finds the object's isolate still loaded, and
Worker Loader does not promise that.** A hit is 79–98 ms p50. A miss, where the isolate has to be loaded again at
hand-out, is 180–320 ms p50. Over a pool, p50 depends on how long objects wait before they are handed out.

### Method

- **Pre-loaded path.** A pool object is a SessionDO warmed before anyone owns it. Warming opens Pi Durable's Harness,
  creates a conversation and loads the object's own Dynamic Worker under `slot:<name>`. That isolate has no
  workspace binding, and its egress props name only the slot. Warming then runs one `ls` on an empty tree, so
  just-bash is compiled and has run once.
- **Hand-out.** A new session claims an object from a pool directory (a Durable Object). The object writes its
  slot-to-session map once and takes the manifest from a WorkspaceDO (step 2). It then lists the workspace in the
  slot's isolate, passing a `WorkspaceScope` with the call, as in the self-hosted pool. If the object has hibernated,
  its Harness reopens in parallel with the listing.
- **Cold path.** M0-CF1's bench, rebuilt in the same Worker: a new SessionDO, setup (two R2 head reads,
  `Harness.open`, a conversation), then the head and manifest from R2 and a Dynamic Worker never loaded before.
- **Isolate code.** The same in both arms: the self-hosted sandbox (`images/isolate-host/src/sandbox.ts`, 1.25 MiB
  with just-bash).
- **Ready.** M0-CF1's definition: the workspace (61 files) is listed by `ls -1R` in the session's isolate. It is
  timed in the routing Worker, claim included.
- **Runs.** 270 sessions in seven batches, sequential and paced, with no failures. The bench ran from Sal's host in
  Germany, and the Worker ran in FRA. Cloudflare placed about 40% of the objects in FRA and the rest in AMS, and the
  WorkspaceDO in AMS.

### Numbers

| Path | n | Ready p50 / p95 | Isolate loaded at hand-out |
|---|---|---|---|
| Cold, today's path | 50 | **1,046 / 1,404 ms** | — |
| Pre-loaded, handed out 1 s after warming | 50 | **79 / 170 ms** | 50 of 50 |
| The same, manifest from R2 instead of the WorkspaceDO | 20 | 272 / 421 ms | 20 of 20 |
| After 60 s idle (object hibernated) | 50 | 225 / 417 ms (hits 86, misses 265 p50) | 23 of 50 |
| After 15 min idle, no keep-alive | 40 | 321 / 569 ms | 0 of 40 |
| After 15 min, alarm every 20 s pinging the isolate | 30 | 106 / 328 ms (hits 98, misses 257 p50) | 20 of 30 |
| After 15 min, `setTimeout` every 20 s (object pinned in memory) | 30 | 168 / 510 ms (hits 89, misses 182 p50) | 14 of 30 |

What the numbers show:

- **A hot hand-out meets the target with room for the network.** At 79 ms p50 it is two round trips from the Worker
  to objects that may sit in another colo. The claim is 24 ms (bare round trip 8), and it includes a durable SQLite
  write. The hand-out call is 53 ms (bare round trip 11). It includes a WorkspaceDO read (19 ms); the remaining
  23 ms or so is the slot-to-session write and the two calls into the warm isolate.
- **The hot manifest is required.** Reading the head and manifest from R2 adds about 190 ms p50 (272 against 79).
- **Hibernation costs little; losing the isolate costs a lot.** After 60 s every object had hibernated, so it woke
  and reopened its Harness. When the isolate survived, ready was still 86 ms p50, 7 ms above a hot hand-out. When it
  did not, ready was 265 ms p50. The extra 180 ms is the load itself (about 70 ms p50 and 120 ms p95, measured in the
  object, against the 310 ms this doc estimated) plus just-bash's first run in a new isolate. That run is CPU only, so
  Workers clocks can't time it on its own.
- **Worker Loader drops idle isolates, and a ping only partly helps.** Without pings, none of the isolates survived
  15 minutes. An alarm every 20 s kept 20 of 30 loaded. Pinning the object in memory with a timer did worse: some
  objects' loader callbacks ran on 44 of their 45 pings. Keeping the Durable Object alive does not keep its Dynamic
  Worker loaded. The docs say as much: "Two requests are never guaranteed to reach the same isolate."
- **The cold path is 1,046 ms p50** (first contact 415, setup 258, list 325), in line with M0-CF1's 1,208.

### Memory and cost of keeping isolates loaded

- **Memory.** It cannot be measured from inside Workers. Each pooled isolate is its own Dynamic Worker holding the
  compiled 1.25 MiB bundle, and Dynamic Workers are not billed for memory or wall time. The cost of idle isolates
  shows up as eviction: the runtime reclaims them, which is what the hit rates above measure.
- **Durable Object duration.** An idle object that can hibernate is not billed for duration. One held in memory, as
  the timer keep-alive does, is billed for 128 MB the whole time: about 324,000 GB-s, or $4 a month per object at
  $12.50 per million GB-s. It also gave the worse hit rate, so don't use it.
- **Alarm keep-alive.** One alarm and one isolate call every 20 s is 129,600 Durable Object requests and 129,600
  Dynamic Worker requests a month per object, about $0.06. Add a little duration per wake and $0.002 a day per
  unique Dynamic Worker. That is roughly $0.15 a month per pooled object, so a pool of 20 costs about $3 a month.
- **Warming.** About 0.5–0.6 s per object, off the critical path. Each warmed object that is never handed out still
  counts as one unique Dynamic Worker that day. Pool objects must be created steadily (M0's `SQLITE_NOMEM`); one a
  second gave no errors here.

### Recommendation

**Adopt (a) and combine it with (b).** Step 2, the hot manifest, is part of (a), not optional.

- **Build steps 2–4 as measured.** Pre-created SessionDOs, each with its own isolate under a stable slot ID, and the
  manifest in Durable Object storage.
- **Keep the pool directory in HarbourStack.** It is already the session directory, so the claim becomes a local
  SQLite write instead of a 24 ms round trip.
- **Hand out the newest object first,** so objects are as young as possible when claimed.
- **Keep each object's isolate warm with an alarm,** not a timer.
- **Size the pool to the arrival rate,** so objects are claimed within minutes.
- **Trim just-bash (b).** The miss is where p50 and p95 are lost. A miss is about 170 ms more than a hit, and nearly
  all of that is loading and first running the bundle, so a smaller bundle cuts every miss.

Expect about 80–110 ms p50 and about 300 ms p95: at the target, not under it with margin. That depends on Worker
Loader keeping isolates, which Cloudflare does not promise.

Measure the hit rate in production (the hand-out can log whether its isolate was loaded). If p50 stays above 100 ms
after (b), the remaining levers are (c), listing from the manifest while the isolate loads, or (d), accepting the
Cloudflare figure. Those choices are for the plan's owner.
