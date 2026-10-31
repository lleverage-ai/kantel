---
title: Quick start
description: Create a session, send it a message, wait for the answer and close it, with curl or the TypeScript SDK.
sidebar:
  order: 3
---

This page takes you from an API key to an agent's answer. It uses polling, which needs nothing but HTTP. To show the agent's work as it happens, use the [stream](/api/streaming/) instead.

## Before you start

You need:

- a running Partan. Locally, the self-hosted stack is the quickest way: see [Install Partan locally](/console/getting-started/install/).
- an API key with the `operator` role on a project. The self-hosted stack writes one to its bootstrap file on first start; otherwise an admin issues one on the console's **API keys** page.
- the project's ID and an agent profile's ID. On Cloudflare the default profile is `assistant`. Self-hosted, the bootstrap makes `echo`, and `assistant` too when real models are set up.

```bash
export PARTAN_URL=http://127.0.0.1:58090   # your deployment's origin
export PARTAN_API_KEY=hbr_…
curl -s "$PARTAN_URL/v1/projects" -H "authorization: Bearer $PARTAN_API_KEY"
```

On Cloudflare, your calls also have to get through Cloudflare Access; see [Authentication](/api/authentication/#cloudflare-access).

## The TypeScript SDK

The SDK is generated from the API's routes. It is one file with no imports, which needs only `fetch` (and `WebSocket` for streams): `packages/api/generated/sdk.ts`. The `@harbour/*` packages aren't published to a registry yet, so copy that file into your app. The examples import it as `@harbour/api/sdk`; with a copy, import it from wherever you put it.

```ts
import { createHarbourClient } from "@harbour/api/sdk";

const partan = createHarbourClient({
	baseUrl: `${process.env.PARTAN_URL}/v1`,
	token: process.env.PARTAN_API_KEY,
});
```

Every method rejects with a `HarbourApiError` carrying the HTTP `status`, the error `code` and its `message`.

## 1. Create a session with its first message

One call creates the session and sends its first message. `labels` are yours: use them to find the session again from your own records.

```bash
curl -s -X POST "$PARTAN_URL/v1/sessions" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "projectId": "PROJECT_ID",
    "agentId": "assistant",
    "title": "Summarise the README",
    "labels": { "ticket": "SUP-1042" },
    "message": { "text": "Summarise README.md in three bullet points." }
  }'
```

```ts
const session = await partan.createSession({
	projectId: "PROJECT_ID",
	agentId: "assistant",
	title: "Summarise the README",
	labels: { ticket: "SUP-1042" },
	message: { text: "Summarise README.md in three bullet points." },
});
const submissionId = session.submission?.id;
```

The answer is `201` with the session record. With a `message`, it also has `submission`, the receipt for that message. If the first message is refused, the session is closed and the call answers the refusal.

## 2. Wait for the run to end

`GET /v1/sessions/{id}/result` waits up to `timeoutMs` (default 25 seconds, at most 120) for the run that message started. It answers `200` with the result once the run has ended, or `202` with `{ "status": "pending" }` while it goes on, so you call it again. The submission ID holds a `/`, so encode it.

```bash
curl -s -G "$PARTAN_URL/v1/sessions/SESSION_ID/result" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  --data-urlencode "submission=SUBMISSION_ID" \
  --data-urlencode "timeoutMs=60000"
```

```ts
async function waitForResult(sessionId: string, submission: string) {
	for (;;) {
		const result = await partan.getRunResult(sessionId, { submission, timeoutMs: 60_000 });
		if (result.status !== "pending") return result;
	}
}

const result = await waitForResult(session.id, submissionId!);
if (result.status === "answered") console.log(result.answer);
else console.error(result.status, result.error);
```

A result is `answered`, with the final `answer`; `failed`, with an `error`; or `aborted`. See [Results, usage and cost](/api/results-and-usage/).

## 3. Send another message

```bash
curl -s -X POST "$PARTAN_URL/v1/sessions/SESSION_ID/messages" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{ "via": "prompt", "text": "Now list any setup steps it mentions." }'
```

```ts
const next = await partan.sendMessage(
	session.id,
	{ via: "prompt", text: "Now list any setup steps it mentions." },
	{ idempotencyKey: crypto.randomUUID() },
);
const followUp = await waitForResult(session.id, next.id);
```

The answer is `202` with a submission. Send an `Idempotency-Key` so a retry can't send the message twice: a retry with the same key answers the first call's submission and sends nothing.

## 4. Stop or close it

`POST /v1/sessions/{id}/abort` stops the run in progress; the session stays open for more messages. `POST /v1/sessions/{id}/close` ends the session for good and releases its sandbox, browsers and grants.

```bash
curl -s -X POST "$PARTAN_URL/v1/sessions/SESSION_ID/close" -H "authorization: Bearer $PARTAN_API_KEY"
```

```ts
await partan.closeSession(session.id);
```

## Next

- [Streaming](/api/streaming/): follow the transcript live.
- [Approvals](/api/approvals/): what to do when a run waits on a person.
- [Host tools](/api/host-tools/): give the agent tools your app runs.
- [Sessions reference](/api/reference/sessions/): every session route.

<!-- Sources (d031001): packages/api/generated/openapi.json (createSession, sendMessage, getRunResult, abortSession, closeSession), packages/api/generated/sdk.ts:427-457,645-653,912-922,1066-1070,1430-1441,1840-1848,1966-2035,2192-2206, packages/runtime/HTTP.md:56-90, apps/selfhosted/src/gateway/components.ts:430-470, apps/cloudflare/src/stack.ts:660-693, deploy/compose/README.md:115-147 -->
