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
  "image": "ubuntu-26.04",
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
| `image` | A microVM's base image, such as `ubuntu-26.04`. Without it, the deployment's default |
| `from` | Start from a snapshot instead: a snapshot's ID, or the name of a [saved snapshot](/snapshots/saved/) |
| `name` | Up to 63 characters. Without it, a generated name such as `brave-otter` |
| `autoStopMinutes` | Minutes after each start before it stops by itself. Default 60, at most 43,200 (30 days); `null` never |
| `idleStopMinutes` | Also stop it once it has gone this many minutes without use. Default `null`: no idle stop. See [Idle stop](#idle-stop) |
| `labels` | Your own key-value pairs, to find it again |
| `env` | Environment variables every command in it sees. Anyone who can run commands in it can read them, so don't put secrets here |
| `environments` | [Environments](/sandboxes/environments/) to start with, by name or ID, in order: where two set the same variable, file or repository path, the later one wins. At most 10. `environment` takes one |
| `visibility` | In an organisation, `private` or `organisation`. See [Accounts and organisations](/accounts/organisations/) |
| `hostLabels` | Place it only on a host with these labels, such as `{"site": "home"}` |
| `account` | The organisation to create it in, when you're signed in as a person. A key always uses its own account |
| `wait` | Answer once it's `running` (or in `error`) |

A create is safe to retry. Send an `Idempotency-Key` header with a value of your own, such as a UUID; a retry with the same key gets the first answer and makes no second sandbox. If the first call failed part way or stopped answering, a retry is `409` `conflict` with `details.idempotencyKey: "held"` and makes none: list your sandboxes (by label, say) to see whether it was made, then use a new key. In the SDK, pass `{ idempotencyKey: crypto.randomUUID() }` as the last argument. Fork, change, recover and delete take a key too; [Safe retries](/api/reference/#safe-retries) lists every call that does, and why the others need none.

### When it can't be placed

When no host can take the sandbox, Kantel says why with a `reason`. A check it can make before placing it refuses the call, with the reason in `details.reason` beside the error's code and message:

```json
{
  "error": {
    "code": "unavailable",
    "message": "No host can run a microvm sandbox now",
    "details": { "reason": "no_host_for_type" }
  }
}
```

Others are found only once a host is being chosen, such as hosts that turn out to be full, or a host that drops off as the sandbox boots. The call then answers as usual and the sandbox goes to `error`, with the reason in its `placementReason` and in the `sandbox.error` event's data; with `wait`, the answer is that sandbox. Any reason can come either way, so check both.

| `reason` | Code (and status, at the call) | What it means | What to do |
| --- | --- | --- | --- |
| `no_host` | `503 unavailable` | No host you may use is connected | Try again once one is |
| `no_host_for_type` | `503 unavailable` | No host runs the type, such as a microVM on a deployment with no KVM host | Ask for the other type |
| `no_host_with_labels` | `503 unavailable` | No host has every label in `hostLabels` | Ask for other labels, or none |
| `no_host_offers_size` | `501 not_supported` | No host offers the size or can make the `resources` | Ask for another size; `GET /v1/sandbox-shapes` says what there is |
| `no_host_enforces_egress` | `501 not_supported` | No host that could take it enforces egress grants or protected variables | Upgrade `kantel-host` |
| `no_host_for_template` | `501 not_supported` | No host that could take it runs templates, or builds the template's custom image | Create it without the template, or turn a host's template builder on |
| `insufficient_capacity` | `429 exhausted` | Hosts match, but none has the memory or disk free now | Try again later, or ask for less |
| `host_unavailable` | `503 unavailable` | The host its disk or snapshot is on is offline, draining or not one you may use now, or it dropped off during the boot | Try again later |
| `account_limit` | `429 exhausted` | The account runs as many sandboxes as it may | Stop or delete one |

The same goes for a start, resume or fork, and for a create from a snapshot. These run only on the host their disk or snapshot is on, so when that host is offline or isn't one you may use, the reason is `host_unavailable`, whatever other hosts there are. A host that is there can still refuse one for its own reason, such as `insufficient_capacity` or `no_host_enforces_egress`. Other errors have no `reason`.

## States

| State | What it means |
| --- | --- |
| `starting` | A host has taken it and is booting it |
| `running` | Commands run now |
| `stopping` | Its disk is being saved |
| `stopped` | It has no machine. Its disk is kept, and its running programs are gone |
| `paused` | Like `stopped`, but its memory is kept too (microVMs only) |
| `moving` | Being moved to another host, then started there; its `move` says how far (`copying`, `stopping`, `final-copy`, `starting`) |
| `error` | The last operation failed or its machine was lost |
| `deleting`, `deleted` | Erased for good |

A running sandbox can also report `health: "degraded"` when its host can't fully reach it. It keeps running, and `reason` says why.

A microVM whose host ends it without being asked goes from `running` to `error`, with a `sandbox.error` event. That happens when the host runs short of memory and stops it, when the kernel kills it at the host's memory limit, when it crashes, or when the host restarts. Its `reason` gives the host's words, such as `Out of memory: …`. Its disk is kept on its host, so a start or a recovery boots it from there. Anything that was in memory is lost.

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

Without `wait`, a stop answers at once with the sandbox in `stopping`. A stop is safe to retry without a key: once the first has finished, stopping a stopped sandbox (or pausing a paused one) answers it as it is.

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

`extendMinutes` and `autoStopMinutes` count from when the call arrives, so a retry a minute later moves the stop time a minute on. Send an `Idempotency-Key` to have a retry keep the first call's `stopsAt`.

## Idle stop

Auto-stop is a lifetime: it stops a sandbox that's still in use. An idle stop stops one that nobody is using. Set `idleStopMinutes` and the sandbox stops once it has gone that long without use, whichever comes first of the two. For a shared test environment that people sign in to now and then, turn auto-stop off and give it an idle stop, so it runs while it's used and stops half an hour after:

```sh
curl -s -X PATCH "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"autoStopMinutes": null, "idleStopMinutes": 30}'
```

With the CLI, that's `kantel new --auto-stop never --idle-stop 30`, or `kantel extend <id> --idle-stop 30` for one that's running. `--idle-stop never` (`null`) turns it off.

These count as use, and each one starts the idle time again:

- A call that needs the sandbox running: a command, its files, exposing a port, opening SSH, the desktop or the browser. A command you wait on counts for as long as it runs; a detached one counts while you follow it (`getCommand`, `kantel exec --attach`).
- Traffic through Kantel's relay: bytes either way over SSH, the desktop or browser, and requests and WebSocket messages to its hosted ports. An SSH session left open with nothing going over it isn't use.

While it runs, the sandbox's `lastActiveAt` says when it was last used (to within about 20 seconds) and `idleStopsAt` when the idle stop comes if nobody uses it first. It stops within about half a minute after that, so use that another gateway saw has reached the record before any gateway stops it. An idle stop is like any other: its disk is kept, and it starts again when you resume it. Its `reason` is `idle-stop`, where an auto-stop's is `auto-stop`, and the `sandbox.stopped` event says so too. Nothing resumes it by itself: a command to it answers `409` (see [When the sandbox isn't running](/sandboxes/commands-and-files/#when-the-sandbox-isnt-running)), and a request to one of its hosted ports gets a page saying it is stopped and why (see [Public ports](/sandboxes/public-ports/#when-the-sandbox-stops)).

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

A microVM fork is its source's machine: the same vCPUs, memory and disk, a custom shape included, unless you name another `size` (only from a snapshot of the disk alone). Its `resources` say so from the moment it's made, while it is still `starting`.

A fork also gets the ports its source has exposed when it's forked, once the fork runs: each the same port, public or behind a token as it was, at the fork's own URL (`https://<port>-<fork's subdomain>.<domain>`). A token-gated port's token is new and isn't shown; expose the port again on the fork to get its URL with a token. The ports are exposed as whoever forked, so they work only while that person or key may open the fork's ports: an API key without the `access` scope still forks, but its forks get no ports. A port someone exposes on the fork by hand while they are being copied is kept as they exposed it. A stopped source has no exposed ports, so a fork of one has none.

## Recover

A sandbox that stops answering, or lands in `error`, can be recovered. Kantel restarts its machine on its disk as it is. Anything in memory is lost.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/recover" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

A resume also works on a sandbox in `error`, from its newest snapshot.

A running sandbox is recovered too, so a retry would restart it again and end what had started since. Send an `Idempotency-Key` to make a retry answer the first recover instead.

## Upgrade an isolate

`POST /v1/sandboxes/{id}/upgrade` (`kantel upgrade <id>`) turns a running or stopped isolate into a microVM with the same ID, files and settings: see [Upgrade an isolate to a microVM](/sandboxes/types/#upgrade-an-isolate-to-a-microvm). With `from` (`kantel upgrade <id> --from <snapshot>`) the microVM starts from a snapshot of a microVM, as a create from it would, with the isolate's files laid over it: see [Upgrade into a snapshot](/sandboxes/types/#upgrade-into-a-snapshot). `autoUpgrade` on a create or a `PATCH` has an isolate do it by itself when a command needs a microVM, into the snapshot `autoUpgradeFrom` names, if any.

## Move to another host

`POST /v1/sandboxes/{id}/move` (`kantel move <id>`) moves a microVM to another host in its pool and starts it there. It keeps its ID, name, settings and URLs. Its disk and its sticky disks' copies go with it, including writes to them that weren't committed. Only once it runs on the new host is it placed there and its copy on the old host deleted. If it can't be moved, it is left where it was. A move never leaves the sandbox's pool, and it needs the pool's sync on and hosts with a kantel-host that moves sandboxes.

`hostId` (`--to <host>`) picks the host. Otherwise the scheduler picks one, as for a create. While it moves, its state is `moving`.

Memory doesn't move yet, so a running or paused sandbox moves only with `keepMemory: false` (`--drop-memory`), and boots on its disk on the new host. Its automatic snapshots from before stay on the old host.

A running sandbox moves with a restart, so it is unavailable for seconds rather than for the whole copy:

1. `copying`: its disk and sticky disks are copied as it runs. It still runs commands and serves its ports.
2. `stopping`: it is stopped. Its processes end, and running commands are killed.
3. `final-copy`: only what it wrote since the first copy is copied.
4. `starting`: it boots on the new host, from its disk.

From `stopping` on, commands and file calls wait for it as they do for a start. If the move fails after the stop, the sandbox is started again where it was. A stop, pause or delete during `copying` ends the move first. Both hosts need a kantel-host that moves running sandboxes.

```sh
curl -s -X POST "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/move" \
  -H "authorization: Bearer $KANTEL_API_KEY" -H 'content-type: application/json' -d '{}'
```

## Delete permanently

Deleting a sandbox erases it and its automatic snapshots for good. It can't be undone. [Saved snapshots](/snapshots/saved/) taken from it stay. The key needs `sandboxes:delete`, which the `agent` preset leaves out on purpose.

```sh
curl -s -X DELETE "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

The answer is the sandbox in `deleting`. It leaves the list once it's gone. A second delete once it's gone is `404` with `not_found`; with an `Idempotency-Key`, a retry gets the first answer instead.

## Usage and cost

Each sandbox carries its `cost` (`total` so far and `ratePerHour` at its size) and a `usage` summary, with `recentCpu`: CPU use over the last two hours in 5-minute steps, from 0 to 1. A self-hosted install's rates are 0 unless its operator sets them. For more detail, ask for its usage over time:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/usage?intervalSeconds=3600" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

It covers the last 24 hours unless `since` gives another start, as epoch milliseconds.

Each point is an interval's means, with its highest readings beside them: `memoryMbMax` and `cpuMax`. A sandbox's memory can peak at twice its mean or more, so size it from the highest. The 5-second readings (`series`) are kept for an hour; after that the highest are all that's left of a peak. `usage.peakMemoryBytes` (with `peakMemoryAt`) and `usage.peakCpu` are its highest since it was made, and stay on its record after it's deleted. `kantel usage <id>` prints them.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:318-507, packages/api/src/compute-schema.ts:201-504, packages/api/src/sdk-runtime.ts:1-60, packages/api/src/route.ts:40-90 -->
