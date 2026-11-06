---
title: How snapshots work
description: The history of snapshots every sandbox keeps, taking one by hand, browsing and reading a snapshot's files, getting an older state back, and deleting snapshots.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A snapshot is a copy of a sandbox's disk at one moment, and, for a paused microVM, its memory too. Kantel takes them for you, so every sandbox has a history of its own. There are two kinds:

| Kind | Made by | Kept |
| --- | --- | --- |
| `automatic` | Kantel, as the sandbox runs and at every stop, or you with [Take a snapshot now](#take-a-snapshot-now) | Until it expires (`expiresAt`, 7 days after it was taken), or the sandbox is deleted. A sandbox's newest snapshot is kept past its time, as is one another snapshot record shares bytes with. On a host whose kantel-host can't keep a saved snapshot's own copy, the host prunes old ones itself instead. Expiry runs on app.kantel.dev; a self-hosted Kantel turns it on with `KANTEL_SNAPSHOT_EXPIRY=on` ([Install](/self-hosting/install/)) |
| `saved` | You, under a name | Until you delete it, even after its sandbox is gone. See [Saved snapshots](/snapshots/saved/) |

A sandbox's newest snapshot is what a resume or a fork starts from, and the sandbox names it in `latestSnapshotId`.

The examples use `KANTEL_URL`, `KANTEL_API_KEY` and the `kantel` client set up in [Create and manage sandboxes](/sandboxes/lifecycle/#before-you-start). Reading snapshots needs a key with `snapshots:read`, and taking or deleting them `snapshots:write`.

## List a sandbox's history

```sh
curl -s "$KANTEL_URL/v1/snapshots?sandboxId=sbx_4kq9x2mt" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {id, kind, trigger, createdAt}'
```

```ts
const history = await kantel.listSnapshots({ sandboxId: "sbx_4kq9x2mt" });
```

Snapshots come newest first, in pages like sandboxes. Each is a [Snapshot](/api/reference/types/#snapshot):

```json
{
  "id": "snap_2h8d6f",
  "kind": "automatic",
  "sandboxId": "sbx_4kq9x2mt",
  "sandboxType": "microvm",
  "state": "ready",
  "trigger": "stop",
  "memory": false,
  "sizeBytes": 1288490188,
  "createdAt": 1793660400000,
  "expiresAt": 1794265200000
}
```

`trigger` says what took it: `periodic` while the sandbox ran, `stop` at a stop or pause, `manual` when you asked, and `save` for a saved snapshot. `memory` is `true` for a pause, which kept the sandbox's memory too. A snapshot is usable once its `state` is `ready`.

`sizeBytes` is the space the snapshot takes on its host's disk now, and Kantel updates it every few minutes from what the host measures. It counts the blocks the snapshot's files have allocated. A file several snapshots share counts once: for a saved snapshot before an automatic one, otherwise for the oldest. So a snapshot you save from a sandbox's history shows the files it shares with that automatic snapshot, and the automatic one shows only what is its own. A size can change when a snapshot it shares files with is deleted. A copy that shares disk blocks without sharing the file, such as a reflinked copy, counts in full. Memory that hasn't been written to the disk yet doesn't count. `uses` counts the sandboxes made or forked from the snapshot, including deleted ones.

Without `sandboxId`, the list has the account's [saved snapshots](/snapshots/saved/#list-saved-snapshots). `kind=automatic` or `kind=saved` narrows a list to one kind.

## Take a snapshot now

Before a risky step, such as letting an agent run a migration, take a snapshot. The sandbox keeps running:

```sh
curl -s "$KANTEL_URL/v1/sandboxes/sbx_4kq9x2mt/snapshots" \
  -H "authorization: Bearer $KANTEL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"description": "Before the schema migration"}' | jq -r .id
```

```ts
const before = await kantel.takeSnapshot("sbx_4kq9x2mt", { description: "Before the schema migration" });
```

It keeps the disk alone; add `"memory": true` to keep a running microVM's memory too (see [Disk only, or memory too](/snapshots/saved/#disk-only-or-memory-too)). It answers at once, with the snapshot in `creating`. It joins the sandbox's history like any automatic snapshot, so it expires too: to keep it, [save it](/snapshots/saved/#save-a-snapshot).

A host refuses a snapshot that would leave it short of disk: less than 10 GiB free once it has copied the disk (and, for a running sandbox, written its memory), counting other snapshots still being written. That answers `429` with `exhausted`, and the message says how much is free. Delete snapshots you no longer need and try again. Saving from a sandbox's history links the files it already has, so it needs no room of its own.

## Browse a snapshot's files

You can look inside any snapshot without starting a sandbox from it, which is also how to read files from a stopped sandbox. List a directory, then read a file of up to 1 MiB:

```sh
curl -s "$KANTEL_URL/v1/snapshots/snap_2h8d6f/files?path=app" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq '.items[] | {name, kind, size}'

curl -s "$KANTEL_URL/v1/snapshots/snap_2h8d6f/file?path=app/.env.example" \
  -H "authorization: Bearer $KANTEL_API_KEY" | jq -r .content
```

```ts
const listing = await kantel.listSnapshotFiles("snap_2h8d6f", { path: "app" });
const file = await kantel.readSnapshotFile("snap_2h8d6f", { path: "app/.env.example" });
```

Paths work as they do for a [running sandbox's files](/sandboxes/commands-and-files/#read-a-file), relative to the user's home unless absolute, and `encoding=base64` reads a binary file. A snapshot that can't be browsed answers `501` with `not_supported`.

## Get an older state back

Pick the snapshot from the history, then do one of these:

- **Get one file back.** Read it from the snapshot and [write it](/sandboxes/commands-and-files/#write-a-file) into the running sandbox.
- **Start a copy from it.** [Fork](/sandboxes/lifecycle/#fork) the sandbox with `snapshotId`. The fork starts from that snapshot, and the sandbox itself stays as it is.
- **Keep it.** [Save it](/snapshots/saved/#save-a-snapshot) under a name, before it expires.

```ts
const copy = await kantel.forkSandbox("sbx_4kq9x2mt", { snapshotId: before.id, wait: true });
```

## Delete a snapshot

```sh
curl -s -X DELETE "$KANTEL_URL/v1/snapshots/snap_2h8d6f" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

This deletes an automatic snapshot or a saved one, and answers `204`. You can't delete the newest snapshot of a stopped sandbox, because its resume needs it: that answers `409` with `conflict`. [Deleting the sandbox](/sandboxes/lifecycle/#delete-permanently) deletes its whole automatic history at once.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:716-827, packages/api/src/compute-schema.ts:701-775, packages/api/src/compute-schema.ts:298-343 -->
