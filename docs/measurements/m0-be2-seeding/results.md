# M0-BE2 results

50 fresh sandboxes per row unless `n` says otherwise (`github-sparse` and the `stat=default` comparison rows
are 10; a few Cloudflare rows lost 1–4 runs to "Network connection lost" between the Worker and the Durable
Object, and those runs are left out). Percentiles are nearest-rank. Method details and caveats are in
[README.md](README.md); every run is in `raw/`.

## Against the plan's targets

The plan's Table 6 targets are proposals; these are the first measurements against them.
"Start+ready" is container start plus seeding. ✓ meets p50 and p95, ◐ meets p50 only, ✗ misses p50,
"baseline" means only part of the step was measured, so it shows the floor rather than settling the target.

| Target (p50 / p95) | Self-hosted Docker | Cloudflare | Verdict |
|---|---|---|---|
| Isolate session ready, workspace listed (100 ms / 300 ms) | – | manifest fetched and parsed in the Worker: vite 13 / 62 ms, n8n 15 / 35 ms (isolate start and session routing not included) | baseline: the listing fits; the session step was not measured |
| Container on the same workspace version, warm image (3 s / 8 s) | empty container: 0.42–0.54 / 0.55–0.92 s | empty container, slim image: 0.26–0.36 / 0.58–0.88 s; from the 4.8 GB cache snapshot: 1.1–1.8 / 4.4–9.0 s | baseline: the start fits, except n8n's cache-snapshot p95 (9.0 s); reattaching a workspace was not measured |
| Small repo worktree off a warm mirror, `tvdavies/sal` (1 s / 3 s) | `docker run` to exit 1.04 / 1.32 s, including container removal; worktree in-container 0.42 / 0.45 s | worktree 2.67 / 6.02 s; ref-sparse 2.09 / 9.52 s; dirbackup-src 1.93 / 3.35 s | self-hosted ✗ as measured, missing p50 by 40 ms; the time includes teardown, and the worktree alone takes 0.42 s; Cloudflare ✗ |
| Large monorepo checkout ready, snapshot or overlay, n8n (10 s / 25 s) | overlay 1.29 / 1.95 s; image layer 1.14 / 2.21 s (both include `node_modules`) | snapshot 3.64 / 112.7 s; ref-sparse (cone only) 4.20 / 9.55 s; dirbackup-src 7.16 / 17.0 s | self-hosted ✓; Cloudflare snapshot ◐, sparse clone ✓ |
| Dependencies ready from a cached layer, n8n `node_modules` 2.5 GB (15 s / 40 s) | archive 32.7 / 35.7 s (extract only); overlay lower: included in the 1.29 s above | archive 46.3 / 137 s; DirectoryBackup 45.5 / 126 s; snapshot (includes deps) 3.64 / 112.7 s | self-hosted ✓ only as an overlay; Cloudflare ✗ except snapshot p50 |

## What decides it

1. **Prepared trees beat seeding.** A checkout that already has its index settled and `node_modules` in place
   is ready in 0.3 s for n8n self-hosted, whether it is a kernel overlayfs lower or an image layer. Every method
   that writes files at start (worktree, clone, archive, DirectoryBackup) scales with file count: 4–8 s for
   n8n's 32k tracked files, 33–45 s for its `node_modules`.
2. **Cloudflare container snapshots are fast where cached and very slow where not.** Snapshot restore start
   was 0.75–2.2 s p50 on a warm node, but 18 of 148 runs (12%) took 44–136 s, which reads as the snapshot being
   pulled to a node that had not seen it (`raw/cloudflare-container-standard-4.jsonl`, `start_ready_ms`).
   The 4.8 GB cache snapshot, started 1,193 times across the run, did so once. So p95 is set by placement, not
   by size, and the plan's p95 targets are out of reach for rarely used snapshots. Snapshots are in public beta.
3. **SquashFS through FUSE is the wrong restore shape at scale.** squashfuse + fuse-overlayfs made the first
   `git status` take 25.8 s (self-hosted) and 31.1 s (Cloudflare) for n8n; the same tree as a kernel overlay
   took 0.3 s, and fuse-overlayfs alone 2.4 s. Medium repos are 1.8–1.9 s, small 0.6–1.0 s.
4. **Git must trust the restored index.** With git's default stat checks, a tree restored from bytes is
   rehashed on first status: n8n image layer 1.91 s vs 0.30 s with `core.checkStat=minimal` and
   `core.trustctime=false`; squashfs 40.9 s vs 25.8 s. Kernel overlay keeps inodes and is unaffected.
5. **A sparse, blobless clone off a mirror is the general fallback.** n8n's three-package cone was ready in
   1.53 s self-hosted (in-container) and 2.89 s on Cloudflare, vs 13.6 s from GitHub with no mirror.
6. **`node_modules` restore is the long pole everywhere except prepared trees.** Extracting n8n's 569 MB
   archive took 32.7 s self-hosted and 44.8 s on Cloudflare; DirectoryBackup was no better (43.8 s).
   Source-only DirectoryBackup was 5.4 s, so readiness should be staged: source first, dependencies after.

## Isolate tier: isomorphic-git over a lazy workspace

isomorphic-git 1.44.5, `log` (depth 50), `statusMatrix` over the cone, edit three files, status again, diff.
The tree is a shallow (50), blobless, sparse checkout; file bodies are fetched on first read.

| Run | Repo (cone rows) | n | Request p50 / p95 | Status p50 / p95 | Bytes read | Peak memory |
|---|---|---:|---:|---:|---:|---:|
| Worker (deployed) | vite (597) | 44 | 0.90 / 1.35 s | 67 / 202 ms† | 1.9 MB | not exposed; no limit errors |
| Worker (deployed) | n8n (5,461) | 50 | 4.00 / 7.41 s | 0.90 / 3.18 s† | 19.6 MB | not exposed; no limit errors |
| Node, `--max-old-space-size=128` | sal (363) | 20 | – | 99 / 109 ms | 2.2 MB | 25 / 30 MB |
| Node | vite (597) | 20 | – | 163 / 175 ms | 1.9 MB | 34 / 35 MB |
| Node | n8n (5,461) | 20 | – | 746 / 841 ms | 19.6 MB | 103 / 138 MB |

Node peak memory is V8 `heapUsed + external` (external includes ArrayBuffers), sampled every 5 ms. It is a
proxy for the isolate's accounting, not the same thing.

† In a deployed Worker `performance.now()` only advances across I/O, so phase times undercount CPU work;
request wall time is the honest number. Worker CPU time per request (`wrangler tail`, the 78 requests it
caught) was 0.45 / 0.86 s p50 / p95 for vite and 2.76 / 3.72 s for n8n.

- It works for small and medium cones well inside the targets. For n8n's cone it is CPU-bound (2.8 s CPU per
  request) and its live memory sits near the 128 MB isolate cap, which is per isolate, shared by concurrent
  requests. It is a read path, not a seeding method for large repos.
- isomorphic-git reads only index version 2; git writes version 3 for sparse checkouts. `harness/isolate/pack.mjs`
  writes a v2 index for the whole tree. The index's stat data must match the lazy tree's. In one exploratory run
  per target with every mtime skewed by 5 s (`STAT_SKEW_MS=5000 node harness/isolate/node-run.mjs ...`, and
  `skew=5000` on the Worker), status read every file in the cone: 5,468 reads, 57 MB and 2.3 s in Node. The
  deployed Worker had not answered after 10 minutes. These two runs are not in `raw/`.
- 6 of 50 vite requests at concurrency 2 were cancelled as hung. isomorphic-git keeps one module-level lock keyed
  by file path, and both requests used `/.git/index`, so one request awaited a promise owned by another. One
  workspace per isolate (per Durable Object) avoids it.
- `tvdavies/sal` was not deployed to the Worker, so its row is Node only.

## Recommendation

- **Self-hosted**: keep a node-local cache of bare mirrors and prepared trees keyed by
  (commit, lockfile hash, image). Seed with the prepared tree as a kernel overlayfs lower (or an image layer
  where the runtime cannot mount overlays). On a cache miss, seed with `clone --filter=blob:none --sparse
  --reference <mirror>` and report `files` ready, restore or install dependencies, then build the prepared tree
  in the background. Do not use squashfuse or fuse-overlayfs for large trees; do not tar `node_modules`.
- **Cloudflare**: use two layers of snapshot. Keep one shared cache snapshot per image, holding the bare
  mirrors, dependency archives and prepared trees for every repo. It is started for every seed, so it stays
  warm: here 1 of 1,193 starts from it was slow. Use it to run a sparse `--reference` clone (n8n's source cone
  in 4.20 / 9.55 s, start included), and report `files` ready. On top of that, keep a per-repo snapshot of the
  prepared tree keyed by (commit, lockfile, image). It wins when warm (3.64 s p50 for n8n with dependencies)
  but never block a session on it, because it is cold about 12% of the time. Without any snapshot, the only
  measured route is a clone from GitHub (13.6 s for n8n's cone self-hosted; not measured on Cloudflare). Use
  DirectoryBackup of source for session handoff, not for cold seeding of large dependency trees. Measure
  snapshot placement again once the beta ends, because it decides the p95.
- **Isolate tier**: isomorphic-git over the lazy workspace for log, status and diff on small and medium cones,
  with the workspace carrying a v2 index whose stat data matches the manifest; hand large cones to a container.
- **Everywhere**: set `core.checkStat=minimal` and `core.trustctime=false` in seeded repos; settle the index
  before capturing a tree; report `files` and `dependencies` readiness separately.

The SeedSpec changes that follow are in [seed-spec.proposal.ts](seed-spec.proposal.ts), for M0-BE1 (#2) and Tom.

## All rows

`node harness/summarise.mjs raw/selfhosted-docker-runc.jsonl raw/cloudflare-container-standard-4.jsonl`
(the isolate rows are in the table above).

| Target | Repo | Method | n | Ready p50 | Ready p95 | Start+ready p50 | Start+ready p95 | Phases (p50) |
|---|---|---|---:|---:|---:|---:|---:|---|
| cloudflare-container-standard-4 | sal | cache-start | 50 | 35 ms | 50 ms | 1.82 s | 4.42 s | start 1.78 s |
| cloudflare-container-standard-4 | sal | container-start | 50 | 32 ms | 83 ms | 314 ms | 881 ms | start 286 ms |
| cloudflare-container-standard-4 | sal | deps-archive | 50 | 3.17 s | 7.53 s | 5.09 s | 9.45 s | start 1.59 s, extract 3.14 s |
| cloudflare-container-standard-4 | sal | dirbackup-full | 50 | 3.09 s | 4.44 s | 4.46 s | 6.01 s | start 1.28 s, restore 2.91 s, status 50 ms |
| cloudflare-container-standard-4 | sal | dirbackup-src | 50 | 763 ms | 1.26 s | 1.93 s | 3.35 s | start 1.25 s, restore 652 ms, status 57 ms |
| cloudflare-container-standard-4 | sal | ref-full | 50 | 650 ms | 857 ms | 2.50 s | 6.40 s | start 1.83 s, clone 177 ms, checkout 301 ms, status 137 ms |
| cloudflare-container-standard-4 | sal | ref-sparse | 50 | 398 ms | 556 ms | 2.09 s | 9.52 s | start 1.70 s, clone 210 ms, sparse 4 ms, checkout 93 ms, status 45 ms |
| cloudflare-container-standard-4 | sal | snapshot-restore | 49 | 134 ms | 188 ms | 1.77 s | 85.8 s | start 1.63 s, status 102 ms |
| cloudflare-container-standard-4 | sal | squashfs | 50 | 1.02 s | 1.77 s | 3.31 s | 6.90 s | start 1.93 s, squashmount 90 ms, mount 25 ms, status 842 ms |
| cloudflare-container-standard-4 | sal | worktree | 50 | 650 ms | 813 ms | 2.67 s | 6.02 s | start 2.08 s, checkout 462 ms, status 139 ms |
| cloudflare-container-standard-4 | vite | cache-start | 50 | 35 ms | 76 ms | 1.50 s | 5.24 s | start 1.42 s |
| cloudflare-container-standard-4 | vite | container-start | 50 | 38 ms | 66 ms | 402 ms | 813 ms | start 356 ms |
| cloudflare-container-standard-4 | vite | deps-archive | 50 | 6.90 s | 17.1 s | 8.45 s | 18.0 s | start 1.11 s, extract 6.87 s |
| cloudflare-container-standard-4 | vite | dirbackup-full | 50 | 8.69 s | 19.3 s | 10.1 s | 22.0 s | start 1.15 s, restore 8.57 s, status 90 ms |
| cloudflare-container-standard-4 | vite | dirbackup-src | 50 | 1.00 s | 1.88 s | 2.23 s | 3.92 s | start 1.01 s, restore 844 ms, status 102 ms |
| cloudflare-container-standard-4 | vite | ref-full | 50 | 975 ms | 1.59 s | 2.32 s | 5.88 s | start 1.44 s, clone 255 ms, checkout 502 ms, status 210 ms |
| cloudflare-container-standard-4 | vite | ref-sparse | 50 | 470 ms | 796 ms | 1.89 s | 3.65 s | start 1.42 s, clone 231 ms, sparse 4 ms, checkout 115 ms, status 74 ms |
| cloudflare-container-standard-4 | vite | snapshot-restore | 50 | 261 ms | 368 ms | 1.40 s | 97.1 s | start 1.02 s, status 218 ms |
| cloudflare-container-standard-4 | vite | squashfs | 49 | 1.94 s | 3.36 s | 3.61 s | 5.27 s | start 1.30 s, squashmount 80 ms, mount 18 ms, status 1.80 s |
| cloudflare-container-standard-4 | vite | worktree | 50 | 835 ms | 1.25 s | 1.97 s | 4.75 s | start 1.02 s, checkout 607 ms, status 205 ms |
| cloudflare-container-standard-4 | n8n | cache-start | 50 | 39 ms | 96 ms | 1.07 s | 8.98 s | start 1.03 s |
| cloudflare-container-standard-4 | n8n | container-start | 50 | 35 ms | 104 ms | 304 ms | 577 ms | start 262 ms |
| cloudflare-container-standard-4 | n8n | deps-archive | 46 | 44.8 s | 136.3 s | 46.3 s | 137.3 s | start 1.22 s, extract 44.8 s |
| cloudflare-container-standard-4 | n8n | dirbackup-full | 50 | 44.2 s | 123.2 s | 45.5 s | 125.9 s | start 1.23 s, restore 43.8 s, status 430 ms |
| cloudflare-container-standard-4 | n8n | dirbackup-src | 50 | 5.79 s | 14.4 s | 7.16 s | 17.0 s | start 1.32 s, restore 5.40 s, status 416 ms |
| cloudflare-container-standard-4 | n8n | ref-full | 50 | 8.16 s | 23.3 s | 9.04 s | 26.1 s | start 1.15 s, clone 728 ms, checkout 7.04 s, status 455 ms |
| cloudflare-container-standard-4 | n8n | ref-sparse | 50 | 2.89 s | 7.48 s | 4.20 s | 9.55 s | start 1.22 s, clone 737 ms, sparse 6 ms, checkout 1.89 s, status 187 ms |
| cloudflare-container-standard-4 | n8n | snapshot-restore | 49 | 1.14 s | 1.41 s | 3.64 s | 112.7 s | start 2.50 s, status 1.10 s |
| cloudflare-container-standard-4 | n8n | squashfs | 48 | 31.1 s | 99.9 s | 32.0 s | 100.9 s | start 993 ms, squashmount 99 ms, mount 31 ms, status 31.0 s |
| cloudflare-container-standard-4 | n8n | worktree | 50 | 7.69 s | 17.1 s | 9.09 s | 18.8 s | start 1.05 s, checkout 7.09 s, status 460 ms |
| selfhosted-docker-runc | sal | container-start | 50 | 3 ms | 3 ms | 499 ms | 905 ms |  |
| selfhosted-docker-runc | sal | deps-archive | 50 | 1.77 s | 2.43 s | 3.81 s | 7.22 s | extract 1.77 s |
| selfhosted-docker-runc | sal | fuse-overlay | 50 | 112 ms | 130 ms | 596 ms | 760 ms | mount 18 ms, status 93 ms |
| selfhosted-docker-runc | sal | overlay | 50 | 39 ms | 51 ms | 602 ms | 6.55 s | mount 14 ms, status 20 ms |
| selfhosted-docker-runc | sal | overlay (stat=default) | 10 | 43 ms | 53 ms | 459 ms | 509 ms | mount 15 ms, status 25 ms |
| selfhosted-docker-runc | sal | ref-full | 50 | 482 ms | 511 ms | 1.04 s | 1.33 s | clone 67 ms, checkout 249 ms, status 164 ms |
| selfhosted-docker-runc | sal | ref-sparse | 50 | 208 ms | 245 ms | 673 ms | 857 ms | clone 74 ms, sparse 5 ms, checkout 82 ms, status 47 ms |
| selfhosted-docker-runc | sal | snapshot-image | 50 | 23 ms | 32 ms | 485 ms | 620 ms | status 21 ms |
| selfhosted-docker-runc | sal | snapshot-image (stat=default) | 10 | 167 ms | 232 ms | 509 ms | 617 ms | status 165 ms |
| selfhosted-docker-runc | sal | squashfs | 50 | 642 ms | 737 ms | 1.13 s | 1.39 s | squashmount 18 ms, mount 13 ms, status 604 ms |
| selfhosted-docker-runc | sal | squashfs (stat=default) | 10 | 1.32 s | 1.43 s | 1.75 s | 1.86 s | squashmount 18 ms, mount 13 ms, status 1.29 s |
| selfhosted-docker-runc | sal | worktree | 50 | 421 ms | 448 ms | 1.04 s | 1.32 s | checkout 257 ms, status 161 ms |
| selfhosted-docker-runc | vite | container-start | 50 | 3 ms | 3 ms | 416 ms | 553 ms |  |
| selfhosted-docker-runc | vite | deps-archive | 50 | 5.60 s | 6.67 s | 9.46 s | 12.0 s | extract 5.60 s |
| selfhosted-docker-runc | vite | fuse-overlay | 50 | 336 ms | 387 ms | 864 ms | 1.29 s | mount 17 ms, status 318 ms |
| selfhosted-docker-runc | vite | github-sparse | 10 | 2.96 s | 3.78 s | 3.61 s | 4.47 s | clone 2.01 s, sparse 6 ms, checkout 872 ms, status 79 ms |
| selfhosted-docker-runc | vite | overlay | 50 | 60 ms | 81 ms | 567 ms | 1.34 s | mount 12 ms, status 44 ms |
| selfhosted-docker-runc | vite | overlay (stat=default) | 10 | 59 ms | 75 ms | 448 ms | 475 ms | mount 14 ms, status 42 ms |
| selfhosted-docker-runc | vite | ref-full | 50 | 679 ms | 728 ms | 1.37 s | 1.65 s | clone 119 ms, checkout 310 ms, status 251 ms |
| selfhosted-docker-runc | vite | ref-sparse | 50 | 306 ms | 470 ms | 856 ms | 1.50 s | clone 122 ms, sparse 6 ms, checkout 95 ms, status 77 ms |
| selfhosted-docker-runc | vite | snapshot-image | 50 | 46 ms | 131 ms | 971 ms | 1.93 s | status 44 ms |
| selfhosted-docker-runc | vite | snapshot-image (stat=default) | 10 | 276 ms | 307 ms | 694 ms | 778 ms | status 274 ms |
| selfhosted-docker-runc | vite | squashfs | 50 | 1.77 s | 2.20 s | 2.25 s | 2.75 s | squashmount 16 ms, mount 12 ms, status 1.75 s |
| selfhosted-docker-runc | vite | squashfs (stat=default) | 10 | 2.78 s | 2.94 s | 3.31 s | 3.49 s | squashmount 15 ms, mount 10 ms, status 2.74 s |
| selfhosted-docker-runc | vite | worktree | 50 | 573 ms | 595 ms | 1.24 s | 1.64 s | checkout 314 ms, status 258 ms |
| selfhosted-docker-runc | n8n | container-start | 50 | 2 ms | 4 ms | 535 ms | 915 ms |  |
| selfhosted-docker-runc | n8n | deps-archive | 50 | 32.7 s | 35.7 s | 49.6 s | 57.0 s | extract 32.7 s |
| selfhosted-docker-runc | n8n | fuse-overlay | 50 | 2.46 s | 2.72 s | 4.17 s | 5.15 s | mount 14 ms, status 2.44 s |
| selfhosted-docker-runc | n8n | github-sparse | 10 | 13.6 s | 16.6 s | 14.7 s | 17.8 s | clone 9.01 s, sparse 6 ms, checkout 4.25 s, status 279 ms |
| selfhosted-docker-runc | n8n | overlay | 50 | 307 ms | 320 ms | 1.29 s | 1.95 s | mount 11 ms, status 293 ms |
| selfhosted-docker-runc | n8n | overlay (stat=default) | 10 | 321 ms | 338 ms | 833 ms | 1.13 s | mount 13 ms, status 302 ms |
| selfhosted-docker-runc | n8n | ref-full | 50 | 4.98 s | 5.24 s | 7.53 s | 8.43 s | clone 349 ms, checkout 4.12 s, status 478 ms |
| selfhosted-docker-runc | n8n | ref-sparse | 50 | 1.53 s | 1.70 s | 2.42 s | 2.84 s | clone 358 ms, sparse 6 ms, checkout 900 ms, status 270 ms |
| selfhosted-docker-runc | n8n | snapshot-image | 50 | 303 ms | 321 ms | 1.14 s | 2.21 s | status 300 ms |
| selfhosted-docker-runc | n8n | snapshot-image (stat=default) | 10 | 1.91 s | 2.28 s | 2.88 s | 5.17 s | status 1.91 s |
| selfhosted-docker-runc | n8n | squashfs | 50 | 25.8 s | 27.4 s | 26.6 s | 28.3 s | squashmount 17 ms, mount 19 ms, status 25.8 s |
| selfhosted-docker-runc | n8n | squashfs (stat=default) | 10 | 40.9 s | 44.9 s | 43.2 s | 45.9 s | squashmount 17 ms, mount 16 ms, status 40.8 s |
| selfhosted-docker-runc | n8n | worktree | 50 | 4.66 s | 5.52 s | 7.51 s | 9.29 s | checkout 4.14 s, status 546 ms |
