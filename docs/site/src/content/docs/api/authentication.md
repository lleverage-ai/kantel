---
title: Authentication
description: API keys for apps, how people sign in, the organisation header, and getting through Cloudflare Access.
sidebar:
  order: 2
---

Every call under `/v1` needs credentials. An app sends an API key. People sign in, and the console sends their credential for them.

## API keys

An API key is your app's credential. Its secret starts `hbr_`, and you send it as a bearer token:

```bash
curl -s "$PARTAN_URL/v1/me" -H "authorization: Bearer $PARTAN_API_KEY"
```

```ts
import { createHarbourClient } from "@harbour/api/sdk";

const partan = createHarbourClient({
	baseUrl: `${process.env.PARTAN_URL}/v1`,
	token: process.env.PARTAN_API_KEY,
});
```

A key:

- belongs to a service identity, your app, which audit events name as the actor;
- has a scope: a **project key** holds one role (`viewer`, `operator` or `admin`) on each project it names, and nothing across the organisation; an **organisation key** holds one role (`viewer` or `operator`) across its organisation, on every project in it, including ones made later;
- may expire, and can be revoked at any time;
- may carry the `import` permission, for loading skills and memory snapshots into the organisation. On a self-hosted gateway that permission has no effect yet: only an organisation admin may import there;
- may carry the `create_projects` permission, if it's an organisation key, to create projects with `POST /v1/projects`.

An admin issues keys on the console's **API keys** page or with `POST /v1/keys`. Partan shows the secret once and keeps only its hash. See [Projects and sharing](/console/projects-and-sharing/#api-keys).

### Organisation keys

Use an organisation key when your app works across the organisation: it creates organisation sessions and organisation-wide agent profiles, and starts sessions in any project. With `create_projects` it can also create a project for each of your app's own workspaces:

```bash
curl -s -X POST "$PARTAN_URL/v1/keys" -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name": "My app", "scope": "organisation", "role": "operator", "permissions": ["create_projects"]}'

curl -s -X POST "$PARTAN_URL/v1/projects" -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" -d '{"name": "Customer 42"}'
# 201 { "id": "PROJECT_ID", "organisationId": "ORG_ID", "name": "Customer 42", "createdAt": … }
```

The SDK's `createProject` makes the same call. An organisation key:

- is issued only by an organisation-wide admin signed in as a person, never with another key;
- holds at most `operator`, so it can't grant roles, issue or revoke keys, or write the organisation's or projects' prompt rules, vault items and vault policies. An organisation admin sets those up;
- acts only in its own organisation, like every key.

A project key can't create projects or act at organisation level, whatever its role.

### Acting for a person

A session works for one person, whose own skills and prompt rules it gets. A person may name only themselves. Your app may name any user with `userId` when it creates a session. Partan doesn't yet map your app's users to its own, so your app keeps its own mapping to Partan user IDs.

## People

People sign in to the console, and their credential reaches the API in one of these ways, depending on the deployment:

| Deployment | How a person signs in | What the API receives |
| --- | --- | --- |
| Cloudflare | Cloudflare Access in front of the hostname | The `Cf-Access-Jwt-Assertion` header Access adds |
| Self-hosted | A six-digit code by email | `Authorization: Bearer hbs_…`, a Partan session token |
| Neither yet | An OIDC provider: the authenticator supports one, but no deployment configures it | `Authorization: Bearer <JWT>` |

Self-hosted, you can get a person's token from a script. Codes last 10 minutes and the session token 12 hours:

```bash
curl -s -X POST "$PARTAN_URL/auth/otp/start" -H "content-type: application/json" -d '{"email":"you@example.com"}'
# Read the code from the email, then:
curl -s -X POST "$PARTAN_URL/auth/otp/verify" -H "content-type: application/json" \
  -d '{"email":"you@example.com","code":"123456"}'
# { "token": "hbs_…", "expiresAt": …, "user": {…}, "organisationIds": [...] }
```

`POST /auth/session/end` with the token as bearer signs it out. Only invited addresses get a code.

## The organisation header

A person may belong to more than one organisation. When they do, name the one to act in with the `harbour-organisation` header; a person in one organisation needs no header. An API key acts only in its own organisation.

## Request IDs

Send `harbour-request-id` with a call to find it again in the audit log. The SDK sends it from `requestId` in a call's options.

## Who you are

`GET /v1/me` answers who the credentials name:

```json
{
  "actor": { "kind": "service", "serviceId": "SERVICE_ID", "keyId": "KEY_ID" },
  "organisationId": "ORG_ID",
  "method": "api_key",
  "name": "SERVICE_ID",
  "roles": [{ "projectId": "PROJECT_ID", "role": "operator" }]
}
```

An organisation key's role is listed without a project: `[{ "role": "operator" }]`.

`GET /v1/projects` lists the projects you may see. Neither route is in the generated SDK yet; see [Unlisted routes](/api/reference/unlisted/). `POST /v1/projects` is; see [Projects](/api/reference/projects/).

## Cloudflare Access

On Cloudflare, Access stands in front of the whole hostname, `/v1/` included. Partan's own deploy configuration sets up no way for an app's key alone to pass it. To call a Cloudflare deployment from your backend, add an Access policy that lets your app through, such as a service token, and send the token's `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers with your API key. Partan takes the API key over any Access identity when both are present.

The SDK sends extra headers with `headers`:

```ts
const partan = createHarbourClient({
	baseUrl: `${process.env.PARTAN_URL}/v1`,
	token: process.env.PARTAN_API_KEY,
	headers: () => ({
		"cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID ?? "",
		"cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET ?? "",
	}),
});
```

A self-hosted gateway has no Access in front of it, so the key alone is enough.

## In a browser

A browser can't put an `Authorization` header on a WebSocket, and Partan has no way yet to mint a short-lived token for one user. Call Partan from your backend with the key, and pass what your UI needs on to it. The console avoids this by being served on the same origin, signed in by cookie.

## Errors

Missing or invalid credentials answer `401` with the code `unauthenticated`. A valid credential without the role a call needs answers `403` `forbidden`. See [Errors](/api/errors/).

<!-- Sources (d031001): packages/identity/src/authenticator.ts:1-150, packages/identity/src/index.ts:20-33, packages/identity/src/otp.ts:13,40,389-409, packages/identity/src/jwt.ts:25-26,201,256, packages/contracts/src/identity.ts:23-28,104-113,193,371-410,441-455,520-535, packages/identity/src/memory.ts:470-485, apps/cloudflare/src/gateway.ts:31-32, apps/cloudflare/test/remote/deployed.test.ts:1-30, apps/cloudflare/README.md:410-430, apps/selfhosted/src/gateway/gateway.ts:1-10,237-252, apps/cloudflare/src/import-access.ts:1-10, packages/api/generated/sdk.ts:1966-2021, packages/api/generated/sdk.ts:503-521, docs/design/public-api.md:33-40,157-161, docs/design/org-api-keys.md:1-25, packages/runtime/HTTP.md:96-111 -->
