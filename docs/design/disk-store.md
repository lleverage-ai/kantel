# The disk store: sticky disks, and keeping disks in sync across a pool's hosts

Status: phase 1 merged (#838, 11 Nov 2026). Phases 2 to 5 are proposed. Phase 2's plan and the design for moving a sandbox to another host (phase 4) were added on 13 Nov 2026, with their decisions made the same day.

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

## Pools

An organisation's hosts are split into pools, and a pool is the boundary for everything in this design. Lleverage, for example, will have around ten hosts: a CI pool, and pools for agent sandboxes and workflow runtimes. Hosts only need to reach, and share data with, the other hosts in their pool. Decided (13 Nov 2026):

- **A pool is a set of an account's hosts, and each host is in exactly one.** The operator's shared hosts are in the operator's own pools. Every account starts with a `default` pool, and existing hosts and data go into it, so an account with one pool sees no change.
- **The mesh is per pool.** Hosts peer with, sync with and hold copies for hosts in their own pool only. Pools never peer, whether they belong to the same account, different accounts or the operator.
- **Data belongs to one pool.** A sticky disk, a saved snapshot, and a sandbox's disk live in the pool where they were made, and sandboxes from them are placed only in that pool. A template stays an account-wide definition; each pool builds it once and its hosts share that build.
- **Placement is by pool, then labels.** A create names a pool, or gets the account's default pool, and labels still choose among that pool's hosts.
- **GitHub runners live inside a pool.** A pool has optional runner kinds, one for each `runs-on` label, each with its template, size, sticky disks and repositories. They replace runner pools and their `hostLabels`, so the CI pool's small and large runners share its hosts and its sticky caches. The runner pool API stays as an alias while callers move.
- **Moving a host to another pool** is an explicit action. It drains the host, removes it from the old pool's mesh, and lets the old pool's data on it go once other hosts hold the required copies.

## Sticky disks

A sticky disk is a named, versioned ext4 disk in an organisation's pool, attached to a microVM as an extra drive and mounted at a path in the guest.

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
- **Saved snapshots**: kept on two hosts when the pool has two or more, so losing a host doesn't lose a person's work. This costs disk, so it's a per-organisation setting, on by default.

Placement prefers a host that already holds a sandbox's sticky disk's head, or its snapshot, as it prefers a host with the owner's isolates today. It doesn't insist, because the fetch is in the background.

### Transport between hosts

Hosts today take no inbound connections: they dial out to the control plane. Peer sync needs one host to reach another. The choices:

1. **A peer port on each host, on the organisation's network.** The host listens on a port bound to its private or direct address (the same addresses the direct and private-network host links use: a LAN, a Tailscale tailnet, Hetzner's vSwitch). Each request carries the control plane's grant, and peers authenticate each other with certificates the control plane issues at join. Fast (block transfers at disk speed), simple, no outside dependency. Hosts that can't reach each other (behind different NATs, no shared network) can't sync this way.
2. **A mesh Kantel sets up**: WireGuard between the hosts of a pool, keys exchanged through the control plane, NAT traversal with a relay for the hard cases. Works everywhere, but it's a project of its own (Kantel Connect territory).
3. **Relay through the control plane.** Works everywhere with no inbound ports, but every block goes through the gateway: too slow and too costly for disks of hundreds of GB.

Decided (11 Nov 2026): 2, the mesh. It works whatever networks the hosts are on, and it's the start of Kantel Connect. Each host gets a WireGuard key and a mesh address at join; the control plane hands each host its pool's peers (keys, addresses and the endpoints it has seen them at); hosts punch through NAT with the control plane coordinating, and fall back to a relay when they can't. Peer sync is plain HTTP over the mesh, so everything above it doesn't care how the bytes travel. Hosts with public addresses (Lleverage's Hetzner machines) connect directly.

Saved snapshots are kept on two hosts by default (decided 11 Nov 2026).

### An object store, optional

An organisation may add an object store (R2, GCS, S3) as a member that holds blocks but runs no sandboxes. Blocks go in under their hash, so they dedupe across versions and disks by themselves. It's for durability (saved snapshots with one host), for hosts that can't reach each other, and for a new host's first fetch. Nothing requires it.

## Phases

1. **Sticky disks on one host.** The catalogue in the control plane (disks, versions, holders), the API, attaching a version's clone as a drive, commit from a trusted caller, retention and the host's budget. GitHub runner pools get `stickyDisks` with a commit rule. Enough for CI on one host. Merged (#838).
2. **Pools, the mesh, block maps and host-to-host sync.** Pools (above), the WireGuard mesh between a pool's hosts, block maps with extent-based change detection, grants, fetches by changed block, prefetch of heads, placement preference. Sticky disks are its first user. Planned below.
3. **Templates and saved snapshots on the disk store.** Template snapshots fetched from peers; saved snapshots kept on two hosts; their disks become versions like any other; a create from a saved snapshot runs on any host that holds it or can fetch it.
4. **Moving a sandbox to another host**, from the API, the CLI and the console, and draining a host by moving its sandboxes off. Designed below.
5. **The optional object store, and peers for bucket mount caches.**

Phases 2 to 4 are what lets an organisation treat each pool of hosts as one, which is what Lleverage needs to run agent sandboxes and workflow runtimes on Kantel. The object store moved to last because nothing in 2 to 4 depends on it.

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
- **Holdings.** `HostCapacity.stickyDisks: [{ diskId, versions: [{ version, allocatedBytes, at }] }]` in every report, `[]` when it holds none, and left out (not `[]`) when the host couldn't read its whole inventory (a directory or version file it can't read; a missing sticky root is none). In phase 1 a host keeps its two newest versions of each disk and deletes older ones after a commit.
- **Room.** A copy the host makes on its own reserves the room it writes, beside every other such copy, and must leave 10 GiB free (`reserveRoom`): a snapshot reserves its sticky drives with its disk, and a full copy of a sticky disk (attach, create from a snapshot, commit, on a file system without reflinks) reserves its own. A reflink takes no room and is never refused. A create's disk budget doesn't count sticky disks: their clones share blocks.
- **Recovery.** A host that restarts thaws the sticky disks of the sandboxes it adopts running, under each sandbox's lock, so a recovery thaw never lands inside a new commit's freeze.
- **Mounts.** The guest releases a snapshot's bucket mount at, above or under a sticky disk's path before it mounts the disk there, as it does for a bundle.

What the control plane keeps (phase 1):

- **The catalogue's writes are atomic** (`StickyDiskWrites`, in memory and SQL): a disk and its name's claim are made together; a delete tombstones the disk and releases its claim together (only a claim naming that disk); a commit records its version and makes it the disk's head together, only while the disk is live. An interrupted write leaves all of it or none.
- **The catalogue forgets versions their host dropped.** The sweep (every 10 minutes) forgets a live disk's version whose host, connected and reporting `stickyDisks`, no longer holds it: never the disk's head, never on the word of a host that doesn't report holdings (absent isn't none), and never a version committed within 2 minutes of the report's arrival, which may have been measured before the commit. `stickyDiskWrites.forget` deletes a version only while it isn't its disk's head.
- **Tombstones outlive their account.** Deleting a disk, or its account, keeps its tombstone for 30 days, and a sweep deletes its versions from hosts again every 10 minutes, so a host that was away has them deleted when it reconnects.
- **GitHub runners commit only from scheduled runs.** A job's commit needs GitHub's word that it succeeded on the runner Kantel registered (`runner_id`, not the runner's name), whether a webhook or polling found it, and that its run's event is `schedule` (which GitHub runs only on the default branch) of one of `branches`. Push and manual runs can't commit yet: GitHub gives a tag's run the tag's name as `head_branch`, and neither the run nor its jobs has a full ref or ref type, so `refs/tags/main` would pass for `refs/heads/main`. Allowing them needs evidence of the ref tied to the run, such as the job's OIDC token (its `ref` and `ref_type` claims). `beforeCommit` runs as root (`ExecParams.User`), and the broker renews its lease while it runs and checks it before it commits.

## Phase 2: the mesh and host-to-host sync (plan)

Where things stand: a host dials one WebSocket out to the control plane (`/v1/hosts/connect`) and takes no inbound connections. Its record (`compute_hosts`) has no address, and the "direct" and "private-network" host links are only different URLs for that same outbound connection. Nothing in the host runs WireGuard or any userspace networking. A sticky disk version records the one host it was made on (`StoredStickyDiskVersion.hostId`). Phase 2 adds the rest in three layers, each usable before the next.

### 2a. The mesh

**Membership.** A mesh is a pool (see Pools). Hosts in different pools are never peers, so no host ever has a route to another pool's hosts, whether that pool is the same account's, another account's or the operator's. A revoked host, or one moved to another pool, leaves its pool's peer lists at once.

**Keys and addresses.** A host makes its WireGuard key pair when it first starts with the `mesh` feature, keeps the private key under its root (mode 0600) and never sends it anywhere. It reports the public key in `Hello` (`Facts.Mesh: { publicKey, listenPort, endpoints }`). The control plane gives the host a mesh address in `Welcome`. Addresses are IPv6 ULAs: one `/48` per pool, derived from the pool's ID, and one `/128` per host, stored on its record. IPv6 can't clash with the sandboxes' `10.231.0.0/16` or with whatever IPv4 network the host is on. A reinstall makes a new key, and the record's key is replaced on the next `Hello`.

**Peers.** `Welcome.mesh` carries `{ address, prefix, peers: [{ hostId, publicKey, address, endpoints }] }`. A `mesh.peers` message brings the whole list again whenever a pool member joins, leaves, is revoked or reports new endpoints. The host applies it as the desired state: it adds, updates and removes WireGuard peers to match.

**The device.** `kantel-host` runs WireGuard in-process (`golang.zx2c4.com/wireguard`) over a TUN device named `kmesh0`. It mustn't start with `kt`, because the firewall treats every `kt+` interface as a sandbox's TAP device. The in-process implementation is chosen over the kernel module for two reasons. Finding a NAT's mapping (STUN) needs to send from the same UDP socket WireGuard uses, which the kernel module doesn't allow but a custom `conn.Bind` does. And it needs no kernel module or `wg` tools on the host. Throughput was the risk; the spike (below) found it keeps up with the kernel module. The firewall accepts only the peer sync port on `kmesh0`, and only from the pool's prefix. Forwarding stays off, and sandboxes can't reach mesh addresses.

**Endpoints, in three steps.** Each step is useful without the next:

1. *Direct.* A host reports its interface addresses and listen port (UDP 51820 by default, `--mesh-port`), plus any `--mesh-endpoint` an operator sets for a forwarded port. Peers try them all. This is enough for hosts with public addresses or on one LAN, which includes Lleverage's Hetzner machines.
2. *NAT traversal.* The host asks a STUN server for its public mapping from the WireGuard socket and reports it as an endpoint. The default STUN server is `stun.cloudflare.com:3478`, settable per control plane, because the hosted control plane runs on Workers and can't take UDP itself. When two hosts behind NAT need each other, the control plane tells both at once over their control connections, and both send handshakes to each other's candidates, which opens both NATs.
3. *Relay.* When neither works (symmetric NAT on both sides), WireGuard packets go over a WebSocket to the gateway, which passes them to the peer's gateway connection: a Durable Object on Cloudflare, the gateway process when self-hosted. The packets stay WireGuard-encrypted, so the relay can't read them. A relay is slow and costs gateway bandwidth, so over a relay hosts skip prefetching and fetch only what a sandbox placed on them needs, at a capped rate.

**Health.** Each capacity report carries each peer's path (direct, punched or relayed), last handshake and round-trip time. The console's host page lists its peers, so "these two hosts can't reach each other" shows up before a sync fails.

### 2b. Block maps

As described under "On one host" above. A version's map is stored beside it as `<version>.map`: a header with its size and block size (4 MiB), then 32 bytes per block, with all-zero bytes standing for a block that is all zeros. The map's SHA-256 is the version's `mapDigest` in the catalogue. A commit makes the map from its parent's: on XFS or btrfs, `FIEMAP` shows which extents the version still shares with its parent, and only unshared extents are read and hashed. On a filesystem without reflinks every block is hashed. Versions committed before phase 2 get their maps in the background, oldest last.

### 2c. Peer sync

**The catalogue.** A `disk_holders` table: `(kind, objectId, version, hostId, state, since)`, where `kind` is `sticky` now and `template` and `snapshot` in phase 3, and `state` is `fetching`, `held` or `deleting`. A version's `hostId` stays as the host that made it. The holdings each host already reports in `HostCapacity.stickyDisks` are reconciled into the table on every report, so the table is what hosts actually have rather than what they were asked to fetch.

**Grants.** The control plane gets an Ed25519 signing key, and `Welcome` carries its public key. A grant is `{ kind, objectId, version, accountId, from: [hostIds], to: hostId, exp }`, signed, valid for 15 minutes. A holder serves a request only with a grant naming it in `from` and naming the mesh peer that asks as `to`. WireGuard already proves which peer is asking, so a grant can't be replayed by another host.

**The server.** It is HTTP/2 on the host's mesh address only, on port 7480:

- `GET /v1/objects/{kind}/{id}/{version}/map`: the block map.
- `GET /v1/objects/{kind}/{id}/{version}/data` with `Range`: a run of blocks, read from the version file. Runs of neighbouring changed blocks go in one request, and HTTP/2 carries many at once.

**The fetch**, run by a host when a sandbox placed on it needs a version (`disk.locate` to the control plane, which answers with holders, their mesh addresses, the `mapDigest` and a grant) or when told to (`disk.fetch`, for prefetch and keeping a second copy):

1. Fetch the map from any holder and check it against `mapDigest`.
2. Reflink the host's nearest version of the same object (the newest one it holds that is an ancestor of the wanted one; else the newest it holds; else a sparse file of the right size) into `<version>.partial`.
3. Fetch each block whose hash differs, spread over the holders, at most 8 runs in flight. Check each block's hash and write it with `pwrite`. A bitmap file beside the partial records done blocks, so a fetch resumes after a restart or a dropped peer.
4. `fsync`, rename to `<version>.img`, write its map, and report it held.

Each host has a sync bandwidth limit (`--sync-rate`, both directions, default 50% of the link it detects) and a cap on concurrent fetches, so a sync can't starve the sandboxes' own network and disk.

**Retention with replicas.** A host's budget still frees old versions oldest first, but it never frees a copy the control plane counts as one of an object's required copies (phase 3's second copy of a saved snapshot). The control plane moves that duty to another host before telling the first that it may let go.

### 2d. Placement and prefetch

- The scheduler's ranking (`packages/hosts/src/scheduler.ts`) gets one more preference after the isolate one: a host that already holds the head of each sticky disk the sandbox attaches. It is a preference only; projected fullness still decides between hosts that hold the same.
- After a commit, the control plane sends `disk.fetch` for the new head to every host in the pool that ran a sandbox with that disk in the last 7 days.
- A sandbox placed on a host with no version of its sticky disk starts with an empty disk, as now, and the host fetches the head in the background for the next one. A sticky disk is a cache, so a sandbox never waits for a sync.

### Protocol

- Feature `mesh`: the host runs the mesh device and the peer sync server, and takes `Welcome.mesh` and `mesh.peers`.
- Feature `disk-sync`: the host makes block maps, takes `disk.fetch` and `disk.delete` for any kind, and answers `disk.locate`'s grants.
- Host to control plane: `disk.locate { kind, objectId, version }` returns `{ mapDigest, holders: [{ hostId, address }], grant }`.
- Control plane to host: `disk.fetch { kind, objectId, version, mapDigest, holders, grant }` is answered when the fetch has started; progress and the result come in capacity reports.

### Order of work

Each step is one PR with its own tests:

1. **Spike: WireGuard throughput.** Two Hetzner hosts, in-process WireGuard over TUN against the kernel module, iperf3 and a 50 GB file over HTTP/2. Decided (13 Nov 2026): if in-process is under about 70% of the kernel's speed, hosts that reach each other directly hand the same keys and addresses to the kernel module, and the in-process code stays for NAT traversal and the relay.

   Result (13 Nov 2026): in-process is at least as fast as the kernel, so every host uses it and the kernel path isn't built. Measured between `lleverage-ci-5` and `lleverage-ci-6` (AX102, Ryzen 9 7950X3D, Ubuntu kernel 6.8, wireguard-go of 24 Oct 2026 with its TUN and UDP offloads on), each figure the median of 3 runs, while CI jobs ran on the hosts (up to 2 at once, load average up to 13). TCP ran for 20 seconds; the download was a 20 GiB file of random data on the XFS data volume, dropped from the page cache before each run, fetched over one HTTP/2 connection without TLS as 64 MiB ranges with 8 in flight. CPU is in cores, counting the test's processes, the kernel's worker and softirq threads and interrupt time, so the CI jobs' own work is left out.

   | Between the hosts (1 Gbit/s link) | No tunnel | Kernel WireGuard | In-process | In-process / kernel |
   | --- | --- | --- | --- | --- |
   | TCP, 1 stream | 0.928 Gbit/s | 0.878 Gbit/s | 0.889 Gbit/s | 101% |
   | TCP, 8 streams | 0.928 Gbit/s | 0.889 Gbit/s | 0.889 Gbit/s | 100% |
   | HTTP/2 download from disk | 0.925 Gbit/s | 0.883 Gbit/s | 0.884 Gbit/s | 100% |
   | CPU, sender / receiver, TCP 1 stream | 0.02 / 0.14 | 0.57 / 0.90 | 0.36 / 0.73 | |
   | CPU, sender / receiver, TCP 8 streams | 0.02 / 0.32 | 0.71 / 1.83 | 0.51 / 0.81 | |
   | CPU, server / client, download | 0.33 / 0.29 | 0.98 / 1.39 | 0.86 / 1.05 | |

   The hosts' links are 1 Gbit/s, so both tunnels run at the link's speed less WireGuard's overhead, and in-process uses less CPU doing it. To see past the link, the same tests ran on one host between two network namespaces joined by a veth pair (both ends share the machine's CPUs):

   | One host, two namespaces | No tunnel | Kernel WireGuard | In-process | In-process / kernel |
   | --- | --- | --- | --- | --- |
   | TCP, 1 stream | 41.7 Gbit/s | 3.30 Gbit/s | 15.8 Gbit/s | 480% |
   | TCP, 8 streams | 211 Gbit/s | 3.28 Gbit/s | 11.5 Gbit/s | 352% |
   | HTTP/2 download from disk | 4.66 Gbit/s | 3.19 Gbit/s | 5.11 Gbit/s | 160% |
   | CPU, both ends, TCP 1 stream | 2.1 | 7.1 | 8.1 | |
   | CPU, both ends, TCP 8 streams | 15.9 | 7.1 | 6.9 | |
   | CPU, both ends, download | 3.3 | 9.4 | 9.3 | |

   The download without a tunnel is bound by reading the file, and in-process reaches that bound; kernel WireGuard over a veth pair stops at about 3.3 Gbit/s. Two things for step 3: the Robot firewall in front of Lleverage's CI hosts filters IPv4 only and lets in nothing but SSH, ICMP and replies, so the spike ran over the hosts' public IPv6 addresses, and the mesh there needs the same (or a Robot rule for the mesh port); and with 1 Gbit/s links, `--sync-rate`'s default of half the link is about 60 MB/s. The spike's code is on the unmerged branch `tvd/lle-18987-wg-spike` (`apps/host/cmd/wgspike`).

2. **Pools:** pool records, a host's pool (join tokens name it), placement by pool, data belonging to a pool, then GitHub runner kinds inside pools.
3. **The mesh with direct endpoints (2a step 1):** keys, addresses, `Welcome.mesh` and `mesh.peers`, the device and firewall, peer health on the host page. Test: `local-stack.sh` with two hosts in network namespaces.
4. **Block maps (2b)** for sticky disk versions, made at commit.
5. **The catalogue's holders, grants and peer sync (2c)** for sticky disks.
6. **Placement and prefetch (2d).**
7. **NAT traversal (2a step 2)**, then **the relay (2a step 3).** Decided (13 Nov 2026): these are a separate, later epic. Lleverage's hosts have public addresses and don't need them.

Lleverage's hosts have public addresses, so steps 1 to 6 give it sticky disks across hosts. Phase 3 then gives it templates and saved snapshots across hosts, and phase 4 gives it moves.

## Phase 3 notes: what a snapshot depends on

Phase 3 puts template snapshots and saved snapshots on the same holders and fetches, but a snapshot is more than one disk file:

- **Its disk is an overlay's upper layer**, not a whole filesystem: `kantel-init` mounts the sandbox's disk over the shared read-only root image. A snapshot is only usable on a host that has the same root image: the same host image version (`host-images-*`, which the host downloads from a release itself) or the same template root filesystem (`images/templates/<key>.ext4`). A template's root filesystem becomes an object on the disk store too, keyed by its `KeyHash`, so a host fetches it from a peer instead of building it.
- **Its memory and machine state restore only on a matching runtime.** `restorableTemplateSnapshot` already refuses a snapshot whose Firecracker, kernel, host image or balloon setting differs (`runtimeFingerprint`). Across hosts the CPU matters too: Firecracker restores a snapshot only on a CPU with the same features, and Kantel sets no CPU template. Each host reports a CPU fingerprint (vendor, family, model and a hash of its CPUID features) beside its runtime fingerprint. Memory travels only to a host that matches both. Otherwise only the disk travels, and the sandbox cold-boots on its disk, which is what a disk-only saved snapshot does anyway; a template snapshot is built again on that host from the template's root filesystem. Decided (13 Nov 2026): match CPUs and cold-boot otherwise, with no Firecracker CPU template, because a template hides CPU features from every sandbox and changing it makes existing snapshots unusable. Revisit if one of Lleverage's pools ends up with mixed CPUs.
- **Its files**: `disk.ext4` and `mem` are synced as block-mapped versions (most of a memory file is zero blocks, which cost nothing), and `state` and `meta.json` go whole.
- **Its reference stops naming a host.** A saved snapshot's backend ref is `{hostId}/{snapshotId}` today, and `mayUse` refuses a create anywhere else. New refs are the snapshot ID alone, with its hosts in `disk_holders`. Old refs keep parsing, and their host becomes their first holder. A create from a snapshot goes to a holder if one has room; otherwise it goes to another eligible host, which fetches the snapshot first and reports it as the create's `fetch` phase.
- **Two copies.** After a save, the control plane picks a second host in the pool (the least full that matches the snapshot's root image) and sends `disk.fetch`. When a holder is revoked, or has been offline for 24 hours, it does the same again from the remaining holder.

## Moving a sandbox to another host (phase 4 design)

`POST /v1/sandboxes/{id}/move { hostId?, keepMemory? }`, `kantel move <id> [--to <host>]`, and a "Move to host" action in the console, beside stop, fork and snapshot. It needs phase 3, because a move is a snapshot synced to another host and started there.

**What moves:** the sandbox's disk, its sticky drive clones (its own copies; uncommitted writes go with it), its memory when kept, and its record's settings (env, egress, ports, mounts, labels). The target mounts bucket and bundle mounts again from its own caches. Its automatic snapshot history stays where it is, and those snapshots become fetchable like any other. The sandbox keeps its ID and its public URLs, because they go through the gateway, which follows its placement. Running commands, SSH sessions and port connections end, and their clients reconnect as they do across a host restart.

**Two ways:**

- **With a restart** (the only way between hosts whose CPU or runtime fingerprints differ, and an option otherwise):
  1. While the sandbox runs, the source reflinks its disk and sticky drives (a crash-consistent copy, made at once) and the target fetches that copy.
  2. The source stops the sandbox with a disk-only stop.
  3. The source makes the final disk's block map from the first copy's, using `FIEMAP`: extents the guest wrote since step 1 are no longer shared. The target fetches only those blocks.
  4. The target boots the sandbox on the disk, and the control plane switches its placement.

  The time without the sandbox is the stop, the blocks written since step 1, and a cold boot: seconds for a sandbox that isn't writing much.
- **Keeping memory** (the default when both hosts' runtime and CPU fingerprints match): the same, but step 2 is a stop that keeps memory, step 3 syncs the memory file as well, and step 4 restores it. The time without the sandbox grows with its memory: about 70 s for 8 GiB over 1 Gbit/s, less where much of it is zero. Pre-copying memory while the guest runs (live migration in the usual sense) isn't something Firecracker offers, so it's out of scope.

A stopped sandbox skips step 1 and the stop.

Decided (13 Nov 2026): a move keeps memory by default when the hosts match, because people expect nothing to be lost in a move. `keepMemory` defaults to true. Between hosts that don't match, the move restarts the sandbox and says so before it starts. The console's dialog shows the estimated pause for each way and offers a restart instead. Draining a host follows the same rule for each sandbox.

**Bookkeeping**, reusing the isolate upgrade's pattern (`packages/hosts/src/service.ts`, the cross-host upgrade). The control plane persists the move's intent before it acts, reserves room on the target, and settles the move with the same settlement claims. A failure before the placement switches rolls back: it deletes the target's copy and starts the sandbox on the source again (resumes it, after a stop that kept memory). After the switch, the source's copy is deleted as owed cleanup, retried until the source confirms it, as an upgrade's source cleanup is. The sandbox's status is `moving`, and its `phase` is one of `copying`, `stopping`, `final-copy`, `starting`, so the console and `kantel ls` show progress.

**Choosing the target.** The scheduler places the sandbox as for a create, without the source and with its shape, but with an extra filter (same root image, or one the target can fetch) and an extra preference (matching fingerprints when `keepMemory` is asked). The console's dialog lists eligible hosts and says for each whether memory can be kept or the sandbox will restart.

**Draining a host.** A draining host already takes no new sandboxes. Phase 4 adds "Move sandboxes off" to a host's page: it moves each running and stopped sandbox in turn, at most two at a time, and with that a host can be updated, resized or retired without anyone losing a sandbox.

A move never leaves the sandbox's pool (see Pools). Moving work to another pool is a new sandbox there.
