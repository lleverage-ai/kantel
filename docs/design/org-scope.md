# Organisation-scoped sessions and layered resources

Status: agreed with Tom on 30 Oct 2026; being built in the PRs listed at the end. This page records the design and the
decisions made while scoping it.

## Why

Harbour's tenancy is platform > organisation > project > session. Users are global and hold `viewer`, `operator` or
`admin` on a project or across an organisation. Most of the resources an agent uses can already be owned by the
organisation: skills (platform, organisation, project or user, the most specific owner wins a name), memory spaces
(organisation, project or user), model connectors (platform or organisation, projects narrow), vault items
(organisation or project, under the organisation's ceiling) and workspaces (project, organisation, user or platform).

What's missing is an agent that works at organisation level. An agent is authorised only through its own session, in
that session's project (`ProjectAccess`, settled question 7), and every session has a project. Erys (a personal
assistant per user), Sal (one assistant across many projects) and Lleverage (organisation-wide agents beside project
ones) all need agents above a project, with organisation-level skills, files, memory and rules as well as
project-level ones.

## Decisions

### 1. A session is scoped to an organisation or to a project

`SessionRecord.projectId` becomes optional: a session without one is **organisation-scoped**. `sessionScope(record)`
in `@harbour/contracts` gives `{ kind: "organisation" }` or `{ kind: "project", projectId }`, and every component reads
the scope from it rather than from `projectId` directly.

`CreateSessionInput` keeps `projectId` and adds `scope?: "project" | "organisation"` (default `project`). Creating
needs an explicit choice, so a caller that forgets `projectId` still gets `invalid` ("A session needs a project"), as
the existing conformance case expects, rather than an organisation session by accident:

- `scope: "project"` (or absent) needs `projectId`, as today.
- `scope: "organisation"` must not name a project (`invalid`).
- A child session is in its parent's scope. Naming another scope for a child is `invalid`.
- An organisation-wide agent profile (no `projectId`) runs in either scope; a project's profile runs only in its
  project, so never in an organisation session (`invalid`).

`SessionFilter` gains `scope?: "organisation" | "project"` so a list can ask for only one kind. `HostToolCall`,
`SessionEnd` and the audit rows carry `projectId` only when the session has one.

### 2. `ProjectAccess` becomes a scope check

The check keeps its name and its shape, because every component and the sharing work in flight call it, and renaming
it in the same week would only make conflicts. `ScopeAccess` is exported as an alias, and the doc comment describes it
as a scope check. What changes is how a check resolves and how agents are judged.

A check resolves to one **scope**: the project it names, else the project of the session it names, else the
organisation. `AccessResult` gains `scope: AccessScope` (`{ kind: "organisation" }` or `{ kind: "project", projectId }`)
next to the existing `projectId`.

- **`system`** passes, as today.
- **Humans and services** need `needed` on the scope: for a project scope, a binding on the project or across the
  organisation (unchanged); for the organisation scope, a binding across the organisation (unchanged: `roleOf` with no
  project counts only organisation-wide bindings). An API key holds roles only on its projects, so a key never passes an
  organisation-scope check; organisation-wide keys are designed in [org-api-keys.md](org-api-keys.md).
- **Agents** act only through their own open session and its children, as an operator, never an admin (unchanged).
  New: the agent's own session must be **in the scope the check resolved to**. A project agent passes project-P checks
  only when its session is in P (unchanged); an organisation agent passes organisation-scope checks, and **no project's
  checks at all**. A project agent still fails an organisation-scope check unless the check names its own session
  (which resolves to its project), exactly as today.

Every settled rule stays as it is: records in another organisation are `not_found`; within one, `forbidden` stays
distinct from `not_found`; a refusal says the same thing whichever rule failed, holds no secret and is audited once as
`access.denied`; worker calls still take a `SystemContext` and `requireSystem`.

**Sharing.** The cross-project sharing primitive (shares, access requests and resource-level bindings, being built at
the same time) sits on this check. `AccessScope` is the shape it should use for an owner or grantee at organisation or
project level, so "shared with the organisation" is a grantee kind like "shared with project P", and the check that
resolves a session's scope is the one place both read.

### 3. What an organisation-scoped agent can reach (least privilege)

An organisation agent sees what the organisation owns, and the session's user's own, and **nothing a project owns**
unless that project shares it explicitly (through the sharing primitive, once it lands). It does not get into every
project because its organisation is above them.

| Resource | Organisation agent | Project agent (unchanged) |
| --- | --- | --- |
| Sessions | its own and its children, which are organisation-scoped too; it can't start a project session | its own and its children, in its project |
| Skills | platform, organisation, the session user's | platform, organisation, its project's, the session user's |
| Memory | organisation spaces and the session user's; a project's space is `forbidden` | organisation, its project's and user spaces |
| Prompt rules | platform, organisation, profile, user | platform, organisation, project, profile, user |
| Vault | proposals for organisation-owned items; a project's item is `forbidden` | its project's items and the organisation's |
| Models | the organisation's and platform connectors and routes; no project policy applies | as today, after its project's policy |
| Files | its workspace, and `/org` (read-only); a `/project` mount is `forbidden` on every read | its workspace, `/project` and `/org` |
| Browser, capabilities, sandbox | as today: by its session's grants and leases | as today |
| Audit | never (agents can't query audit) | never |

Downward inheritance is unchanged: what the organisation owns is visible in every project, so project agents keep
seeing organisation skills, memory, rules and `/org`.

**The session's user.** `SessionRecord.userId` (optional, new) is the person a session works for. It defaults to the
creator when that is a human. A service or Harbour may name a user when it creates a session (a host app running one
assistant per person, as Erys would); a human may name only themselves; an agent's child inherits its parent's. It
picks the user layer of skills and prompt rules, and later user-owned vault items. It grants no role: the user's own
resources are already readable across their organisation.

### 4. Organisation files: a read-only `/org` mount

`@harbour/workspace/mounts` gains `createWorkspaceOrgFiles({ workspaces, access? })`, the `org-files` source, beside
`project-files`. Each organisation's files are a tree in a workspace under `orgFilesWorkspaceId(organisationId)`, owned
by the organisation. A mount's `ref` is the organisation ID, which must be the caller's (another is `not_found`).

- Mounting it (`create`, `remount`) and every `read`, `stat` and `list` through it check the source on every call, with
  nothing cached (the settled question 11 rule). Organisation files are open to the organisation's members, as
  organisation skills and memory are, so the source check is the organisation's: the caller must still be able to read
  the workspace it reads through, checked again on each read, and the ref must be the caller's own organisation.
- `write` needs operator on the organisation scope (`workspace.org-files.write`): a human or service with an
  organisation-wide role. Agents don't write organisation files through the mount; a commit under `/org` is `refused`
  like any mount.

### 5. Layered prompt rules

Prompt layers live only on `AgentProfile.promptLayers` today. A new contract, `PromptRules` (`rules.ts`), stores named
rules owned by the platform, an organisation, a project or a user, and resolves them for a session in order
**platform → organisation → project → profile → user**, as skills are layered, with each owner's rules ordered by an
explicit `order` and then name.

- Harbour injects nothing (the clean-prompt decision, #143). The platform layer is empty until the deployment's operator
  (a `system` caller) adds rules to it.
- An organisation session has no project layer.
- Rules are fixed when a session is created, like pinned skill revisions: the runtime resolves them once and stores the
  joined layers with the session's profile copy, named `rules:<owner kind>:<name>`, so a restart or a reopened session
  runs the same prompt and an edit reaches only new sessions.
- Writes: organisation rules need an organisation-wide admin, a project's rules admin on the project, a user's rules
  that user (or an organisation-wide admin), platform rules `system`. Agents never write rules. Reads follow the owner:
  a project's rules need viewer on it; organisation, platform and user rules are open to the organisation.
- Every change is audited (`rules.rule.put`, `rules.rule.removed`) with the rule's ID and owner, never its text.

### 6. User-owned vault items

In scope (Tom, 30 Oct 2026: "build them now"), as the stack's sixth PR. A personal credential (my Gmail, used by an
agent in a shared project) must not become the organisation's. The vault already accepts a user owner
(`{ kind: "user", organisationId, userId }`) but treats it like the organisation's (an open question in the vault
contract). From this PR it is its user's:

- **The scope check learns a user owner.** `AccessCheck.userId` says the record belongs to that user. A person passes
  only as that user (another person, an organisation admin included, is `forbidden`); a service needs the role
  organisation-wide, as for the organisation's records (a host app acting for its users, as it may name a session's
  `userId`); an agent passes only through its own open session, as an operator, when that session's `userId` is the
  owner, whether the session is a project's or the organisation's. A check that also names a project or session needs
  that too, as before.
- **Managing it** (`putItem`, `putPolicy`, `revokePolicy`): its user, or a service with an organisation-wide admin
  role. Agents never.
- **Seeing it** (`getItem`, `listItems`, and the policies on it in `listPolicies`): its user, a service with an
  organisation-wide role, and agents whose session works for its user. Others get `forbidden` on a read, and lists leave
  it out: it never shows up as the organisation's.
- **Using it.** `propose` naming it passes only for its user, or an agent whose own session works for its user; the
  proposal is in that session's project, or the organisation for an organisation session. Only its user (or a service
  with an organisation-wide operator role) opens the approval view or decides: a project operator can't approve someone
  else's credential. Egress injects it only for a request whose agent's open session works for its user, checked on
  every decision; without project access, or without the request's agent and session, it is never injected. The
  organisation's ceiling still bounds every route. A model connector never reads one.
- **Unchanged.** Grants stay the session's records (project operators may still stop one), new secrets proposed by an
  agent are still the organisation's or the project's, and the existing vault cases are unchanged. Storage needs
  no migration: the owner is in each item's JSON, and the row's organisation column is the user's organisation.
- **Console.** Items are made by host apps (no console screen creates one), so the console change is on the approval
  page: a request for a personal item carries a "Your personal item" badge for its owner. Anyone else who can see the
  request (an operator on the session's project) can't read the item, so the page shows "A credential", read-only,
  and says the credential may be someone's personal one. The fixture gains an open proposal for one.

With the sharing primitive (docs/design/sharing.md in that stack), `ResourceCheck.owner` of kind `user` is the same
owner. Its owner rule should take this one: an agent passes `use` through a session that works for the user, and a
change needs the user or a service, not any organisation admin.

## Contract changes by package

| Package | Change |
| --- | --- |
| contracts `common.ts` | `AccessScope`, `sessionScope` |
| contracts `access.ts` | scope resolution, the agent rule above, `AccessResult.scope`, `ScopeAccess` alias |
| contracts `session.ts` | `SessionRecord.projectId?`, `userId?`; `CreateSessionInput.scope?`, `userId?`; `SessionFilter.scope?`; `SessionEnd.projectId?`; `HostToolCall.projectId?`; `SessionModelsStart` as create |
| contracts `rules.ts` | new: `PromptRule`, `PromptRules`, `resolvePromptLayers` |
| runtime | create and list for both scopes; rules resolved at create; SQL store stores `project_id = ''` for an organisation session |
| workspace | `org-files` source and `/org`; `sessionSkillVisibility` gives an organisation session no project and its user |
| skills, memory | no contract change: an organisation session's visibility has no project, and the scope check refuses project-owned records |
| vault, browser, codemode, models, schedules | no contract change; they read `sessionScope` where they read `projectId` today |
| api, gateways | `POST /v1/sessions` takes `scope`; `GET /v1/sessions?scope=`; `/v1/rules` routes |
| console | a scope picker (Organisation or a project) on new sessions, the session list, skills, memory and rules |

## Conformance

Existing cases are not changed; new ones are added under an `organisation scope:` prefix and run with
`{ projectAccess: true }`, so every target that runs project access runs them too:

- access (`packages/testing/test/access.test.ts` and the harness): an organisation agent passes organisation checks
  and fails every project's; a project agent still fails an organisation check that names no session; an
  organisation-wide human passes, a project-only human and an API key don't.
- session: create with `scope: "organisation"` (an organisation-wide operator may, a project operator may not, a project
  profile is `invalid`); a child of an organisation session is organisation-scoped; lists by scope; an organisation
  agent can't create a project session.
- skills: an organisation session lists platform, organisation and user skills and no project's.
- memory: an organisation agent recalls from an organisation space and is refused a project's.
- workspace: `/org` reads, with the source checked on every read, and a commit under `/org` refused.
- rules: a new `registerRulesConformance` suite (writes by owner, agents refused, resolve order, the organisation
  session has no project layer, audit without text).
- vault, under a `user items:` prefix: only the user or an organisation-wide service makes one, an organisation admin
  and another person are refused and don't see it listed; agents see and propose for it only through a session working
  for its user (project or organisation); only its user opens the approval view and decides, a project operator and an
  organisation admin are refused; egress injects it only for its user's open sessions and never names it in another
  session's fix, under the ceiling; its policies are its user's to list and revoke; a model connector never reads it.
  The access unit test covers `AccessCheck.userId` for each actor kind.

The in-memory reference implementations pass all of them; the Cloudflare and self-hosted targets register the same
suites and must pass unchanged.

## Data migration

- Sessions: no schema change. The session table's `project_id` column is `NOT NULL`, and SQLite (D1, Durable Object
  SQLite) can't relax that without rebuilding the table, so an organisation session stores `project_id = ''`. The JSON
  record is the source of truth and has no `projectId`. `''` is never a project ID (create already refuses it), so no
  project filter matches it. Existing rows are all project sessions and need nothing.
- Rules: a new table (`<prefix>prompt_rules`), created by a migration in the rules store. No backfill: profile
  `promptLayers` stay where they are as the profile layer.
- Organisation files: a workspace under a derived ID (`of_…`, as project files use `pf_…`), created on first use.
  Nothing to migrate. Like `/project`, no target mounts `/org` into a session's workspace on its own yet: a host
  registers the source with its workspaces and names the mount when it creates a workspace.

## Public API and console

- `POST /v1/sessions` takes `scope` (`project` by default) and `projectId` only for a project session; `GET
  /v1/sessions` takes `scope`. The SDK and OpenAPI document are regenerated.
- `GET /v1/rules?owner=…`, `GET /v1/rules/{ruleId}`, `PUT /v1/rules`, `DELETE /v1/rules/{ruleId}`, and
  `GET /v1/rules/resolved?projectId=` (what a new session would get). The console's Rules page (`/rules`) lists and
  edits each owner's rules and previews the resolved order for the organisation or a project.
- The console gains an **Organisation** entry above the projects: its sessions, and a new session there. The skills,
  memory and rules screens get a scope picker (Organisation, or one of the projects) for what they show and where a new
  one is owned. Screenshots go in each PR.

## PRs

Stacked, each with its base in its description:

1. This design note.
2. Contracts and the scope check, the reference runtime (memory and SQL) for organisation sessions, and the new
   conformance cases, with both targets passing.
3. Public API and gateways for organisation sessions, and the console's Organisation entry and scope picker.
4. `/org` files: the `org-files` source and its workspace conformance cases (taken before prompt rules, being the
   smaller change).
5. Prompt rules: contract, reference and SQL store, suite, runtime layering, API and console screen.
6. User-owned vault items: `AccessCheck.userId`, the vault's user scope, the `user items:` cases, and the approval
   page's personal badge.

## Follow-ups

Out of scope here:

- A platform-level host key that creates organisations and users, for self-serve sign-up.
- External identities (users and organisations matched to a host's by external ID).
- Token exchange (a short-lived token for one user and session, from the host's backend).
- Metering of sandbox, browser and storage use.
- A billing limits API.
- Organisation-wide API keys: a key that can act at organisation scope (create organisation sessions, write
  organisation rules) for host apps. Today a key holds roles only on its projects, and #253 is adding key permissions;
  the two should be designed together.
- A personal secret paste: a `secret` proposal that creates an item owned by the session's user, not the
  organisation or project. Today an agent's new secret is still the organisation's or the project's.
- Schedules owned by an organisation that start organisation sessions.
