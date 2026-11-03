---
title: Create and manage sandboxes
description: Create a sandbox, then start, stop, pause, resume, fork, recover and delete it, with auto-stop, labels and sharing, from curl or the TypeScript SDK.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A sandbox goes through a few states in its life. You create it, it runs, and it stops by itself after an hour unless you say otherwise. You can stop it, start it again, copy it, and delete it for good when you're done.

## Before you start

The examples call the API with `curl` and the [TypeScript SDK](/tools/typescript-sdk/). Both read your control plane's address and a [scoped API key](/accounts/api-keys/) from the environment:

```sh
export KANTEL_URL=http://127.0.0.1:58090
export KANTEL_API_KEY=ksk_...
```

On a self-hosted install, [turn on the compute API](/self-hosting/install/#turn-on-the-compute-api) first; it gives you a first key. In fish, use `set -x KANTEL_URL http://127.0.0.1:58090` instead of `export`. The key needs `sandboxes:read` and `sandboxes:write` for most of this page, and `sandboxes:delete` to delete. The `agent` preset has everything here except deleting.

The SDK examples on these pages use this client, with the SDK's file copied into your project as [TypeScript SDK](/tools/typescript-sdk/#add-it-to-your-project) describes:

```ts
import { createKantelClient } from "./kantel-sdk.ts";

const kantel = createKantelClient({
	baseUrl: `${process.env.KANTEL_URL}/v1`,
	token: process.env.KANTEL_API_KEY,
});
```

## Create a sandbox

Every field of the body is optional. An empty body gives you an isolate with a generated name, in the key's account:

```sh
curl -s "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{}'
```

Most agents want a full Linux machine. Ask for a microVM, and add `wait` to get the answer once it's running rather than as soon as a host has taken it:

```sh
curl -s "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type": "microvm", "name": "fix-login-bug", "size": "default", "labels": {"ticket": "PROJ-12"}, "wait": true}'
```

```ts
const sandbox = await kantel.createSandbox({
	type: "microvm",
	name: "fix-login-bug",
	size: "default",
	labels: { ticket: "PROJ-12" },
	wait: true,
});
console.log(sandbox.id, sandbox.state); // sbx_4kq9x2mt running
```

The answer is the [Sandbox](/api/reference/types/#sandbox). An abridged one:

```json
{
  "id": "sbx_4kq9x2mt",
  "name": "fix-login-bug",
  "type": "microvm",
  "size": "default",
  "image": "ubuntu-24.04",
  "state": "running",
  "visibility": "private",
  "capabilities": { "exec": true, "files": true, "ssh": true, "desktop": true, "browser": true, "ports": true, "docker": true, "kvm": true, "pause": true },
  "labels": { "ticket": "PROJ-12" },
  "autoStopMinutes": 60,
  "stopsAt": 1793664000000,
  "cost": { "currency": "USD", "total": 0, "ratePerHour": 0 }
}
```

The fields you can set when you create one:

| Field | What it does |
| --- | --- |
| `type` | `isolate` (the default) or `microvm`. See [Isolates and microVMs](/sandboxes/types/) |
| `size` | A microVM's size: `small`, `default`, `large` or `xlarge`. A deployment may offer fewer |
| `image` | A microVM's base image, such as `ubuntu-24.04`. Without it, the deployment's default |
| `from` | Start from a snapshot instead: a snapshot's ID, or the name of a [saved snapshot](/snapshots/saved/) |
| `name` | Up to 63 characters. Without it, a generated name such as `brave-otter` |
| `autoStopMinutes` | Minutes after each start before it stops by itself. Default 60, at most 43,200 (30 days); `null` never |
| `labels` | Your own key-value pairs, to find it again |
| `env` | Environment variables every command in it sees. Anyone who can run commands in it can read them, so don't put secrets here |
| `visibility` | In an organisation, `private` or `organisation`. See [Accounts and organisations](/accounts/organisations/) |
| `hostLabels` | Place it only on a host with these labels, such as `{"site": "home"}` |
| `account` | The organisation to create it in, when you're signed in as a person. A key always uses its own account |
| `wait` | Answer once it's `running` (or in `error`) |

A create is safe to retry. Send an `Idempotency-Key` header with a value of your own, such as a UUID; a retry with the same key gets the first answer and makes no second sandbox. In the SDK, pass `{ idempotencyKey: crypto.randomUUID() }` as the last argument.

If every host is full, the create answers `429` with `exhausted`. If no host can run the type you asked for, such as a microVM on a deployment with no KVM host, it answers `503` with `unavailable`.

## States

| State | What it means |
| --- | --- |
| `starting` | A host has taken it and is booting it |
| `running` | Commands run now |
| `stopping` | Its disk is being saved |
| `stopped` | It has no machine. Its disk is kept, and its running programs are gone |
| `paused` | Like `stopped`, but its memory is kept too (microVMs only) |
| `error` | The last operation failed or its machine was lost |
| `deleting`, `deleted` | Erased for good |

A running sandbox can also report `health: "degraded"` when its host can't fully reach it. It keeps running, and `reason` says why.

## List and find sandboxes

The list shows the sandboxes that are starting, running or stopping, newest first. Add `all=true` for stopped, paused and errored ones too, `state` for one state, and `label.<key>=<value>` to filter by label:

```sh
curl -s "$KANTEL_URL/v1/sandboxes?all=true&label.ticket=PROJ-12" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {id, name, state}'
```

```ts
const page = await kantel.listSandboxes({ all: true, label: { ticket: "PROJ-12" } });
for (const sandbox of page.items) console.log(sandbox.id, sandbox.state);
```

Pages hold 50 by default, up to 500 with `limit`. When there are more, the answer has `nextCursor`; pass it back as `cursor`. One sandbox is `GET /v1/sandboxes/{sandboxId}` (`getSandbox`).

## Stop or pause

A stop saves the sandbox's disk as a snapshot and lets the machine go. Programs that were running end. A stopped sandbox costs nothing to run.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/stop" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"wait": true}'
```

A pause keeps the sandbox's memory as well as its disk, so a resume carries on exactly where it left off, with the same programs running. Only microVMs pause, and only where the sandbox's `capabilities.pause` is `true`; an isolate answers `501` with `not_supported`.

```ts
await kantel.stopSandbox("sbx_4kq9x2mt", { keepMemory: true, wait: true }); // paused
```

Without `wait`, a stop answers at once with the sandbox in `stopping`.

## Resume or start

A resume brings a sandbox back with the same ID on a new machine. A paused sandbox carries on from its memory. A stopped one boots from its newest snapshot.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/resume" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"size": "large", "wait": true}'
```

Give `size` to come back bigger or smaller. A start (`POST /v1/sandboxes/{sandboxId}/start`, `startSandbox`) takes the same body but always boots fresh from the newest disk snapshot: a paused sandbox's memory is let go, and its programs start again. Use it when a paused sandbox's programs are in a state you don't want back. Starting a sandbox that's already running answers it as it is.

## Auto-stop and extending

A sandbox stops by itself `autoStopMinutes` after each create, start or resume. While it runs, `stopsAt` says when. To give it longer, move its stop time from now:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"extendMinutes": 240}'
```

Set `"autoStopMinutes": null` to turn auto-stop off, so it runs until you stop it. The same call renames a sandbox, replaces its `labels` (send them all: the ones you leave out go) and changes its `visibility`.

## Fork

A fork makes new sandboxes, each a copy of an existing one. The source doesn't change. Prepare one sandbox, with your repository cloned and its dependencies installed, then fork it once for each agent:

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/fork" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"count": 5, "labels": {"batch": "evals-3"}, "wait": true}' | jq -r '.items[].id'
```

```ts
const forks = await kantel.forkSandbox("sbx_4kq9x2mt", { count: 5, labels: { batch: "evals-3" }, wait: true });
await Promise.all(forks.items.map((fork) => kantel.runCommand(fork.id, { command: "pnpm test" })));
```

`count` is 1 by default and at most 50. A fork copies the source's newest snapshot, or the one `snapshotId` names from its history. A running microVM on a host that can fork live is copied with its memory. Each copy gets its own ID and records the source in `source.sandboxId`. Forks are idempotent like creates.

## Recover

A sandbox that stops answering, or lands in `error`, can be recovered. Kantel restarts its machine on its disk as it is. Anything in memory is lost.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/recover" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

A resume also works on a sandbox in `error`, from its newest snapshot.

## Delete permanently

Deleting a sandbox erases it and its automatic snapshots for good. It can't be undone. [Saved snapshots](/snapshots/saved/) taken from it stay. The key needs `sandboxes:delete`, which the `agent` preset leaves out on purpose.

```sh
curl -s -X DELETE "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

The answer is the sandbox in `deleting`. It leaves the list once it's gone.

## Usage and cost

Each sandbox carries its `cost` (`total` so far and `ratePerHour` at its size) and a `usage` summary, with `recentCpu`: CPU use over the last two hours in 5-minute steps, from 0 to 1. A self-hosted install's rates are 0 unless its operator sets them. For more detail, ask for its usage over time:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/usage?intervalSeconds=3600" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

It covers the last 24 hours unless `since` gives another start, as epoch milliseconds.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:318-507, packages/api/src/compute-schema.ts:201-504, packages/api/src/sdk-runtime.ts:1-60, packages/api/src/route.ts:40-90 -->
