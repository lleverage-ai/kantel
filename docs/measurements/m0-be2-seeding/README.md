# M0-BE2: seeding and git measurements

Stream M0-BE2 of the Harbour plan v2 (issue #5): how fast a sandbox can be seeded with a small repo, a
medium repo and a large monorepo, plus their dependencies, on a self-hosted Docker node and on Cloudflare,
and whether isomorphic-git can serve status, diff and log on the isolate tier.

- [results.md](results.md): p50/p95 per method, repo and target, against the plan's targets, and the recommendation.
- SeedSpec: the shape these measurements proposed was adopted as is into
  [packages/contracts/src/workspace.ts](../../../packages/contracts/src/workspace.ts) (`SeedMethod`, `SeedReport`,
  `prepare`, `staleWithin`, `indexState`), with the reasoning in its comments. The proposal file was removed then;
  it is in git history at `docs/measurements/m0-be2-seeding/seed-spec.proposal.ts`.
- `raw/*.jsonl`: every run, one JSON line each. `harness/summarise.mjs` turns them into the tables.
- `harness/`: everything needed to rerun it.

## Fixtures

| Name | Repo | Commit | Tracked files | Bare mirror | Checkout + node_modules | node_modules archive (zstd) | Sparse cone |
|---|---|---|---:|---:|---:|---:|---|
| small | `tvdavies/sal` | `0cf75d83` | 1,118 | 19 MB | 238 MB | 31 MB | `src` |
| medium | `vitejs/vite` | `64e24670` | 2,915 | 79 MB | 782 MB | 167 MB | `packages/vite` |
| large | `n8n-io/n8n` | `7ac6ff19` | 32,357 | 722 MB | 3.4 GB | 569 MB | `packages/cli packages/core packages/workflow` |

`tvdavies/sal` is the plan's named small repo (Tom's own). It never went to a public place: no unauthenticated
GitHub rows use it, and the isolate Worker serves only vite and n8n.

## Methods

Every run is one fresh container (self-hosted: `docker run --rm`; Cloudflare: a new Durable Object and
container instance per run), so nothing is warm inside the sandbox. The node-local cache is warm, as it
would be on a node that has seeded the repo before. `harness/images/bin/seed-op` does the work and times
each phase in the same way on both targets.

| Method | What it does | Ready means |
|---|---|---|
| `container-start` | `seed-op noop`: the floor | container answers |
| `cache-start` (CF) | start from the snapshot that holds the node-local cache (mirrors, archives, SquashFS) | container answers |
| `worktree` | `git worktree add --detach` off a warm bare mirror | first `git status` done |
| `ref-full` | `git clone --reference <mirror>` and a full checkout | first `git status` done |
| `ref-sparse` | `git clone --filter=blob:none --sparse --reference <mirror>`, cone checkout | first `git status` done |
| `overlay` (self-hosted) | prepared checkout with `node_modules` as a read-only overlayfs lower, tmpfs upper | first `git status` done, deps present |
| `fuse-overlay` (self-hosted) | the same through fuse-overlayfs | as above |
| `squashfs` | SquashFS image of the prepared checkout via squashfuse + fuse-overlayfs (the Sandbox SDK's restore shape) | as above |
| `deps-archive` | extract a `node_modules` tar.zst keyed by lockfile hash | extracted |
| `snapshot-image` (self-hosted) | prepared checkout baked into an image layer: the self-hosted analogue of a container snapshot | first `git status` done, deps present |
| `snapshot-restore` (CF) | start from a container snapshot of the prepared checkout | as above |
| `dirbackup-full` (CF) | Sandbox SDK `DirectoryBackup` restore of the prepared checkout (source + `node_modules`) from R2 | as above |
| `dirbackup-src` (CF) | the same, source and `.git` only (`node_modules/` excluded) | first `git status` done |
| `github-sparse` (self-hosted) | baseline: blobless sparse clone straight from GitHub, public repos only | first `git status` done |
| `isogit-lazy` (Worker) | isomorphic-git `log` (50), `statusMatrix` over the cone, edit 3 files, status again, diff, over a lazily fetched tree | all done |

Git config: `core.checkStat=minimal` and `core.trustctime=false` for every restored tree (`stat=minimal` in
the raw lines). Without them a tree restored from bytes has new inode and ctime values, and git rehashes every
file on the first status (see the `stat=default` rows). Prepared trees have their index settled (status run
once, more than a second after checkout) before they are captured.

## Targets

- **Self-hosted**: plain Docker 29.8 (runc, overlayfs storage) on Sal's host: 48 threads, 125 GB RAM, NVMe
  RAID, Linux 7.2. Not M0-SH1's Compose stack: it had not landed when these ran; the methods only need
  `docker run`, so the rows carry over. The host was shared with other work (load average 6–10), which shows
  in the p95s.
- **Cloudflare Containers**: `standard-4` instances behind a Durable Object
  (`harness/cloudflare/src/index.ts`), driven 6 at a time from Sal's host. Times are measured in the Durable
  Object: `start_ready_ms` from `start()` to the container answering, `op_wall_ms` for the seeding exec (plus
  the restore for DirectoryBackup rows). Container snapshots and DirectoryBackup use the Sandbox SDK's APIs.
- **Cloudflare Worker isolate**: `harness/isolate/worker.js`, isomorphic-git 1.44.5 over `LazyFs`
  (`harness/isolate/lazyfs.js`), which lists a manifest once and fetches each file body on first read. The
  bodies are the Worker's static assets, one object per file, standing in for an object-store-backed
  workspace. In a Worker `performance.now()` only advances across I/O, so CPU-bound phases read low; use
  `client_ms` (request wall time) and the Node runs (`raw/node-isolate-proxy.jsonl`, `--max-old-space-size=128`)
  for CPU time and memory.

## Not measured, and why

- **A fat image with the cache baked in.** The Cloudflare registry timed out committing layers of 600 MB and
  more (`net/http: timeout awaiting response headers`, three attempts). The public repos' cache was built inside
  a container with Internet access (`harness/images/bin/seed-prepare`) and saved as a container snapshot instead.
- **A `node_modules` archive streamed from R2 or MinIO.** The agent that ran this may not upload local files to
  object storage from the CLI, so the archives were not uploaded; the DirectoryBackup rows cover restore from R2.
- **M0-SH1's Compose stack and gVisor.** Plain Docker with runc only.
- **Cloudflare Container instance types other than `standard-4`**, and regions: placement was Cloudflare's choice.

## Running it

```sh
# Self-hosted: build the image and the node-local cache, then 50 runs per row
docker build -t harbour-m0-seed-bench:local -f harness/images/bench.Dockerfile harness/images
CACHE=/path/to/cache harness/selfhosted/prepare.sh
CACHE=/path/to/cache OUT=raw/selfhosted-docker-runc.jsonl STAT=minimal N=50 harness/selfhosted/run.sh

# Cloudflare containers: render wrangler.jsonc from the template, deploy, prepare snapshots, drive
cd harness/cloudflare && npx wrangler deploy && npx wrangler secret put BENCH_TOKEN
# /prepare runs a script in a fresh container, then snapshots it and/or backs up a directory, and returns
# the snapshot id and backup record. Payloads are in payloads/:
#   prepare-cache.json  slim image + Internet: mirrors, deps archives and SquashFS images for vite and n8n
#   prepare-ready.json  from the cache snapshot: unpack <repo>'s prepared tree, snapshot it and back it up
#   prepare-src.json    the same tree, backed up without node_modules/
curl -N -X POST -H "Authorization: Bearer $T" "$URL/prepare?box=prep-cache" -d @payloads/prepare-cache.json
# Fill the returned ids into a plan like payloads/plan.used.json (the plan these results came from; its
# snapshots and backups are deleted). Dependency archive names come from prepare-cache's output.
BENCH_URL=$URL BENCH_TOKEN_FILE=token node drive.mjs plan.json ../../raw/cloudflare-container-standard-4.jsonl

# Isolate tier
node harness/isolate/pack.mjs <sparse blobless checkout> <out>
cd harness/isolate && npx wrangler deploy && BENCH_URL=... BENCH_TOKEN_FILE=... node drive.mjs ../../raw/cloudflare-worker-isolate.jsonl 50 2

node harness/summarise.mjs raw/*.jsonl
```

## Failed runs

Cloudflare and isolate failures are in `raw/` as `ok:false` lines and left out of the tables. Self-hosted
failures are recorded the same way from this commit on. Before that they were only logged: 60 n8n
`snapshot-image` attempts failed because the image had been built through a context that honoured n8n's
`.dockerignore`. They were dropped, the image was rebuilt by copy and commit, and the rows were rerun.

## Cloudflare resources

All named `harbour-m0-seed-*`, all deleted after the runs (listed in the PR): Workers
`harbour-m0-seed-bench` and `harbour-m0-seed-isogit`, the `SeedBox` container application and its images,
R2 bucket `harbour-m0-seed-r2` (DirectoryBackup objects), and the container snapshots
`harbour-m0-seed-cache` and `harbour-m0-seed-ready-{sal,vite,n8n}`.
