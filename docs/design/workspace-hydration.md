# Workspace hydration and cheap forks

TASK-4056. A workspace should be usable as soon as its file tree is known, read each file body on first use, fill
in the rest in the background, and say when it is done. A fork of a workspace, a snapshot or a template should cost
the same whatever its size. This is boat.dev's model (a sandbox is `ready` with "Files in `/home/user`: All visible.
Content downloads in the background. A read of a file waits for that file only", and `hydrated` with a
`sandbox.hydrated` webhook marks the end), applied to Kantel's workspace rather than to a VM disk.

## Where it lives

In the workspace (`@kantel/workspace/stored`), not in a sandbox. Every reader of a workspace goes through it: the
pi environment's file tools read and write it directly (#196), the isolate tier reads bodies through
`WorkspacePort.readBlob`, the container tier syncs from the same calls, the console reads it through the read API, and
export hands files back to the host. A lazy mechanism in one tier would leave the others blocked on, or wrong about,
bodies that are not there yet. Putting it under `readBody` gives every caller the same behaviour, and the targets
(Cloudflare R2, self-hosted Postgres with S3 or MinIO) only supply storage.

## What already existed

- Trees are already metadata only. A version's tree object holds each path's digest, size, version and mode, and
  listing never reads a body (a 10,000-file workspace lists with one tree read on R2,
  `targets/cloudflare/workspace/test/store.test.ts`).
- Bodies are content-addressed blobs under the organisation's prefix (`org/<org>/blobs/<sha256>`), shared by every
  workspace and version of that organisation that has the same content.
- `seedReadiness` (`pending`, `metadata`, `files`, `dependencies`, `failed`) and `seed.status` events stage a seed's
  readiness, following M0-BE2's recommendation to report `files` and `dependencies` separately.
- `SeedMethod` already names `lazy`, and M0-BE2 measured isomorphic-git over a lazily fetched tree on the isolate tier.

What was missing: a seed's `create` wrote every distinct body as its own object before returning, so a large seed
was as slow as its body count; there was no record of whether bodies were in place, no event when they were, and no
way to start a new workspace from an existing one without copying.

## First slice (this change)

### Lazy seed

With `hydration` set in `StoredWorkspacesOptions` (a host opts in), a seed is lazy unless its spec says
`hydration: "eager"`. A lazy `create`:

1. Resolves the sources as before and writes the tree object: paths, sizes, digests and modes.
2. Packs the bodies into staging packs (32 MiB each by default), content-addressed like blobs and trees:
   `org/<org>/packs/<sha256>.pack`, with an index `….pack.json` mapping each digest to its offset and length.
3. Commits the head with `hydration: { hydrated: false, entriesTotal, bytesTotal, startedAt }` and returns. The record
   is at `files` readiness: every file lists and reads.

So a seed of 40,000 files costs a tree, one pack per 32 MiB and its index, rather than 40,000 object writes. Seeds
with at most `minBodies` (default 16) distinct bodies stay eager; that is one batch of writes either way.

### First read

`readBody` (behind `read`, `readBlob` and `export`) checks the record's staging packs first, then the blob. From a
pack it reads only that body: from memory in the process that wrote it, else with a ranged read (`getObjectRange`;
R2 `get(key, { range })`, S3 `Range: bytes=`), else the whole pack as a fallback for a store without ranges. Every body
read from a pack is checked against its SHA-256 before it is returned, so a damaged or swapped pack fails as
`unavailable` rather than returning wrong bytes.

### Background hydration and the hydrated event

After `create` the instance copies each pack's bodies out to their blobs (16 at a time, each checked against its
digest), writes `….pack.done`, then clears the record's staging list and sets `hydrated: true` and `hydratedAt`
with a compare-and-set on the head, retried if a commit or remount moved it meanwhile. It then sends one
`workspace.hydrated` event: to the host's `onHydrated` sink (a `WorkspaceHydratedEvent`, beside `seed.status`) and to
the audit log, with `entriesTotal`, `bytesTotal` and `elapsedMs`, never paths or contents.

`hydration.background` hands each run to the host, so a Worker can keep it alive with `ctx.waitUntil`. A run cut
short (an evicted Worker, a restarted pod) is not lost: any instance that loads a workspace with staging packs left
resumes it, and the done markers mean a pack is never copied twice.

The record's `hydration` is what the read API's `GET /v1/workspaces/:id` returns, so a client can poll it as boat's
`GET /sandboxes/{id}` is polled for `hydrated`. Absent `hydration` means the bodies were always in place.

### Forks

`Workspaces.fork(ctx, id, { owner, sessionId?, version? })` and `POST /v1/workspaces/:id/fork` make a new workspace
whose version 1 is the source's tree at `version` (head by default). It writes one tree object and a head: bodies are
the source's blobs, in the same organisation, so nothing is copied. A fork of a workspace still hydrating carries its
staging packs and hydrates from the same packs (the done markers make the second pass a no-op). It records
`forkedFrom: { workspaceId, version }` and audits `workspace.forked`. Forks are independent after: a commit to either
never touches the other, since trees and blobs are immutable.

Templates and snapshots need nothing new for this: a template is a workspace you fork from, and a snapshot is a
version of one (`version`). A "saved snapshot" is a workspace kept for forking.

### Security

- A body is only read from a pack after the caller passed the same checks as any read: the workspace is in the
  caller's organisation (another organisation's is `not_found`), the project role allows the read, and the path (or,
  for `readBlob`, the digest) belongs to a tree of that workspace the caller may read. A digest from elsewhere reads
  nothing, from a blob or a pack.
- Packs sit under the organisation's prefix, beside its blobs. Nothing crosses organisations, and a pack is reachable
  only through a workspace record that lists it.
- The staging list is internal: it is stripped from every record a caller sees.
- A fork needs viewer on the source (`workspace.fork`, the right to read it, audited as `access.denied` on refusal),
  then `create`'s own checks for the new owner (operator, session) and its mounts. The route checks operator on the
  target project before reading the body.
- A fork of a workspace still seeding (`pending`, `metadata`) is refused as `conflict`: the seed would never reach it.

### Deployment targets

- Cloudflare: R2 range reads; `background` should be the request's `ctx.waitUntil`. Packs keep a large seed inside a
  Worker's subrequest budget, which per-body writes would not.
- Self-hosted (Kubernetes, Compose): S3/MinIO range reads through `createS3Objects.getRange`; the Postgres store
  passes it through. Nothing in the cluster changes.
- V8 isolate (just-bash) and containers: unchanged. They read through `readBlob` and the workspace port, which go
  through `readBody`. A first `cat` of a pending file waits for that body only.
- Direct workspace file tools (the pi environment): unchanged, they call `read`.

The isolate host loader (`images/isolate-host/src/loader.ts`) reads blobs straight from S3 under the older
`workspaces/<id>/blobs/` layout of `apps/selfhosted`; it does not serve stored workspaces, so it is unaffected, but
anything that reads stored blob keys directly must go through the workspace instead before lazy seeds are turned on.

## Tests

- `packages/workspace/test/hydration.test.ts`: a lazy seed is three object writes; it lists and reads before any blob
  exists; a second instance reads one body with one range read; hydration ends with the record, the sink and the audit
  event; a stopped hydration is resumed by the next instance; a commit during hydration is kept; packs split; a
  damaged pack is refused; eager when asked or small; forks cost one tree, copy no body, are independent, refuse other
  organisations, and a fork of a hydrating workspace hydrates from the same packs.
- The workspace conformance suite runs in full with every seed lazy (`stored workspaces, lazily hydrated`, and the
  same on Miniflare R2), and gains fork cases run against the in-memory, stored, R2 and Postgres (PGlite, and the
  Postgres + MinIO stack when configured) implementations.
- Range reads: R2 on Miniflare, S3 with a scripted endpoint (206 and a store that ignores `Range`).
- Write API: the fork route, its client, and its refusals.

## Next slices, in order

1. **Turn it on in the hosts.** Pass `hydration` (with `background: ctx.waitUntil` on Cloudflare) in
   `apps/cloudflare` and `apps/selfhosted`, and forward `onHydrated` and `seed.status` into the session event stream
   the console reads. Decide whether lazy is the default for every seed or only above a size.
2. **Read order.** Put the bodies most likely to be read first at the front of the first pack (boat's "playbook" of
   files opened at start), learned per template from what sessions open before `hydrated`.
3. **Git seeds without a full fetch.** Today a git source still fetches the whole tarball before `create` returns; the
   tree can be known from the Git tree API before the bodies, which would make `metadata` the point of usability for
   git seeds too.
4. **Container tier first-sync.** A container's first sync could start from the tree and pull bodies by digest on
   demand (a FUSE layer or a lazy overlay), instead of materialising the whole tree before the first command.
5. **Garbage collection.** Packs whose done marker exists and that no record lists can be deleted after a grace
   period; blobs need reference counting or a mark-and-sweep across trees, which forks make more valuable.
6. **Progress.** `entriesDone` (boat's `hydration.entriesDone` of `entriesTotal`) if a client needs a progress bar;
   `hydrated` stays the end signal.
