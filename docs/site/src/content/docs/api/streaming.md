---
title: Streaming
description: Follow a session live over a WebSocket or server-sent events, fold frames into a snapshot, resume after a drop and page back through history.
sidebar:
  order: 4
---

`GET /v1/sessions/{sessionId}/stream` sends a session's transcript and state as they change: the agent's text as it is written, each tool call from start to result, status changes and the running usage. The console is built on it. It is served as a WebSocket or as server-sent events (SSE), with the same frames.

## Frames

A stream is a sequence of frames:

1. `hello`: the protocol version (`v: 1`), the session ID, a cursor, and `resumed`, which says whether deltas or a snapshot follow.
2. `snapshot`: the session's state and its latest page of items. Or, when you resume and the stream still holds what you missed, the `delta`s after your cursor instead.
3. `delta`: one for every change, live, each with a list of ops.

An `error` frame carries a `code` and a `message`.

A snapshot holds:

| Field | What |
| --- | --- |
| `cursor` | Where in the stream this snapshot is |
| `status`, `attention` | The session's status, and how a list groups it: `working`, `waiting` or `done` |
| `title` | The session's title |
| `items` | The latest page of transcript items, oldest first |
| `hasEarlier` | Whether older items exist; page back to them with [history](#history) |
| `usage` | The session's running token usage and cost |

A delta has its own `cursor`, a time (`at`) and `ops`:

| Op | Does |
| --- | --- |
| `append` | Adds an item |
| `replace` | Replaces the item with the same ID, such as a tool call once its result lands |
| `text` | Appends text to an assistant item's `text`, `thinking` or `document` |
| `args` | Appends to a string inside a tool item's `args` while the model is still writing the call |
| `status` | Sets the session's status and attention |
| `title` | Sets the title |
| `usage` | Sets the session's running usage |

Transcript items are `user`, `assistant`, `tool`, `card` and `notice`. Their fields are in the [types reference](/api/reference/types/#transcriptitem).

## Over a WebSocket

Connect with `Upgrade: websocket`. Each message is a JSON array of frames; `hello` and the snapshot arrive together. An empty array every 15 seconds keeps the socket open. You send nothing. The server compresses messages with `permessage-deflate` where the platform can.

The SDK's `streamSession` opens the socket for you. With a bearer token it passes the `authorization` header to the `WebSocket` constructor, which Node's built-in `WebSocket` (undici) accepts and a browser doesn't:

```ts
import { createHarbourClient } from "@harbour/api/sdk";

const partan = createHarbourClient({ baseUrl: `${process.env.PARTAN_URL}/v1`, token: process.env.PARTAN_API_KEY });

const stream = partan.streamSession("SESSION_ID", {
	onFrames(frames) {
		for (const frame of frames) {
			if (frame.type === "delta") {
				for (const op of frame.delta.ops) {
					if (op.op === "text" && (op.field ?? "text") === "text") process.stdout.write(op.append);
					if (op.op === "status") console.log(`\n[${op.status}]`);
				}
			}
		}
	},
	onClose({ code, reason }) {
		console.log("closed", code, reason, "resume from", stream.cursor);
	},
});
```

`stream.cursor` is the last cursor the stream sent. `stream.close()` closes it.

## Over server-sent events

Without an upgrade, the route answers `text/event-stream`. Each frame is one event named after its type (`hello`, `snapshot`, `delta`, `error`) with the frame as its JSON data. Snapshot and delta events carry their cursor as the event ID. After the first frames, one `ready` event says you have caught up. A comment every 15 seconds keeps the connection open.

```bash
curl -N "$PARTAN_URL/v1/sessions/SESSION_ID/stream" -H "authorization: Bearer $PARTAN_API_KEY"
```

```text
event: hello
data: {"type":"hello","v":1,"sessionId":"…","cursor":"…","resumed":false}

event: snapshot
id: …
data: {"type":"snapshot","snapshot":{…}}

event: ready
data: {}
```

A browser's `EventSource` can't send an `Authorization` header, so read the stream from your backend, or with `fetch` and a body reader.

## Folding frames into state

To keep a copy of the session, start from the snapshot and apply each delta's ops in order:

```ts
import type { ServerFrame, SessionSnapshot, TranscriptItem } from "@harbour/api/sdk";

function fold(state: SessionSnapshot | undefined, frame: ServerFrame): SessionSnapshot | undefined {
	if (frame.type === "snapshot") return frame.snapshot;
	if (frame.type !== "delta" || state === undefined) return state;
	let next: SessionSnapshot = { ...state, cursor: frame.delta.cursor, updatedAt: frame.delta.at };
	let items: TranscriptItem[] = [...next.items];
	for (const op of frame.delta.ops) {
		switch (op.op) {
			case "append":
				items.push(op.item);
				break;
			case "replace":
				items = items.map((item) => (item.id === op.item.id ? op.item : item));
				break;
			case "text":
				items = items.map((item) => {
					if (item.id !== op.itemId || item.kind !== "assistant") return item;
					const field = op.field ?? "text";
					if (field === "text") return { ...item, text: item.text + op.append };
					if (field === "thinking") return { ...item, thinking: (item.thinking ?? "") + op.append };
					return item.document ? { ...item, document: { ...item.document, text: item.document.text + op.append } } : item;
				});
				break;
			case "status":
				next = { ...next, status: op.status, attention: op.attention };
				break;
			case "title":
				next = { ...next, title: op.title };
				break;
			case "usage":
				next = { ...next, usage: op.usage };
				break;
			// This sketch skips "args", which streams a tool call's arguments while the model writes them.
		}
	}
	return { ...next, items };
}
```

An op may name an item older than the snapshot's page (when `hasEarlier` is true); skip it. Partan's own reducer, `applyFrames` in `packages/protocol/src/reduce.ts`, handles every op, `args` included, and keeps unchanged items as the same objects so a UI re-renders only what changed. The `@harbour/protocol` package isn't published yet, so copy `reduce.ts` and `args.ts` if you want it.

## Resuming

Reconnect with `?after=<cursor>`, the last cursor you hold. If the stream still holds the deltas after it, `hello` says `resumed: true` and they follow; otherwise you get a fresh snapshot. Over SSE, `Last-Event-ID` resumes too.

```ts
function follow(sessionId: string, after?: string) {
	const stream = partan.streamSession(
		sessionId,
		{
			onFrames: (frames) => {
				/* fold them */
			},
			// Reconnect from the last cursor the stream sent. Stop once you no longer need the session.
			onClose: () => setTimeout(() => follow(sessionId, stream.cursor ?? after), 1_000),
		},
		after === undefined ? {} : { after },
	);
}
```

## History

A snapshot holds only the latest page of items. To scroll back, call `GET /v1/sessions/{id}/history` with `before` set to the snapshot's first item ID, then follow `nextCursor`. Pages come newest first, up to 200 items each (default 50).

```bash
curl -s -G "$PARTAN_URL/v1/sessions/SESSION_ID/history" \
  -H "authorization: Bearer $PARTAN_API_KEY" \
  --data-urlencode "before=ITEM_ID" --data-urlencode "limit=50"
```

The self-hosted gateway doesn't serve history yet.

## When the stream is refused

A refused or unknown session answers a JSON error before any stream opens, with the usual status codes: `401`, `403` or `404`. See [Errors](/api/errors/).

<!-- Sources (d031001): packages/api/generated/openapi.json (streamSession, getSessionHistory), packages/protocol/src/index.ts:25-40,288-300, packages/protocol/src/reduce.ts:1-145, packages/api/generated/sdk.ts:553-590,1549-1556,1614-1633,1966-2010,2130-2185,2218-2225, packages/runtime/HTTP.md:69-111, apps/selfhosted/src/gateway/gateway.ts:157-170 -->
