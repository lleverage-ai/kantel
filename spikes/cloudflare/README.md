# M0-CF1: Cloudflare spike

Issue [#3](https://github.com/tvdavies/harbour/issues/3). One Worker app, `harbour-m0-cf1`: a SessionDO per session runs Pi Durable on the object's SQLite storage, with an ExecutionEnv backed by Harbour's sandbox. Shell commands run in just-bash inside a Dynamic Worker (isolate tier), or, for git, bun, node, python and the like, in a Container on the same workspace version (container tier). Both tiers share one versioned workspace in R2 and reach the network only through a stub vault.

Status: deployed and left running. The [scenario](../scenario/README.md) passes, including the crash test; the cold-start numbers are in [docs/measurements/m0-cf1](../../docs/measurements/m0-cf1/README.md).

## Shape

```
client ── Worker (bearer token) ── SessionDO ── Pi Durable Harness (DO SQLite), scripted model, bash/read/write/edit
                                       │
                                       ├─ HarbourEnv (ExecutionEnv) ── file tools ──────────────► R2Workspace
                                       │        └─ exec ── HarbourSandbox.route(command)
                                       │                     ├─ isolate: Worker Loader ─► HarbourIsolate (just-bash)
                                       │                     │     env.WORKSPACE = WorkspaceGateway(props: workspaceId)
                                       │                     │     globalOutbound = VaultGateway(props: session, "isolate")
                                       │                     └─ container: HarbourContainer DO (ctx.container, durable_object policy)
                                       │                           enableInternet: false; all HTTP(S) intercepted ─► VaultGateway(..., "container")
                                       └─ VaultDO (audit)
```

| File | What it does |
| --- | --- |
| `src/contracts.ts` | Draft `Workspace`, `Sandbox`, `Vault`, `SessionRuntime` contracts, kept until M0-BE1 lands (see below) |
| `src/session.ts` | SessionDO: opens the Harness, drives runs from the alarm handler, crash hook, HTTP surface |
| `src/env.ts` | Pi Durable `ExecutionEnv`: shell to the sandbox, file operations to the workspace, one head |
| `src/sandbox.ts` | Routing and the two tiers |
| `src/isolate/entry.ts` | The Dynamic Worker: just-bash over a lazy view of one version; commits what the command changed |
| `src/container-tier.ts` | Container DO: start, egress interception, diff sync, commit |
| `container/` | Image (Debian, bun, git, python3, curl, jq, ripgrep) and the agent on port 8080 |
| `src/workspace.ts` | R2 workspace: content-addressed blobs, immutable manifests, `HEAD` swapped with a conditional put |
| `src/vault.ts` | Stub vault: policy match, header injection, redaction of the secret in responses, audit |
| `scripts/bench.ts` | Cold-start table |

### Decisions inside the spike

- **One writer, compare-and-swap commits.** Every command starts from the head the SessionDO holds and commits before it returns; `HEAD` is replaced only if its etag is unchanged, so a stale writer fails instead of losing a write. On reopen the head is read from R2, so a crash between commit and anything else cannot lose it.
- **The isolate never holds storage or credentials.** Its only bindings are `WorkspaceGateway`, pinned to one workspace by props, and the vault as `globalOutbound`. Hashes are computed on the gateway side.
- **The container gets the version pushed to it.** The container DO sends the diff between the version the container holds and the version the command needs, and takes back the changed files; it never talks to R2. `.git` and `node_modules` stay local to the container, not synced.
- **Routing by program name** (`git`, `gh`, `bun`, `node`, `npm`, `python`, `make`, …) anywhere in command position, plus an explicit `# harbour:container` first line. just-bash covers `rg`, `jq`, `curl`, `sed`, `awk`.
- **Scripted model.** pi-ai's faux provider, stateless over the transcript, so the scenario needs no model key and replays after a crash.

## Findings

1. **Crash mid tool call works as Pi Durable documents it.** The DO is aborted right after a command's workspace commit lands and before its tool result is recorded. The alarm reopens it about 1.8 s later; the Harness writes `Tool bash was interrupted and may have partially run`, and the scripted model reissues the call. The rerun starts on the already-committed version and changes nothing. Pi's `bash` is not `replay: "safe"`, so Harbour gets the "may have partially run" path, not a silent rerun: the agent decides. Commands that are not idempotent (appends, pushes) need that path surfaced to the model, as here.
2. **Each tier sees the other's last write**: the container reads `notes/x.md` written by the write tool and the page the isolate fetched; the isolate reads `git-log.txt` the container wrote. All 50 container cold-start runs saw the isolate's marker.
3. **The vault holds for both tiers.** Allowed hosts get the header injected (an echo service shows it arrived); the value is redacted from the response before the sandbox sees it, in response headers and in literal, JSON-escaped, URL, base64 and HTML forms, and a binary body containing it is withheld; an unlisted host gets 403; every use is audited with the header name and item, never the value. The canary appears in none of: tool results, the recorded fixture, or 2,225 lines of `wrangler tail` taken during a run.
4. **Cold starts:** container ready p50 2.4 s / p95 3.2 s against a 3 s / 8 s target (meets); isolate session ready p50 1.0 s / p95 2.0 s against 100 / 300 ms (misses). About half the isolate figure is creating a never-seen Durable Object; most of the rest is R2 round trips. See the measurements page for the breakdown and the proposed fixes (a pool of pre-created session objects; head and manifest in DO storage).
5. **Gotchas worth keeping:**
   - just-bash turns its private-range check on whenever `process` exists, as under `nodejs_compat`, and the check needs DNS pinning Workers cannot do: every `curl` fails until `denyPrivateRanges: false` is set. The vault is the policy point anyway.
   - Under the `durable_object` scheduling policy, `@cloudflare/containers` 0.3.7 cannot pass the image or instance size, so the spike uses `ctx.container` directly; wrangler wants `images` instead of `image`/`instance_type`/`max_instances`.
   - The egress CA (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) appears only after HTTPS interception is turned on, after the container process starts, so an entrypoint cannot install it. The agent appends it to a copy of the system bundle before the first command (`update-ca-certificates` cost about 2 s on `standard-1`).
   - Workers clocks advance only on I/O, so CPU-only phases read 0 ms server-side.
   - Tool-result entries are not in call order by entry ID; order by the message timestamp.
6. **Redaction is the weak point of header injection.** Any allowed host that reflects request headers is a way to read the secret back, and string matching cannot cover every encoding (a host could hash, split or compress it). The production vault should inject only into hosts that do not reflect headers, and treat redaction as a second line of defence.

The review of PR #40 found six issues, all fixed and checked live by `scripts/regressions.ts`: JSON-escaped echoes defeated redaction; a directory replaced by a file broke container sync; a losing concurrent `create` could overwrite the first manifest; a container could be reused by another session or workspace; files created through a symlinked parent in the isolate were not committed; and a container timeout did not kill background children. The cold-start runs predate these fixes; the only change on that path is one Durable Object storage write when a container starts.

## Not done here

- The git, monorepo and dependency rows of the cold-start table belong to M0-BE2 (#5).
- No conformance suite: M0-BE1's suite was not on main. Pi Durable's `createEnvConformance` was not run against `HarbourEnv`, which implements only what Pi's coding tools use (`watch`, temp files, `rename`, line readers return `not_supported`).
- The vault is a stub: static policies, one item, exact host match, no path scope, no proposals or approvals. Its echo hosts (`postman-echo.com`, `httpbin.org`) exist to prove injection and are exactly the reflecting hosts a real policy should refuse.
- A crash between writing a new workspace's first manifest and creating its `HEAD` leaves that workspace ID unusable; acceptable for a spike, where IDs are per run.
- Non-HTTP egress from the container (raw TCP, SSH) is blocked by `enableInternet: false` but was not tested.

## Reconciling with M0-BE1 (#2, PR #39)

The real contracts in `packages/contracts` are richer than the drafts here. When they land:

| Draft here | M0-BE1 | Change needed |
| --- | --- | --- |
| `WorkspaceVersion` string (`v3.ab12cd`) | `number` | Keep the integer in `HEAD`; give each manifest a unique key (`versions/<n>-<nonce>.json`) named by `HEAD`, so racing writers still cannot overwrite each other's manifest |
| `commit(base, changes)` → version | `CommitRequest { baseVersion, changes, writer }` → `CommitResult { version, changed }` | Rename and return the changed paths |
| `Sandbox.exec`, `route(command)`, `release` | `Sandboxes` with leases: `acquire`/`renew`/`release`/`exec`/`run`, `route(tool, command)` | The container DO becomes the lease holder; `ExecResult` adds `leaseId`, `workspaceVersion`, `durationMs`; routing reads `TierRoute.programs` |
| `VaultPolicy { host, methods, inject }` | `VaultItem` + `VaultPolicy { route: RouteScope, lifetime }`, `InjectionRule { header, template }` | Add path prefix, template and lifetime; the gateway logic stays |
| `SessionRuntime` (setup/prompt/state/kill) | `SessionRuntime` (create/prompt/… with `CallContext`) | The SessionDO's HTTP surface maps onto it; `kill` stays a test hook |

## Run it

```sh
cd spikes/cloudflare
bun install
bun run typecheck && bun test test
HARBOUR_SPIKE_TOKEN=$TOKEN bun scripts/regressions.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev
bun run deploy                      # builds dist/isolate.bundle.txt, the container image, and deploys
printf %s "$TOKEN"  | npx wrangler secret put HARBOUR_SPIKE_TOKEN
printf %s "$CANARY" | npx wrangler secret put VAULT_CANARY
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
