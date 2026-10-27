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

What follows in this folder came first: this stream's own scenario, which
also measures takeover against the lease TTL and kills the host from outside
(`docker kill` or `docker pause`), and a conformance suite.

Shared by both targets (M0-CF1 Cloudflare, M0-SH1 self-hosted). Nothing here
imports a target or a package: only `fetch` against the spike HTTP API.

- `contracts/` draft interfaces for what the spike exercises (workspace,
  sandbox tiers, session lease, spike API, scenario specs).
- `scenario/run.ts` the scripted research task (plan §15), with `--crash`.
- `conformance/` the target-agnostic suite; `run.ts --target=selfhosted|cloudflare --base=URL`.
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

These are stand-ins until `packages/contracts` (#2) lands. When it does:

1. Replace `spike/contracts` imports with `@harbour/contracts` and delete the
   draft. Expected mapping: `Workspace`/`Manifest` to the workspace contract
   (versioned list/read/commit), `SandboxTierRunner` to the sandbox exec
   contract, `SessionLeases` to the sandbox or session lease contract.
2. Register the self-hosted implementations with BE1's conformance suites
   (`packages/testing`), next to `spike/conformance`.
3. The spike API stays a spike API; M1-BE1's session API replaces it.

Anything BE1's contracts do not cover (the session lease, the vault stub) stays
under `apps/selfhosted` until its M1 stream owns it.
