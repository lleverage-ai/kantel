---
title: Errors
description: The error body, every error code and its HTTP status, and which calls are safe to retry.
sidebar:
  order: 7
---

Every error has the same body:

```json
{ "error": { "code": "forbidden", "message": "…", "details": {} } }
```

`code` is one of the codes below, `message` says what went wrong in plain words, and `details` is present only when there is more to say. An error never carries a secret: an unexpected failure answers `500` `unavailable` without its message.

| Code | Status | Means |
| --- | --- | --- |
| `invalid` | 400 | The request is malformed, or a value is out of range |
| `unauthenticated` | 401 | The call has no credentials, or they aren't valid |
| `forbidden` | 403 | The caller lacks the role or permission the call needs |
| `not_found` | 404 | No such thing, or one the caller may not see |
| `conflict` | 409 | The request clashes with the current state, such as an `Idempotency-Key` reused with another `via` |
| `aborted` | 409 | The work was aborted |
| `expired` | 410 | It existed but has ended, such as a closed browser's live view |
| `refused` | 422 | A rule refused it, such as a first message the session won't take |
| `exhausted` | 429 | A limit was reached |
| `not_supported` | 501 | This deployment doesn't do that, such as listing a session's models where it has no model choice |
| `unavailable` | 503 | A dependency is down or not configured, or an unexpected failure (500) |

Something in another organisation is generally `not_found`, not `forbidden`, so a caller can't learn what exists there.

## In the SDK

Every SDK method rejects with a `HarbourApiError`:

```ts
import { HarbourApiError } from "@harbour/api/sdk";

try {
	await partan.getSession("SESSION_ID");
} catch (error) {
	if (error instanceof HarbourApiError && error.code === "not_found") {
		// The session doesn't exist, or this key may not see it.
	} else throw error;
}
```

It has the HTTP `status`, the `code`, the `message` and any `details`. A response with no error body becomes `unauthenticated` for a `401` and `unavailable` otherwise.

## Retrying

- `unavailable` and `exhausted` are worth retrying after a pause.
- `POST /v1/sessions/{id}/messages` takes an `Idempotency-Key`. Retry with the same key and Partan answers the first call's submission without sending the message again.
- `GET` calls are safe to repeat, and so is closing a session: closing a closed one does nothing.
- `POST /v1/sessions` takes no idempotency key. Put your own reference in `labels` and list sessions by label (`GET /v1/sessions?label.<key>=<value>`) before creating another.

## Signing-in errors

The self-hosted sign-in routes (`/auth/otp/...`) answer `400` `invalid`, `401` `unauthenticated` or `503` `unavailable`. A wrong or expired code answers `401` with the same body as any other, so the route can't be used to find out who has an account.

<!-- Sources (d031001): packages/runtime/HTTP.md:73-76, packages/api/generated/sdk.ts:2022-2085, packages/api/generated/openapi.json (components.schemas.ErrorBody, ErrorCode; listSessions label query), packages/browser/src/http.ts:45-55, packages/contracts/src/identity.ts:371-383, packages/api/generated/sdk.ts:2216 -->
