# M0 spike: shared contracts, scenario and conformance

**The shared scenario.** M0-CF1 (#3, PR #40) wrote the scenario both
targets run: `spikes/scenario/run.ts` and `research-task.json`, over the HTTP
surface in its `spikes/scenario/README.md`. The self-hosted session hosts
serve that surface too (`/sessions/:id/{setup,prompt,state,kill,exec,vault,fixture,file}`
in `apps/selfhosted/src/main.ts`), and CF1's `run.ts` passes against them
unchanged, normal and `--kill-after-exec 2`:

```bash
HARBOUR_SPIKE_TOKEN=unused HARBOUR_CANARY=harbour-canary-0000 \
  bun spikes/scenario/run.ts --base-url http://127.0.0.1:58081 [--kill-after-exec 2]
```

On self-hosted, `kill` makes the owning host process exit right after the
n-th command commits; another host takes the session over (event `reopen`)
and Docker restarts the killed one. CI runs it once #40 is on main.

**The conformance suite** (`conformance/`, 9 cases) speaks only that same
surface (`conformance/shared.ts`), so it runs against either target:
`bun spike/conformance/run.ts --target=cloudflare --base=https://...` with
`HARBOUR_SPIKE_TOKEN` and `HARBOUR_CANARY` set. Its egress cases use the
shared scenario's hosts and policy (postman-echo.com allowed with an injected
header, api.github.com refused), so it needs no fixture inside either target.

What follows in this folder came first: this stream's own scenario over a
`/v0` API, which also measures takeover against the lease TTL and kills the
host from outside (`docker kill` or `docker pause`).

Shared by both targets (M0-CF1 Cloudflare, M0-SH1 self-hosted). Nothing here
imports a target or a package: only `fetch` against the spike HTTP API.

- `contracts/` draft interfaces for what the spike exercises (workspace,
  sandbox tiers, session lease, spike API, scenario specs).
- `scenario/run.ts` the scripted research task (plan §15), with `--crash`.
- `conformance/` the target-agnostic suite over the shared surface; `run.ts --target=selfhosted|cloudflare --base=URL`.
- `fixtures/research-site/` the page the task fetches; it needs the injected header.

## The spike HTTP API

| Method and path | Body | Returns |
|---|---|---|
| `GET /v0/target` | | `{ target, leaseTtlMs? }` |
| `POST /v0/sessions` | `{ sessionId? }` | `CreateSessionResponse` |
| `POST /v0/sessions/:id/prompt` | `{ text, requestId }` | `202 { submissionId }`; same `requestId`, same submission |
| `GET /v0/sessions/:id` | | `SessionState`: tool results with their tier, the settled answer, workspace head |
| `GET /v0/sessions/:id/audit` | | `{ events }` |
| `GET /v0/takeovers` (optional) | | takeovers this host performed, with `resumedAt` (epoch ms) |

The model is scripted (the Pi faux provider with a response factory), and a
prompt is `harbour-scenario ` plus a JSON `ScenarioSpec`. Its next step is a
pure function of the transcript, so a host that takes a session over mid-run
continues it exactly. For CF1: the self-hosted factory is
`apps/selfhosted/src/scenario-model.ts`; it only imports pi-ai, so the
SessionDO can use the same file.

## Reconciling with M0-BE1's contracts

M0-BE1's contracts landed in #39. What this branch takes from them now:

- **Tier routing.** `apps/selfhosted/src/sandbox/router.ts` routes with
  `DEFAULT_TIER_ROUTES` and `routeTool` from `packages/contracts` and
  `packages/sandbox`. Self-hosted only escalates further towards the container
  (a container program later in a pipeline, or `# harbour:container`).
- **`SandboxTier`** comes from `packages/contracts`.
- **`Workspaces`.** `apps/selfhosted/src/workspaces.ts` implements the real
  contract on Postgres (records, head, history) and MinIO (content-addressed
  blobs, one immutable tree object per version), and passes
  `packages/testing`'s workspace suite (15 cases) in
  `apps/selfhosted/test/workspaces.conformance.test.ts`. Mount sources stay in
  memory in that test.

What is still spike-internal, and where it goes in M1:

1. The session host still runs on the manifest-per-command store
   (`MinioWorkspace`, opaque string versions, fenced by the session lease).
   Moving it onto `PostgresWorkspaces` needs the contract's commit to carry
   the lease fence (`CommitRequest.writer.leaseId` is there but not checked),
   and the sandboxes to commit `changes` rather than whole manifests.
2. The per-command `SandboxTierRunner` maps onto the contract's `Sandboxes`
   (`acquire`/`exec`/`release` leases per tier) once a container lease lives
   longer than one command.
3. The session lease (`SessionLeases`) has no BE1 contract; it stays in
   `apps/selfhosted` until the M1 session-host stream owns it.
4. The vault stub maps onto `packages/vault`'s `RouteScope` and
   `InjectionRule`; it should register with the vault suite when it becomes a
   real service.
5. The spike API stays a spike API; M1-BE1's session API replaces it.
