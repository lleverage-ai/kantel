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
- `authenticateApiKey` and `roleOf` are worker calls (settled by Tom on 27 Oct 2026, question 13: "Require a system
  identity"): the gateway and `ProjectAccess` make them as `system`. Any other actor, an organisation admin included,
  or no caller is `forbidden` and audited once as `access.denied`, never with the key's secret — "worker calls:
  roleOf and authenticateApiKey refuse every caller but system".

## Sign-in (M1-BE7)

`signIn(ctx, identity)` resolves a person a sign-in provider vouched for (`ExternalIdentity`: the verified `issuer`,
`subject`, and optionally `email`, `emailVerified` and `name` of a Cloudflare Access or OIDC token) to a `SignIn`: their
`User` and the organisations they may act in (created in, or holding a role in). Harbour is invite-only: an admin
creates the user, and sign-in never creates one.

- A user whose `externalSubject` is `externalSubjectOf(issuer, subject)` (`"<issuer> <subject>"`) is that person — "signIn
  finds a user by issuer and subject, links an invited user by verified email once, and refuses anyone else". Issuer
  and subject compare exactly, case included, and `createUser` refuses a subject another user has (`conflict`) —
  "signIn compares issuer and subject exactly, and no two users share a subject".
- Otherwise a provider-verified email links the one user with that email and no `externalSubject` (emails compare
  trimmed and lower-cased, `normaliseEmail`, on both sides),
  once, audited as `identity.user.linked` with the user as actor. An unverified email, an email two unlinked users
  share, a linked user's email at a new subject, or nobody at all is `forbidden`.
- The organisations — "signIn lists the organisations the user was created in or holds a role in".
- A worker call: the authenticator makes it as `system` — "worker calls: signIn refuses every caller but system".

## The authenticator (M1-BE7)

`Authenticator` (`packages/contracts/src/identity.ts`) is the middleware every Harbour API takes. It turns a
request's headers into an `AuthenticatedCaller` (an `Authentication` plus its `method`), and an API builds each
call's `CallContext` from it with `callContextFor(caller, { projectId, requestId, signal })`.

- Credentials: `Authorization: Bearer hbr_…` is a host app's API key (`api_key`). Human sign-in, a Cloudflare
  Access token in `Cf-Access-Jwt-Assertion` (`cloudflare_access`) or an OIDC token as a non-`hbr_` bearer (`oidc`),
  is configured per deployment and lands in a later change. A human names the organisation they act in with the
  `Harbour-Organisation` header (`ORGANISATION_HEADER`); a key's organisation is the key's.
- It authenticates and never authorises. A key's caller is `{ kind: "service", serviceId, keyId }`, so
  `ProjectAccess` (through `roleOf`) limits it to the key's projects and role, whatever its service's bindings.
- Failures reject with `forbidden` and `details.authentication` (`AuthenticationFailure`): `missing` and `invalid`
  (HTTP 401) or `organisation` (HTTP 403). `authenticationFailureOf(error)` reads it. A failure says nothing about
  which keys or users exist and never echoes the credential. Other errors (a directory that is down) propagate.
- `@harbour/identity/authenticator` has the implementation: `createAuthenticator({ identity })`,
  `withAuthentication(authenticator, handler)` for Fetch-style handlers (401 with `WWW-Authenticate: Bearer`, or 403,
  with a JSON `{ error: { code, failure, message } }` body), and `authenticationFailureResponse(error)` for routers
  that call `authenticate` themselves. Build tests against it with the in-memory directory: issue a key, send it as a
  bearer.

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

Left out: persistence, listing services,
deleting records, rate limits on `authenticateApiKey`, and a guard against revoking the last organisation admin.

## Open questions

- Should a user be global or belong to organisations explicitly? `User` has no organisation, so cross-organisation
  visibility of users is an implementation choice today.
- Should reads by an actor with no role in the organisation be `forbidden` or `not_found`?
- Should the contract define a bootstrap `ctx.organisationId` for `createOrganisation` and the first `createUser`?
- Should a project-scoped key ever hold an organisation-wide role (for example to create projects)?
