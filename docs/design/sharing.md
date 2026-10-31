# Sharing across projects

Approved by Tom on 30 Oct 2026 (TASK-4035). Resources that cut across projects (skills, memory spaces, vault items,
workspaces, model connectors, and a host's own kinds) can be shared into other projects at a fine grain. A share is
either assigned outright or requested and then granted or rejected, and every step is recorded with provenance.
Separately, each resource can name who maintains it and who approves edits to it. Kantel is the source of truth for
shares and grants; the runtime and the components enforce them when a session uses a resource. Host apps drive it all
over the public API and bring their own UI, so it works headless first.

Contracts: `packages/contracts/src/sharing.ts`. Check: `ProjectAccess.resource` in `packages/contracts/src/access.ts`.
Store: `@kantel/sharing` (`packages/sharing`), in memory and on SQL (D1, SQLite, Postgres). Conformance:
`@kantel/testing/sharing`.

## Model

**Resource.** `{ kind, id, revision? }`. Kantel's own kinds are `skills.skill`, `memory.space`, `vault.item`,
`workspace` and `models.connector`, named as their audit subjects already are. A host may share its own kinds (such as
a brand guideline) by registering each resource with its owner first (`Sharing.registerResource`); a host kind is any
other dotted lowercase name, and Kantel's component prefixes are reserved. The core holds no host's kinds.

**Share.** A resource, a grantee, a permission and provenance: who granted it and when, the request it answers, an
expiry, the share it was passed on from, and when and by whom it was revoked. A share without `revision` follows the
latest published revision; one with `revision` pins it.

- Grantee: a `project`, an `agent` (an agent profile, in every session that runs it), a `user`, or a `session`. The
  `session` grantee is what a supervisor passes on to a child session (see below).
- Permission, weakest first: `use` (list, read and run with it), `propose` (draft or propose a change), `edit` (change
  it), `approve` (publish a change or decide a proposal). Each includes the ones before it.
- `agentWrites`, off by default: whether agents the share covers may write through it (see below). Only an `edit` or
  `approve` share may turn it on.

**Access request.** A request for a share: the resource, the grantee it is for, the permission, a reason, the
requesting actor, and the session and agent it came from. Its status is `pending`, `granted`, `rejected` or
`withdrawn`; a decision records who decided, when, a note, and the share it created.

**Resource bindings.** Relation tuples in the Zanzibar style, `(object, relation, subject)`, stored in one SQL table:

- `(skills.skill:sk-1, maintainer, user:alice)`: Alice may edit the skill.
- `(skills.skill:sk-1, approver, group:reviewers)`: every member of the group may approve edits and decide requests.
- `(group:reviewers, member, user:bob)`: group membership, in the same table.

Subjects are users, services and groups. A group is an organisation's, and holds users and services, not other
groups (one level of expansion, so a check is two indexed reads).

**Policy.** Per resource, optional: `twoPersonRule`, under which whoever publishes an edit may not have written it.

## Who may do what

**Authority over a resource** (create a share, decide a request, manage its bindings and policy): a human or service
holding `approver` on it, directly or through a group; or, as the fallback, admin where the resource lives (its
project for a project's resource, across the organisation for an organisation's, the user themselves for a user's,
and only Kantel for a platform resource). Agents never hold it.

**Requests go to the resource owner's approvers**, not to the requesting project's admin. `Sharing.listRequests` with
`{ decidable: true }` is that inbox.

**Detaching.** An admin of the grantee's project may always revoke a share into their project (a `project` grantee, or
a `session` grantee in their project), whoever granted it.

**Agents** may request access, through their own session, for their own session, agent or project. They never create a
share for their own session or project. A supervisor may pass on a share it holds to a child session only: the new
share names the held one as its parent, for the same resource, at no wider permission, no later expiry and the same
pinned revision; it ends when the parent is revoked. The same narrowing rule as browser parent grants
(`packages/browser/src/memory.ts`, `noWiderThan`). It may let the child's agents write only when the held share does,
and passes on `edit` only then.

**Agent writes** (decided by Tom, 30 Oct 2026: a per-share opt-in). A share's granter may turn on `agentWrites` on an
`edit` or `approve` share, when creating it or when granting a request (`DecideRequestInput.agentWrites`). Through
that share, and only that one, agents it covers may `edit`: write the resource without a review step. They still never
`approve`, and the owner rules and bindings never give an agent `edit`. Without the flag nothing changes: an agent
gets at most `propose`, however strong the share. The flag is generic, not a workspace rule; today the workspace is
the one component whose agent writes are checked at `edit` (skills and memory check an agent's drafts and proposals
at `propose`), so in practice it lets agents write a shared workspace.

**Using** a resource in a project (`ProjectAccess.resource` with permission `use`):

- a platform or organisation resource: as today, any project of the organisation (see open question 1);
- a project's resource: that project, or any project, session, agent or user an active share covers;
- a user's resource: that user, or a share.

The actor must also have the usual project access to the project it uses the resource in. A pinned share covers only
its revision.

**Changing** a resource (`propose`, `edit`, `approve`) is separate from using it. It passes on any of:

- the existing role fallback on the owner (the component's authority, such as `SkillsAuthority.publish`);
- a binding: `maintainer` for `propose` and `edit`, `approver` for all three;
- a share with that permission, held through the project where the actor has the component's role, or as that user,
  session or agent.

Agents never pass for `approve`, and pass for `edit` only through a share with `agentWrites` on: otherwise they draft
only.

## Enforcement

One implementation: `ProjectAccess.resource(ctx, check)` decides every resource check, audits a refusal as
`access.denied` like any other, and returns how it passed (`owner`, `share`, `binding` or `system`), the share that
covered it and the resource's policy. `createProjectAccess` takes the store's read seam (`SharingLookup`); without one,
only the owner rules apply, which is today's behaviour. Components call it instead of reinterpreting shares:

- **Skills.** `SkillVisibility.shared` names skills owned elsewhere by ID; the runtime and the `/skills` mount pass
  the profile's `skills`. `pinForSession` and `list` add those a share covers (a refusal is audited and the skill left
  out); a share pinned to a revision pins that revision. Reads of a project's skill go through the check, so a session
  reads only the revision its share allows, and nothing once the share is revoked. Saving a draft needs `edit`
  (`propose` for an agent), publishing `approve` (the `SkillsAuthority` roles on the owner are the fallback); with the
  two-person rule, the publisher may not be one of the draft's authors, which the stores now record
  (`skill_draft_authors`).
- **Memory.** `requireSpace` checks a project's space through the check, so `memoryScopes` naming another project's
  is refused unless shared. Organisation and user spaces keep their rules. Proposals need `propose`, applying one or
  importing a snapshot `approve`; with the two-person rule, no one applies their own proposal. `Memory.getSpace` is
  new, for the resolver.
- **Vault.** A session may propose a grant on another project's item only while it is shared into its project; the
  proposal is in the requesting project and decided there, with its binding code, ceiling and routes unchanged. Egress
  rechecks the share for a grant on another project's item, so revoking it stops the grant's use. Policies are the
  item's admins' own and stand as set.
- **Workspaces.** Reading another project's workspace (not a session's own) needs `use`, writing it `edit`, which an
  agent holds only through a share with `agentWrites` on.
- A person or service acts in the call's project unless the check names one; as a member of the owner's project, they
  keep reading its resources from anywhere.
- **Model connectors** are organisation or platform resources, so they stay usable everywhere as today, narrowed by
  `ProjectModelPolicy`.

**Provenance.** When a session uses a resource through a share, the check records `(session, resource, revision,
share)` once (`Sharing.listUses`), so "which revision did this session run with, and under which share" has an answer.
Skill pins already record the revision.

## One pipeline

Every share, request and decision is audited under the `sharing` source in one shape: `sharing.share.created`,
`sharing.share.revoked`, `sharing.request.created`, `sharing.request.granted`, `sharing.request.rejected`,
`sharing.request.withdrawn`, `sharing.binding.added`, `sharing.binding.removed`, `sharing.policy.set`, with the
resource as `data.resource`, the grantee, the permission, the requester, and the decider and note on a decision. Share
events and grants carry `agentWrites`.

Vault and browser grants keep their own stores and terms (routes, binding codes, ceiling, sites, contexts) and are not
moved onto it in this change: their guarantees are settled and tested, and their decisions are made per use, not per
resource. Follow-up (open question 3).

## Public API

Under `/v1/sharing`, so it doesn't clash with file shares' `/v1/shares`:

| Route | Call |
| --- | --- |
| `POST /v1/sharing/shares`, `GET /v1/sharing/shares` | `createShare`, `listShares` |
| `GET /v1/sharing/shares/{shareId}`, `POST /v1/sharing/shares/{shareId}/revoke` | `getShare`, `revokeShare` |
| `POST /v1/sharing/requests`, `GET /v1/sharing/requests` | `requestAccess`, `listRequests` |
| `GET /v1/sharing/requests/{requestId}` | `getRequest` |
| `POST /v1/sharing/requests/{requestId}/decision`, `.../withdraw` | `decideRequest`, `withdrawRequest` |
| `GET /v1/sharing/bindings`, `POST /v1/sharing/bindings`, `POST /v1/sharing/bindings/remove` | bindings |
| `PUT /v1/sharing/policies`, `GET /v1/sharing/policies?kind=&id=` | `setPolicy`, `getPolicy` |
| `POST /v1/sharing/resources` | `registerResource` (host kinds) |
| `GET /v1/sharing/uses?sessionId=` | `listUses` |

Built in `@kantel/api` (`sharingRoutes`, tag `sharing`) and served by `@kantel/sharing/http` on both deployments.
List filters come as pairs (`resourceKind` and `resourceId`, `granteeKind` and `granteeId`, `objectKind` and
`objectId`, `subjectKind` and `subjectId`); half a pair is `invalid`. A grant or reject is
`{ decision: "grant" | "reject", permission?, agentWrites?, expiresAt?, revision?, note? }`, narrowing only, except
`agentWrites`, which is the decider's to give. A share in a response always has `agentWrites` (`false` unless turned
on); `agentWrites: true` on a `use` or `propose` share or grant is `invalid`.

## Decisions made here

1. **Organisation and platform resources stay visible everywhere.** The brief says resources owned outside the
   session's project need a share. Read literally that would cut every project off from the organisation's skills,
   vault items and all model connectors (which are never project-owned). So shares are required for another
   project's or another user's resources, and organisation-wide resources keep today's behaviour.
2. **A `session` grantee**, besides project, agent and user, so a supervisor can pass a share to one child session
   without widening it to every session of that agent profile.
3. **Permissions are a ladder** (`use` < `propose` < `edit` < `approve`), so one share answers "may use" and "may
   change" without combining several.
4. **Bindings are not shares.** A binding names a person, service or group on one resource and holds anywhere; a share
   names a project, session, agent or user and holds there. Both answer the change checks; only shares answer `use`.
5. **Draft authors** are every actor who saved the open draft since the last publish. The two-person rule refuses a
   publisher who is one of them.
6. **Group subjects** are flat: groups hold users and services, not groups.
7. **A `user` grantee** covers that person acting as themselves, not sessions they started.
8. **Agent writes are a per-share opt-in** (Tom, 30 Oct 2026; was open question 6). `agentWrites` lifts an agent to
   `edit`, never `approve`, through that share only. It is on the share, not the request: a requester asks for a
   permission, and only the owner's side decides whether agents may write with it. A stored share made before the
   flag existed reads as `false` (`migrateSharing` adds the column with that default).

## Open questions

1. **Narrowing organisation resources.** Should an organisation's resource be restrictable to the projects it is
   shared with (a per-resource `restricted` flag)? Proposed: yes, as a policy field, once a host needs it.
2. **Expiring requests.** Pending requests don't expire. Should they, and after how long?
3. **Vault and browser on the shared pipeline.** Route vault proposals and browser requests through `AccessRequest`
   rows (so one inbox lists them) while keeping their terms, binding codes and passkeys in their own stores. Needs a
   design pass on who decides: vault decides per use in the requesting project, sharing decides per resource on the
   owner's side.
4. **Revoking what a session already has.** Revoking a share stops new uses and later reads; a skill already rendered
   into a running session's context stays there until the session ends.
5. **Vault items on Cloudflare.** The Cloudflare vault runs in its own Durable Object without project access, so its
   items can't be shared yet (the stack has no resolver for `vault.item`). Self-hosted and in-memory vaults enforce
   shares. Follow-up: give the vault object the stack's access, or resolve items over its RPC.
6. **Asking for agent writes.** A request can't ask for `agentWrites` today; the decider turns it on. Should a request
   carry it, so an agent can say it needs to write? Proposed: add it if hosts need it, as a hint the decider may drop.
