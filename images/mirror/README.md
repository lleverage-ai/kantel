# @kantel/mirror

The mirror cache service for seeding (M2-BE1, issue #21). It keeps warm bare git mirrors on node-local disk, and a
session gets its checkout off a mirror instead of from the git provider. It runs the `git` binary, so it is for nodes:
the self-hosted node, or the container that holds the mirrors on Cloudflare (M2-CF1, M2-SH1 wire it into their
targets).

```ts
import { createGitMirrorCache, createMirrorGitFetcher, startMirrorWarmer } from "@kantel/mirror";

const mirrors = createGitMirrorCache({ root: "/var/lib/harbour/mirrors", env: { HTTPS_PROXY: vaultProxy } });
const commit = await mirrors.resolve(ctx, "tvdavies/sal", "main");
await mirrors.checkout(ctx, { repo: "tvdavies/sal", commit, dest: "/work/sess-1", sparse: ["src"] });

// Seed workspace files off the mirror (method `mirror` in the seed report):
createStoredWorkspaces({ store, seeders: { git: createMirrorGitFetcher(mirrors) } });

// Keep the repositories the host's seed specs name warm:
startMirrorWarmer(mirrors, { ctx, repos: () => ["tvdavies/sal"], intervalMs: 60_000 });
```

| Operation | What it does |
| --- | --- |
| `sync(ctx, repo, { force? })` | Clones the mirror (`git clone --mirror`) when it is absent, else fetches it unless it was fetched in the last `freshForMs` (30 s). Concurrent calls for one repository share one fill; fills across repositories are bounded by `maxConcurrentFills` (2). |
| `resolve(ctx, repo, ref)` | A branch, tag or commit as a full commit ID. Fetches once when the mirror lacks it; `not_found` after that. A ref with revision syntax (`..`, a leading `-`) is `invalid`. |
| `checkout(ctx, { repo, commit, dest, sparse?, mode? })` | `reference` (default): `git clone --no-checkout --reference <mirror>`, with `--filter=blob:none --sparse` and a cone `sparse-checkout set` when `sparse` is given, then a detached checkout. `worktree`: `git worktree add --detach` in the mirror. Both set `core.checkStat=minimal` and `core.trustctime=false` and point `origin` at the real remote. `dest` must be absent or empty (`conflict`). |
| `release(ctx, repo, dest)` | Removes a checkout and prunes the mirror's worktree list. |
| `tree(ctx, repo, commit)` | The commit's files with modes, from `git archive` (symlinks and submodules left out), within `maxTreeBytes` (512 MiB). |

The defaults follow M0-BE2's measurements (`docs/measurements/m0-be2-seeding/results.md`). Off a warm mirror,
`worktree` took 0.42 s for tvdavies/sal and the sparse `reference` clone took 1.53 s for n8n's three-package cone,
both self-hosted.

Remote URLs: `owner/name` is GitHub over HTTPS and an `https:` URL is used as given. Anything else needs a
`remoteUrl` mapping. A URL with credentials in it is refused: git authenticates through the host's egress (the
vault's forward proxy or a credential helper in `env`), never through the spec.
