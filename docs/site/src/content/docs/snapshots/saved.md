---
title: Saved snapshots
description: Save a sandbox's state under a name, start new sandboxes from it, replace it with a newer version, and delete it.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
These routes are part of Kantel's API, which every control plane serves. Their shapes may still change.
:::

A saved snapshot is a sandbox's state kept under a name until you delete it. It outlives the sandbox it came from, and any number of new sandboxes can start from it. Set a sandbox up once, with your repository cloned, your tools installed and your caches warm, save it, and start each new sandbox from there in the state you left it.

A saved snapshot records a state; Kantel doesn't know how it was made, so it can't rebuild it, and it doesn't pick up a newer base image. For an environment described by an image, a size and a setup script, which Kantel builds, keeps up to date and rebuilds for you, use a [template](/api/reference/templates/) instead (experimental), and save snapshots of the states you reach from it.

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
const saved = await kantel.saveSnapshot({
	name: "web-app-base",
	sandboxId: "sbx_4kq9x2mt",
	description: "Node 22, pnpm, repo cloned, deps installed",
});
```

This saves the sandbox's state now. To save a moment from its history instead, add that snapshot's ID as `snapshotId`; see [How snapshots work](/snapshots/history/).

A stopped sandbox's state is its newest snapshot. Saving it, or a snapshot from its history, keeps a copy of its own: the history entry stays in the history and still expires, and deleting either one leaves the other. A history entry older than the sandbox's newest stop may have kept only its disk, and a save of it then has `memory: false`. The separate copy needs an up-to-date host. On a host from before it could keep one (update it from the console), the save shares the history entry's files: it goes when the host prunes that entry, after a few more stops, or deletes it with the sandbox. To keep a save from such a host, start the sandbox and save it running.

### Disk only, or memory too

Saving a running microVM keeps its disk alone by default. A sandbox made from it starts up on that disk, at any size. Add `"memory": true` to keep the microVM's memory as well: a sandbox made from it then carries on where the saved one was, with its processes still running and nothing to start up, but it has to be the same machine size. Memory takes as much space as the machine has, several GB on the larger sizes, so save it only when a fast resume matters.

```ts
const warm = await kantel.saveSnapshot({ name: "web-app-warm", sandboxId: "sbx_4kq9x2mt", memory: true });
```

From the CLI, that's `kantel snapshot save sbx_4kq9x2mt web-app-warm --memory`; in the console, tick **Keep its memory too** in the Save snapshot dialog. Saving a stopped sandbox, or a snapshot from its history, keeps what that snapshot holds, as above: `memory` in the answer says which.

### The least memory a sandbox from it needs

A disk-only snapshot starts at any size, including one too small for the work it was saved for. A monorepo's type-check that needs 13 GB fails partway through on 8. Give `minMemoryMb` when you save it, and Kantel refuses a sandbox made from it with less memory (`invalid`, saying how much it needs) before it starts one:

```ts
await kantel.saveSnapshot({ name: "monorepo-checks", sandboxId: "sbx_4kq9x2mt", minMemoryMb: 16_384 });
await kantel.createSandbox({ from: "monorepo-checks", resources: { vcpus: 8, memoryMb: 16_384 } });
```

From the CLI, that's `kantel snapshot save sbx_4kq9x2mt monorepo-checks --min-memory 16`, then `kantel new --from monorepo-checks --vcpus 8 --memory 16`. It applies to every create from the snapshot, whatever size it asks for or none. A replace keeps the least of the snapshot it replaces unless it gives its own; `0` removes it. The snapshot's own machine may be smaller: the least is for what is made from it.

Kantel keeps a saved disk small: before it copies a running microVM's disk it asks the guest to trim the blocks deleted files left behind (with a sandbox image recent enough to do it), and on a host whose storage is XFS or btrfs the copy shares its blocks with the sandbox's disk until either changes.

A name is up to 63 characters of lower-case letters, digits, `-`, `_` and `.`, starting with a letter or digit, and is unique in its account. The answer is the [Snapshot](/api/reference/types/#snapshot), with `kind: "saved"`.

### Record what it holds, and how fresh it is

A snapshot says when it was saved (`createdAt`) and when the state it holds was taken (`takenAt`). The two differ when you save a stopped sandbox, whose state is from its stop, or a snapshot from its history. A snapshot saved before Kantel kept `takenAt` has none.

Kantel doesn't look inside the files, so it can't know what commit a checkout in the snapshot is at, or which lockfile its caches were built from. Record those yourself in `labels` when you save it (or take it), and read them back to tell how far a cache has fallen behind. Up to 20 labels, each value up to 500 characters:

```sh
base=$(kantel exec sbx_4kq9x2mt -- git -C /home/user/app rev-parse HEAD)
kantel snapshot save sbx_4kq9x2mt app-warm --replace \
  --description "Deps installed, build cache warm" --label git.base="$base"
```

```ts
const warm = await kantel.saveSnapshot({
	name: "app-warm",
	sandboxId: "sbx_4kq9x2mt",
	replace: true,
	labels: { "git.base": base },
});
```

`kantel snapshot info app-warm` shows its description, labels, when its state was taken and when it was saved; with `--json`, `jq -r '.labels["git.base"]'` gives the commit, for a client to diff its branch against. The console lists the description and labels under each saved snapshot's name. Labels are set when it's saved: to change them, save it again with `replace`.

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

Each new sandbox records where it came from in `source.snapshotId`. A snapshot keeps its sandbox's type in `sandboxType`, so start a microVM's snapshot as a microVM. A name that doesn't exist in the account answers `404` with `not_found`.

### Bring your branch into one

A sandbox made from a snapshot with a clone of your repository in it, its dependencies installed, only needs the difference from the clone's base commit. `kantel sync --git` sends just that, as one patch, rather than every file as `kantel push` does, which on a large monorepo takes minutes ([#726](https://github.com/lleverage-ai/kantel/issues/726)):

```sh
id=$(kantel new --type microvm --from app-warm --json | jq -r .id)
kantel sync "$id" --git --to /home/user/app
kantel exec "$id" --timeout 0 -- 'cd app && pnpm test'
```

It finds the base in the `git.base` label above, or in a `.kantel-base-sha` file at the top of the clone, which beats the label, since it belongs to the checkout rather than the snapshot. Your working tree goes as it is, uncommitted changes and new files included, and the sandbox's `node_modules` and build caches stay. Sync fails, and says why, when the trees don't match afterwards. A 2.5 MiB patch of 467 files into a 21,000-file monorepo took about 2.5 seconds. See [Syncing a git checkout](/tools/cli/#syncing-a-git-checkout).

Creating from a saved snapshot and [forking](/sandboxes/lifecycle/#fork) both copy a state. Fork when the source is a sandbox you're working in now; save and create when it's a state you'll come back to, or the source sandbox will be deleted.

## Replace a saved snapshot

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

## Two copies

Where a saved snapshot's pool has two or more hosts that sync snapshots (current `kantel-host`, in a [pool with sync on](/hosts/)), Kantel keeps it on two of them, so losing a host doesn't lose it. Once the host it was saved on has it ready, usually within a minute of the save, Kantel picks a second host in the pool and that host copies it: preferably one with the same CPU and runtime, which takes the memory too, otherwise the one with the most free disk. If a host with a copy is revoked, or has been offline for 24 hours, the remaining host copies it to another. Hosts never delete a copy to free space; they refuse new copies instead, and a host whose saved snapshot limit the account has used up isn't given one. A snapshot's details (`GET /v1/snapshots/{snapshotId}`, or `kantel snapshot info`) list its `hosts`, each `held` or `fetching`, with `memory` saying whether a sandbox made from it there restores its memory. A host you can't see (a shared one) is listed without its name.

Copies are on by default. An account's admin turns them off with `snapshotCopies: false` (`PATCH /v1/accounts/{accountId}`, or `kantel org set --snapshot-copies off`). New saves then stay on their own host, and copies that already exist stay until their snapshots are deleted. Snapshots saved on a host from before snapshot sync aren't copied.

## Limits

A deployment may cap how many saved snapshots an account keeps. Saving past the cap answers `429` with `exhausted`. Your account's usage shows the cap as `limits.savedSnapshots`; see [Accounts and organisations](/accounts/organisations/#usage-and-limits).

A host's admin may also limit how many bytes of saved snapshots each account keeps on that host (`savedSnapshotBytesLimit` on the [host](/hosts/#what-takes-the-disk)). A save that would take the account past it answers `429` with `exhausted`, saying how much the account has saved there, and the bytes it took for the save are deleted again. Each saved snapshot counts at its full size, including the files it shares with other snapshots, so copies that share files count separately.

## Delete a saved snapshot

Delete it by its ID. Sandboxes made from it are unaffected.

```sh
curl -s -X DELETE "$KANTEL_URL/v1/snapshots/snap_2h8d6f" \
  -H "authorization: Bearer $KANTEL_API_KEY"
```

[Webhooks](/monitoring/webhooks/) can tell you when a saved snapshot is made or deleted, with `snapshot.saved` and `snapshot.deleted`.

<!-- Sources (9cc20eb3): packages/api/src/compute-routes.ts:749-817, packages/api/src/compute-schema.ts:701-775, packages/api/src/compute-schema.ts:365-404, packages/api/src/compute-schema.ts:485-504 -->
