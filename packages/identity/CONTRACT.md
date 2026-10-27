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

- Credentials: `Authorization: Bearer hbr_…` is a host app's API key (`api_key`). People sign in with a Cloudflare
  Access token in `Cf-Access-Jwt-Assertion` (`cloudflare_access`) or an OIDC token as a non-`hbr_` bearer (`oidc`),
  whichever providers the deployment configures. The order is: an `hbr_` bearer is a key (a host app behind Access
  may carry an Access service token too, and its key decides); then the Access header, when an Access provider is
  configured; then any other bearer goes to the OIDC provider (with several, the one whose issuer the token's
  unverified `iss` names). A bearer token with no provider to verify it is `invalid`.
- A verified token becomes an `ExternalIdentity`, and `signIn` (as `system`) finds the user; a `forbidden` from it
  is `invalid`. The person names the organisation they act in with the `Harbour-Organisation` header
  (`ORGANISATION_HEADER`), which must be one of theirs; without it, they must have exactly one. Anything else is
  `organisation`. The caller is `{ method, actor: { kind: "human", userId }, organisationId }`, with no projects or
  role: their roles decide per project. A key's organisation is the key's.
- It authenticates and never authorises. A key's caller is `{ kind: "service", serviceId, keyId }`, so
  `ProjectAccess` (through `roleOf`) limits it to the key's projects and role, whatever its service's bindings.
- Failures reject with `forbidden` and `details.authentication` (`AuthenticationFailure`): `missing` and `invalid`
  (HTTP 401) or `organisation` (HTTP 403). `authenticationFailureOf(error)` reads it. A failure says nothing about
  which keys or users exist and never echoes the credential. Other errors (a directory that is down) propagate.
- `@harbour/identity/authenticator` has the implementation: `createAuthenticator({ identity, providers? })` (the
  directory needs `signIn` when providers are given, else creation throws `invalid`),
  `withAuthentication(authenticator, handler)` for Fetch-style handlers (401 with `WWW-Authenticate: Bearer`, or 403,
  with a JSON `{ error: { code, failure, message } }` body), and `authenticationFailureResponse(error)` for routers
  that call `authenticate` themselves. Build tests against it with the in-memory directory: issue a key, send it as a
  bearer.

### Sign-in providers

`@harbour/identity/jwt` verifies tokens with `jose`. Each provider takes an optional `fetch` (default the global one),
`clock` and `clockToleranceSeconds` (default 0), and needs `exp` in every token.

- `cloudflareAccessProvider({ teamDomain, audience })`: `teamDomain` is the Access team domain, with or without
  `https://`; `audience` is the Access application's AUD tag. Tokens must be RS256, issued by
  `https://<teamDomain>`, for the AUD tag, signed by a key from `/cdn-cgi/access/certs`. Access verifies emails, so
  the email counts as verified. A token without a subject or email (a service token) is `invalid`: host apps use API
  keys.
- `oidcProvider({ issuer, audience, jwksUri?, algorithms?, discovery? })`: `audience` is the client ID. Without
  `jwksUri`, the discovery document (at `discovery`, default `<issuer>/.well-known/openid-configuration`) is fetched
  once and must name exactly `issuer`; its `jwks_uri` gives the keys. `iss` must equal `issuer` exactly. Algorithms
  default to RS256, ES256 and EdDSA; `none` and HMAC are refused at creation. The email is verified only when
  `email_verified` is `true` (or `"true"`).
- Keys are cached for 10 minutes. A token naming an unknown `kid` (the provider rotated its keys) refetches them once,
  at most once every 30 seconds by the clock. A failed fetch is remembered for those 30 seconds too, so tokens arriving
  while the provider is down never fetch more often, and fetches time out after 5 seconds.
- A token that does not verify is `invalid`, with a generic message that never holds the token. Keys or discovery
  that cannot be fetched or read, a published key that will not import, or discovery naming another issuer, are
  `unavailable` (not 401): the provider is at
  fault, not the caller.

### The mock IdP for tests

`@harbour/identity/testing` is portable and needs no network. `createMockIdp({ issuer, audience, algorithm?, clock? })`
signs tokens (RS256 by default, or ES256) and answers discovery and its JWKS through its own `fetch`, which you pass
to `oidcProvider`. `createMockAccess({ teamDomain, audience, clock? })` does the same for `/cdn-cgi/access/certs`.
`sign(claims, { kid?, expiresInSeconds?, algorithm?, header? })` fills `iss`, `aud`, `sub`, `iat` and `exp` from the
clock; a claim set to `undefined` is left out. `rotate()` adds new keys and keeps the old ones published until
`removeOld()`. The identity suite also serves a mock IdP over real HTTP on 127.0.0.1 (`test/http-idp.ts`) for
`oidcProvider` with the global fetch.

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
