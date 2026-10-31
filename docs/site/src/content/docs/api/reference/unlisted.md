---
title: Unlisted routes
description: Routes the deployments serve under /v1 that aren't in the OpenAPI document or the SDK yet.
sidebar:
  order: 99
---

The deployments serve these routes beside the public API. The console calls them, and your app may too, but they aren't in the OpenAPI document or the generated SDK, and they may change without notice. Each will move into the public API route by route.

They take the same credentials and answer errors with the same body as the public API. See [Errors](/api/errors/).

Where a column says **No**, that deployment doesn't serve the route.

## Identity and keys

| Route | Does | Cloudflare | Self-hosted |
| --- | --- | --- | --- |
| `GET /v1/me` | Who the credentials name, their organisation and roles | Yes | Yes |
| `GET /v1/projects` | The projects the caller may see | Yes | Yes |
| `GET /v1/organisations` | The organisations the caller may act in | Yes | Yes |
| `GET /v1/members` | The organisation's people, by name | Yes | Yes |
| `GET /v1/keys`, `POST /v1/keys` | List and issue API keys; see [Projects and sharing](/console/projects-and-sharing/#keys-over-the-api) | Yes | Yes |
| `POST /v1/keys/{keyId}/revoke` | Revoke a key | Yes | Yes |
| `GET`, `POST /v1/me/passkeys`, `POST /v1/me/passkeys/registration`, `POST /v1/me/passkeys/confirmation`, `POST /v1/me/passkeys/{id}/remove` | A person's passkeys | Yes | Yes |
| `POST /v1/members/{userId}/passkeys/reset` | An admin resets a person's passkeys | Yes | Yes |
| `POST /auth/otp/start`, `POST /auth/otp/verify`, `POST /auth/session/end` | Email sign-in; see [Authentication](/api/authentication/#people) | No | Yes |
| `GET /v1/deployment` | What backs each part of the deployment | No | Yes |

## Sessions, profiles and host tools

| Route | Does | Cloudflare | Self-hosted |
| --- | --- | --- | --- |
| `PATCH /v1/sessions/{id}` | Rename, pin, archive or mark unread: `{ title?, pinned?, archived?, unread? }` | Yes | Yes |
| `DELETE /v1/sessions/{id}` | Close and delete a session | Yes | Yes |
| `POST /v1/sessions/{id}/edit` | Rewind to a message and send it edited | Yes | Yes |
| `GET /v1/sessions/{id}/children` | A session's child sessions | Yes | Yes |
| `GET /v1/sessions/{id}/snapshot` | The session's current snapshot, without a stream | Yes | Yes |
| `GET /v1/sessions/{id}/events` | The older server-sent events route; use `/stream` | Yes | Yes |
| `POST /v1/sessions/{id}/prompt`, `/steer`, `/follow-up` | The older message routes; use `/messages` | Yes | Yes |
| `GET /v1/profiles`, `GET /v1/profiles/{agentId}` | List and read agent profiles | Yes | Yes |
| `PUT /v1/profiles/{agentId}` | Store an agent profile; see [Packaging an agent](/api/packaging-an-agent/#the-agent-profile) | Yes | Yes |
| `PUT /v1/hosts/{hostId}` | Register host tools; see [Host tools](/api/host-tools/) | Yes | Yes |
| `GET /v1/hosts/{hostId}/tools` | A host's tools | Yes | Yes |
| `DELETE /v1/hosts/{hostId}?registration=<id>` | End a host's registration | Yes | Yes |

## Browsers

| Route | Does | Cloudflare | Self-hosted |
| --- | --- | --- | --- |
| `POST /v1/browser/decisions` | Allow or decline an agent's browser request: `{ sessionId, callId, allow }`; see [Approvals](/api/approvals/#browser-requests) | Yes | Yes |
| `POST /v1/browser/live` | A watch-only live-view link for the caller: `{ sessionId, browserSessionId }` | Yes | Yes |
| `POST /v1/browser/replay` | A replay link for the caller, with the same body | Yes | Yes |

Each is served only when the deployment has a browser.

## Workspaces and files

| Route | Does | Cloudflare | Self-hosted |
| --- | --- | --- | --- |
| `GET /v1/workspaces/{id}` | A workspace's record | Yes | Yes |
| `GET /v1/workspaces/{id}/files?path=&recursive=&version=&cursor=&limit=` | List files, never their bodies | Yes | Yes |
| `GET /v1/workspaces/{id}/stat?path=&version=` | One file's entry | Yes | Yes |
| `GET /v1/workspaces/{id}/content?path=&version=` | A file's bytes | Yes | Yes |
| `GET /v1/workspaces/{id}/history?cursor=&limit=` | The workspace's versions, newest first | Yes | Yes |
| `GET /v1/workspaces/{id}/export?prefix=` | Files under prefixes, base64 | Yes | Yes |
| `POST /v1/workspaces` | A new workspace, seeded from a public GitHub repository | Yes | No |
| `PUT /v1/workspaces/{id}/content` | Write a file a person edited | Yes | No |
| `POST /v1/workspaces/{id}/fork` | Fork a workspace into a project | Yes | No |
| `GET /v1/git/branches` | A repository's branches, for a branch picker | Yes | No |
| `POST /v1/attachments`, `GET /v1/attachments/{id}` | Upload a file for a message, and read it back | Yes | No |
| `GET /shared/{token}`, `/shared/{token}/raw` | A file share link's page and bytes, without signing in | Yes | No |

## Connection approvals

Under `/v1/connection-approvals`, for a person deciding on the console's **Connection requests** page. See [Connection requests](/console/connection-requests/).

| Route | Does |
| --- | --- |
| `GET /v1/connection-approvals/viewer` | Who is deciding |
| `GET /v1/connection-approvals/requests?status=&sessionId=`, `GET /v1/connection-approvals/requests/{id}` | Requests |
| `GET /v1/connection-approvals/requests/{id}/approval`, `/requester` | What a request asks, and who asked |
| `POST /v1/connection-approvals/requests/{id}/passkey-challenge`, `/decision` | Decide a request, with a passkey |
| `GET /v1/connection-approvals/items/{id}` | An item's record, never its value |
| `GET /v1/connection-approvals/grants?status=&sessionId=`, `GET /v1/connection-approvals/grants/{id}`, `POST /v1/connection-approvals/grants/{id}/revoke` | Grants |
| `GET`, `POST /v1/connection-approvals/sessions/{id}/access` | Block or unblock a session's credential use |
| `GET /v1/connection-approvals/sessions/{id}/usage` | A session's outbound requests through the egress proxy |

Served on both deployments when they have the encrypted store. The old base, `/v1/vault`, and the old `/proposals` segment for `/requests` still answer for one release; each answer through them carries a `Deprecation` header and a `Link` to the new path (`rel="successor-version"`).

## Audit, models and the rest

| Route | Does | Cloudflare | Self-hosted |
| --- | --- | --- | --- |
| `GET /v1/audit/events`, `GET /v1/audit/event?id=` | The audit log; see [Audit](/console/audit/#query-the-api) | Yes | Yes |
| `GET /v1/connectors?projectId=` | Each model connector's models | Yes | No |
| `POST /v1/connectors/{id}/test-image` | Try an image model | Yes | No |
| `POST /v1/measurements/isolate-ready` | An internal measurement | Yes | No |

<!-- Sources (d031001): apps/cloudflare/src/gateway.ts:1-36, apps/selfhosted/src/gateway/gateway.ts:1-30, packages/identity/src/http.ts:1-8, packages/identity/src/passkey-http.ts:1-5, packages/identity/src/otp-http.ts:1-5, packages/runtime/src/http/server.ts:60-90, packages/runtime/HTTP.md:46-70, packages/browser/src/http.ts:1-25, packages/workspace/src/read-api.ts:1-30, packages/workspace/src/write-api.ts:40-80, packages/vault/src/approval-api.ts:1-30, packages/audit/src/http.ts:59-64, apps/cloudflare/src/connectors.ts:1-23 -->
