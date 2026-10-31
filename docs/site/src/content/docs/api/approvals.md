---
title: Approvals
description: What happens when an agent needs a person's say-so, and which approvals an app can answer today.
sidebar:
  order: 5
---

Some things an agent can't do on its own. It can ask for a browser on named sites, and a person decides. It can ask for a connection, a credential, and a person approves it. Kantel never lets an agent approve its own request.

Today an app can answer browser requests. Connection approvals are made by people in the console. Other kinds of card are defined in the protocol but not used yet.

## Browser requests

When the agent calls `browser_request`, the call waits up to 10 minutes for a decision. In the transcript it is a `tool` item named `browser_request`, still `running`, whose `args` hold the agent's `reason` and the `sites` it wants:

```json
{
  "kind": "tool",
  "id": "…",
  "callId": "CALL_ID",
  "name": "browser_request",
  "status": "running",
  "args": { "reason": "Check the order status page", "sites": ["shop.example.com"] }
}
```

Answer it with `POST /v1/browser/decisions`, naming the session and the call:

```bash
curl -s -X POST "$KANTEL_URL/v1/browser/decisions" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"sessionId":"SESSION_ID","callId":"CALL_ID","allow":true}'
# { "status": "granted" }
```

```ts
async function decideBrowser(sessionId: string, callId: string, allow: boolean) {
	const response = await fetch(`${process.env.KANTEL_URL}/v1/browser/decisions`, {
		method: "POST",
		headers: { authorization: `Bearer ${process.env.KANTEL_API_KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ sessionId, callId, allow }),
	});
	if (!response.ok) throw new Error(`Kantel answered ${response.status}`);
	return (await response.json()) as { status: "granted" | "declined" };
}
```

Allowing grants the sites the agent named, for 30 minutes, and the agent's call returns. Declining tells the agent so, and it carries on. Deciding needs the `operator` role on the session's project, as a person or an API key. A call that is no longer waiting answers `404`.

This route is one of the console's, so it isn't in the OpenAPI document or the SDK; see [Unlisted routes](/api/reference/unlisted/). It is served only when the deployment has a browser.

Once a browser is open, your app can show it in its own page with the embed API; see [Browsers](/console/browsers/#embedding-a-browser-in-another-app).

## Connection approvals

Kantel gives an agent a credential only through a grant a person approved. An approval is a `card` item in the transcript, of type `connection.approval`, with what the agent wants, why, the host, methods and path it would be used for, a binding code, an expiry and a `link` to the console's connection request page. Transcripts written before the rename carry the same card as `vault.approval`; read both for one release.

People decide on the console's **Connection requests** page. Once they have a passkey, approving needs it, and they confirm the binding code the agent showed. See [Connection requests](/console/connection-requests/).

What an app can't do yet:

- **Approve from your own app.** The approval routes under `/v1/connection-approvals` are the console's, made for a person's passkey. A host app can't approve requests itself.
- **See agents ask from a running session.** No session tool asks for a connection yet, so `connection.approval` cards don't appear in live transcripts today.

## Question cards

The protocol defines a `question` card, with the question, optional choices and an answer. Nothing emits one yet, and there is no route to answer one.

## Connections

Connecting an outside service by OAuth needs the person to sign in at the provider. Your app starts the connect with `POST /v1/connections/connect` and gives the person the `connectUrl`; Kantel checks the person who opens it is the one it was made for. See [Connectors](/console/connectors/#from-the-api).

## Waiting runs

A run that waits on a person holds its place: [`getRunResult`](/api/reference/messages/) answers `pending` until the decision arrives and the run ends. If nobody answers, the request times out and the agent is told. To give up sooner, abort the run with `POST /v1/sessions/{sessionId}/abort`.

<!-- Sources (d031001): packages/browser/src/session.ts:1-30,108-145,280-300,320-355, packages/browser/src/http.ts:1-25, packages/browser/src/index.ts:167-179, packages/browser/src/memory.ts:615-660, apps/console/src/ui/actions.ts:119-138, apps/console/src/api/client.ts:299-302, packages/api/generated/sdk.ts:142-157,1205-1212,1863-1883,1942-1957, packages/protocol/src/index.ts:166-198, packages/vault/src/approval-api.ts:1-30, packages/vault/CONTRACT.md:1-24, docs/design/public-api.md:61,175-178, docs/connections.md:40-60 -->
