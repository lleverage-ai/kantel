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
- Names follow Agent Skills (lowercase letters, digits, dashes, 1–64) and are unique per owner: "Names are unique per
  owner, and the same name under another owner is fine".
- Platform skills are visible to every organisation but only a `system` actor creates or changes them (drafts
  included): "Only Harbour may create or change platform skills, and every organisation sees them".
- Another organisation's skills are `not_found` and never listed; an owner outside the caller's organisation is
  `invalid`: "Another organisation's skills are not found and never listed".
- Revisions record publisher and time, `skills.revision.published` is audited once per revision (id
  `skills:revision:<skillId>:<n>`), and revisions page newest first: "Revisions record who published them and when,
  and listRevisions pages newest first".
- A revision and a listing carry only their documented keys: "A skill grants nothing: a revision and its listing
  expose only their documented keys".

## The in-memory implementation

`createMemorySkills({ clock?, audit?, mountRoot? })` keeps packages, drafts, frozen revisions, file contents and pins
in maps. `normaliseSkillPath`, `skillDigest` (hex SHA-256 over files sorted by path, each `path\0content\0`),
`validateSkillName` and `parseSkillFrontmatter` are exported from the package root. A draft's description is the one
given, else the `SKILL.md` frontmatter's, else the package's; publishing makes it the package's description. A
retried publish after success (no draft, digest equal to the latest) returns the latest revision. In `saveDraft` and
`importRevision` every change follows the one await (the digest) and re-reads the package; `publish` changes
everything before its first await. It leaves out
durable storage, file size limits, role checks beyond "not an agent", and checking the frontmatter `name` against the
package name.

## Open questions

- Should `list` and `pinForSession` check `visibility` against the caller (an agent's own project and user), or does
  the session runtime own that? Today any caller in the organisation may pass any project or user.
- Should the frontmatter `name` have to match the package name, as Agent Skills require?
- `get` and `readFile` let anyone in the organisation read a user's or another project's skill by ID; only `list` is
  narrowed. Is that intended?
- An import with a new ref but unchanged files still makes a new revision, so each ref maps to exactly one revision.
  Should it reuse the latest instead, like `publish`?
- An import leaves any open draft in place. Should it close it?
