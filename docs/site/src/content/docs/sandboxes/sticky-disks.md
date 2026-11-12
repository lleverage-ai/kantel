---
title: Sticky disks
description: Keep caches warm between sandboxes. A sticky disk is a named, versioned disk; each microVM gets its own copy-on-write copy of the newest version, and committing a sandbox's copy makes it the next version.
sidebar:
  badge:
    text: Experimental
    variant: caution
---

:::caution[Experimental]
Sticky disks are off unless the deployment turns them on with `KANTEL_STICKY_DISKS=experimental`, and they need hosts that run them. For now a disk's versions stay on the host that committed them: a sandbox on another host starts from an empty disk. Keeping an organisation's hosts in step is the next step (see the design in `docs/design/disk-store.md`).
:::

A sticky disk is for what jobs and agents warm up and want next time: a pnpm or npm store, Docker's images and build cache, a git mirror, compiled tools. It is an ext4 disk of a size you choose, mounted at a path you choose in a microVM.

- Each sandbox gets its own copy of the newest version its host holds, made in an instant whatever the disk's size. It can write anything, Docker's data directory included, because no other sandbox shares that copy.
- What a sandbox writes is thrown away when it is deleted, unless you **commit** its copy: then that copy is the disk's next version, and later sandboxes start from it.
- Only commit from sandboxes you trust. Every later sandbox reads what that one wrote.

## Use one

```sh
curl -X POST https://<your-kantel>/v1/sticky-disks \
  -H "authorization: Bearer $KANTEL_API_KEY" -H "content-type: application/json" \
  -d '{"account": "<organisation id>", "name": "ci-cache", "sizeGb": 200}'
```

Attach it when you create a microVM, up to two disks each:

```json
{ "type": "microvm", "stickyDisks": [{ "disk": "ci-cache", "path": "/var/lib/ci" }] }
```

The sandbox's `stickyDisks` says, for each, the version its copy came from (none for an empty disk) and whether it's `mounted`. When the sandbox has done its warming, commit:

```sh
curl -X POST https://<your-kantel>/v1/sandboxes/<sandbox>/sticky-disks/ci-cache/commit -H "authorization: Bearer $KANTEL_API_KEY"
```

The sandbox must be running. Its filesystem is frozen for the moment the copy takes, so stop anything still writing first (Docker, say). `GET /v1/sticky-disks/ci-cache` lists the newest versions, and `head` is the one new sandboxes start from.

## Tips

- Put a tool's working directory on the same disk as its cache. pnpm links packages into `node_modules` only within one filesystem, and copies them across two.
- Prune before you commit (`pnpm store prune`, `docker system prune`), and delete working files you don't want in the next version. A disk only grows otherwise.
- Pools of [GitHub Actions runners](/sandboxes/github-runners/) attach sticky disks and commit them after successful scheduled jobs on the branch you name.

## Where the data lives

A host keeps each version as a file cloned from the version before it, so a version takes only the blocks that changed. It keeps the two newest versions of each disk. Deleting a disk deletes its versions from every connected host, and again from any host that was away, as it reconnects, for 30 days; deleting an account does the same for its disks. A sandbox keeps its copy until it is deleted.

On a host whose filesystem can't clone files (XFS and btrfs can; ext4 can't), copying a disk means copying all of it: when a sandbox gets its copy, when it's made from a snapshot, and when it commits. Each full copy needs room for the disk's data and must leave 10 GiB of the host's disk free, or it fails for want of room; a sandbox's disk that couldn't be copied shows as `failed`, with why. A sandbox's snapshots need room for its sticky disks as well as its own disk.

<!-- Sources: docs/design/disk-store.md, packages/compute/src/service.ts (stickyDisksFor, commitStickyDisk), packages/hosts/src/protocol.ts (HOST_FEATURES.stickyDisks), apps/host/internal/microvm (sticky disks) -->
