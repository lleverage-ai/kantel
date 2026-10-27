# M0-CF1: Cloudflare spike

Issue [#3](https://github.com/tvdavies/harbour/issues/3). One Worker app, `harbour-m0-cf1`: a SessionDO per session runs Pi Durable on the object's SQLite storage, with an ExecutionEnv over M0-BE1's `Workspaces` and `Sandboxes` contracts (`@harbour/contracts`). Shell commands run in just-bash inside a Dynamic Worker (isolate tier), or, for the programs in the contract's routing table (git, bun, node, python and the like), in a Container on the same workspace (container tier). Both tiers share one versioned workspace in R2 and reach the network only through the vault (`@harbour/vault`'s in-memory vault, hosted in a Durable Object).

Status: deployed and left running. The [scenario](../scenario/README.md) passes, including the crash test, and the workspace and sandbox conformance suites from `@harbour/testing` pass; the cold-start numbers are in [docs/measurements/m0-cf1](../../docs/measurements/m0-cf1/README.md).

## Shape

```
client ── Worker (bearer token) ── SessionDO ── Pi Durable Harness (DO SQLite), scripted model, bash/read/write/edit
                                       │
                                       ├─ HarbourEnv (ExecutionEnv) ── file tools ─► ObjectStoreWorkspaces (R2)
                                       │        └─ exec ── CloudflareSandboxes.run(tool "bash") ── routeTool(DEFAULT_TIER_ROUTES)
                                       │              leases in DO SQLite  ├─ isolate: Worker Loader ─► HarbourIsolate (just-bash)
                                       │                                   │     env.WORKSPACE = WorkspaceGateway (read-only, props: workspaceId)
                                       │                                   │     globalOutbound = VaultGateway(props: session, "isolate")
                                       │                                   └─ container: HarbourContainer DO (ctx.container)
                                       │                                         enableInternet: false; HTTP(S) intercepted ─► VaultGateway(..., "container")
                                       └─ VaultDO: createMemoryVault (policies, items, decideEgress, audit)
```

| File | What it does |
| --- | --- |
| `src/workspace.ts` | `ObjectStoreWorkspaces`: M0-BE1's `Workspaces` over an object store. Content-addressed blobs, immutable manifests, the head swapped with a conditional put, read-only mounts, version history, exports, audit |
| `src/object-store.ts`, `src/r2.ts` | The store interface; an in-memory store with R2's etag semantics for tests; the R2 adapter |
| `src/sandbox.ts` | `CloudflareSandboxes`: M0-BE1's `Sandboxes`. Leases with TTLs and `sweep`, tier routing from the contract's table, isolate commits per command, container changes committed on release |
| `src/tiers.ts` | The two backends: Worker Loader (isolate) and the container Durable Object |
| `src/isolate/entry.ts`, `src/isolate/shell.ts` | The Dynamic Worker: just-bash over a lazy, read-only view of one version plus an overlay; returns what the command changed |
| `src/workspace-gateway.ts` | The isolate's only workspace binding: entries and blobs of one workspace, no writes |
| `src/container-tier.ts`, `container/` | Container DO (lease ownership, serialised calls, sync to the head, pending changes, reset, timeout) and the agent in the image (Debian, bun, git, python3, curl, jq, ripgrep) |
| `src/vault.ts`, `src/redact.ts` | `VaultDO` hosting `createMemoryVault`; `VaultGateway` asks `decideEgress`, injects the header, forwards, redacts the value from the response |
| `src/env.ts` | Pi Durable `ExecutionEnv`: shell to `Sandboxes.run`, file operations to `Workspaces`, one head |
| `src/session.ts` | SessionDO: opens the Harness, drives runs from the alarm handler, releases leases when a run settles, crash hook, HTTP surface |
| `test/` | `@harbour/testing`'s workspace and sandbox conformance suites against the spike's implementations, and redaction tests |
| `scripts/bench.ts`, `scripts/regressions.ts` | Cold-start table; live checks for the review fixes |

### Decisions inside the spike

- **Compare-and-swap commits on the head.** Every commit names its base version; the head object in R2 is replaced only if its etag is unchanged, and each version's manifest has its own key, so a stale or racing writer gets `conflict` instead of losing a write. The file tools retry a conflict on the new head; sandbox commits rebase.
- **Isolate commits per command; container on release.** As the contract says. An isolate command's changes come back to `CloudflareSandboxes`, which commits them before returning. The container keeps its changes in its working copy, rebased onto the current head before each command (its own edits win), and they are committed when the lease is released: the SessionDO releases the session's leases whenever a run settles. A live container is checkpointed before an isolate command, so the isolate also sees the container's latest writes.
- **The isolate never holds storage or credentials.** Its bindings are `WorkspaceGateway`, read-only and pinned to one workspace by props, and the vault as `globalOutbound`. Writes under a mount fail with `Read-only file system`.
- **The container never talks to R2.** The container DO sends the diff between the version the container holds and the head, and takes back the changed files. `.git` and `node_modules` stay local to the container.
- **Routing is the contract's table.** `routeTool(DEFAULT_TIER_ROUTES, ...)` looks at the first word of a command (after `cd ... &&`). The old `# harbour:container` marker and routing on any word in command position are gone, so the scenario's container steps now start with `git`.
- **Leases and audit live in the SessionDO's SQLite**, so a restarted object still knows its leases and can release them.
- **Scripted model.** pi-ai's faux provider, stateless over the transcript, so the scenario needs no model key and replays after a crash.

## Findings

1. **Crash mid tool call works as Pi Durable documents it.** The DO is aborted right after a command's workspace commit lands and before its tool result is recorded. The alarm reopens it about 0.2 s later; the Harness writes `Tool bash was interrupted and may have partially run`, and the scripted model reissues the call. The rerun starts on the already-committed version and changes nothing. Pi's `bash` is not `replay: "safe"`, so Harbour gets the "may have partially run" path, not a silent rerun: the agent decides. Commands that are not idempotent (appends, pushes) need that path surfaced to the model, as here.
2. **Each tier sees the other's last write**: the container reads `notes/x.md` written by the write tool and the page the isolate fetched; the isolate reads `git-log.txt` the container wrote. Every container cold-start run saw the isolate's marker.
3. **The vault holds for both tiers.** Allowed hosts get the header injected (an echo service shows it arrived); the value is redacted from the response before the sandbox sees it, in response headers and in literal, JSON-escaped, URL, base64 and HTML forms, and a binary body containing it is withheld; an unlisted host gets 403; every use is audited with the header name and item, never the value. The canary appears in none of the tool results, the recorded fixture or the exec log.
4. **Cold starts:** see the measurements page. The container tier meets its 3 s / 8 s target; the isolate tier misses its 100 / 300 ms target, mostly from creating a never-seen Durable Object and R2 round trips. Whether to change the target or build the fixes is an open decision, not made here.
5. **Gotchas worth keeping:**
   - just-bash turns its private-range check on whenever `process` exists, as under `nodejs_compat`, and the check needs DNS pinning Workers cannot do: every `curl` fails until `denyPrivateRanges: false` is set. The vault is the policy point anyway.
   - just-bash lets some filesystem errors escape `bash.exec`: a redirect into a read-only path throws instead of failing the command. `runShell` catches it and returns exit 1 with `bash: <path>: Read-only file system`, but the whole script stops there, so `echo x > /mount/f || true` does not reach `true`. Missing programs behave like bash: `git --version` in the isolate is exit 127 with `bash: git: command not found`.
   - Under the `durable_object` scheduling policy, `@cloudflare/containers` 0.3.7 cannot pass the image or instance size, so the spike uses `ctx.container` directly; wrangler wants `images` instead of `image`/`instance_type`/`max_instances`.
   - The egress CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) appears only after HTTPS interception is turned on, after the container process starts, so an entrypoint cannot install it. The agent appends it to a copy of the system bundle before the first command.
   - Workers clocks advance only on I/O, so CPU-only phases read 0 ms server-side.
   - Tool-result entries are not in call order by entry ID; order by the message timestamp.
   - The first container starts after a deploy pull the new image and take 5 to 8 s.
6. **Redaction is the weak point of header injection.** Any allowed host that reflects request headers is a way to read the secret back, and string matching cannot cover every encoding (a host could hash, split or compress it). The production vault should inject only into hosts that do not reflect headers, and treat redaction as a second line of defence.

The review of PR #40 found six issues (and a re-review four more in the fixes), all fixed and checked live by `scripts/regressions.ts`: JSON-escaped echoes defeated redaction; a directory replaced by a file broke container sync; a losing concurrent `create` could overwrite the first manifest; a container could be reused by another session or workspace; files created through a symlinked parent in the isolate were not committed; and a container timeout did not kill background children.

## Reconciled with M0-BE1 (#2, PR #39)

The draft contracts are gone; the spike implements and is tested against the real ones.

| Contract | Spike implementation | Conformance (`@harbour/testing`) |
| --- | --- | --- |
| `Workspaces` | `ObjectStoreWorkspaces` over R2 (`MemoryObjectStore` in tests, with R2's conditional-put semantics) | `createWorkspaceConformance`: 15 cases pass |
| `Sandboxes` | `CloudflareSandboxes`; the tests use the real isolate shell (just-bash) and a simulated container, because the container backend needs Cloudflare | `createSandboxConformance`: 14 cases pass |
| `Vault` | `createMemoryVault` from `@harbour/vault`, hosted in `VaultDO` | covered by `packages/vault`'s own conformance test; the gateway is checked live by the scenario |
| `SessionRuntime` | not implemented: the SessionDO keeps its HTTP surface (setup/prompt/state/kill/exec) | not run |

## Gaps

- **A stopped container loses uncommitted changes.** Container changes are committed when the lease is released, which the SessionDO does when a run settles. If the container stops inside a run (3 minutes without a command, or the host goes away), its uncommitted changes are gone and the next container command starts from the head; nothing tells the agent. Production needs either a commit per container command or a checkpoint before the inactivity timeout, and an error when a lease's container has gone.
- `SessionRuntime` is not implemented, and Pi Durable's `createEnvConformance` was not run against `HarbourEnv`, which implements only what Pi's coding tools use (`watch`, temp files, `rename`, line readers return `not_supported`).
- Mounts are not available in the container. The isolate and `Workspaces` serve them read-only at their absolute paths, but the container receives only the workspace tree, so a mount's files are absent there and anything the container writes outside the workspace is never collected.
- The git, monorepo and dependency rows of the cold-start table belong to M0-BE2 (#5).
- The vault's policies are static and seeded in code. Its echo hosts (`postman-echo.com`, `httpbin.org`) exist to prove injection and are exactly the reflecting hosts a real policy should refuse.
- Non-HTTP egress from the container (raw TCP, SSH) is blocked by `enableInternet: false` but was not tested.

## Run it

From the repository root, `pnpm install`, `pnpm typecheck`, `pnpm lint` and `pnpm test` cover this package. The live scripts run under bun.

```sh
cd spikes/cloudflare
pnpm test                                   # conformance and redaction tests
pnpm run deploy                             # builds dist/isolate.bundle.txt, the container image, and deploys
printf %s "$TOKEN"  | npx wrangler secret put HARBOUR_SPIKE_TOKEN
printf %s "$CANARY" | npx wrangler secret put VAULT_CANARY
HARBOUR_SPIKE_TOKEN=$TOKEN bun scripts/regressions.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev
HARBOUR_SPIKE_TOKEN=$TOKEN HARBOUR_CANARY=$CANARY bun ../scenario/run.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev
HARBOUR_SPIKE_TOKEN=$TOKEN bun scripts/bench.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev --runs 50 --out ../../docs/measurements/m0-cf1
```

## Cloudflare resources (all left running)

| Resource | Name |
| --- | --- |
| Worker (with SessionDO, VaultDO, HarbourContainer Durable Object classes and a Worker Loader binding) | `harbour-m0-cf1`, on workers.dev |
| Container application (`durable_object` policy) | `harbour-m0-cf1-sandbox` |
| Container images | `harbour-m0-cf1-harbourcontainer-sandbox` (tags `wrangler-*`) |
| R2 bucket | `harbour-m0-workspaces` |
| Worker secrets | `HARBOUR_SPIKE_TOKEN`, `VAULT_CANARY` |

Containers stop after 3 minutes without activity. To remove everything:

```sh
cd spikes/cloudflare
npx wrangler delete harbour-m0-cf1                          # Worker, its Durable Objects and secrets
npx wrangler containers list                                # find the harbour-m0-cf1-sandbox application ID
npx wrangler containers delete <harbour-m0-cf1-sandbox ID>   # if wrangler delete left it behind
npx wrangler containers images list | grep harbour-m0-cf1   # then for each tag:
npx wrangler containers images delete harbour-m0-cf1-harbourcontainer-sandbox:<tag>
# A bucket must be empty to delete: expire every object, wait a day (or empty it in the dashboard), then delete.
npx wrangler r2 bucket lifecycle add harbour-m0-workspaces expire-all "" --expire-days 1
npx wrangler r2 bucket delete harbour-m0-workspaces
```
