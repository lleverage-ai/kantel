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

`@harbour/workspace/read-api` is the HTTP surface the console's file browser and note viewer read, with a typed
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
types as `Workspaces` and rethrows error bodies as `HarbourError`. The export route needs `export` on the reader it is
given and answers 501 without it.

## Seeding v0 (M1-BE3)

`create` resolves the seed's sources in order, later sources winning on a path, after the caller's create and mount
checks pass (so a refused caller fetches nothing). `files` sources are applied as before. A `git` source is fetched by
the `GitFetcher` the host passes as `seeders: { git }` to `createMemoryWorkspaces` or `createStoredWorkspaces`: the tree
at the resolved commit, cut to `sparse` and placed under `into`, becomes part of version 1, with executable bits kept by
stored workspaces. The record then carries a `SeedReport` (`method: "clone"`, the resolved commit per source,
`indexState: "refreshed"` because the tree arrives without `.git`, timings, and a `cacheKey` that is equal for equal
resolved sources and pinned mounts, sorted by mount point). A fetch failure fails the create with the fetcher's code. Without a fetcher, or with an
`objects` source, the workspace waits at `metadata` as before.

`@harbour/workspace/git-tarball` has `createGitHubTarballFetcher({ fetch?, apiBase?, codeloadBase?, maxBytes?,
maxFiles? })`, which runs anywhere `fetch` and `DecompressionStream` do (a Worker or a node): it resolves the ref with
the commits API (skipped for a pinned commit) and reads the commit's tarball from codeload. Pass the vault's egress
`fetch` for private repositories; the spec never carries credentials. Symlinks and submodules are skipped; an archive cut short
(mid-body, mid-header or before its end block) or with a bad header checksum is `unavailable`, never a partial tree; over
`maxBytes` (512 MiB uncompressed) or `maxFiles` (100,000) is `exhausted`. History, dependency steps, mirrors, snapshots
and `objects` sources stay with M2-BE1.

## Export to the host (M1-BE3)

`Workspaces.export(ctx, id, prefixes)` returns the files under the prefixes at head. `@harbour/workspace/export` has
`syncExport(ctx, workspaces, id, { prefixes, sink, previous? })`, which keeps a host-side copy (a task's `notes/`) in step:
it writes only files whose digest changed since `previous`, removes files that an earlier sync wrote and the workspace
no longer has, never touches host files it did not write, and returns the next manifest. The sink decides where bytes
go; `createMemoryExportSink()` is one for tests, and a filesystem sink must keep paths inside its root. The read API
client's `export` is a drop-in source for a remote host.

## Read-only mount sources (M1-BE3)

`@harbour/workspace/mounts` has the two sources every target mounts, built on contracts rather than storage:

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
  with Harbour's own authority.
- `createSkillsMountSource({ skills, visibility })` is the `skills` source for `/skills`; a mount's ref is the
  session ID. `latestVersion` pins the session's skills through `Skills.pinForSession` (once), and the version
  `skillsMountVersion(pins)` names the pinned revisions themselves (`pins:<skillId>@<revision>,…`), so it never changes
  meaning. Files are at `/skills/<name>/<path>`, where `SkillListing.path` points. Every read goes through
  `getRevision` and `readFile` as the caller, so a forged pin to another project's skill is `forbidden`.
  `sessionSkillVisibility(sessions)` gives the session's own project as its visibility.

Both are read-only like every mount: a commit under a mount point is `refused`. The workspace conformance suite runs a
second time with `/project` served from workspace-backed trees (`test/mounts.conformance.test.ts`).

## The in-memory implementation

`createMemoryWorkspaces({ clock?, audit?, sources?, access? })` returns a `KeyedWorkspaces` and keeps each version as an immutable map (copy-on-write).
`createMemoryProjectFiles({ access? })` is a `project-files` source versioned per ref (`"0"` is empty), with a `seed` helper for
tests. Paths inside a source are relative and `""` is its root. It also rejects a tree where a path is both a file and
a directory (`invalid`), a delete of a missing file (`not_found`), an empty commit (`invalid`) and an owner in another
organisation (`forbidden`). Seed mounts and input mounts are merged, the input winning on the same mount point.
History includes version 0. It leaves out: fetching `objects` seeds and `git` seeds without a fetcher (recorded at
`seedReadiness: "metadata"`), dependency steps, durable storage and any org check inside the project files source. Without `access`, both check only
the organisation.

## Stored workspaces (`@harbour/workspace/stored`)

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
- `objects` fetching, git history and dependency steps (M2-BE1). The seed shape, readiness stages and methods are
  settled by M0-BE2's measurements (#5); v0 fetches git trees only, as `clone` without `.git`.
