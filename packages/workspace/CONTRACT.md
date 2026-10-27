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

## The in-memory implementation

`createMemoryWorkspaces({ clock?, audit?, sources? })` keeps each version as an immutable map (copy-on-write).
`createMemoryProjectFiles()` is a `project-files` source versioned per ref (`"0"` is empty), with a `seed` helper for
tests. Paths inside a source are relative and `""` is its root. It also rejects a tree where a path is both a file and
a directory (`invalid`), a delete of a missing file (`not_found`), an empty commit (`invalid`) and an owner in another
organisation (`forbidden`). Seed mounts and input mounts are merged, the input winning on the same mount point.
History includes version 0. It leaves out: fetching `git` and `objects` seeds (recorded at `seedReadiness:
"metadata"`), dependency steps, durable storage and any org check inside the project files source.

## Open questions

- How a mount source checks that the caller's organisation owns the ref; the memory source does not.
- Whether deleting a missing path should be idempotent rather than `not_found`.
- Seed readiness stages and `git`/`objects` fetching for real targets (M0-BE2, M2-BE1).
