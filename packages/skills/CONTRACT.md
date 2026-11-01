# Skills contract

## What it is for

Skills are Agent Skills packages (a directory with `SKILL.md` at its root) with a stable ID, an owner and immutable
revisions. Sessions see skills by name, description and path, read them on demand and pin the revision they used. A
skill grants nothing: no revision changes a vault, capability or browser grant. Hosts keep their own authoring flow and
publish through `importRevision`; the console uses drafts and `publish`.

## Records

- **Package**: owner (platform, organisation, project or user), name (unique per owner), description, latest
  revision, the open draft's digest and, for imports, the source and ref.
- **Revision**: number (1, 2, 3… per skill), digest, name, description, file paths and sizes (UTF-8 bytes), optional
  namespaced `extensions`, who published it and when, and the source for imports. Never changes once published.
- **Listing**: skill ID, name, description, revision and the mount path `<mountRoot>/<name>/SKILL.md`.
- **Pin**: a session's skill and revision, fixed on first use.

## Key operations

`create` → `saveDraft` (returns the digest) → review → `publish` with that digest. `getRevision`, `readFile` and
`listRevisions` (newest first) read published revisions. `list` and `pinForSession` serve sessions. `importRevision`
creates the package if needed and publishes, idempotent by source and ref.

## Rules and the suite cases that enforce them

- Revisions are immutable; later drafts, publishes and changes to the caller's objects never reach them: "A published
  revision never changes when later drafts are saved and published".
- What was reviewed is what is published: "Publishing needs the digest of the reviewed draft".
- Agents may save and read drafts but never create, publish or import: "An agent may save a draft but may not create,
  publish or import a skill".
- An unchanged draft creates nothing and audits nothing: "Publishing a draft identical to the latest revision creates
  no new revision".
- A draft needs `SKILL.md` at its root; paths are relative, without `..`, empty segments, backslashes or NUL, and
  unique after normalisation (`./a` is `a`): "A draft without SKILL.md or with a path outside the package is invalid".
- Sessions see platform, organisation, their project's and their user's skills only, and the more specific owner wins
  a name clash (user > project > organisation > platform): "A session lists platform, organisation, its project's and
  its user's skills, never another project's or user's, and the most specific owner wins a name clash".
- Pins are set once per session: "Pins are fixed per session: a later revision reaches only new sessions". An agent
  pins only its own session: "An agent may pin skills only for its own session".
- Imports are idempotent by `(sourceId, ref)` per package; a new ref always publishes a new revision: "Imports are
  idempotent by source and ref, and a new ref publishes a new revision".
- Names follow Agent Skills (lowercase letters, digits, dashes, 1 to 64 characters) and are unique per owner: "Names are unique per
  owner, and the same name under another owner is fine".
- Platform skills are visible to every organisation but only a `system` actor creates or changes them (drafts
  included): "Only Kantel may create or change platform skills, and every organisation sees them".
- Another organisation's skills are `not_found` and never listed; an owner outside the caller's organisation is
  `invalid`: "Another organisation's skills are not found and never listed".
- Revisions record publisher and time, `skills.revision.published` is audited once per revision (id
  `skills:revision:<skillId>:<n>`), and revisions page newest first: "Revisions record who published them and when,
  and listRevisions pages newest first". `skills.package.created`, `skills.draft.saved` (digest and file count, never
  contents) and `skills.session.pinned` are audited by their actor: "An agent may save a draft but may not create,
  publish or import a skill" and "Pins are fixed per session".
- An import leaves an open draft open, so `get` and `readDraft` agree; only publishing the draft closes it: "An import
  leaves an open draft open".
- A revision and a listing carry only their documented keys: "A skill grants nothing: a revision and its listing
  expose only their documented keys".

## Project access

A package is project-scoped when its owner is a project. After the organisation lookup (another organisation's skill
is still `not_found`) and after the agent rules above (which keep their `forbidden`), each call checks
`ProjectAccess.require` with the package's project and subject `skills.skill`: `skills.create`, `skills.saveDraft`,
`skills.publish` and `skills.importRevision` need the store's authority (below, `operator` by default);
`skills.get`, `skills.readDraft`, `skills.getRevision`, `skills.readFile` and `skills.listRevisions` need `viewer`.
Reads of platform-, organisation- and user-owned packages stay open to the organisation; changes to them follow the
write authority below. `skills.list` needs `viewer` on `visibility.projectId` when it is set; without it no project's skills are
listed. `skills.pinForSession` needs `operator` with the session and `visibility.projectId`, so the session must be in
that project. In both, `visibility.userId` may name only the calling human; services and Kantel may name any user, an
agent none. That is not a project check: it is `forbidden` without an `access.denied` audit. A refusal is `forbidden`
and audited once as `access.denied`. The cases: "project access: an operator outside the project is refused for every
change and read of its skills, and nothing changed", "project access: a viewer on the project may read its skills
but not change them", "project access: an agent whose session belongs to another project is refused, and nothing
changed", "project access: an agent whose session was closed is refused", "project access: lists without a project
filter leave out another project's skills for an operator outside it", "project access: a visibility may name only
the calling human's own user; services and Kantel may name any user, agents none" and "project access: an operator
on the project and an agent in its own session still work on its skills".

## Write authority

A store takes a `SkillsAuthority` (`authority`): the least role `create`, `saveDraft`, `publish` and
`importRevision` each need, `operator` for all by default (`DEFAULT_SKILLS_AUTHORITY`); one missing a role is
`invalid` when the store is built. Where the role is held follows the owner: on the project for a project's skill;
across the organisation (a binding with no project) for an organisation's; for a user's, that human user always may
and anyone else needs the role across the organisation; platform skills stay Kantel's alone. An agent acts through
its own open session (any project's, for an organisation's skill) and counts as an operator, never an admin, so an
authority needing `admin` for `saveDraft` shuts agents out; agents still never create, publish or import. A refusal
is `forbidden`, audited once as `access.denied`, and changes nothing. The cases: "write authority: changing an
organisation's skill needs a role across the organisation, not on one project, and reading it does not", "write
authority: a user changes their own skill without a role; anyone else needs one across the organisation", "write
authority: an agent saves a draft to an organisation's skill only through its own open session, and still may not
publish", and, with `writes`, "writes: a store's authority sets the role each change needs, and a user's own skills
need none" and "writes: an authority needing admin to save drafts shuts agents out, since an agent counts as an
operator".

## Write operations (`@kantel/skills/writes`)

Transport-neutral: each operation parses untrusted JSON strictly (an unknown or missing field is `invalid`) and runs
on any `Skills` as the caller, so the store's rules apply. `skillsWriteOperations` holds them by name and
`runSkillsWrite(skills, ctx, name, input)` runs one (an unknown name is `not_found`): `skills.create`,
`skills.saveDraft`, `skills.validate`, `skills.publish`, `skills.importRevision` and `skills.exportRevision` (a
`SourcePublishingSkills` only, else `not_supported`). `skills.validate` reads the open draft and returns its digest
(what `publish` takes) and `validateSkillPackage`'s problems, or one problem and no digest when there is no draft.

`validateSkillPackage(name, files)` (package root) checks a package against the Agent Skills specification
(https://agentskills.io/specification) without throwing: a name of 1 to 64 lowercase letters, digits and single inner
dashes, valid and unique paths, text content, `SKILL.md` at the root, and frontmatter naming the package and holding
a description of 1 to 1024 characters. `parseSkillFrontmatter` reads plain, quoted and block-scalar values, drops
comments and ignores values that are not text. Stores do not enforce it, so existing packages keep publishing.

## Writing back to a source (`@kantel/skills/publish`)

`withSourcePublishing({ skills, sourceFor, audit?, clock? })` wraps any `Skills`. After a native `publish` that made
a new revision, it reads the revision's files and calls the package's `SkillSource.publish`, one export at a time
per skill, in order, skipping a revision a newer one has replaced in the store. A revision that came from a source,
and one this wrapper has exported already (an unchanged draft gives back the latest), are not exported. Nothing after
the store's publish fails it: a failed export is audited `skills.revision.export_failed` with the error code only;
success is audited `skills.revision.exported` with the source, ref, revision and digest.
`exportRevision(ctx, skillId, revision)` retries the latest revision only (an older one is `conflict`, so the source
never goes back; agents `forbidden`; the caller must be able to read the skill; `not_supported` without a writable
source), and a failure reaches the caller as the source's error code with a message of Kantel's own. Ordering holds
within one wrapper; processes sharing a store may still race, so a source that can should refuse an older revision.

## The in-memory implementation

`createMemorySkills({ clock?, audit?, access?, authority?, mountRoot? })` keeps packages, drafts, frozen revisions, file contents and pins
in maps. `normaliseSkillPath`, `skillDigest` (hex SHA-256 over files sorted by path, each `path\0content\0`),
`validateSkillName` and `parseSkillFrontmatter` are exported from the package root. A draft's description is the one
given, else the `SKILL.md` frontmatter's, else the package's; publishing makes it the package's description. A
retried publish after success (no draft, digest equal to the latest) returns the latest revision. In `saveDraft` and
`importRevision` every change follows the last await (the digest) and re-reads the package; `publish` re-reads it
after the access check and changes everything before the audit. Without `access` it checks only the organisation
(and the user rule is off); every target and conformance run passes one. It leaves out durable storage, file size
limits and checking the frontmatter `name` against the package name (`validateSkillPackage` reports it).

## The durable implementation (`@kantel/skills/sql`)

`createSqlSkills({ driver, objects, prefix?, clock?, audit?, access?, authority?, mountRoot? })` runs on any `SqlDriver` from
`@kantel/sql` (Postgres self-hosted; D1 or a Durable Object's SQLite on Cloudflare) with file bodies in an
`ObjectBucket` (`r2ObjectBucket(env.BUCKET)` on Cloudflare, an S3 or MinIO adapter self-hosted,
`createMemoryObjectBucket()` in tests). It applies the same rules as the in-memory store (`src/rules.ts`, shared by
both) and passes the whole suite, with `projectAccess`, on PGlite, `node:sqlite`, D1 in Miniflare and (with
`KANTEL_TEST_POSTGRES_URL`) a real Postgres. `migrateSkills(driver)` creates the tables if they are missing;
`skillsSchema(dialect)` gives the statements for a target's own migrations.

- Rows: `skill_packages`, `skill_drafts` (the open draft), `skill_revisions` (only ever inserted; `(skill, source,
  ref)` is unique, so a ref imports once, across restarts too), `skill_sessions` and `skill_pins` (a session's pins,
  set once in one batch). A draft's or revision's files are a JSON list of path, size and SHA-256.
- Bodies are objects keyed by their SHA-256 under the owner's organisation (`skills/org/<organisation>/<sha256>` or
  `skills/platform/<sha256>`, after `prefix`), written before the row that names them and never rewritten or
  deleted; a read checks the body against its hash and fails `internal` if it is missing or altered.
- Racing publishes, imports and pins settle as the in-memory store's do: each inserts the next row with
  `ON CONFLICT DO NOTHING` and a writer token, only the writer whose row landed moves the package on and audits, and
  a loser re-reads and tries again.

## Source helpers (`@kantel/skills/sources`)

Portable glue a host uses around any `Skills`; no storage and no Node APIs. A host brings each source as a
`SkillSource` (a Git checkout, a directory, an API) and picks the ref to pin.

- `syncSkillSources(skills, ctx, { sources, owner, exclude?, extensions? })` publishes several sources as one set
  through `importRevision`, in priority order: on a name more than one offers, the first source's skill is published
  and the rest are reported in `shadowed`, as Pi does when it layers skill directories. Excluded names are reported
  in `excluded`; a skill the store refuses (`invalid` or `conflict`) is reported in `refused`, and so is a winner
  whose `(sourceId, ref)` was imported before but is not the latest revision any more (importing it again returns the
  old revision and leaves the latest current, so new sessions would not get it; a new ref brings it back). Nothing is
  skipped silently. Every revision records its own `{ sourceId, ref }`. `syncSkillSource` is the one-source form.
- `sessionSkillListings(skills, ctx, sessionId, visibility, mountRoot?)` pins the session (or returns its existing
  pins) and returns the listings and revisions of those pins, so later publishing never changes what a running
  session sees.
- `renderSkillListings(listings)` is Pi's `<available_skills>` prompt block (name, description, mount path), XML
  escaped; empty for no skills. A host that keeps some skills out of the prompt (Pi's `disable-model-invocation`)
  filters the listings first; they stay pinned and mounted.

A session reads its pinned packages through the `skills` mount source in `@kantel/workspace/mounts`
(`createSkillsMountSource`), at `/skills/<name>/…`, where the listings' paths point.

The examples/sal-worker example composes these for a worker and checks that it is given the same skills a local
worker is given for the same task.

## Notes

- Agent Skills require the frontmatter `name` to match the package name. `validateSkillPackage` and `skills.validate`
  report a mismatch; stores still accept it.
- `get` and `readFile` let anyone in the organisation read a user's skill by ID; project skills are checked. Only
  `list` is narrowed for users.
- An import with a new ref but unchanged files still makes a new revision, so each ref maps to exactly one revision.
- An import leaves any open draft open, and publishing that draft later replaces the imported content as the next
  revision.
