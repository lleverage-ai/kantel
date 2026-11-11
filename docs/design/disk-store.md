# The disk store: sticky disks, and keeping disks in sync across an organisation's hosts

Status: proposed (11 Nov 2026). Phase 1 is being built; phases 2 to 4 are the plan.

## What it's for

Three kinds of disk data in Kantel outlive a sandbox, and today all three are stuck on the host that made them:

| Kind | What | Lost, what happens |
| --- | --- | --- |
| Sticky disks (new) | Caches that jobs and agents warm and reuse: a pnpm store, Docker's images and build cache, a git mirror | The next sandbox starts cold. Nothing else is lost |
| Template snapshots | A template's built disk and memory | It is built again |
| Saved snapshots | A sandbox's state, kept by its person | Their work is lost |

An organisation with three hosts wants each of these on whichever host a sandbox lands on, without a copy of everything on every host, and without needing an object store. One storage layer, the disk store, does this for all three.

## What it isn't

Bucket mounts stay what they are: a read-only view of an object store someone else owns, such as Lleverage's workflow buckets in GCS. The bucket is the source of truth, external writers change it, and its contents are files, not disks. Kantel keeps a per-host read cache of them and never becomes their system of record. Lleverage's agent files stay in GCS.

The two meet in one place (phase 4): a host can ask a peer for a bucket chunk before it asks the bucket, saving GCS egress and latency on multi-host organisations. The chunk is identified as the mount cache already identifies it (store, bucket, key, version, credential), so a peer only serves a chunk read with the same credential.

## Sticky disks

A sticky disk is a named, versioned ext4 disk in an organisation, attached to a microVM as an extra drive and mounted at a path in the guest.

- Each sandbox gets its own copy-on-write clone of a version: instant on XFS or btrfs (`FICLONE`), whatever the disk's size. It may write anything, Docker's data directory included, because no other sandbox uses that copy.
- A sandbox's writes are thrown away when it goes, unless it was asked to commit. Committing makes its copy the disk's next version. Commits come only from callers the disk's policy trusts. For GitHub runners that's a job on a protected ref such as `refs/heads/main`, so pull request jobs never write the shared cache. That is stricter than the CI hosts today, whose caches any PR job writes, and it lets the merge queue use the warm cache too.
- Versions are immutable. The newest committed version is the disk's head. Two commits from the same version both become versions; the later one is the head. A cache needs no merging.
- A cache never needs the newest version: a sandbox takes the newest one its host has, and the head arrives in the background. CI never waits for a sync.

Attached in the template, for Lleverage's CI:

```yaml
stickyDisks:
  - name: ci-cache          # an org-scoped disk, made empty (ext4) on first use
    path: /var/lib/ci       # pnpm store, Docker's data-root, git mirror, and the job workspace
    sizeGb: 200
    commit: { refs: ["refs/heads/main"] }
```

The job's workspace goes on the same disk as the pnpm store, because pnpm links packages into `node_modules` only within one filesystem; across two it copies them. The trusted job deletes the workspace and prunes the caches (`pnpm store prune`, `docker image prune`) before it commits, and stops Docker cleanly.

## On one host: reflinks, not a chunk store

A host keeps each version it holds as a file, `disks/<disk>/<version>.img`, reflinked from the version it came from. A version costs only the blocks that differ from its parent; unchanged blocks share extents on disk. There is no separate chunk store holding a second copy of the data.

Each version has a block map: its size, and the SHA-256 of each 4 MiB block that isn't all zeros. Disks change in place, so fixed, aligned blocks find unchanged data as well as content-defined chunking would, and they line up with file ranges that can be reflinked or written in place. A 200 GB disk's map is about 1.6 MB.

Making a version's block map after a commit doesn't read the whole disk. A block whose extents are still shared with the parent's (same physical extents, from `FIEMAP`) hasn't changed and keeps the parent's hash; only unshared extents are read and hashed. A cache that a job changes by 2 GB costs 2 GB of reading.

Deleting an old version frees only its own blocks. A host keeps, for each disk: its newest version, any version a running sandbox was cloned from (until it ends), and any version a commit is being made from. Everything else is freed oldest first, once the host's disk store is over its budget (a share of the disk, set per host).

Blocks that are the same in two different disks (two templates on one base image, say) can share extents too (`FIDEDUPERANGE`, done in the background). That's an optimisation, not phase 1.

## Across hosts: hosts sync with each other

The control plane already knows every host and coordinates them, so it keeps the catalogue: each disk, its versions (ID, parent, size, block map digest, made when and by what), and which hosts hold which versions. Disk data moves between hosts, never through the control plane.

A host that needs a version (a sandbox placed on it needs it, or the prefetch policy below) asks the control plane which hosts hold it, and gets a short-lived grant for those hosts and that version. Then it:

1. Fetches the version's block map from a holder and checks it against the catalogue's digest.
2. Reflinks its own nearest version of the disk (or starts from a sparse file) into a new file.
3. Fetches each block whose hash differs, from several holders at once, checks each block's hash, and writes it in place.
4. Reports that it holds the version.

Only changed blocks cross the network, and a host only ever holds what it needs. Every block is checked against a hash the control plane vouches for, so a peer can't serve bad data.

Which hosts hold what:

- **Sticky disks**: the hosts that run sandboxes using the disk prefetch its head after each commit. Others fetch on first use. No copy is required to survive: a lost disk is a cold cache.
- **Template snapshots**: fetched from a peer that built them, instead of every host building its own. A host still builds one when no peer has it.
- **Saved snapshots**: kept on two hosts when the organisation has two or more, so losing a host doesn't lose a person's work. This costs disk, so it's a per-organisation setting, on by default.

Placement prefers a host that already holds a sandbox's sticky disk's head, or its snapshot, as it prefers a host with the owner's isolates today. It doesn't insist, because the fetch is in the background.

### Transport between hosts

Hosts today take no inbound connections: they dial out to the control plane. Peer sync needs one host to reach another. The choices:

1. **A peer port on each host, on the organisation's network.** The host listens on a port bound to its private or direct address (the same addresses the direct and private-network host links use: a LAN, a Tailscale tailnet, Hetzner's vSwitch). Each request carries the control plane's grant, and peers authenticate each other with certificates the control plane issues at join. Fast (block transfers at disk speed), simple, no outside dependency. Hosts that can't reach each other (behind different NATs, no shared network) can't sync this way.
2. **A mesh Kantel sets up**: WireGuard between an organisation's hosts, keys exchanged through the control plane, NAT traversal with a relay for the hard cases. Works everywhere, but it's a project of its own (Kantel Connect territory).
3. **Relay through the control plane.** Works everywhere with no inbound ports, but every block goes through the gateway: too slow and too costly for disks of hundreds of GB.

Decided (11 Nov 2026): 2, the mesh. It works whatever networks the hosts are on, and it's the start of Kantel Connect. Each host gets a WireGuard key and a mesh address at join; the control plane hands each host its organisation's peers (keys, addresses and the endpoints it has seen them at); hosts punch through NAT with the control plane coordinating, and fall back to a relay when they can't. Peer sync is plain HTTP over the mesh, so everything above it doesn't care how the bytes travel. Hosts with public addresses (Lleverage's Hetzner machines) connect directly.

Saved snapshots are kept on two hosts by default (decided 11 Nov 2026).

### An object store, optional

An organisation may add an object store (R2, GCS, S3) as a member that holds blocks but runs no sandboxes. Blocks go in under their hash, so they dedupe across versions and disks by themselves. It's for durability (saved snapshots with one host), for hosts that can't reach each other, and for a new host's first fetch. Nothing requires it.

## Phases

1. **Sticky disks on one host.** The catalogue in the control plane (disks, versions, holders), the API, attaching a version's clone as a drive, commit from a trusted caller, retention and the host's budget. GitHub runner pools get `stickyDisks` with a commit rule. Enough for CI on one host.
2. **Block maps and host-to-host sync.** Block maps with extent-based change detection, the peer port and grants, fetches by changed block, prefetch of heads, placement preference.
3. **Templates and saved snapshots on the disk store.** Template snapshots fetched from peers; saved snapshots kept on two hosts; their disks become versions like any other.
4. **The optional object store, and peers for bucket mount caches.**

## Open questions

- Whether Firecracker's virtio-block passes TRIM through to the host file (to be checked on a host). Without it, blocks a guest frees stay allocated in the version, and a cache that churns needs rebuilding from empty now and then (a disk setting: rebuild after N versions or past a size). With it, the trusted job runs `fstrim` before it commits.
- Commit needs the guest's filesystem quiet: the runner stops Docker, syncs and unmounts (or the sandbox is stopped) before the host freezes the clone.

## Phase 1: the host protocol

What the control plane and `kantel-host` agree on for sticky disks on one host. Names in TypeScript (`packages/hosts/src/protocol.ts`) and Go (`apps/host/internal/proto`) match.

- **Feature** `sticky-disks` (`HOST_FEATURES.stickyDisks`, `proto.FeatureStickyDisks`). Kantel sends sticky disks only to a host that reports it.
- **Slots.** Every microVM boots with `StickyDrives` (2) writable drives after its bundle drives, `sticky0.ext4` and `sticky1.ext4` in its VM directory, empty placeholder files until a disk is attached. Firecracker can't add a drive to a running VM and a template snapshot restores the drives it was built with, so the slots are always there; templates made before them are made again.
- **Attach**, on `sandbox.create` only: `stickyDisks: [{ diskId, path, sizeGiB, version? }]`, at most 2. The host clones the version file (`FICLONE`, a full copy where the filesystem can't) into a free slot, or, with no `version`, its newest version of the disk, or, with none, makes a new sparse ext4 of `sizeGiB`. It points the slot's drive at the clone (`PATCH /drives`) and the guest agent mounts it read-write at `path` (made if missing). The sandbox keeps its clones for its life: stop, start, resume and recover keep them, a fork clones them, and delete removes them.
- **Answer.** `HostSandbox.stickyDisks: [{ diskId, path, version?, state: "mounted" | "failed", reason? }]`, `version` being the version it was cloned from (absent for a new disk).
- **`sticky.commit`** `{ sandboxId, diskId, version }`: the guest agent syncs and freezes the mount (`FIFREEZE`), the host clones the slot's file to `sticky/<diskId>/<version>.img` under its root, and the guest thaws it. Answers `{ version, sizeBytes, allocatedBytes }`. `conflict` unless the sandbox is running; `not_found` when it has no such disk.
- **`sticky.delete`** `{ diskId, version? }`: deletes that version, or every version of the disk. Answers `{}`.
- **Holdings.** `HostCapacity.stickyDisks: [{ diskId, versions: [{ version, allocatedBytes, at }] }]` in every report. In phase 1 a host keeps its two newest versions of each disk and deletes older ones after a commit.
