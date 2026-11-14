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

**Membership.** A mesh is a pool (see Pools). Hosts in different pools are never peers, so no host ever has a route to another pool's hosts, whether that pool is the same account's, another account's or the operator's. A revoked host, or one moved to another pool, leaves its pool's peer lists at once. The mesh is opt-in per pool (decided 13 Nov 2026): a pool's `sync` setting, off by default, and only hosts in a pool with it on get `Welcome.mesh` and `mesh.peers`. Turning it off sends them an empty list and a welcome without the mesh. The default flips once the mesh is verified on real hosts.

**Keys and addresses.** A host makes its WireGuard key pair when it first starts with the `mesh` feature, keeps the private key under its root (mode 0600) and never sends it anywhere. It reports the public key in `Hello` (`Facts.Mesh: { publicKey, listenPort, endpoints }`). The control plane gives the host a mesh address in `Welcome`. Addresses are IPv6 ULAs: one `/48` per pool, derived from the pool's ID, and one `/128` per host, stored on its record. IPv6 can't clash with the sandboxes' `10.231.0.0/16` or with whatever IPv4 network the host is on. A reinstall makes a new key, and the record's key is replaced on the next `Hello`.

**Peers.** `Welcome.mesh` carries `{ address, prefix, peers: [{ hostId, publicKey, address, endpoints }] }`. A `mesh.peers` message brings the whole list again whenever a pool member joins, leaves, is revoked or reports new endpoints. The host applies it as the desired state: it adds, updates and removes WireGuard peers to match.

**The device.** `kantel-host` runs WireGuard in-process (`golang.zx2c4.com/wireguard`) over a TUN device named `kmesh0`. It mustn't start with `kt`, because the firewall treats every `kt+` interface as a sandbox's TAP device. The in-process implementation is chosen over the kernel module for two reasons. Finding a NAT's mapping (STUN) needs to send from the same UDP socket WireGuard uses, which the kernel module doesn't allow but a custom `conn.Bind` does. And it needs no kernel module or `wg` tools on the host. Throughput was the risk; the spike (below) found it keeps up with the kernel module. The firewall accepts only the peer sync port on `kmesh0`, and only from the pool's prefix. Forwarding stays off, and sandboxes can't reach mesh addresses.

**Endpoints, in three steps.** Each step is useful without the next:

1. *Direct.* A host reports its interface addresses and listen port (UDP 51820 by default, `--mesh-port`), plus any `--mesh-endpoint` an operator sets for a forwarded port. Peers try them all. This is enough for hosts with public addresses or on one LAN, which includes Lleverage's Hetzner machines. A host lists its global IPv6 addresses before its IPv4 ones: the Hetzner Robot firewall in front of Lleverage's hosts drops inbound IPv4 UDP but leaves IPv6 alone, so they reach each other over IPv6 (the throughput spike, 13 Nov 2026).
2. *NAT traversal.* The host asks a STUN server for its public mapping from the WireGuard socket and reports it as an endpoint. The default STUN server is `stun.cloudflare.com:3478`, settable per control plane, because the hosted control plane runs on Workers and can't take UDP itself. When two hosts behind NAT need each other, the control plane tells both at once over their control connections, and both send handshakes to each other's candidates, which opens both NATs.
3. *Relay.* When neither works (symmetric NAT on both sides), WireGuard packets go over a WebSocket to the gateway, which passes them to the peer's gateway connection: a Durable Object on Cloudflare, the gateway process when self-hosted. The packets stay WireGuard-encrypted, so the relay can't read them. A relay is slow and costs gateway bandwidth, so over a relay hosts skip prefetching and fetch only what a sandbox placed on them needs, at a capped rate.

**Health.** Each capacity report carries each peer's path (direct, punched or relayed), last handshake and round-trip time. The console's host page lists its peers, so "these two hosts can't reach each other" shows up before a sync fails.

### 2b. Block maps

As described under "On one host" above. A version's map is stored beside it as `<version>.map`: a header with its size and block size (4 MiB), then 32 bytes per block, with all-zero bytes standing for a block that is all zeros. The map's SHA-256 is the version's `mapDigest` in the catalogue. A commit makes the map from its parent's: on XFS or btrfs, `FIEMAP` shows which extents the version still shares with its parent, and only unshared extents are read and hashed. On a filesystem without reflinks every block is hashed. Versions committed before phase 2 get their maps in the background, oldest last.

### 2c. Peer sync

**The catalogue.** A `disk_holders` table: `(kind, objectId, version, hostId, state, since)`, where `kind` is `sticky` now and `template` and `snapshot` in phase 3, and `state` is `fetching`, `held` or `deleting`. A version's `hostId` stays as the host that made it. The holdings each host already reports in `HostCapacity.stickyDisks` are reconciled into the table on every report, so the table is what hosts actually have rather than what they were asked to fetch.

**Grants.** The control plane gets an Ed25519 signing key, and `Welcome` carries its public key. A grant is `{ kind, objectId, version, accountId, from: [hostIds], to: hostId, exp }`, signed, valid for 15 minutes. A holder serves a request only with a grant naming it in `from` and naming the mesh peer that asks as `to`. WireGuard already proves which peer is asking, so a grant can't be replayed by another host. Decided (13 Nov 2026): the key is one per control plane, made by the first gateway that needs it and kept in the database sealed with `KANTEL_SECRETS_KEY`, claimed so every gateway replica signs with the same key; without a secrets key over a database there is no key, so no grants (as protected values are refused). A signed grant is `<payload>.<signature>`: the grant's JSON in base64url, and Ed25519 over that text in base64url (`packages/compute/src/grants.ts`).

**Rotating the grant key.** Decided (14 Nov 2026): each key has an ID (the first 9 bytes of the SHA-256 of its public key, in base64url), and each grant names the key that signs it as `kid`. A super-admin rotates the key (`POST /v1/admin/grant-key/rotate`, `kantel-admin grant-key rotate`) in two steps, so no grant reaches a host that doesn't have its key: the rotation writes the new key as `next`, published at once, which begins signing 3 minutes later (`from`), once every connected host has been told it; the key it replaces is then retired, still accepted for 16 minutes (a grant's lifetime and a minute). The step at `from` needs no write: every gateway reads the setting for each grant and welcome and works out which key signs at that moment, and the next write (another rotation) moves them into place. Each write is one conditional write of the `grantKey` setting; a rotation while one is published replaces the published key, which is still accepted until a grant's lifetime after its `from`, as it may have begun signing on another gateway just as the rotation was written (a replacement keeps it the same way). While a key is published, the welcome gives the signing key an `until` too (16 minutes after `from`), so a host told of the rotation stops accepting the old key then even if it hears nothing more. A gateway that can't open the key that signs, as it signs a grant (it was sealed with a `KANTEL_SECRETS_KEY` the deployment no longer has), replaces it the same way, conditional on the key it couldn't open, with a new key that signs at once (nothing else can sign), so `disk.locate` doesn't stay unavailable; the old public key is still kept as retired. It leaves a key that began signing less than 5 minutes before: gateways whose secrets keys differ (one being changed) would otherwise replace each other's keys on every grant, so those with the other secrets key answer `unavailable` until they have the same one. Welcomes need only public keys, so they never replace a key. `Welcome.grantKeys` lists every key a host accepts: the signing one first, then the published one with its `from`, then each retired one with its `until`; `Welcome.grantKey` stays the signing key for hosts from before rotation. A host checks a grant with the key its `kid` names, and a retired key only until its `until`. Connected hosts are sent their welcome again at once on a rotation; the hosts service checks each connected host's keys against the control plane's every minute on its heartbeat, and on the first heartbeat after a published key begins signing, so a telling missed (or a retired key's time up) is made good and an older host that only reads `grantKey` has the new key within seconds of it signing. Such a host refuses a grant the old key signed from then on; its fetches ask `disk.locate` again for a new grant, as for one that expired. No host feature gates this: older hosts ignore `grantKeys` and `kid`, and older control planes send `grantKey` alone, which hosts keep as a key with no ID. A replacement of a key that can't be opened signs at once, so a holder not yet told the new key refuses grants for up to a minute; a fetch that fails then is asked for again. Automatic rotation on a schedule isn't done: an operator rotates when a key may have leaked, and an unreadable key replaces itself.

**The server.** It is HTTP/2 on the host's mesh address only, on port 7480:

- `GET /v1/objects/{kind}/{id}/{version}/map`: the block map.
- `GET /v1/objects/{kind}/{id}/{version}/data` with `Range`: a run of blocks, read from the version file. Runs of neighbouring changed blocks go in one request, and HTTP/2 carries many at once.

**The fetch**, run by a host when a sandbox placed on it needs a version (`disk.locate` to the control plane, which answers with holders, their mesh addresses, the `mapDigest` and a grant) or when told to (`disk.fetch`, for prefetch and keeping a second copy):

1. Fetch the map from any holder and check it against `mapDigest`.
2. Reflink the host's nearest version of the same object (the newest one it holds that is an ancestor of the wanted one; else the newest it holds; else a sparse file of the right size) into `<version>.partial`.
3. Fetch each block whose hash differs, spread over the holders, at most 8 runs in flight. Check each block's hash and write it with `pwrite`. A bitmap file beside the partial records done blocks, so a fetch resumes after a restart or a dropped peer.
4. `fsync`, rename to `<version>.img`, write its map, and report it held.

Each host has a sync bandwidth limit (`--sync-rate`, both directions, default 50% of the link it detects) and a cap on concurrent fetches, so a sync can't starve the sandboxes' own network and disk.

**Progress.** As built (LLE-19061): each capacity report from a host that fetches lists its fetches (`HostCapacity.fetches`): kind, object, version, `queued`, `running` or `failed`, the version's blocks (every part's) and how many are in place, and the last error it met. A failed fetch is listed while its partial is left for it to go on (and for 10 minutes after it failed, when it has none), and none is listed once its version is held. The catalogue records each as a `fetching` holder, by the same rules as a held one (a saved snapshot's as a copy of its ref), and lets one go once a report it can't be newer than (the 2-minute grace, which spares one `fetchHostSnapshot` wrote as the host was told) no longer lists it, or as soon as one lists it held; a report without `fetches` (a host from before them) lets none go. Progress itself stays in the host's last report, not in the catalogue. A `fetching` holder is never offered by `disk.locate`, and doesn't keep a sticky disk's version from being forgotten (a fetch needs a held copy to finish); prefetch and template copies skip a host already fetching.

**Retention with replicas.** A host's budget still frees old versions oldest first, but it never frees a copy the control plane counts as one of an object's required copies (phase 3's second copy of a saved snapshot). The control plane moves that duty to another host before telling the first that it may let go.

### 2d. Placement and prefetch

- The scheduler's ranking (`packages/hosts/src/scheduler.ts`) gets one more preference after the isolate one: a host that already holds the head of each sticky disk the sandbox attaches. It is a preference only; projected fullness still decides between hosts that hold the same.
- After a commit, the control plane sends `disk.fetch` for the new head to every host in the pool that ran a sandbox with that disk in the last 7 days.
- A sandbox placed on a host with no version of its sticky disk starts with an empty disk, as now, and the host fetches the head in the background for the next one. A sticky disk is a cache, so a sandbox never waits for a sync.

As built (LLE-18993): a create sends each sticky disk's head as the version to attach, and the scheduler prefers a host whose last capacity report lists every head. "Ran a sandbox with the disk" is kept on the disk's record (`ranOn`: host to when one last started there), written at most once an hour per host and disk, so a burst of jobs costs a read each. Prefetch goes only to hosts in the disk's pool that are online, while the pool's `sync` is on and the hosts report `disk-sync`, and only once the head has its block map's digest: a head whose map took longer than its commit is sent when the sweep gets the digest from its host's report. Hosts that already hold or are fetching the head are skipped. The two-host test is `apps/host/test/disk-prefetch.sh`.

### Protocol

- Feature `mesh`: the host runs the mesh device and the peer sync server, and takes `Welcome.mesh` and `mesh.peers`.
- Feature `disk-sync`: the host makes block maps, takes `disk.fetch` and `disk.delete` for any kind, and answers `disk.locate`'s grants.
- Host to control plane: `disk.locate { kind, objectId, version }` returns `{ mapDigest, holders: [{ hostId, address }], grant }`.
- Control plane to host: `disk.fetch { kind, objectId, version, mapDigest, holders, grant }` is answered when the fetch has started; progress and the result come in capacity reports (`fetches` while under way or failed, then the holdings once held).

### Order of work

Each step is one PR with its own tests:

1. **Spike: WireGuard throughput.** Two Hetzner hosts, in-process WireGuard over TUN against the kernel module, TCP with 1 and 8 streams and a large file from disk over HTTP/2. Decided (13 Nov 2026): if in-process is under about 70% of the kernel's speed, hosts that reach each other directly hand the same keys and addresses to the kernel module, and the in-process code stays for NAT traversal and the relay.

   Result (13 Nov 2026): in-process is at least as fast as the kernel, so every host uses it and the kernel path isn't built. Measured between `lleverage-ci-5` and `lleverage-ci-6` (AX102, Ryzen 9 7950X3D, Ubuntu kernel 6.8, wireguard-go of 24 Oct 2026 with its TUN and UDP offloads on), each figure the median of 3 runs, while CI jobs ran on the hosts (up to 2 at once, load average up to 13). TCP ran for 20 seconds; the download was a 20 GiB file of random data on the XFS data volume, dropped from the page cache before each run, fetched over one HTTP/2 connection without TLS as 64 MiB ranges with 8 in flight. CPU is an estimate in cores: the test's processes, all of the kernel's worker and softirq threads, and interrupt time. That leaves out the CI jobs' processes but not kernel work they cause, so treat it as a rough comparison; the whole machine's figures were too noisy with jobs running.

   | Between the hosts (1 Gbit/s link) | No tunnel | Kernel WireGuard | In-process | In-process / kernel |
   | --- | --- | --- | --- | --- |
   | TCP, 1 stream | 0.928 Gbit/s | 0.878 Gbit/s | 0.889 Gbit/s | 101% |
   | TCP, 8 streams | 0.928 Gbit/s | 0.889 Gbit/s | 0.889 Gbit/s | 100% |
   | HTTP/2 download from disk | 0.925 Gbit/s | 0.883 Gbit/s | 0.884 Gbit/s | 100% |
   | CPU, sender / receiver, TCP 1 stream | 0.02 / 0.14 | 0.57 / 0.90 | 0.36 / 0.73 | |
   | CPU, sender / receiver, TCP 8 streams | 0.02 / 0.32 | 0.71 / 1.83 | 0.51 / 0.81 | |
   | CPU, server / client, download | 0.33 / 0.29 | 0.98 / 1.39 | 0.86 / 1.05 | |

   The hosts' links are 1 Gbit/s, so both tunnels run at the link's speed less WireGuard's overhead, and in-process's CPU estimates are lower. To see past the link, the same tests ran on one host between two network namespaces joined by a veth pair (both ends share the machine's CPUs):

   | One host, two namespaces | No tunnel | Kernel WireGuard | In-process | In-process / kernel |
   | --- | --- | --- | --- | --- |
   | TCP, 1 stream | 41.7 Gbit/s | 3.30 Gbit/s | 15.8 Gbit/s | 480% |
   | TCP, 8 streams | 211 Gbit/s | 3.28 Gbit/s | 11.5 Gbit/s | 352% |
   | HTTP/2 download from disk | 4.66 Gbit/s | 3.19 Gbit/s | 5.11 Gbit/s | 160% |
   | CPU, both ends, TCP 1 stream | 2.1 | 7.1 | 8.1 | |
   | CPU, both ends, TCP 8 streams | 15.9 | 7.1 | 6.9 | |
   | CPU, both ends, download | 3.3 | 9.4 | 9.3 | |

   In-process and untunnelled downloads reached similar speeds, around 5 Gbit/s (this test doesn't isolate the download's bottleneck); kernel WireGuard over the veth pair reached about 3.3 Gbit/s. Two things for step 3: the Robot firewall in front of Lleverage's CI hosts filters IPv4 only and lets in nothing but SSH, ICMP and replies, so the spike ran over the hosts' public IPv6 addresses, and the mesh there needs the same (or a Robot rule for the mesh port); and with 1 Gbit/s links, `--sync-rate`'s default of half the link is about 60 MB/s. The spike's code is on the unmerged branch `tvd/lle-18987-wg-spike` (`apps/host/cmd/wgspike`).

2. **Pools:** pool records, a host's pool (join tokens name it), placement by pool, data belonging to a pool, then GitHub runner kinds inside pools.
3. **The mesh with direct endpoints (2a step 1):** keys, addresses, `Welcome.mesh` and `mesh.peers`, the device and firewall, peer health on the host page. Test: `local-stack.sh` with two hosts in network namespaces.
4. **Block maps (2b)** for sticky disk versions, made at commit.
5. **The catalogue's holders, grants and peer sync (2c)** for sticky disks.
6. **Placement and prefetch (2d).**
7. **NAT traversal (2a step 2)**, then **the relay (2a step 3).** Decided (13 Nov 2026): these are a separate, later epic. Lleverage's hosts have public addresses and don't need them.

Lleverage's hosts have public addresses, so steps 1 to 6 give it sticky disks across hosts. Phase 3 then gives it templates and saved snapshots across hosts, and phase 4 gives it moves.

## Phase 3 notes: what a snapshot depends on

Phase 3 puts template snapshots and saved snapshots on the same holders and fetches, but a snapshot is more than one disk file:

- **Its disk is an overlay's upper layer**, not a whole filesystem: `kantel-init` mounts the sandbox's disk over the shared read-only root image. A snapshot is only usable on a host that has the same root image: the same host image version (`host-images-*`, which the host downloads from a release itself) or the same template root filesystem (`images/templates/<key>.ext4`). A template's root filesystem becomes an object on the disk store too (kind `rootfs`), so a host fetches it from a peer instead of building it. Its ID is the key the file has on hosts (`images/templates/<key>.ext4`, a build's `rootfsKey`) rather than the template snapshot's `KeyHash`: templates and shapes that use one image share one file, a host on another Firecracker or kernel (another `KeyHash`) fetches it too, and a rebuild, whose custom image's key is new, builds again rather than fetching the old one. It has one version, `1`, as the file never changes once it is made. Each holder keeps the map digest its host reported, since two hosts that each built one before they synced hold different bytes under one key.
- **Its memory and machine state restore only on a matching runtime.** `restorableTemplateSnapshot` already refuses a snapshot whose Firecracker, kernel, host image or balloon setting differs (`runtimeFingerprint`). Across hosts the CPU matters too: Firecracker restores a snapshot only on a CPU with the same features, and Kantel sets no CPU template. Each host reports a CPU fingerprint (vendor, family, model and a hash of its CPUID features) beside its runtime fingerprint. Memory travels only to a host that matches both. Otherwise only the disk travels, and the sandbox cold-boots on its disk, which is what a disk-only saved snapshot does anyway; a template snapshot is built again on that host from the template's root filesystem. Decided (13 Nov 2026): match CPUs and cold-boot otherwise, with no Firecracker CPU template, because a template hides CPU features from every sandbox and changing it makes existing snapshots unusable. Revisit if one of Lleverage's pools ends up with mixed CPUs.
- **Its files**: `disk.ext4` and `mem` are synced as block-mapped versions (most of a memory file is zero blocks, which cost nothing), and `state` and `meta.json` go whole.
- **As built (LLE-19003).** A saved snapshot is kind `snapshot`, its ID the host's snapshot ID (a ref's second half), in two versions, one for each block-mapped file: `disk` (`disk.ext4`, its record `meta.json` beside it) and `memory` (`mem`, Firecracker's `state` beside it), so the memory has its own holders, digest and grants, and goes only to the hosts that ask for it. A host maps each saved snapshot's files after a save or keep (automatic snapshots are the host's own history and never objects) and reports them in `HostCapacity.holdings.snapshot`; the catalogue keeps a holder only of a saved snapshot it has (found by the ref of the reporting host or another holder, which each holder keeps, so copies outlive the original's holder), of an account the host may hold, and `disk.locate` offers it only in the snapshot's pool, to hosts of the asker's architecture. `disk.fetch` for a snapshot's `disk` (`POST /v1/admin/hosts/{hostId}/snapshot-fetches`) reads its record from a holder first and gets the root image (`HostImage`: a host image version installed from the release beside the channel's, without becoming current, which needs image patching, and only the same image by the digest it was downloaded with, as an image from before versions is named on its own host alone; a template's root filesystem by `rootfsKey`; an unversioned host image only when its recorded digest is the same), stages the record in `snapshot-fetches/<id>/` (which keeps that image version from a prune), fetches the disk and publishes the directory in one rename, marked `coldBoot`. A template's root filesystem must be the same build: the holder's record names its map digest (`rootfsDigest`), and a host whose file under the key is another build refuses the snapshot. The host then fetches the memory itself when its CPU fingerprint is the same and the snapshot's portable runtime is the one it has for that image, asking again with a backoff while no host has reported it yet, and on its next connection after that; a snapshot whose machine had bundle images or sticky disks on its drives keeps its memory on its own host for now, as those files don't travel. Copies go with their snapshot by construction, from hosts' reports: a host reporting a snapshot the catalogue has no record of at all (by its own ref or any holder's) is told `snapshot.delete` for it, at once for a copy it fetched (its holding says `copy`) and after 2 hours (`SNAPSHOT_ORPHAN_GRACE_MS`, well over a save's or keep's 30 minutes) for one it saved itself, so a save under way is spared; it is told again each grace while it still reports it. The sweep forgets a holder whose snapshot's record is gone, however it went, so the next report treats the copy so. A host also asks `disk.locate` just before it publishes a copy, and drops it on `not_found`. Deleting a snapshot still deletes the copies it knows of at once (holders recorded as copies of its ref, since a host names its own snapshots and two refs may share an ID, and hosts told to fetch it, `fetching` until their first report), but that is a fast path: nothing depends on it. Snapshot sync uses the grant key, so it is on where sticky disks or templates are. The two-host test is `apps/host/test/snapshot-sync.sh`.

  As built for template snapshots (LLE-18997): `template-snapshots/<id>` is an object of kind `template`, its ID the snapshot's and its one version `1`, behind the host feature `template-sync`. A version can have several block-mapped files, its parts (`disksync.Parted`), here `disk` and `mem`: its map is then a manifest naming each part's map digest, and the manifest's digest is the version's map digest, so it vouches for each part's map. Saved snapshots use the same parts. `state`, `meta`, the drive counts and, over a template's own root filesystem, that file's map digest (`rootfs-map`) go whole. A host reports each snapshot it holds with both maps, with its pool and what its memory was made on (its CPU and portable runtime). The control plane records these as holders, and `disk.locate` answers only holders whose copy restores on the asker (`memoryRestoresOn`): same CPU, and the copy's runtime among the asker's. Once a host holds a ready entry of a template on a Kantel base, the control plane asks each other host of the entry's pool on its runtime that takes copies (`template-sync`, in the pool's mesh) to build it under the same ID. That host's `template.build` first gets the root filesystem, as before. It then fetches the snapshot from a matching holder and boots nothing. With none it builds its own, which hosts on its own CPU and runtime can then fetch. A fetched snapshot is published only where its CPU, runtime and root filesystem bytes match. Its meta.json is rewritten for the host (local root filesystem path, local runtime fingerprint), and `restorableTemplateSnapshot` then checks it as for one built there. A create from the template goes to whichever host with a copy that restores there has the most room (`SandboxTemplateBoot.snapshotHosts`), and boots fresh elsewhere only when they are all full. Thrown away, an entry's copies are deleted with it; the sweep deletes a copy whose entry is gone. A custom image's snapshot is copied too (LLE-19074), but only over the entry's own image, as a host that built or pulled the image again might get another digest under the same key, and a template holding doesn't say which image it was made of. So the copy request names the entry's `rootfsKey` and image digest (`TemplateBuildParams.Copy`, host feature `template-image-copies`). The copy host uses the root filesystem under that key with that digest, held already or fetched from a peer, and never builds or pulls it: with none, or another image under the key, the copy fails. A host with a copy therefore holds the entry's image, so `startCustom` places a create on it, from the snapshot or booting the image fresh, and a reconcile counts the entry served while its builder is drained or gone, so long as a host with a copy can serve it. This was chosen over copies reporting the image they were built over: there is no fallback to get wrong, and nothing in holdings or placement has to compare images.
- **Its reference stops naming a host.** A saved snapshot's backend ref is `{hostId}/{snapshotId}` today, and `mayUse` refuses a create anywhere else. New refs are the snapshot ID alone, with its hosts in `disk_holders`. Old refs keep parsing, and their host becomes their first holder. A create from a snapshot goes to a holder if one has room; otherwise it goes to another eligible host, which fetches the snapshot first and reports it as the create's `fetch` phase.

  As built (LLE-19004): a saved snapshot taken on a host with `snapshot-sync` (`snapshot.save` or `snapshot.keep`) gets a host ID `ssnap_` and 32 hex digits, unique across hosts, which is its whole ref (`packages/hosts/src/snapshot-refs.ts`); its record keeps the host it was taken on (`StoredSnapshot.hostId`), its first holder, since its holders come only with reports. Any other snapshot keeps `{hostId}/{snapshotId}` (automatic ones, and those of older hosts), and so does every ref from before. A ref naming a host always means that host's copy: the compute plane names a call to one host (its files, a keep, a fork or an upgrade from it, its delete) `{hostId}/{snapshotId}`, so those stay where they were. Hosts report a saved snapshot's sizes and base by its ID, and only the host it was taken on is taken at its word for them. A create from a snapshot is given its holders (`SandboxSpec.snapshotCopies`: the host it was taken on, then the catalogue's holders of its ref, each with whether its copy there restores its memory), and whether it may be fetched (snapshots synced, its pool known, and a holder online in it that has reported it); its eligible hosts are its pool's. The host backend tries the holders whose copy restores its memory, then the others, each group all at once and then in turn, as a template's copies; with none with room, the registry chooses one of the other eligible hosts with `snapshot-sync`, of an architecture a serving holder has (`SnapshotCopies.architectures`), as it would place the sandbox (`sandboxes.choose`), which is told `disk.fetch` for the snapshot's disk (finding its holders itself, `disk.locate`), and the create waits until the host's capacity report lists it (at most 15 minutes) before it is made there; one that has no room by then is passed over for the next, three at most. Only a ref naming no host is fetched: an older ref's host-local ID may name another snapshot on the host that would fetch it, so it goes on its host or a copy held under its ref. A create that failed before it was placed is made again by its start or recovery the same way, from either kind of ref. A saved snapshot named by its ID alone stays in its pool when the host it was taken on moves to another: its copies there still serve it. Its `startup.fetchMs` is that wait. `startup.restoredMemory` says, for a snapshot with memory, whether the host restored it (its timings name a `restore`, or a `boot` on the disk alone). Rolling the control plane back leaves the snapshots saved since unusable until it is rolled forward, as an older one can't parse a ref that names no host.
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
