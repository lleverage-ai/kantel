# Kantel, by Lleverage

Kantel runs AI agents for people and for apps: sessions, sandboxes (isolate and container), a workspace, browsers,
connections and the vault behind them, skills, memory, prompt rules, schedules and an audit log. It runs on Cloudflare
or on your own machines. People use it through the console; apps use it through the public API.

## Documentation

The documentation for people who use the console, run a deployment or build an app on the API is the Starlight site
in [docs/site](docs/site/README.md). Start with its [home page](docs/site/src/content/docs/index.md).

Each package, app and target has a README, and each component package has a `CONTRACT.md` (below).

## Repository layout

| Path | What |
| --- | --- |
| `apps/cloudflare` | The Cloudflare deployment: one Worker, its Durable Objects, D1 and R2 |
| `apps/selfhosted` | The self-hosted gateway and session hosts |
| `apps/console` | The console, the web app people use |
| `apps/model-gateway` | The model gateway, which serves every model call |
| `apps/vault-proxy` | The egress proxy that injects credentials for sandboxes |
| `packages/contracts` | The TypeScript interfaces every component and target implements |
| `packages/*` | The components (runtime, workspace, sandbox, vault, connections, browser, skills, memory, rules, schedules, audit, identity, models and more), the public API and SDK (`packages/api`), the component library (`packages/ui`) and the conformance suites (`packages/testing`) |
| `targets/cloudflare/*`, `targets/selfhosted/*` | Each target's implementations of the contracts |
| `deploy/compose`, `deploy/kubernetes` | Running the self-hosted stack with Docker Compose or on Kubernetes |
| `images/*` | Container images: the sandbox, the browser, the isolate host and the Git mirror |
| `examples/*` | Example host apps |
| `spike`, `spikes/*` | The scripted scenario and conformance runs the self-hosted CI uses |
| `docs/site` | The documentation site |

## Development

Node 22.19 or later and pnpm 10.

```sh
pnpm install
pnpm check        # typecheck, Biome and the tests
```

Frontend work follows [AGENTS.md](AGENTS.md). After changing an API route, regenerate the OpenAPI document and the
API reference (see [docs/site/README.md](docs/site/README.md#the-api-reference)).

## Contracts

Kantel is built against a set of TypeScript contracts. Each has three parts:

- **The interface**, in `@kantel/contracts` (`packages/contracts/src`). It doesn't depend on Pi or any provider SDK,
  so a target can implement it on Cloudflare, Kubernetes, a single process or anything else.
- **A reference implementation** that runs in memory (`@kantel/<name>/memory`). It is the executable specification,
  and the one local development uses.
- **A conformance suite** in `@kantel/testing`. Every target must pass it unchanged.

Each suite exports `register<X>Conformance(runner, name, provider)`, which registers its cases with any runner that has
`describe`, `it` and `expect`. The provider builds a fresh subject for each case from the dependencies the suite passes
in (a manual clock, a recording audit sink and a project access fixture), then calls `use(subject)`. A target proves
itself in one file:

```ts
import { registerVaultConformance } from "@kantel/testing/vault";
import { describe, expect, it } from "vitest";
import { createD1Vault } from "../src/d1.ts";

registerVaultConformance({ describe, expect, it }, "D1 vault", async (deps, use) => {
	const vault = await createD1Vault({ clock: deps.clock, audit: deps.audit, database: await freshDatabase() });
	await use({ vault });
}, { projectAccess: true });
```

`{ projectAccess: true }` adds the suite's project access, worker call, mount read and existence cases.

Rules every contract shares:

- **Errors** are `KantelError`s with a code: `invalid`, `not_found`, `forbidden`, `conflict`, `expired`, `refused`,
  `exhausted`, `unavailable`, `aborted` or `not_supported`.
- **Organisations are isolated.** A record in another organisation is `not_found`, never `forbidden`, so IDs leak
  nothing across organisations. Within one organisation, `forbidden` stays distinct from `not_found`.
- **Access is checked by Kantel on every call.** Every call takes a `CallContext` naming the actor (`human`, `agent`,
  `service` or `system`) and the organisation, and the runtime and every component check `ProjectAccess` before acting.
  People and services pass by role; an API key is limited to its projects and its role. An agent passes only through
  its own open session, as an operator and never an admin. A refusal is `forbidden` and audited once as
  `access.denied`.
- **Calls Kantel makes on its own behalf** (scheduler ticks, audit drains, egress decisions, sweeps) take a
  `SystemContext` and refuse any other actor.
- **Every change is audited** through an `AuditSink`, with its actor. Components append to an `AuditOutbox` that a
  relay drains to the `AuditStore`, idempotently by organisation and event ID. No audit event holds a secret value;
  each suite plants a canary secret and checks for it.
- **One session-end hook.** Closing or aborting a session runs every registered teardown (sandbox leases, browsers,
  capability grants, vault grants) as `system`, in order; one that fails doesn't stop the others.

| Contract | Interface | Reference implementation | Suite | Details |
| --- | --- | --- | --- | --- |
| Identity and tenancy | `IdentityDirectory`, `ProjectAccess` | `@kantel/identity/memory` | `registerIdentityConformance` | [identity](packages/identity/CONTRACT.md) |
| Session runtime | `SessionRuntime`, `SessionDirectory`, `AgentProfiles`, `HostToolBridge`, `SessionEndHook` | `@kantel/runtime/memory` | `registerRuntimeConformance` | [runtime](packages/runtime/CONTRACT.md), [HTTP API](packages/runtime/HTTP.md) |
| Client wire protocol | `SessionStream`, frames, `applyDelta` | `@kantel/protocol/memory` | `registerProtocolConformance` | [streaming](docs/site/src/content/docs/api/streaming.md) |
| Workspace | `Workspaces`, `MountSource` | `@kantel/workspace/memory` | `registerWorkspaceConformance` | [workspace](packages/workspace/CONTRACT.md) |
| Sandbox | `Sandboxes`, `routeTool` | `@kantel/sandbox/memory` | `registerSandboxConformance` | [sandbox](packages/sandbox/CONTRACT.md) |
| Vault (the encrypted store behind connections) | `Vault` | `@kantel/vault/memory` | `registerVaultConformance` | [vault](packages/vault/CONTRACT.md) |
| Capability registry and host tools | `CapabilityRegistry` | `@kantel/codemode/memory` | `registerCapabilityConformance` | [codemode](packages/codemode/CONTRACT.md) |
| Browser | `Browser`, `BrowserProvider` | `@kantel/browser/memory` | `registerBrowserConformance` | [browser](packages/browser/CONTRACT.md) |
| Skills | `Skills`, `SkillSource` | `@kantel/skills/memory` | `registerSkillsConformance` | [skills](packages/skills/CONTRACT.md) |
| Memory | `Memory`, `MemorySource` | `@kantel/memory/memory` | `registerMemoryConformance` | [memory](packages/memory/CONTRACT.md) |
| Prompt rules | `PromptRules` | `@kantel/rules/memory` | `registerRulesConformance` | [rules](packages/rules/CONTRACT.md) |
| Schedules | `Schedules` | `@kantel/schedules/memory` | `registerSchedulesConformance` | [schedules](packages/schedules/CONTRACT.md) |
| Audit | `AuditStore`, `AuditOutbox`, `AuditSink` | `@kantel/audit/memory` | `registerAuditConformance` | [audit](packages/audit/CONTRACT.md) |
| Models | `ModelGateway`, connectors and routes | `@kantel/models` | `registerModelGatewayConformance`, `registerModelConnectorConformance` | [models](packages/models/CONTRACT.md) |
| Sharing | shares, access requests and policies | `@kantel/sharing` | `registerSharingConformance` | [projects and sharing](docs/site/src/content/docs/console/projects-and-sharing.md) |

## Names

The product was called Kantel before it was renamed Kantel, and some identifiers keep the old name: the repository,
API keys (`ktk_`), tunnel tokens (`ktt_`), the `kantel-*` HTTP headers, the `kantel` Worker and browser provider,
the `kantel` and `kantel-light` theme IDs, and `harbour/*` keys in tool calls' `_meta`. Packages are `@kantel/*`
and settings `KANTEL_*`; a `KANTEL_*` setting still works when its `KANTEL_*` one isn't set.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
