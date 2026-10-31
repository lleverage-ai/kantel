# Workspace contract

## What it is for

A versioned file tree per task or session, with read-only mounts (project files, skills) at pinned versions. Agents
and sandboxes read and commit through it; hosts export results from it. Settled rule: project files are a read-only
mount at a pinned version; writes go through the source's tools (`MountSource.write`), never through the mount.

## Records

- `WorkspaceRecord`: owner, optional session, `head` version, pinned `mounts`, seed spec and `seedReadiness`.
- Versions: version 0 is the empty tree; each commit adds one. `WorkspaceVersionInfo` records the actor and paths.
- `Mount`: an absolute mount point, a source kind, a ref (such as a project ID) and a pinned version; always read-only.
- `MountSource`: a mountable source with its own versions; `write` (optional) creates a new source version.

## Key operations

`create` (seed `files` become version 1), `get`, `list` (paged, no bodies), `stat`, `read` (at any version, or from
a mount for an absolute path), `commit` (atomic, optimistic on `baseVersion`), `history`, `remount`, `export`.

## Rules and the suite cases that enforce them

| Rule | Case |
| --- | --- |
| A new workspace is version 0; seed files are version 1 | creates a workspace at version 0 with no files; applies seed files as version 1 |
| A commit is atomic and adds one version | commits puts and deletes atomically as one new version |
| A stale `baseVersion` is `conflict` | rejects a commit on a stale base version with conflict |
| Old versions stay readable | reads older content at an older version |
| Paths are normalised relative paths, else `invalid` | rejects paths that are not normalised relative paths as invalid |
| Listing pages (default 100) and never returns bodies | lists 250 files in three pages, sorted and without bodies |
| Directories derive from files; `recursive` lists below | lists nested files only when recursive |
| History is newest first with the actor | returns history newest first with the committing actor |
| Export returns head files under the prefixes | exports only the files under the requested prefixes at head |
| A commit under a mount is `refused`, audited, and changes nothing | refuses a commit under /project, audits it and leaves the head unchanged |
| Mounts are read-only and pinned until `remount` | keeps a mount read-only and pinned until remount |
| Mounts are listed and read through the source | lists and reads /project through the mount |
| Commits are audited | audits each commit as workspace.committed |
| Another organisation sees `not_found` | hides another organisation's workspace as not_found |

## Project access (settled question 7)

A workspace is project-scoped through its owner (`{ kind: "project" }`) and/or its `sessionId`; both are checked when
both are set. Workspaces owned by the organisation, a user or the platform with no session have no project check.
After the organisation lookup (another organisation's workspace stays `not_found`), each call requires through
`ProjectAccess`:

- operator: `workspace.create`, `workspace.commit`, `workspace.remount`;
- viewer: `workspace.get`, `workspace.list`, `workspace.stat`, `workspace.read`, `workspace.history`,
  `workspace.export`;
- viewer on the project a `project-files` mount names in `ref`, as `workspace.mount`, for every such mount `create`
  (seed and input mounts) and `remount` pin;
- viewer on that source project again, as `workspace.mount.read`, on every `read`, `stat` and `list` through the
  mount (settled question 11, below);
- `createMemoryProjectFiles({ access })`: `write` needs operator on `ref` as `workspace.files.write`. Its reads are
  not checked by the source itself, because the workspace checks the source project on every read through the mount.

An agent passes only from its own open session in the project, and for a session-tied workspace only in that
session or as its parent. There is no list of workspaces, so no list filtering. Cases (run with `projectAccess`):
"project access: refuses an operator outside the project on every call, and changes nothing", "... refuses a viewer
a change but lets it read", "... refuses mounting another project's files, and changes nothing", "... refuses an
agent whose session belongs to another project, and changes nothing", "... refuses an agent acting on another
session's workspace in its own project", "... refuses an agent whose session was closed", "... lets an operator on
the project and an agent in its own session work".

## Reads through a mount (settled question 11)

Settled by Tom on 27 Oct 2026: "Check the source project on every read." A `read`, `stat` or `list` under a
`project-files` mount point needs viewer on the project the files come from (the mount's `ref`), as well as on the
workspace's own project. The check runs on every read and nothing caches a past allow, so a role revoked between two
reads refuses the second. A caller who may read the workspace but not the source project gets `forbidden`, audited
once as `access.denied` under the source project, with no file content or secret. The workspace's own files stay
readable. Cases (run with `projectAccess`): "mount reads: a read through a mount passes when the caller may read the
project the files come from", "mount reads: refuses a caller the source project, though it may read the workspace's
own project", "mount reads: checks the source project again on every read, so access revoked between reads refuses
the next".

## Existence (settled question 12)

Settled by Tom on 27 Oct 2026: "Keep forbidden distinct." Within an organisation, an existing workspace the caller
may not see is `forbidden` and a missing one `not_found`; across organisations both are `not_found`, as before. Case:
"existence (settled question 12): in the organisation, an ID the caller may not see is forbidden and a missing one
not_found; across organisations both are not_found".

## Console read API (M1-BE3)

`@kantel/workspace/read-api` is the HTTP surface the console's file browser and note viewer read, with a typed
client. `createWorkspaceReadApi({ workspaces, authenticate, basePath?, maxContentBytes? })` returns a fetch-style
handler (`Request` to `Response`, or `null` for a path outside `basePath`), so the Cloudflare gateway Worker and the
self-hosted gateway mount the same code. It takes only the read operations (`get`, `list`, `stat`, `read`,
`history`) and no `Sandboxes`, so browsing never acquires a sandbox, and every call goes through the workspace's own
project-access checks, mount reads included. The host's `authenticate` turns the request into a `CallContext`.

| Route (`GET`, under `/v1/workspaces`) | Returns |
| --- | --- |
| `/:id` | the `WorkspaceRecord` (head, pinned mounts, seed readiness) |
| `/:id/files?path=&recursive=&version=&cursor=&limit=` | `Page<FileEntry>`, no bodies; `path=/project` lists a mount |
| `/:id/stat?path=&version=` | one `FileEntry` |
| `/:id/content?path=&version=` | the bytes, `ETag` (the digest, `If-None-Match` answers 304), `Harbour-Version` (JSON) |
| `/:id/history?cursor=&limit=` | `Page<WorkspaceVersionInfo>`, newest first |
| `/:id/export?prefix=notes/` | `{ files }`, each file under the prefixes at head with its bytes base64 (`prefix` repeats; the total is capped at `maxContentBytes` and checked from listings before any body is read, 413 above it) |

Errors are `{ "error": { "code", "message" } }`: `invalid` 400, `forbidden` and `refused` 403, `not_found` 404,
`conflict` 409, `expired` 410, `exhausted` 429, `not_supported` 501, `unavailable` 503; a file over
`maxContentBytes` (16 MiB) is 413. Content is never run by a browser: HTML and SVG go out as `text/plain`, and every
response has `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. A workspace file read
at an explicit `version` is cached as immutable; a mount path never is, because `remount` moves its pin. `HEAD` answers
carry no body, errors included. `createWorkspaceReadClient({ baseUrl, fetch?, headers? })` returns the same
types as `Workspaces` and rethrows error bodies as `KantelError`. The export route needs `export` on the reader it is
given and answers 501 without it.

## Creating a seeded workspace over HTTP (M1-BE3)

`@kantel/workspace/write-api` is the one write route, beside the read API: `POST /v1/workspaces` with
`{ projectId, sessionId?, seed?, mounts? }` (seed spec v0: `files` and `git` sources) answers `201` with the
`WorkspaceRecord` and a `Location`. `createWorkspaceWriteApi({ workspaces, access, authenticate, basePath?,
maxBodyBytes? })` is a fetch-style handler that answers only that method and path (`null` otherwise, so a gateway tries
it before the read API). A host then creates a session with the record's ID as its `workspaceId`.

| Case | Answer |
| --- | --- |
| Created | 201, the record; a git source is fetched by the `seeders: { git }` the host gave its workspaces |
| Not an operator on the project (and the session, when named) | 403 `forbidden`, audited once as `access.denied` with operation `workspace.create`, checked before the seed is read, so nothing is fetched |
| A malformed body, a seed path outside the workspace, a file and a directory at one path | 400 `invalid` |
| An `objects` source or dependency steps (`deps`) | 501 `not_supported`, rather than recorded and ignored (M2-BE1) |
| A body over `maxBodyBytes` (16 MiB) | 413 |

It holds no `Sandboxes`: seeding writes files and never runs a command. `createWorkspaceWriteClient({ baseUrl, fetch?,
headers? })` posts the body and rethrows error bodies as `KantelError`. Creating isn't audited yet; the audit log
shows a refusal, not a creation.

## Sharing a file (`@kantel/workspace/shares`, `shares-api`)

A file an agent made (a document, a PDF, any file) is shared after Claude's Share popover. `FileShares` (in
`@kantel/contracts`' `shares.ts`) holds one live share a file: its general access (`restricted`, only those who can
see the workspace; `link`, anyone with the link), its invites by email, and a link token. A share always shows the
file's newest version. `createSqlFileShares({ driver, workspaces, access?, audit?, clock? })` stores them in one
`file_shares` table (`migrateFileShares`); a change is a compare-and-set on its revision.

| Case | Answer |
| --- | --- |
| Reading a share or listing a workspace's | viewer on the workspace, as reading its files |
| Sharing, setting access, inviting, revoking | operator on the workspace's project, and a person: an agent or an API key is `forbidden` |
| Sharing a file that has a live share | that share, unchanged |
| A share of a file deleted since | still listed and revocable |
| Changing a revoked share | `conflict` |
| Each change | audited as `workspace.share.created`, `.changed`, `.invited`, `.uninvited` or `.revoked`, without the token or an email |

Invites are stored and listed only: Kantel sends no email, and an invite grants no access of its own.

`createSharesApi({ shares, authenticate, basePath? })` serves `@kantel/api`'s `shareRoutes`.
`createSharedLinkHandler({ shares, workspaces, renderPage, renderMissing })` serves `/shared/<token>` and
`/shared/<token>/raw` without sign-in: `open` (a worker call) finds a live `link` share by its token, and the file is
read as Kantel in the share's organisation. A link that doesn't open (unknown, restricted, revoked, its file gone or
larger than the read API serves) is the same `renderMissing` page. The raw bytes are served `no-store`, `nosniff` and,
but for a PDF, under a sandboxing CSP.

## Seeding v0 (M1-BE3)

`create` resolves the seed's sources in order, later sources winning on a path, after the caller's create and mount
checks pass (so a refused caller fetches nothing). `files` sources are applied as before. A `git` source is fetched by
the `GitFetcher` the host passes as `seeders: { git }` to `createMemoryWorkspaces` or `createStoredWorkspaces`: the tree
at the resolved commit, cut to `sparse` and placed under `into`, becomes part of version 1, with executable bits kept by
stored workspaces. The record then carries a `SeedReport` (`method: "clone"`, the resolved commit per source,
`indexState: "refreshed"` because the tree arrives without `.git`, timings, and a `cacheKey` that is equal for equal
resolved sources and pinned mounts, sorted by mount point). A fetch failure fails the create with the fetcher's code. Without a fetcher, or with an
`objects` source, the workspace waits at `metadata` as before.

`@kantel/workspace/git-tarball` has `createGitHubTarballFetcher({ fetch?, apiBase?, codeloadBase?, maxBytes?,
maxFiles? })`, which runs anywhere `fetch` and `DecompressionStream` do (a Worker or a node): it resolves the ref with
the commits API (skipped for a pinned commit) and reads the commit's tarball from codeload. Pass the vault's egress
`fetch` for private repositories; the spec never carries credentials. Symlinks and submodules are skipped; an archive cut short
(mid-body, mid-header or before its end block) or with a bad header checksum is `unavailable`, never a partial tree; over
`maxBytes` (512 MiB uncompressed) or `maxFiles` (100,000) is `exhausted`. History, dependency steps, mirrors, snapshots
and `objects` sources stay with M2-BE1.

## Seeding v1 (M2-BE1)

Seed spec v1 (`version: 1`; a v0 spec without `version` means the same) is a declarative file per host app or
project. `@kantel/workspace/seed-spec`'s `parseSeedSpec` checks its shape, and the write API parses through it, so a
spec means the same wherever it is read. v1 adds:

- `archive` sources: an `https:` URL (no credentials in it), an optional sha256 `digest` that pins the bytes (a
  mismatch fails the create as `unavailable`), `strip` leading segments and `into`. Fetched by the host's
  `seeders.archive` (`createHttpArchiveFetcher({ fetch?, maxBytes? })` in `@kantel/workspace/archive`); tar or gzip'd
  tar by magic bytes, budgets as for git tarballs.
- `objects` sources read through `seeders.objects` (`ObjectsSeeder`), reported with the version that was read.
- Dependency steps with a `name` and a `tier` (default `container`). Each step is keyed when files are ready: sha256
  over its command, outputs, tier and key entries, where a path entry carries the seeded file's sha256 (absent hashes
  as null), a `word:` entry is a label hashed as written, and a bare word the host defines in `seeders.labels` (such as
  `image`) is its value. `SeedReport.deps` lists each step's key and, once the sandbox tier has acted, its `layer`
  (`restored` or `built`); `depsKey` is over the steps' keys and goes into `cacheKey` with the host's `image` label.
  Equal step keys share a layer, so a changed lockfile changes only its own step's key.
- Methods: the report's method is the git fetcher's (`GitFetcher.method`, `clone` by default; `mirror` off a warm
  mirror), else `archive`. A spec whose `methods` excludes it is `not_supported`, before anything is fetched.
- Seed status events: with `onSeedStatus` (a `SeedStatusSink`) on `createMemoryWorkspaces` or
  `createStoredWorkspaces`, each seed emits `seed.status` events naming the workspace, organisation and session:
  `metadata` once every git ref is pinned (before the tree is read, when the fetcher has `resolve`), then `files`
  with the depsKey and step keys, or `failed` with the error's code and message. A sink that throws never fails the
  seed. The session runtime forwards them into the session; the contract carries them, not `packages/runtime`.

The dependency stage. Once files are ready, `prepareDependencies` (`@kantel/sandbox/dependencies`) takes each step in
order. If a layer is cached under the step's key, `DependencyLayers.restore` puts it back. Otherwise the step runs on a
lease of its tier and `DependencyLayers.save` keeps its outputs (the step's `outputs`, else every `node_modules`). The
stage is then recorded with `Workspaces.recordDependencies`, which moves readiness from `files` to `dependencies`, or
to `failed` with the error. The report's steps then carry `layer`, `timings.dependencies` is set and a `seed.status`
event is sent. It records once: a workspace at any other stage is `conflict`, and steps that are not the seed's, in
order and with its keys, are `invalid`. `createArchiveDependencyLayers` (`@kantel/workspace/dependency-layers`) keeps
layers as tarballs in an object store and restores one as a single version. It is the generic fallback. Targets hold
large layers as overlay lowers or snapshots, because M0-BE2 found that extracting a large `node_modules` takes too
long.

`GitFetcher`, `ArchiveFetcher`, `ObjectsSeeder`, `Seeders`, `SeedFile` and `GitTree` are contract types now
(`@kantel/contracts`), so targets and the mirror service implement them without depending on this package.

The seeding cases of the conformance suite (`{ seeding: true }`) run on memory, stored, Cloudflare R2 and self-hosted
Postgres workspaces: the provider wires `deps.seeders` and `deps.onSeedStatus`.

| Rule | Case |
| --- | --- |
| A git source is pinned to its commit, cut to its cone under `into`, as version 1 | seeding: a git source is pinned to its commit, cut to its cone under into, and seeded as version 1 |
| Stages arrive in order, the commit pinned at `metadata` | seeding: emits metadata then files for the workspace, the commit pinned at metadata |
| Equal seeds share a cache key; a moved ref changes it | seeding: equal seeds share a cache key, and a moved ref changes it |
| A changed lockfile changes only its step's key | seeding: a changed lockfile changes only its dependency step's key, and the steps run in the container tier |
| The host's image label keys layers and the cache | seeding: the host's image label keys the dependency layer and the cache |
| An archive is unpacked and pinned by digest; a mismatch is `unavailable` | seeding: an archive source is unpacked under into and pinned by its digest; seeding: an archive that does not match its digest fails the create as unavailable and emits failed |
| A refused caller fetches nothing | seeding: a caller refused the create fetches nothing; an unknown ref fails it as not_found |
| A spec's `methods` bind the host | seeding: a spec that allows only methods the host lacks is not_supported, and nothing is fetched |
| The dependency stage records once, with layers; a failed stage is `failed` | seeding: the dependency stage moves files to dependencies with each step's layer, once, and a failed stage is failed |
| A source without a seeder waits at `metadata` | seeding: a source the host has no seeder for waits at metadata |

## Export to the host (M1-BE3)

`Workspaces.export(ctx, id, prefixes)` returns the files under the prefixes at head. `@kantel/workspace/export` has
`syncExport(ctx, workspaces, id, { prefixes, sink, previous? })`, which keeps a host-side copy (a task's `notes/`) in step:
it writes only files whose digest changed since `previous`, removes files that an earlier sync wrote and the workspace
no longer has (removals first, so a path can turn from a file into a directory), never touches host files it did not
write, and returns the next manifest. When the sink fails part-way it rejects with the manifest of what the host now
holds in the error (`exportManifestOf(error)`), the failed path marked unknown, to pass to the next sync. The sink decides where bytes
go; `createMemoryExportSink()` is one for tests, and a filesystem sink must keep paths inside its root. The read API
client's `export` is a drop-in source for a remote host.

## Read-only mount sources (M1-BE3)

`@kantel/workspace/mounts` has the sources every target mounts, built on contracts rather than storage:

- `createWorkspaceProjectFiles({ workspaces, access? })` is the `project-files` source for `/project`. Each
  project's files are a tree in a workspace of the target's own store, under the derived ID
  `projectFilesWorkspaceId(organisationId, projectId)` and owned by the project, so the files are as durable as the
  workspaces. Versions are that workspace's versions as strings (`"0"` is empty). `write` needs operator on the project
  (`workspace.files.write`), commits with the caller as the actor and retries a lost race on the head (blind puts and
  deletes). The store must be a `KeyedWorkspaces`: `Workspaces` plus `ensure(ctx, id, input)`, which opens or creates a
  workspace under an ID the caller derives (`checkKeyedId`); an ID another organisation holds is `conflict`, and a caller
  gets an existing record (or the one that won a race) only with viewer on it. The ID hashes the JSON pair, so it is
  unambiguous, and includes the organisation, so a ref is always the caller's organisation's project; this settles
  the first open question below for this source. The source uses a tree only when it is exactly the project's (owned
  by it, in no session, with no mounts): any other workspace under the ID is `conflict`, because the source reads it
  with Kantel's own authority.
- `createWorkspaceOrgFiles({ workspaces, access? })` is the `org-files` source for `/org` (docs/design/org-scope.md).
  One tree per organisation, under `orgFilesWorkspaceId(organisationId)` and owned by the organisation, kept as
  project files are. A mount's `ref` is the organisation ID and must be the caller's own: another organisation's is
  `not_found` to mount, remount, read through or write (`checkOrgFilesRef`). Organisation files are open to the
  organisation's members, as its skills and memory are, so a read through the mount needs only what reading the
  workspace needs, checked again on every read with nothing cached, plus the ref check. `write` needs operator on the
  organisation scope (`workspace.org-files.write`): a person or service with an organisation-wide role. Agents never
  write it, an organisation session's included (its check asks an agent for admin, which no agent holds, so the
  refusal is audited as `access.denied` like any other). A project agent reads `/org` from its own session's
  workspace; an organisation agent reads `/org` and is `forbidden` every read under a `/project` mount.
- `createSkillsMountSource({ skills, visibility })` is the `skills` source for `/skills`; a mount's ref is the
  session ID. `latestVersion` pins the session's skills through `Skills.pinForSession` (once), and the version
  `skillsMountVersion(pins)` names the pinned revisions themselves (`pins:<skillId>@<revision>,…`), so it never changes
  meaning. Files are at `/skills/<name>/<path>`, where `SkillListing.path` points. Every read goes through
  `getRevision` and `readFile` as the caller, so a forged pin to another project's skill is `forbidden`.
  `sessionSkillVisibility(sessions)` gives the session's own project as its visibility.

All are read-only like every mount: a commit under a mount point is `refused`. The workspace conformance suite runs a
second time with `/project` and `/org` served from workspace-backed trees (`test/mounts.conformance.test.ts`). With
`orgFiles` the suite runs the organisation files cases: "organisation files: an organisation-wide operator writes
them, and a project's workspace reads them at /org, pinned", "... refuses writes from agents of either scope and from
project-only roles, audited, changing nothing", "... another organisation's files are not_found, to mount and to
write", and "organisation scope: an organisation session's agent reads /org in its workspace, and /project is
forbidden on every read". The stored, Cloudflare R2 and self-hosted (PGlite, Postgres + S3) suites run them.

## The in-memory implementation

`createMemoryWorkspaces({ clock?, audit?, sources?, access? })` returns a `KeyedWorkspaces` and keeps each version as an immutable map (copy-on-write).
`createMemoryProjectFiles({ access? })` is a `project-files` source versioned per ref (`"0"` is empty), with a `seed` helper for
tests. Paths inside a source are relative and `""` is its root. It also rejects a tree where a path is both a file and
a directory (`invalid`), a delete of a missing file (`not_found`), an empty commit (`invalid`) and an owner in another
organisation (`forbidden`). Seed mounts and input mounts are merged, the input winning on the same mount point.
History includes version 0. It leaves out: fetching `objects` seeds and `git` seeds without a fetcher (recorded at
`seedReadiness: "metadata"`), dependency steps, durable storage and any org check inside the project files source. Without `access`, both check only
the organisation.

## Stored workspaces (`@kantel/workspace/stored`)

`createStoredWorkspaces({ store, clock?, audit?, sources?, access? })` is the implementation every durable target
wraps: it answers exactly as the in-memory one does, and a target supplies only a `WorkspaceStore` (the head with a
compare-and-set token, the version table, and immutable objects). File bodies are content-addressed blobs at
`org/<organisation>/blobs/<sha256>`; each version's tree is an immutable JSON object at
`org/<organisation>/trees/<sha256>.json` with each file's digest, size, last-changed version and mode bits. Listing and
`stat` read only trees (cached per process, bounded by entries), never bodies. A commit writes its blobs and tree first
and then moves the head with a compare-and-set on the token it read: a lost race is `conflict` and leaves only
unreferenced objects. A token moved only by a remount is retried. `ensure` behaves as the in-memory one, including
checking the loser of a race against the record that won.

Beyond the contract, for the sandbox tiers: `list` returns mode bits, `commit` accepts them on puts (a put without one
keeps the previous mode), and `readBlob(ctx, id, digest, { version })` reads a body by digest only when the digest is a
file of that version. `createMemoryWorkspaceStore()` is a store for tests that counts blob and tree reads. The suite
runs against stored workspaces, with memory and workspace-backed project files, in `test/stored.conformance.test.ts`.

The conformance suite's keyed cases (`{ keyed: true }`) cover `ensure`: once per ID, one winner of a race, `conflict`
across organisations and, with project access, the race loser checked against the winner.

## Open questions

- How a mount source checks that the caller's organisation owns the ref; the memory source does not. (Whether the
  caller may read the ref is settled: the workspace requires viewer on it as `workspace.mount`.)
- Whether deleting a missing path should be idempotent rather than `not_found`.
- Git history in the workspace, and overlay or snapshot dependency layers in the targets (M2-CF1, M2-SH1). The seed shape, readiness stages and methods are settled by M0-BE2's measurements (#5); seeding still
  imports trees without `.git`.
