---
title: Saved snapshots
description: Save a sandbox's state under a name, start new sandboxes from it as a template, replace it with a newer version, and delete it.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A saved snapshot is a sandbox's state kept under a name until you delete it. It outlives the sandbox it came from, and any number of new sandboxes can start from it. That makes it a template: set a sandbox up once, with your repository cloned, your tools installed and your caches warm, save it, and start each new sandbox from there in the state you left it.

The examples use `KANTEL_URL`, `KANTEL_API_KEY` and the `kantel` client set up in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). Saving and deleting need a key with `snapshots:write`, listing `snapshots:read`, and creating sandboxes `sandboxes:write`.

## Save a snapshot

Set up a sandbox, then save it. It can be running or stopped:

```sh
curl -s "$KANTEL_URL/v1/snapshots" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "web-app-base", "sandboxId": "sbx_4kq9x2mt", "description": "Node 22, pnpm, repo cloned, deps installed"}'
```

```ts
const template = await kantel.saveSnapshot({
	name: "web-app-base",
	sandboxId: "sbx_4kq9x2mt",
	description: "Node 22, pnpm, repo cloned, deps installed",
});
```

This saves the sandbox's state now. To save a moment from its history instead, add that snapshot's ID as `snapshotId`; see [How snapshots work](/snapshots/history/).

A stopped sandbox's state is its newest snapshot. Saving it, or a snapshot from its history, keeps a copy of its own: the history entry stays in the history and still expires, and deleting either one leaves the other. A history entry older than the sandbox's newest stop may have kept only its disk, and a save of it then has `memory: false`. On [your own hosts](/hosts/), a host too old to keep a copy answers `501` with `not_supported`: update it, or start the sandbox and save it running.

A name is up to 63 characters of lower-case letters, digits, `-`, `_` and `.`, starting with a letter or digit, and is unique in its account. The answer is the [Snapshot](/api/reference/types/#snapshot), with `kind: "saved"`.

## Start sandboxes from one

Give the name, or the snapshot's ID, as `from` when you [create a sandbox](/sandboxes/lifecycle/#create-a-sandbox):

```sh
curl -s "$KANTEL_URL/v1/sandboxes" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type": "microvm", "from": "web-app-base", "name": "agent-1", "wait": true}'
```

```ts
const sandboxes = await Promise.all(
	["agent-1", "agent-2", "agent-3"].map((name) =>
		kantel.createSandbox({ type: "microvm", from: "web-app-base", name, wait: true }),
	),
);
```

Each new sandbox records where it came from in `source.snapshotId`. A snapshot keeps its sandbox's type in `sandboxType`, so start a microVM template as a microVM. A name that doesn't exist in the account answers `404` with `not_found`.

Creating from a saved snapshot and [forking](/sandboxes/lifecycle/#fork) both copy a state. Fork when the source is a sandbox you're working in now; save and create when the state is a template you'll come back to, or the source sandbox will be deleted.

## Update a template

Saving under a name already in use answers `409` with `conflict`. To replace the old version, say so with `replace`:

```sh
curl -s "$KANTEL_URL/v1/snapshots" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name": "web-app-base", "sandboxId": "sbx_7wn3p5rc", "replace": true}'
```

Sandboxes already made from the old version keep running as they are; only new ones start from the new version.

## List saved snapshots

```sh
curl -s "$KANTEL_URL/v1/snapshots?kind=saved" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {name, id, sandboxType, sizeBytes}'
```

A saved snapshot's `sandboxId` is the sandbox it came from, and is gone once that sandbox is deleted. One saved snapshot is `GET /v1/snapshots/{snapshotId}` (`getSnapshot`), and you can [browse its files](/snapshots/history/#browse-a-snapshots-files) like any other.

## Limits

A deployment may cap how many saved snapshots an account keeps. Saving past the cap answers `429` with `exhausted`. Your account's usage shows the cap as `limits.savedSnapshots`; see [Accounts and organisations](/accounts/organisations/#usage-and-limits).

## Delete a saved snapshot

Delete it by its ID. Sandboxes made from it are unaffected.

```sh
curl -s -X DELETE "$KANTEL_URL/v1/snapshots/snap_2h8d6f" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

[Webhooks](/monitoring/webhooks/) can tell you when a saved snapshot is made or deleted, with `snapshot.saved` and `snapshot.deleted`.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:749-817, packages/api/src/compute-schema.ts:701-775, packages/api/src/compute-schema.ts:365-404, packages/api/src/compute-schema.ts:485-504 -->
