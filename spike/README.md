# M0 spike: shared contracts, scenario and conformance

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
