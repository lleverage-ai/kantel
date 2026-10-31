# Organisation-wide API keys

Status: built (TASK-4197, 31 Oct 2026), with the open question decided: an organisation key is capped at `operator`,
and a `create_projects` permission lets one create projects (see [Decision](#decision-capped-at-operator)). It follows
#253 (key permissions, merged 30 Oct 2026) and the organisation-scope stack ([org-scope.md](org-scope.md)). Where the
build differs from the proposal below, [As built](#as-built) says so.

## Why

A host app calls Kantel with an API key. Today a key is a service's, holds one role, and acts only in its listed
projects (`ApiKey.projectIds`, `ApiKey.role`). `IdentityDirectory.roleOf` gives a key no organisation-wide role, so a
key never passes a check that resolves to the organisation (org-scope.md, decision 2). A host app therefore cannot,
with its key:

- create or list organisation-scoped sessions (`POST /v1/sessions` with `scope: "organisation"`);
- write organisation prompt rules, organisation skills or organisation memory;
- create a user's vault item for one of its users (org-scope.md, decision 6, needs a service with an
  organisation-wide admin role).

Erys (one assistant per person, above any project) and Sal (one assistant across projects) need all three. Only a
signed-in organisation admin can do them today.

#253 adds a narrow answer for one case: `ApiKey.permissions` (`["import"]`) and the `keyPermits` worker call let a
project key import skills and memory snapshots into organisation-owned records, for those two operations only. It
deliberately gives the key no organisation-wide role.

## Proposal

### Scope

A key gets a scope, using the same shape as a session's:

```ts
// @kantel/contracts identity.ts
interface ApiKey {
	// …as today
	/** Where the key's role applies. Absent on keys issued before this: `projects`. */
	readonly scope?: "projects" | "organisation";
	/** For `projects`, at least one; for `organisation`, empty. */
	readonly projectIds: readonly ProjectId[];
}
interface CreateApiKeyRequest {
	// …as today
	readonly scope?: "projects" | "organisation"; // default "projects"
}
```

An organisation key's role counts **as an organisation-wide binding**: `roleOf(key, org)` returns it, and so does
`roleOf(key, org, anyProject)`, exactly as a person's organisation-wide binding does. A host app that should stay out of
some projects uses project keys, as today. Least privilege stays the issuer's choice; the default is still `projects`.

### What it can never do

Whatever its role, a call signed in with any key (project or organisation) is refused on:

- issuing, listing or revoking keys, and changing members or role bindings (identity's key and member routes refuse a
  key-authenticated caller with `forbidden`, audited once as `access.denied`), so a key never mints a stronger key;
- platform records (platform skills, rules, connectors and vault items stay `system` only);
- anything an agent can't do on its behalf: keys are services, never agents, so an organisation key does not pass an
  agent's session checks.

### Who mints and revokes

- Issuing an organisation key needs an organisation-wide admin, signed in as a person (not a key). A project admin is
  `forbidden`, as #253 does for a key with a permission. Its role may be `viewer`, `operator` or `admin`.
- Revoking needs an organisation-wide admin. `listApiKeys` shows organisation keys to organisation-wide admins only;
  project keys keep today's rule (keys whose every project the caller administers).
- Expiry works as for any key (`expiresAt`).

### How it passes the scope check

No change to `ProjectAccess` itself: it already asks `roleOf` for humans and services. An organisation key with
`operator` passes organisation-scope operator checks (create an organisation session, use the organisation's skills
and memory), and project checks in every project. With `admin` it also writes organisation rules, skills and memory,
and creates a user's vault item for a user in the organisation.

Sessions: a service may name the session's `userId` (decision 3). With an organisation key that becomes the normal way
a host app starts an assistant for one of its users, so `create` should check that the named user is a member of the
organisation (`not_found` otherwise), for keys and services alike.

### Audit

- `identity.api_key.issued` and `identity.api_key.revoked` carry `data.scope` (`projects` or `organisation`) and the
  role, never the secret, as today.
- Calls made with the key are audited as its service, as today; each event's actor already names the service, and the
  key ID is in the authentication record.
- A key refused on the routes above is one `access.denied` with `data.caller: "api_key"`.

### Fit with #253's permissions

The two are independent and both live on the key:

- `permissions` stays the narrow tool: a project key with `import` imports into organisation records and does nothing
  else organisation-wide. `keyPermits` is unchanged.
- An organisation key with `admin` doesn't need `import` (it already holds the organisation-wide role imports ask for);
  an organisation key with `operator` may still be given `import`.
- Storage: `scope` goes in a side table made with `CREATE TABLE IF NOT EXISTS`, as `identity_api_key_details` and
  #253's `identity_api_key_permissions` are, so existing D1 and Postgres databases need no migration step. A key with
  no row there is a `projects` key.

## Conformance

New identity cases (memory, PGlite, SQLite, D1):

- an organisation admin issues an organisation key; a project admin can't; `scope: "organisation"` with project IDs is
  `invalid`;
- `roleOf` gives an organisation key its role with and without a project, and a project key none without one;
- a revoked or expired organisation key holds nothing;
- `listApiKeys` shows an organisation key to an organisation-wide admin only.

New gateway cases (Cloudflare and self-hosted): an organisation operator key creates an organisation session and is
refused on `POST /v1/keys`; an organisation admin key writes an organisation rule and a user's vault item; a project key
still gets 403 on both.

## PRs

With #253 merged: (1) contracts and identity (both directories) with the conformance cases; (2) the gateways'
key-route refusals and the user check on session create; (3) the console's API keys page, where the project picker
gains "Whole organisation".

## Open question (decided)

Should an organisation key be capped at `operator`, leaving organisation admin work to people? This note allowed `admin`
because Erys's host app has to create its users' vault items and rules without a person signed in; the identity routes
stay closed to every key either way.

## Decision: capped at operator

Decided 31 Oct 2026 (TASK-4197): **an organisation key holds `viewer` or `operator`, never `admin`**
(`ORGANISATION_KEY_MAX_ROLE` in `@kantel/contracts`; `admin` is `invalid`). What a host app needs beyond that comes
from narrow permissions on the key, as #253's `import` does:

- `create_projects` (new): the key may call `POST /v1/projects` (`IdentityDirectory.createProject`) in its own
  organisation. Only an organisation key may carry it (`invalid` on a project key), and only an organisation-wide admin
  may issue one, as for any permission.
- `import` (#253): unchanged; an organisation key may carry it too.

Why the smaller option: Lleverage's backend needs to create a project per Lleverage project and run organisation and
project sessions in them. `operator` across the organisation plus `create_projects` does exactly that. `admin` across
the organisation would also let the key grant roles, issue and revoke keys over every project, write every rule and
vault item and change vault policies; a leaked host key would then be a leaked organisation admin. With the cap, a
leaked organisation key can run sessions and add projects, both audited as the key, and can't widen its own access or
anyone else's.

What it leaves to people for now: organisation and project prompt rules, vault items and policies, and role grants all
need `admin`, so an organisation admin signed in as a person still sets them up. If Erys or Lleverage needs one of them
unattended, add a permission for that one operation rather than lifting the cap.

## As built

- **Contracts** (`packages/contracts/src/identity.ts`): `ApiKeyScope`, `API_KEY_SCOPES`, `ORGANISATION_KEY_MAX_ROLE`,
  `ApiKey.scope` (absent means `projects`), `Authentication.scope`, `create_projects` in `API_KEY_PERMISSIONS`, and
  `CreateProjectRequest` / `CreateProjectResponse` with `PROJECT_NAME_MAX_LENGTH`. `CreateApiKeyRequest.projectIds`
  is optional, for an organisation key.
- **Directories** (memory and SQL): an organisation key's role is an organisation-wide binding in `roleOf`, so
  `ProjectAccess` needs no change; `listProjects` shows it every project of its organisation; `createProject` admits a
  live organisation key with `create_projects`, in its own organisation only. Scope is stored in a side table,
  `identity_api_key_scopes`, written only for organisation keys, so existing databases need no migration.
- **Issuing**: an organisation key needs an organisation-wide admin who is not calling with a key (`forbidden`
  otherwise), names no project (`invalid`), and holds at most `operator` (`invalid`). Revoking one needs an
  organisation-wide admin, and `listApiKeys` shows it to organisation-wide admins only.
- **Key and member routes**: the proposal's blanket refusal of every key-authenticated caller was not built, because
  it would change what project keys may do today (an operator key reaches the key routes' gate, and a project-admin
  key may issue keys for its projects). With the cap, an organisation key fails every admin check on those routes
  anyway, and no key can issue an organisation key.
- **Audit**: `identity.key.issued` and `identity.key.revoked` carry `data.scope` and `data.role`; a project created
  with an organisation key is `identity.project.created` with the key's service as actor and the key ID on it.
- **Public API**: `POST /v1/projects` (`createProject`, tag `projects`) is in `packages/api`'s routes, the OpenAPI
  document and the SDK, served by `@kantel/identity/http` beside `GET /v1/projects` in both deployments.
- **Console**: the API keys page offers "Whole organisation" to an organisation-wide admin, with roles up to operator
  and a "Can create projects" box, and marks organisation keys in the list.
- **Not built**: the user-membership check on `POST /v1/sessions` (`userId`), and the `access.denied` event for keys
  refused on the key routes; both stay in the gaps.
