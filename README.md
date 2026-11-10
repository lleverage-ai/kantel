# Kantel, by Lleverage

Kantel is a compute plane for AI agents that you can run yourself. It gives agents sandboxes to work in (isolates and
microVMs, with a desktop, a browser and SSH), on Linux machines you add with one command. Kantel doesn't run the agent:
Claude Code, Codex, pi or your own loop reaches it through the console, the public API, the TypeScript SDK, the
`kantel` CLI or its MCP server.

Until November 2026 Kantel also ran the agents themselves (sessions, models, connections, the vault, skills, memory and
schedules). That agent plane is kept, as it was, on the `agent-plane-archive` branch and the
`agent-plane-archive-2026-11-03` tag (commit `e496aeb2817595f5fae5b0cdb919dbc94a5505f5`).

## Documentation

The documentation for people who use the console, run a deployment or build an app on the API is the Starlight site
in [docs/site](docs/site/README.md). Start with its [home page](docs/site/src/content/docs/index.md).

Each package, app and target has a README, and each component package has a `CONTRACT.md` (below).

## Repository layout

| Path | What |
| --- | --- |
| `apps/selfhosted` | The self-hosted gateway: the console, the compute plane's API, identity and audit |
| `apps/cloudflare` | The Cloudflare Worker: the console, identity and audit. Its Durable Objects, D1 and R2 stay, and the agent plane's objects are inert |
| `apps/console` | The console, the web app people use |
| `apps/host` | `kantel-host`, which runs sandboxes on a Linux machine, and the guest image's agent (Go) |
| `apps/site` | kantel.dev: the marketing page, the install script and the docs |
| `packages/compute`, `packages/hosts` | The compute plane's API, and its host registry, placement and dispatch to `kantel-host` |
| `packages/api`, `packages/cli`, `packages/admin` | The public API with its OpenAPI document and SDK, the `kantel` CLI and MCP server, and `kantel-admin` |
| `packages/identity`, `packages/audit`, `packages/sql` | Organisations, projects, people, roles and API keys; the audit log; the SQL seam under both |
| `packages/contracts`, `packages/testing` | The TypeScript interfaces the components implement, and their conformance suites |
| `packages/ui` | The component library and the compute console |
| `packages/sandbox`, `packages/workspace`, `packages/browser`, `packages/usage` | Libraries from the agent plane, kept dormant: the sandbox facade and its tiers, the versioned workspace, the browser broker and the usage ledger |
| `targets/selfhosted/sandbox` | The self-hosted container tier: a gVisor container per lease |
| `deploy/compose` | Running the self-hosted stack with Docker Compose |
| `images/*` | Container images: the sandbox, the browser and the isolate host |
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
import { createMemoryIdentity } from "@kantel/identity/memory";
import { registerIdentityConformance } from "@kantel/testing/identity";
import { describe, expect, it } from "vitest";

registerIdentityConformance({ describe, expect, it }, "in-memory identity", async (deps, use) => {
	await use({ identity: createMemoryIdentity({ clock: deps.clock, audit: deps.audit }) });
});
```

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
- **Calls Kantel makes on its own behalf** (audit drains, sweeps) take a `SystemContext` and refuse any other actor.
- **Every change is audited** through an `AuditSink`, with its actor. Components append to an `AuditOutbox` that a
  relay drains to the `AuditStore`, idempotently by organisation and event ID. No audit event holds a secret value;
  each suite plants a canary secret and checks for it.

| Contract | Interface | Reference implementation | Suite | Details |
| --- | --- | --- | --- | --- |
| Identity and tenancy | `IdentityDirectory`, `ProjectAccess` | `@kantel/identity/memory` | `registerIdentityConformance` | [identity](packages/identity/CONTRACT.md) |
| Audit | `AuditStore`, `AuditOutbox`, `AuditSink` | `@kantel/audit/memory` | `registerAuditConformance` | [audit](packages/audit/CONTRACT.md) |
| Workspace (dormant) | `Workspaces`, `MountSource` | `@kantel/workspace/memory` | `registerWorkspaceConformance` | [workspace](packages/workspace/CONTRACT.md) |
| Sandbox (dormant) | `Sandboxes`, `routeTool` | `@kantel/sandbox/memory` | `registerSandboxConformance` | [sandbox](packages/sandbox/CONTRACT.md) |
| Browser (dormant) | `Browser`, `BrowserProvider` | `@kantel/browser/memory` | `registerBrowserConformance` | [browser](packages/browser/CONTRACT.md) |

The compute plane's own API (`@kantel/compute`, `@kantel/hosts`) is tested in its packages rather than through a
suite.

## Names

The product was called Harbour, and for a day Partan, before it was renamed Kantel. Packages are `@kantel/*`, settings
`KANTEL_*`, headers `kantel-*`, new API keys `ktk_…`, sign-in sessions `kts_…` and host join tokens `kth_…`. What was
named before the rename still works: a `HARBOUR_*` setting when its `KANTEL_*` one isn't set, a `harbour-*` header,
an `hbr_` or `hbs_` token, the `harbour` browser provider and the `harbour` and `harbour-light` theme IDs.
The repository moved from `tvdavies/harbour` to `lleverage-ai/kantel`; GitHub redirects the old name. Some names stay
as they are, because something outside the code holds them: the deployed Workers (`harbour`, `harbour-dev`) and hostname (`harbour.myslop.app`), the D1 databases and R2 buckets,
the browser and sandbox Durable Object classes (`HarbourBrowser`, `HarbourSandbox`) and their container apps, stored
names such as the self-hosted `harbour` Postgres schema, and `harbour/*` keys in tool calls' `_meta`.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
