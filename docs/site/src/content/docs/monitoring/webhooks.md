---
title: Webhooks
description: Get a signed HTTPS request when a sandbox starts, stops, fails or is deleted, or a saved snapshot changes; check the signature; and test, follow and rotate a webhook.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, and a control plane serves them only when it runs with `KANTEL_COMPUTE=experimental`. Their shapes may still change.
:::

A webhook sends an account's events to an HTTPS endpoint of yours as they happen, so your systems hear when a sandbox is ready or has stopped without asking over and over. Each delivery is signed the way [Standard Webhooks](https://www.standardwebhooks.com/) are, so you can check it came from your Kantel.

The examples use `KANTEL_URL` and `KANTEL_API_KEY` as set in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). Managing webhooks needs a key with `account:admin`.

## Events

| Event | When |
| --- | --- |
| `sandbox.created` | A sandbox has been made, before it runs |
| `sandbox.running` | It runs commands now: after a create, start, resume, fork or recovery |
| `sandbox.stopped` | It stopped, by a call or by its auto-stop |
| `sandbox.paused` | It paused, keeping its memory |
| `sandbox.error` | It went into `error` |
| `sandbox.degraded` | Its host lost full contact with it |
| `sandbox.recovered` | Its host has it back |
| `sandbox.deleted` | It has been erased |
| `snapshot.saved` | A saved snapshot was made |
| `snapshot.deleted` | A saved snapshot was deleted |

## Create a webhook

Name it, give its URL, and choose the events it gets:

```sh
curl -s "$KANTEL_URL/v1/webhooks" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "ops", "url": "https://hooks.example.com/kantel", "events": ["sandbox.running", "sandbox.stopped", "sandbox.error"]}'
```

```ts
const { webhook, secret } = await kantel.createWebhook({
	name: "ops",
	url: "https://hooks.example.com/kantel",
	events: ["sandbox.running", "sandbox.stopped", "sandbox.error"],
});
```

The answer holds the webhook and its signing secret, which starts `whsec_`. The secret is shown only once, so store it where your endpoint can read it.

The URL must be HTTPS. A self-hosted install may allow `http://` to a private address, for an endpoint on your own network.

## What a delivery looks like

Each delivery is a `POST` whose body is one [Event](/api/reference/types/#event):

```json
{
  "id": "evt_8x7w6v",
  "type": "sandbox.stopped",
  "accountId": "acc_7f3k2m9q",
  "createdAt": 1793664000000,
  "sandboxId": "sbx_4kq9x2mt",
  "data": { "name": "fix-login-bug", "state": "stopped", "previousState": "running", "actor": { "kind": "api_key", "id": "key_5n2p8r", "name": "ci" } }
}
```

with three headers:

| Header | What it holds |
| --- | --- |
| `webhook-id` | The event's ID. A retry sends the same one, so use it to skip events you've already handled |
| `webhook-timestamp` | When this attempt was sent, in seconds since the epoch |
| `webhook-signature` | `v1,` and the signature |

Answer with a `2xx` status quickly, and do slow work afterwards. A delivery that fails or gets another status is tried again with growing gaps between tries, up to 8 attempts in all.

## Check the signature

Check every delivery before you trust it. The `standardwebhooks` package does it for you; give it the body exactly as it arrived, before any JSON parsing:

```sh
npm install standardwebhooks
```

```ts
import { createServer } from "node:http";
import { Webhook } from "standardwebhooks";

const verifier = new Webhook(process.env.KANTEL_WEBHOOK_SECRET!); // whsec_...

createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		try {
			const event = verifier.verify(body, request.headers as Record<string, string>) as { id: string; type: string };
			console.log(event.type, event.id);
			response.writeHead(204).end();
		} catch {
			response.writeHead(400).end();
		}
	});
}).listen(8080);
```

`verify` throws if the signature doesn't match or the timestamp is more than a few minutes off, which stops someone replaying an old delivery. Libraries for other languages are listed at [standardwebhooks.com](https://www.standardwebhooks.com/).

## Test a webhook

Send a signed test delivery, a `sandbox.created` event for a made-up sandbox, to check your endpoint end to end:

```sh
curl -s -X POST "$KANTEL_URL/v1/webhooks/whk_3m4n5b/test" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '{state, lastStatus, lastError}'
```

The answer is the delivery, with what your endpoint answered.

## Follow deliveries

Each webhook keeps 30 days of deliveries, newest first:

```sh
curl -s "$KANTEL_URL/v1/webhooks/whk_3m4n5b/deliveries" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {eventType, state, attempts, lastStatus, nextAttemptAt}'
```

A delivery is `pending` while it still has tries left, then `delivered` or `failed`. The webhook itself shows its `lastDelivery`.

The same events are in the account's event list too, so you can catch up on anything missed. Add `sandboxId` for one sandbox's history:

```sh
curl -s "$KANTEL_URL/v1/events?sandboxId=sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {type, createdAt}'
```

Listing events needs `sandboxes:read`.

## Change, pause and delete

Change a webhook's `name`, `url` or `events`, or set `enabled` to `false` to stop deliveries for a while:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/webhooks/whk_3m4n5b" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"enabled": false}'
```

Deleting a webhook (`DELETE /v1/webhooks/{webhookId}`) drops the deliveries still queued for it.

## Rotate the secret

```sh
curl -s -X POST "$KANTEL_URL/v1/webhooks/whk_3m4n5b/rotate" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq -r .secret
```

Deliveries are signed with the new secret from then on. One already on its way may still carry the old signature, so let your endpoint accept both secrets for a few minutes after you rotate.

<!-- Sources (712a09ae): packages/api/src/compute-routes.ts:929-1045, packages/api/src/compute-schema.ts:893-1031 -->
