# Organisation-wide API keys

Status: design note only (Tom, 30 Oct 2026: "Design note now"). Not built; it follows #253 (key permissions, merged 30 Oct
2026) and the organisation-scope stack ([org-scope.md](org-scope.md)).

## Why

A host app calls Harbour with an API key. Today a key is a service's, holds one role, and acts only in its listed
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
// @harbour/contracts identity.ts
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

## Open question

Should an organisation key be capped at `operator`, leaving organisation admin work to people? This note allows `admin`
because Erys's host app has to create its users' vault items and rules without a person signed in; the identity routes
stay closed to every key either way.
