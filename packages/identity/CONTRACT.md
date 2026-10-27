# Identity and tenancy

## What it is for

`IdentityDirectory` (`packages/contracts/src/identity.ts`) answers two questions for every call: who is acting, and
may they do this here? Organisations own projects. Users and service identities hold roles on a project or across an
organisation. Host apps call with API keys scoped to projects.

## Records

- `Organisation`, `Project` (belongs to one organisation), `User` (global; sign-in subject optional), `ServiceIdentity`
  (a host app inside one organisation).
- `RoleBinding`: a principal's `viewer`, `operator` or `admin` role on one project, or on the whole organisation when
  `projectId` is absent.
- `ApiKey`: a service's key, scoped to listed projects with one role. Only a hash and a 12-character display prefix are
  kept. `IssuedApiKey` carries the secret once.

## Key operations

`createOrganisation`, `createProject`, `createUser`, `createServiceIdentity`, `grantRole`/`revokeRole`,
`issueApiKey`/`revokeApiKey`/`listApiKeys`, `authenticateApiKey` (secret → `Authentication`), `roleOf` and
`authorize`. Portable helpers in `@harbour/identity`: `generateApiKeySecret` (`hbr_` + 32 random bytes, base64url),
`apiKeyPrefix`, `hashApiKeySecret` (hex SHA-256) and `strongestRole`.

## Rules and the suite cases that enforce them

- Only a `system` actor creates an organisation; the named admin can then manage it — "only a system actor creates an
  organisation, and its named admin can then create projects".
- Roles are ordered viewer < operator < admin — "orders roles viewer < operator < admin: an operator passes a viewer
  check and fails an admin check".
- An organisation-wide binding covers every project — "an organisation-wide binding applies to every project of the
  organisation, including later ones"; the strongest binding wins — "a human's role on a project is the strongest of
  its project and organisation-wide bindings".
- Granting replaces the binding for the same principal and scope — "granting a role replaces the existing binding for
  the same principal and scope"; "revoking a role removes the access it gave".
- A key acts only in its projects, with its role, whatever its service's bindings — "a host key scoped to one project
  cannot act in another project of the same organisation"; "a key cannot act in another organisation". A service with
  no key uses its bindings — "a service actor without a key acts with its own role bindings".
- Tenant isolation: another organisation's record is `not_found`; `authorize` across organisations is `forbidden` —
  "a record from another organisation is not_found, and authorize across organisations is forbidden".
- The secret is returned once, never listed and never stored in plain text — "returns a key's secret once and never
  lists or stores it in plain text".
- Revoked, expired and unknown keys are `forbidden`, never `not_found` — "revoked and expired keys fail with
  forbidden"; "an unknown key fails with forbidden, not not_found".
- Mutations need admin on their scope — "a viewer cannot grant roles or issue keys"; "a project admin manages only its
  project: no keys over other projects, no organisation-wide grants".
- Identity never authorises an agent; the runtime does, by session — "an agent actor is never authorised by identity".
- Every mutation is audited with its actor and no secret — "every mutation is audited with its actor, and no audit
  event contains a secret".
- `listProjects` shows only projects the actor holds a role on — "listProjects shows only projects the actor holds a
  role on".

## The in-memory implementation

`createMemoryIdentity({ clock?, audit? })` from `@harbour/identity/memory` keeps everything in maps for the life of the
instance. It reads time only from the clock (key expiry is `now >= expiresAt`) and emits `identity.key.issued`,
`identity.key.revoked`, `identity.role.granted` and `identity.role.revoked`, plus `identity.organisation.created`,
`identity.project.created`, `identity.user.created` and `identity.service.created`. Choices the contract leaves open:

- Reads need some role in `ctx.organisationId` (else `forbidden`); `getProject` also needs a role on the project (else
  `not_found`). A user is visible in the organisation they were created in or hold a role in.
- The first admin of an organisation must be an existing user; a service principal is `invalid`.
- `listApiKeys` shows keys whose every project the caller administers. Revoking a revoked key is a no-op.
- `listRoleBindings` with a project lists that project's bindings (viewer on it needed); without, all of the
  organisation's (organisation-wide viewer needed).

Left out: persistence, sign-in (Cloudflare Access, OIDC) and user lookup by external subject, listing services,
deleting records, rate limits on `authenticateApiKey`, and a guard against revoking the last organisation admin.

## Open questions

- Should a user be global or belong to organisations explicitly? `User` has no organisation, so cross-organisation
  visibility of users is an implementation choice today.
- Should reads by an actor with no role in the organisation be `forbidden` or `not_found`?
- Should the contract define a bootstrap `ctx.organisationId` for `createOrganisation` and the first `createUser`?
- Should a project-scoped key ever hold an organisation-wide role (for example to create projects)?
