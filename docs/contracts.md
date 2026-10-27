# Harbour contracts

Harbour is built against a set of TypeScript contracts. Each contract has three parts:

- **The interface** in `@harbour/contracts` (`packages/contracts/src`). It does not depend on Pi or on any provider
  SDK, so a deployment target can implement it with Cloudflare, AWS, Kubernetes or a single process.
- **A reference implementation** that runs in memory (`@harbour/<name>/memory`). It is the executable specification
  and the implementation the local dev loop uses.
- **A conformance suite** in `@harbour/testing`. Every target must pass it unchanged.

The suites follow the pattern of Pi Durable's `registerEnvConformance`. Each suite exports a
`create<X>Conformance({ assertions, provider })` that returns plain `{ name, run }` cases, plus a
`register<X>Conformance(runner, name, provider)` that registers them with any runner that has `describe`, `it` and
`expect`. The provider builds a fresh subject for every case from the deps the suite passes in (`ManualClock`,
`RecordingAuditSink`), then calls `use(subject)`. A target proves itself in one file:

```ts
import { registerVaultConformance } from "@harbour/testing/vault";
import { describe, expect, it } from "vitest";
import { createD1Vault } from "../src/d1.ts";

registerVaultConformance({ describe, expect, it }, "D1 vault", async (deps, use) => {
	const vault = await createD1Vault({ clock: deps.clock, audit: deps.audit, database: await freshDatabase() });
	await use({ vault });
});
```

Errors are `HarbourError`s with a code (`invalid`, `not_found`, `forbidden`, `conflict`, `expired`, `refused`,
`aborted`, `unavailable`). Records from another organisation are `not_found`, never `forbidden`, so that IDs leak
nothing. Every call takes a `CallContext` that names the actor (`human`, `agent`, `service` or `system`) and the
organisation. Every change made on a caller's behalf is audited through an `AuditSink`, with its actor. The scheduler's own
bookkeeping (materialising and claiming occurrences) lives on the occurrence records instead. No audit event contains a secret
value; each suite plants `CANARY_SECRET` and checks for it.

## The contracts

| Contract | Interface | Reference implementation | Suite (cases) | Notes |
| --- | --- | --- | --- | --- |
| Identity and tenancy | `IdentityDirectory` | `@harbour/identity/memory` | `registerIdentityConformance` (18) | [identity](../packages/identity/CONTRACT.md) |
| Session runtime | `SessionRuntime`, `SessionDirectory`, `AgentProfiles`, `HostToolBridge` | `@harbour/runtime/memory`, on Pi Durable 1.4.0 | `registerRuntimeConformance` (14) | [runtime](../packages/runtime/CONTRACT.md) |
| Client wire protocol | `SessionStream`, frames, `applyDelta` | `@harbour/protocol/memory` | `registerProtocolConformance` (9) | [below](#client-wire-protocol) |
| Workspace | `Workspaces`, `MountSource` | `@harbour/workspace/memory` | `registerWorkspaceConformance` (15) | [workspace](../packages/workspace/CONTRACT.md) |
| Sandbox | `Sandboxes`, `routeTool` | `@harbour/sandbox/memory` | `registerSandboxConformance` (14) | [sandbox](../packages/sandbox/CONTRACT.md) |
| Vault | `Vault` | `@harbour/vault/memory` | `registerVaultConformance` (41) | [vault](../packages/vault/CONTRACT.md) |
| Capability registry and host tools | `CapabilityRegistry` (host tools: `HostToolBridge`) | `@harbour/codemode/memory` | `registerCapabilityConformance` (17) | [codemode](../packages/codemode/CONTRACT.md) |
| Browser | `Browser`, `BrowserProvider` | `@harbour/browser/memory` | `registerBrowserConformance` (24) | [browser](../packages/browser/CONTRACT.md) |
| Skills | `Skills`, `SkillSource` | `@harbour/skills/memory` | `registerSkillsConformance` (15) | [skills](../packages/skills/CONTRACT.md) |
| Memory | `Memory`, `MemorySource` | `@harbour/memory/memory` | `registerMemoryConformance` (19) | [memory](../packages/memory/CONTRACT.md) |
| Schedules | `Schedules` | `@harbour/schedules/memory` | `registerSchedulesConformance` (23) | [schedules](../packages/schedules/CONTRACT.md) |
| Audit | `AuditStore`, `AuditOutbox`, `AuditSink` | `@harbour/audit/memory` | `registerAuditConformance` (17) | [audit](../packages/audit/CONTRACT.md) |

The capability registry lives in `@harbour/codemode`, where the plan's layout puts code mode, because direct tools,
code-mode scripts and saved programs all call the same registry.

## Settled decisions the suites enforce

These come from the plan and cannot be changed by a target.

- **Binding codes.** Every vault proposal gets a binding code, such as `K7Q-2MX`. The approver sees the real code once,
  among at least three decoys, and must pick it to approve a write, a route grant or a secret paste. A wrong or missing
  code is refused, changes nothing and is audited as `vault.binding_code.mismatch`. The proposal stays pending. The
  vault derives a proposal's kind from its terms, so an agent cannot avoid the code by calling a write a read.
- **Agents never decide.** An agent actor cannot open the approval view, decide a proposal, or change items, policies
  or the ceiling. Identity never authorises an agent actor. Agents are meant to be authorised through their session, but
  the in-memory runtime and sandbox do not check that yet (open question 7).
- **Browser contexts are chosen by a supervisor or a human.** Only a human, a service, or an agent acting in the
  parent session may grant a context to a session. An agent granting to its own session, or to an unrelated one, is
  `refused` and audited. A parent-session agent may only pass on a context it already holds through an active grant,
  never wider (persistence, timeout and sites), and the passed-on grant ends when its own does. Tom confirmed this
  rule on 27 Oct 2026 (settled question 10). An agent cannot list or create contexts. It asks with a request that names no context, and
  opening with a context its grant does not hold is `refused`. It receives only a session-scoped CDP URL, never the
  provider's context ID. Only one persisting browser session may be open per context, and ending the agent session
  closes every browser and ends its grants.
- **Grants are rechecked on every call.** A capability call is checked against the caller's grants each time, retries
  included, and journalled by call ID. A committed call replays its result. A crashed `unsafe` call is never rerun: it
  is `refused` until an operator resolves it.
- **Memory changes only through approved proposals.** Agents propose; humans and services apply. A learned fact can
  never overwrite what the owner set, and a near-duplicate `remember` is flagged and cannot be applied.
- **Published skills never change.** A revision is immutable and pinned per session. Publishing needs the digest of
  the draft that was reviewed. A skill grants nothing.
- **Schedules never overlap.** Occurrences are unique per schedule and due time, missed runs coalesce into one, a
  claim is exclusive under a lease, and calendar times follow the schedule's time zone across DST.
- **Project files are a read-only mount.** `/project` (any absolute mount point) is pinned to a version and read-only.
  A workspace commit under it is `refused` and audited. A write from either sandbox tier fails and leaves both the
  source and the workspace unchanged. Changes to project files go through `MountSource.write`, as an operator action.
- **Tier routing.** Tools go through the route table: ordinary shell and file work runs in the isolate, and real binaries
  (`git`, `node`, `bun`, `python` and others) run in the container. The container sees the isolate's latest commit.
  Ending a session releases every lease it holds.
- **Keys are scoped.** A host API key scoped to one project cannot act in another project of the same organisation, or
  in another organisation. Its secret is returned once and stored only as a hash. Identity enforces this; workspace
  mounts, vault items and sandbox leases do not yet check the caller's project (open question 7).

## Client wire protocol

`@harbour/protocol` defines what a console receives for one session. On connecting, the client sends
`{ type: "hello", v: 1, after? }`. The server answers with `hello` (`resumed` true or false), then a `snapshot`, unless
it can resume after the client's cursor. After that it sends `delta` frames. A `history` request pages earlier items.

- A snapshot holds at most one page of items and says whether there are earlier ones.
- A delta is a list of ops: `append`, `replace` (by item id), `text` (streamed text appended to an assistant item),
  `status`, `title` and `usage`. Each delta carries the cursor it leads to.
- `applyDelta` and `applyFrames` rebuild state on the client and keep untouched items as the same objects, so a UI can
  re-render only what changed.
- Transcript items are `user` (with `via: "prompt" | "steer" | "followUp"`), `assistant`, `tool` (with a
  plain-language label), `notice` and `card`. Cards carry structured UI such as `vault.approval`, which includes the
  binding code.
- Status carries an attention level from `attentionFor(status)`: `working`, `waiting` (needs a human) or `done`.

The suite checks the following:

- A fresh connection gets hello, then a snapshot.
- Live deltas applied to the first snapshot equal a fresh snapshot.
- A held cursor resumes with only the later deltas.
- An unknown cursor, or one older than the retained deltas, falls back to a snapshot.
- Snapshots are bounded, and history pages back to the first item.
- Untouched items keep their identity.
- A closed connection gets nothing more.
- An approval card arrives with its code.

The runtime's `ConversationProjector` (`packages/runtime/src/project.ts`) turns Pi Durable's committed view into these
ops, so every target streams the same items.

## Audit

`AuditEventInput` has a dotted `type` (`vault.decision.approved`, `workspace.committed`, `sandbox.lease.released`,
`identity.key.issued` and so on), an actor, an organisation, and an optional project, session, agent and subject. It
carries a stable `id`, so that a retried operation does not record the same event twice. `AuditSink.append` takes a
batch.

Components never write to the store directly. They append to an `AuditOutbox`, which a relay drains to the
`AuditStore`. A failed drain keeps its events queued, and a retried one delivers each event once, in order, because
the store and the outbox are idempotent by organisation and id. The store is append-only. It can be queried by project, session, agent, actor, source,
type prefix, subject and time, with paging by sequence that stays stable while rows are appended. Only an
organisation's retention removes rows; deleting a session leaves them. Every row has an actor, and agents cannot
query the store. Each component's suite also checks the events that component emits, and that the canary secret
never appears in them.

## Vault design reference: Mehen

The vault's vocabulary and flows were checked against the public site of [Mehen](https://mehen.dev/), a credential
vault and proxy for AI agents. The check covered the site only. Its documentation at `https://app.mehen.dev/docs` needs
a sign-in and was not read. No code or text was copied. Where the two agree, Harbour keeps its own names:

| Harbour | Mehen's public site | Choice |
| --- | --- | --- |
| Agents and sandboxes never hold a value; egress injects it | "Agents get capabilities, never secrets" | Same principle. The vault's records, audit events and approval views never carry a value; the suite plants a canary to check. |
| `VaultItem.hosts` and `RouteScope` (host, methods, path prefix) | Each credential is "bound to hosts, paths and methods"; anywhere else is refused | Aligned. Harbour adds the organisation's ceiling as an outer bound. Prefixes match whole path segments and values go out only over https. |
| `InjectionRule` (`header`, `template` such as `Bearer {key}`) | Not described on the site | Harbour's own: the egress proxy injects the header. |
| `VaultItem.placeholder` (`harbour://<name>/<6 hex>`) | `mehen run` gives programs a placeholder (`mehen://<credential>/<id>`) that becomes the real key only on the way to a bound host | Adopted the idea: a sandbox's environment holds the placeholder, and the proxy swaps it only for a bound host. The id is random and never derived from the value. |
| `EgressDecision.fix` | A refusal "says the fix" (ask a human, with a link) | Adopted. Every denial carries a `fix`: `propose` (a proposal could allow it) or `none` (outside the ceiling). |
| Secret proposals with a link (`Proposal.link`) | Intake links: the human types the key into the vault's page, never into the chat, and the link expires | Aligned. A secret is pasted only into the vault's approval page, needs the binding code, and expires with the proposal. |
| Proposals, `decide`, `waitForOutcome` | Risky calls are "held for approval"; the agent waits; agents cannot approve | Aligned. Harbour also lets the approver narrow the terms. It tells the waiting agent the effective terms and that no request has run yet. |
| `ProposalKind` derived from terms (`read`, `write`, `route`, `secret`) | Rules decide what waits: writes, production, new hosts | Aligned on writes and new hosts. Production is a policy question for the capability contract (second PR). |
| `VaultPolicy` (standing rules) and `Grant` (one approval's effect) | Bindings and rules; no separate grant concept is shown | Harbour separates admin policies from per-session grants. Grants carry uses and expiry. |
| Binding codes | Approval with a passkey; machine enrolment by matching words | Different mechanism, same aim: the human proves they saw this exact request. Harbour's binding code (picked from decoys, tied to a terms hash) is settled in the plan. A passkey can be added as the approver's authentication later. |
| `VaultUse` and `vault.*` audit events | A "crossings" log of every decision (allowed, held, refused) | Aligned. Every egress decision is a `VaultUse`, and decisions are audited. |
| Relay (the vault makes the call and scrubs the response) | Offered alongside placeholders | Not in M0. Harbour's egress proxy injects in flight and does not relay. Response scrubbing belongs to the capability contract. |
| OAuth connections | "Connect my Gmail": tokens go to the vault | Not in M0. It is a later item kind. |

## Open questions

Each package's `CONTRACT.md` lists its own. The ones that cut across packages:

1. **Bootstrap context.** `CallContext` needs an `organisationId` before the first organisation exists. The memory
   implementation passes a placeholder. Should the contract define a bootstrap context?
2. **Who checks project roles for sessions.** It could be the runtime, or the gateway in front of it.
3. **Pi types in `@harbour/runtime`.** The projector and the host-tool adapter take Pi types, so targets can reuse
   them. Hosts still import only `@harbour/contracts`.
4. **Ceilings.** An organisation without a ceiling is bounded only by item hosts. Should every organisation start with
   an explicit one?
5. **Container sync.** How a real container picks up isolate commits while its lease is live, and whether `aborted`
   and `session_ended` releases commit the container's changes.
6. **Users across organisations.** `User` has no organisation, so which organisations can see a user is an
   implementation choice for now.
7. **Project scoping beyond identity.** The in-memory workspace does not check that the caller owns a mount's ref.
   The vault lets an agent propose against another project's item, although a human must still approve it with the
   code. The sandbox and runtime do not check that an agent acts only in its own session. These checks need a shared
   way to authorise a `CallContext` (identity plus the session directory) and suite cases in each contract, before any
   target ships these services. Skills' `list` and `pinForSession` take a project and user from the caller without
   checking them, and memory spaces are scoped by organisation only.
8. **Session-end wiring.** Ending a session should release its sandbox leases (done), close its browsers
   (`Browser.endSession`) and end its capability and vault grants. The runtime calls only the sandbox today. The
   other calls belong in M1-BE1, behind one session-end hook.
9. **Reading browser requests.** The browser contract has no read for an agent's requests, so "granted" is visible only
   through audit. `getRequest` and `listRequests` are the likely additions, with a way to decline.
10. **Agent supervisors and browsers. Settled: yes, as built (Tom, 27 Oct 2026).** An agent in the parent session
    counts as a supervisor. It may pass a context it holds to its child session, no wider, and the passed-on grant
    ends when its own does.
