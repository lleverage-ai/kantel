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
`authorize`. Portable helpers in `@kantel/identity`: `generateApiKeySecret` (`hbr_` + 32 random bytes, base64url),
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
`User` and the organisations they may act in (created in, or holding a role in). Kantel is invite-only: an admin
creates the user or invites their email, and sign-in creates a user only for an invite.

- A user whose `externalSubject` is `externalSubjectOf(issuer, subject)` (`"<issuer> <subject>"`) is that person — "signIn
  finds a user by issuer and subject, links an invited user by verified email once, and refuses anyone else". Issuer
  and subject compare exactly, case included, and `createUser` refuses a subject another user has (`conflict`) —
  "signIn compares issuer and subject exactly, and no two users share a subject".
- Otherwise a provider-verified email links the one user with that email and no `externalSubject` (emails compare
  trimmed and lower-cased, `normaliseEmail`, on both sides),
  once, audited as `identity.user.linked` with the user as actor. An unverified email, an email two unlinked users
  share, a linked user's email at a new subject, or nobody at all is `forbidden`.
- Invites: `createInvite(ctx, {email, role})`, `listInvites(ctx)` and `revokeInvite(ctx, id)` need the organisation's
  `admin` role, and work within its own organisation only — "invites: only an organisation admin invites, lists and
  revokes them, in its own organisation". An email with a pending invite in the organisation, or a member's, is
  `conflict`; anything but an email (at most 254 characters) or a role is `invalid` — "invites: a pending invite or a
  member with the email is a conflict, and a bad email or role is invalid". An invite is pending for
  `INVITE_TTL_MILLISECONDS` (14 days) until accepted or revoked; the audit events (`identity.invite.created`,
  `identity.invite.revoked`) carry its role, never the email.
- Each sign-in with a provider-verified email accepts every pending invite to it: someone with no user gets one,
  linked to the sign-in and created in the first inviting organisation (`identity.user.created`, the person as
  actor); each invite grants its organisation-wide role, as granted by whoever invited them, unless they hold a role
  in that organisation already, and is audited once as `identity.invite.accepted` (`{role, granted}`) — "invites: a
  verified sign-in with the email joins someone new once, with the role, and is audited", "invites: a revoked or
  expired invite lets nobody in, and someone already here keeps their role". `canSignIn` says yes for a pending
  invite.
- The organisations — "signIn lists the organisations the user was created in or holds a role in".
- A worker call: the authenticator makes it as `system` — "worker calls: signIn refuses every caller but system".
- `canSignIn(ctx, identity)` says whether `signIn` would accept the identity now, without linking or auditing, and
  does the same lookups whoever it names (not a constant-time promise; the public route keeps its own response
  independent of the answer). Email one-time PIN sign-in asks it before sending a code — "canSignIn answers
  what signIn would, without linking or auditing anyone". A worker call too.

## Email one-time PIN (M1-BE7, self-hosted)

Sign-in is by email one-time PIN (decided by Tom, 27 Oct 2026, issue #15). On Cloudflare, Access's own one-time PIN
login sits in front of Kantel and `cloudflareAccessProvider` verifies its token. Self-hosted, Kantel runs the same
flow itself: `POST /auth/otp/start {email}` (`OTP_START_PATH`) always answers 202 with the same body, and only an
invited user's inbox gets a code; `POST /auth/otp/verify {email, code}` (`OTP_VERIFY_PATH`) calls `signIn` with
`ExternalIdentity { issuer: EMAIL_OTP_ISSUER, subject: <normalised email>, email, emailVerified: true }` and issues a
Kantel session (`hbs_…`), which the authenticator accepts as the `harbour_session` method. Sign-in and sign-out are
audited as `identity.session.started` and `identity.session.ended`. The wire types are in
`packages/contracts/src/identity.ts`.

### Implementation (`@kantel/identity/otp`, `/otp/http`, `/smtp`, `/sql`)

- `createEmailOtp({ identity, codes, sessions, mailer, clock?, audit?, sessionTtlMilliseconds?, defer?,
  onMailError? })` is the service; `createOtpHandler({ otp })` serves the three routes as a Fetch-style handler;
  `kantelSessionProvider({ sessions })` goes in `createAuthenticator({ providers })`. Stores: `createSqlOtpStores(driver)`
  (tables `identity_otp_codes` and `identity_sessions`, created by `migrateIdentity`) or `createMemoryOtpStores()`.
- Codes: 6 uniformly random digits, valid 10 minutes, stored as the SHA-256 of the code's ID, email and code. A new
  code burns the email's older ones. At most 5 codes per email per hour; a start over the limit sends nothing and
  answers the same.
- Start does the same work for every well-formed email: `canSignIn`, then a code row under the rate limit (a decoy
  that no code matches for a stranger), so the database sees the same statements either way. The mail is sent after
  the response, on a later task kept alive by `defer` (a Worker passes `ctx.waitUntil`), so neither its outcome nor
  any of its work is on the response path; a failed send goes to `onMailError` without the code. The send still
  loads the server for a moment after the response, so a caller timing a request made right after could notice it;
  a deployment that must rule that out sends from a queue.
- Verify claims one attempt with a single guarded `UPDATE … RETURNING` before comparing (constant-time), and consumes a
  match with another, so concurrent guesses never pass 5 and a code signs in once. Wrong, expired, used, burned and
  unknown all answer the same 401.
- Sessions: `hbs_` + 32 random bytes, stored as SHA-256, 12 hours by default. The authenticator takes an `hbs_`
  bearer before anything but an API key, and resolves the person through `signIn` on every call.
- Mail: `createSmtpMailer({ url, from })` or `smtpMailerFromEnv()` (`KANTEL_SMTP_URL`, `KANTEL_MAIL_FROM`).
  `smtps://` is TLS from the start; `smtp://` requires STARTTLS; only `?starttls=off` sends in the clear, for a relay on
  a private network such as Mailpit. `MemoryOtpMailer` is for tests.
- Proof: `packages/identity/test/otp.test.ts` (memory, PGlite, node:sqlite, D1, and real Postgres when
  `KANTEL_TEST_POSTGRES_URL` is set), `smtp.test.ts` (an in-process SMTP relay), and `otp.mailpit.test.ts`, #15's
  definition of done over HTTP against Mailpit when `KANTEL_TEST_SMTP_URL` and `KANTEL_TEST_MAILPIT_URL` are set.

### Wiring it into the self-hosted stack (deployment lanes)

1. Run Mailpit (`axllent/mailpit`) in the compose stack; its SMTP port is 1025 and its UI and API 8025.
2. Give the gateway `KANTEL_SMTP_URL=smtp://mailpit:1025?starttls=off` and `KANTEL_MAIL_FROM=Kantel <harbour@…>`;
   a real relay takes `smtps://user:pass@host` or `smtp://user:pass@host:587` instead.
3. Run `migrateIdentity(driver)` on the Postgres driver, build `createSqlOtpStores(driver)`, then
   `createEmailOtp({ identity, ...stores, mailer: smtpMailerFromEnv(), audit })`.
4. Mount `createOtpHandler({ otp })` at `/auth/otp/start`, `/auth/otp/verify` and `/auth/session/end`, unauthenticated.
5. Add `kantelSessionProvider(stores)` to the gateway's `createAuthenticator({ identity, providers })`.
6. Rate-limit `/auth/otp/*` per client address at the edge too; the per-email limits do not stop one client from
   trying many emails.

## Passkeys (#132, for M1-FE2's vault approvals)

A person registers passkeys with identity, and the vault's approval API asks for one before an approval reaches the
vault. Kantel is the WebAuthn relying party; the wire types are in `packages/contracts/src/passkey.ts`.

- **Relying party.** `RelyingParty { id, name, origin }`: by default the origin the request was made to
  (`relyingPartyFor(request.url)`), so on Cloudflare it is the gateway's hostname and self-hosted the host the
  gateway is reached on. A deployment behind a proxy that rewrites the host passes its own (`relyingParty` option).
  Each challenge stores the relying party it was issued for, and a passkey stores the RP ID it was made for, so an
  assertion is checked against the origin it was asked for on and never another.
- **Registration.** `registrationOptions(ctx, rp)` issues a challenge for the person (`attestation: "none"`,
  `userVerification: "required"`, the person's passkeys in `excludeCredentials`); `register(ctx, response, name?)`
  takes that challenge out of the store (single use) and checks the client data (type, challenge, origin, not
  cross-origin), the RP ID hash, user presence and verification, and that the credential ID matches the
  authenticator's. It stores the public key (ES256, EdDSA or RS256 as a JWK), counter, transports and backup flag,
  never a secret; a credential ID registered already (to anyone) is `conflict`; at most `PASSKEYS_PER_PERSON` (20).
  Audited `identity.passkey.registered`; `remove` is audited `identity.passkey.removed`.
- **Approval challenge.** `approvalChallenge(ctx, rp, binding)` issues a random 32-byte challenge, valid
  `PASSKEY_CHALLENGE_TTL_MILLISECONDS` (5 minutes), bound to the person, the relying party and a `PasskeyBinding`:
  the proposal, its terms hash, `approve` or `paste`, and the narrowing shown (compared in canonical form, methods
  sorted). It lists the person's passkeys for this RP ID as `allowCredentials`.
- **Verification.** `verifyApproval(ctx, binding, assertion)` takes the challenge the client data names out of the
  store first (one `DELETE … RETURNING`), so it is used once whatever happens next and only one of two concurrent
  uses gets it. It then needs: a challenge issued to this person for an approval, unexpired; the same binding as the
  decision cites; a passkey of this person's for that RP ID; the origin and RP ID hash; user presence and
  verification; a signature that verifies over the authenticator data and the client data's hash; and a counter
  that moves on when either side counts (one that doesn't means a cloned key). The counter moves with an `UPDATE`
  guarded by the value read. Every refusal is `refused` with `details.passkey`, a `PasskeyRefusal`: `missing`,
  `malformed`, `challenge`, `binding`, `origin`, `credential`, `user_verification`, `signature`, `counter` or
  `algorithm`. Identity does not audit refusals: the approval API does, as `connections.passkey.refused`.
- **When one is needed.** `required(ctx)`: with `approvals: "registered"` (the default) once the person has a passkey,
  so nobody is locked out on the day passkeys arrive; with `"always"`, for every approval.
- **Only a person.** Every call but `required` is `forbidden` for anyone but a human actor.
- **Stores.** `createSqlPasskeyStores(driver)` (tables `identity_passkeys`, `UNIQUE` on `credential_id`, and
  `identity_passkey_challenges`, created by `migrateIdentity`) on Postgres self-hosted and D1 on Cloudflare, or
  `createMemoryPasskeyStores()`. Expired challenges are deleted as new ones are issued.
- **HTTP** (`@kantel/identity/passkey/http`): `createPasskeyHandler({ passkeys, authenticator, relyingParty?,
  signIn? })` serves `GET`/`POST /v1/me/passkeys`, `POST /v1/me/passkeys/registration` and
  `POST /v1/me/passkeys/:id/remove` behind the authenticator (POSTs need `application/json`, else 415; a refusal is
  422 with `error.passkey`), and `createPasskeyClient` calls them.
- **Proof.** `packages/identity/test/passkey.test.ts` runs on memory, PGlite, `node:sqlite`, D1 in Miniflare and
  (with `KANTEL_TEST_POSTGRES_URL`) a real Postgres, with a software authenticator
  (`@kantel/identity/passkey/testing`) making real ES256, EdDSA and RS256 passkeys. Not checked: attestation
  statements (Kantel asks for none) and whether a second passkey may be added without the first; anyone signed in
  as the person can register one.

## The authenticator (M1-BE7)

`Authenticator` (`packages/contracts/src/identity.ts`) is the middleware every Kantel API takes. It turns a
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
- `@kantel/identity/authenticator` has the implementation: `createAuthenticator({ identity, providers? })` (the
  directory needs `signIn` when providers are given, else creation throws `invalid`),
  `withAuthentication(authenticator, handler)` for Fetch-style handlers (401 with `WWW-Authenticate: Bearer`, or 403,
  with a JSON `{ error: { code, failure, message } }` body), and `authenticationFailureResponse(error)` for routers
  that call `authenticate` themselves. Build tests against it with the in-memory directory: issue a key, send it as a
  bearer.

### Sign-in providers

`@kantel/identity/jwt` verifies tokens with `jose`. Each provider takes an optional `fetch` (default the global one),
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

`@kantel/identity/testing` is portable and needs no network. `createMockIdp({ issuer, audience, algorithm?, clock? })`
signs tokens (RS256 by default, or ES256) and answers discovery and its JWKS through its own `fetch`, which you pass
to `oidcProvider`. `createMockAccess({ teamDomain, audience, clock? })` does the same for `/cdn-cgi/access/certs`.
`sign(claims, { kid?, expiresInSeconds?, algorithm?, header? })` fills `iss`, `aud`, `sub`, `iat` and `exp` from the
clock; a claim set to `undefined` is left out. `rotate()` adds new keys and keeps the old ones published until
`removeOld()`. The identity suite also serves a mock IdP over real HTTP on 127.0.0.1 (`test/http-idp.ts`) for
`oidcProvider` with the global fetch.

## The in-memory implementation

`createMemoryIdentity({ clock?, audit? })` from `@kantel/identity/memory` keeps everything in maps for the life of the
instance. It reads time only from the clock (key expiry is `now >= expiresAt`) and emits `identity.key.issued`,
`identity.key.revoked`, `identity.role.granted` and `identity.role.revoked`, plus `identity.organisation.created`,
`identity.project.created`, `identity.user.created` and `identity.service.created`. Choices the contract leaves open:

- Reads need some role in `ctx.organisationId` (else `forbidden`); `getProject` also needs a role on the project (else
  `not_found`). A user is visible in the organisation they were created in or hold a role in.
- The first admin of an organisation must be an existing user; a service principal is `invalid`.
- `listApiKeys` shows keys whose every project the caller administers. Revoking a revoked key is a no-op.
- `listRoleBindings` with a project lists that project's bindings (viewer on it needed); without, all of the
  organisation's (organisation-wide viewer needed).

Left out: persistence (in the durable implementation below), listing services,
deleting records, rate limits on `authenticateApiKey`, and a guard against revoking the last organisation admin.

## The durable implementation

`@kantel/identity/sql` runs on any `SqlDriver` from `@kantel/sql`: Postgres (`postgresPoolDriver(pool)` over `pg`) for
the self-hosted target, and D1 (`d1Driver(env.DB)`) or another SQLite for Cloudflare. It passes the whole suite on
PGlite, `node:sqlite`, D1 in Miniflare and (with `KANTEL_TEST_POSTGRES_URL`) a real Postgres, and behaves as the
in-memory directory, with the same choices, errors and audit events.

- `migrateIdentity(driver)` creates the tables if they are missing; `identitySchema(dialect)` gives the statements for
  a target's own migrations. Tables: `identity_organisations`, `identity_projects`, `identity_users` (with the
  normalised email sign-in matches on, and `UNIQUE` on `external_subject`), `identity_services`,
  `identity_role_bindings` (`UNIQUE` per organisation, principal and scope, `*` for organisation-wide) and
  `identity_api_keys` (the hex SHA-256 of the secret, `UNIQUE` and looked up by, never the secret; the projects as a
  JSON list). Times are numbers, IDs text.
- `createSqlIdentity({ driver, clock?, audit? })` holds no state of its own, so any number of instances (workers) share
  one database: a key issued or revoked on one is honoured on the others at once. There are no interactive
  transactions: an organisation and its first admin are one `batch`; a grant is one `INSERT … ON CONFLICT DO UPDATE`
  that replaces the binding for the same principal and scope; revoking a key sets `revoked_at` only where it is unset,
  so one revocation is audited. Uniqueness races are settled by the constraints: two users racing for one external
  subject leave one, and the other is `conflict`; linking by email updates only a user still unlinked, and a first
  sign-in that loses that race finds the user by subject.
- Grants and revocations are checked against the caller's role and then written, with no transaction between. So
  that a grant checked just before its granter was revoked cannot write after the revocation and bring the binding
  back, each reads the organisation's `roles_version` before its check, and its batch moves the version on only if
  it is unchanged; otherwise the batch fails whole and the call is `conflict` (try again). A grant or revocation that
  races another in the same organisation can therefore be refused, never applied out of order ("a grant checked
  before its granter was revoked does not bring the revoked binding back").
- `listProjects` pages in creation order (`nextCursor` is the last project's ID, as in memory). Lists bind as one JSON
  parameter, so no statement meets D1's 100-parameter cap. Audit events go to the sink after the write.
- On Postgres each `createProject` takes an advisory lock first, so projects commit in creation order and a reader
  paging by cursor never skips one that commits late.
- Differences from memory: `createUser` refuses an `email` that is not a string (`invalid`).

## Open questions

- Should a user be global or belong to organisations explicitly? `User` has no organisation, so cross-organisation
  visibility of users is an implementation choice today.
- Should reads by an actor with no role in the organisation be `forbidden` or `not_found`?
- Should the contract define a bootstrap `ctx.organisationId` for `createOrganisation` and the first `createUser`?
- Should a project-scoped key ever hold an organisation-wide role (for example to create projects)?
