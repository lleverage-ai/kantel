# #17 option (a): a pre-loaded isolate per SessionDO

Issue [#17](https://github.com/tvdavies/harbour/issues/17), M1-CF1. The readiness doc
([isolate-readiness.md](../../docs/design/isolate-readiness.md)) estimated Cloudflare's "ready" at about 400 ms p50 even
with a hot manifest and pre-created SessionDOs, against a 100 ms target, and left option (a) to measure: a pool of
SessionDOs, each holding its own pre-loaded isolate. This spike measures it, next to today's cold path, on real
Cloudflare. The numbers and the recommendation are in the doc's "Measured: option (a)" section; the raw files are in
[docs/measurements/m1-cf1-ready-preload](../../docs/measurements/m1-cf1-ready-preload/README.md).

It is a separate, temporary Worker, `harbour-ready-spike`, with its own R2 bucket of the same name. It shares nothing
with the production `harbour` Worker (no routes, bindings or storage) and was deleted after the run.

## Shape

```
bench (Sal's host) ── Worker harbour-ready-spike ─┬─ /bench/cold:    new SessionDO ─ ping, setup (R2 head ×2, Harness.open,
                                                  │                  conversation), list (R2 head + manifest, new isolate)
                                                  ├─ /bench/warm:    SessionDO(slot).warm ─ Harness.open, conversation,
                                                  │                  LOADER.get("slot:<slot>"), list + ls on an empty tree
                                                  │                  ─ PoolDO(batch).add(slot)
                                                  └─ /bench/handout: PoolDO(batch).claim ─ SessionDO(slot).handout:
                                                                     write slot→session once, manifest from WorkspaceDO,
                                                                     list + `ls -1R /workspace | wc -l` in the slot's
                                                                     isolate with a WorkspaceScope for the workspace
```

| File | What it does |
| --- | --- |
| `src/session.ts` | `SessionDO`: the cold path (M0-CF1's setup and list) and the pool path (warm, keep-alive by timer or alarm, hand-out) |
| `src/isolate.ts` | The Dynamic Worker: M1-BE1's self-hosted sandbox (`images/isolate-host/src/sandbox.ts`, just-bash) unchanged, plus a boot ID and call count so a reused isolate can be told from a reload |
| `src/workspace.ts` | One 61-file workspace version in R2 (head, manifest, blobs, as M0-CF1 lays it out), `WorkspaceDO` holding the head's manifest hot, the `Blobs` binding (today's isolate), `WorkspaceScope` (the pool's per-call scope) and an `Egress` that refuses everything |
| `src/pool.ts` | `PoolDO`: the free list a new session claims a warmed object from |
| `scripts/bench.ts` | Drives the batches and writes one JSON file per batch |

What it leaves out on purpose: egress (the isolate's `globalOutbound` refuses everything; its props carry the session or
only the slot, as the design has them), writes and commits, and a model. "Ready" is M0-CF1's: the session is set up and
the workspace listed by `ls -1R` in the session's isolate, timed in the routing Worker.

## Run it

```sh
cd spikes/ready-preload
npx wrangler r2 bucket create harbour-ready-spike
pnpm run deploy                                  # builds dist/isolate.bundle.txt (1.25 MiB) and deploys
printf %s "$TOKEN" | npx wrangler secret put READY_SPIKE_TOKEN
B=https://harbour-ready-spike.<subdomain>.workers.dev
curl -X POST -H "authorization: Bearer $TOKEN" $B/seed -d '{"workspaceId":"ws-bench","files":61}'
export READY_SPIKE_TOKEN=$TOKEN
bun scripts/bench.ts --base-url $B --mode cold --runs 50 --batch cold
bun scripts/bench.ts --base-url $B --mode hot --runs 50 --batch hot
bun scripts/bench.ts --base-url $B --mode hot --runs 20 --batch hot-r2 --manifest-from r2
bun scripts/bench.ts --base-url $B --mode idle --runs 50 --idle-ms 60000 --batch idle-60s
bun scripts/bench.ts --base-url $B --mode idle --runs 40 --idle-ms 900000 --batch idle-15m
bun scripts/bench.ts --base-url $B --mode idle --runs 30 --idle-ms 900000 --keep-alive timer --batch idle-15m-timer
bun scripts/bench.ts --base-url $B --mode idle --runs 30 --idle-ms 900000 --keep-alive alarm --batch idle-15m-alarm
```

## Remove it

```sh
curl -X POST -H "authorization: Bearer $TOKEN" $B/cleanup     # empties the bucket
npx wrangler delete harbour-ready-spike                       # the Worker, its Durable Objects and its secret
npx wrangler r2 bucket delete harbour-ready-spike
```
