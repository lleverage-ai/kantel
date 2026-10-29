# Memory contract

## What it is for

Memory holds curated facts ("concepts") for an owner, recalls a small, explained set of them for a task, and changes
only through proposals that a human or service applies. Learned facts never overwrite what the owner set.

## Records

- **Space**: an owner within one organisation, a name, and the `snapshot` (source ID, ref, import time) it was last
  imported from. Every read and write is scoped to the space's organisation.
- **Concept**: a stable path ID (`projects/harbour/vault-binding-codes`), title, optional description, statement, tags,
  scope (`global`, a `project` or a `job`), at least one source, `setBy` (`owner` or `learned`), `version`, `status`
  (`active`, `superseded`, `forgotten`), `supersededBy`, `updatedAt`, an optional `staleAfter`, `overrides` (a job
  concept's exception to a general one) and `extensions` (namespaced data a host keeps and Harbour does not read).
- **Proposal**: one write (`remember`, `correct`, `supersede`, `forget`), who proposed it, `pending`, `applied` or
  `rejected`, and `duplicateOf` with `duplicate` (`score` 0 to 1, and the `check` that found it) when a `remember`, a
  `correct` or a `supersede`'s replacement nearly repeats or paraphrases another active concept.

## Key operations

`propose` (any actor) → `decide` (humans and services) → `getConcept`, `listConcepts`, `recall`, `search` and
`exportBundle`; `importSnapshot` (humans and services) replaces a space's concepts with a source's revision.

`recall` follows Sal's recall so a Sal worker on Harbour is given what a local one is (`src/recall.ts`):

- One full-text index over every concept of the named spaces, any status: ID, title, description, tags and statement
  weighted 4, 4, 2.5, 3 and 1, tokenised as SQLite FTS5 `porter unicode61` and scored as its `bm25()` (`src/fts.ts`,
  checked against `node:sqlite` in `test/fts.test.ts`). No embeddings.
- A match needs a keyword score of 3 (roughly one title, ID or tag match), and, from 30 concepts, a BM25 score of 8
  and half the best. Filler-only queries recall nothing. A stale concept scores half.
- `profile` concepts come first, oldest first, whatever the query, within `maxProfileConcepts` (all) and
  `maxProfileBytes` (24576); those left out are named in `profileOmitted` and in the text. Matches follow, up to
  `maxConcepts` (5) and `maxBytes` (4096 UTF-8 bytes of their rendered text, less the frame and the omitted notice,
  which are always shown and may on their own exceed it). `exclude` leaves out IDs the session
  already holds. A job concept with `overrides` comes in with the concept it overrides, and only for its job.
- The result has the rendered `text`, the concepts, a manifest (version, reason, score, matched terms, staleness,
  truncation and snapshot ref), `skipped` matches with why, and `truncated`. The target's `RecallRenderer` makes the
  text and so decides what the byte budgets count.

`search` ranks by the same keyword score, stale at half and inactive (on request) at a quarter, up to `limit` (5,
at most 10), each hit with a snippet. `exportBundle` returns `<id>.md` per concept (YAML frontmatter, then the
statement) and an `index.md` of active concepts.

## Rules and the suite cases that enforce them

- Nothing reaches memory before a human or service applies it: "keeps a proposed fact out of memory until a human
  applies it", "rejects a proposal without changing memory and never decides a proposal twice".
- Agents never decide or create spaces: "refuses an agent applying or rejecting a proposal, even its own", "lets only
  humans and services create memory spaces".
- Near-duplicates and paraphrases are flagged and cannot be applied while the original is active: "flags a
  near-duplicate remember with duplicateOf and refuses to apply it while the original is active", "flags a paraphrase
  of an active concept, not only a near-identical statement, and refuses to apply it", "flags a correction or a
  replacement that repeats another active concept, but never the concept it changes". A `remember` of an active ID is
  `conflict`: "refuses a remember for a concept ID that is already active".
- Owner-set facts are safe from agents: "refuses an agent correcting, superseding or forgetting an owner-set concept,
  but lets it propose a correction to a learned one".
- Who proposed decides `setBy`: "marks a concept learned when an agent's proposal is applied and owner when a human's
  or service's is".
- One writer per space with version checks: "refuses a stale expectedVersion with conflict and changes nothing",
  "serialises concurrent applies on one space so exactly one of two racing corrections applies".
- Recall is bounded and explained: "bounds recall by maxConcepts and maxBytes, reports truncation and keeps the
  profile apart", "keeps the profile within its own limits, names what it leaves out and shows the oldest first",
  "recalls a concept only for a keyword match in its title, ID or tags, not one passing word", "recalls the most
  relevant concept for a query first by BM25, without embeddings", "applies the BM25 floor and half-the-best cutoff
  once a space holds 30 concepts", "recalls project and job concepts only when their
  scope is asked for, and global ones always", "brings a job's exception along with the general concept it overrides,
  and only for that job", "names each recalled concept's version and reason in the manifest and marks stale
  concepts", "never recalls superseded or forgotten concepts, and a superseded one points to its replacement".
- Search: "searches by keyword, ranks stale concepts lower and lists inactive ones only when asked".
- Snapshots: "imports a snapshot as one change, records its ref and names it in every recall".
- Valid input: "refuses a concept without a source as invalid", "refuses a malformed concept ID as invalid".
- Organisation isolation: "hides another organisation's spaces as not found for reads, recall, proposals and
  decisions".
- The bundle: "exports one Markdown file with frontmatter per concept and an index of active concepts".

## Project access (settled question 7)

A space is project-scoped when its owner is a project. After the organisation lookup (another organisation's space
is still `not_found`) and after the agent rules (agents creating spaces or deciding stay `forbidden` first), each
call checks `ProjectAccess.require` with the space's project, and for an agent its own session, subject
`memory.space` (`memory.proposal` for `decide`): `memory.createSpace`, `memory.propose` and `memory.decide` need
`operator`; `memory.getConcept`, `memory.listConcepts`, `memory.listProposals`, `memory.exportBundle` and
`memory.recall` and `memory.search` need `viewer`; `memory.importSnapshot` needs `operator`. `recall` and `search`
find every named space first, then check each project-owned one and refuse the whole call if one fails. Organisation- and user-owned spaces keep their rules: the organisation's agents still
recall from its spaces. A refusal is `forbidden` and audited once as `access.denied`. Every list names its space, so
there is no unfiltered list to narrow, and no call names a session. The cases: "project access: an operator outside
the project is refused for every change and read of its space, and nothing changed", "project access: a viewer on the
project may read its space but not change it", "project access: an agent whose session belongs to another project is
refused, and nothing changed", "project access: an agent whose session was closed is refused" and "project access: an
operator on the project and an agent in its own session still work on its space".

## Write authority (M2-BE5)

A memory takes a `MemoryAuthority`: the least role `createSpace`, `propose`, `decide` and `importSnapshot` each need
(`DEFAULT_MEMORY_AUTHORITY`: `operator` for all four). Where the role is held depends on the space's owner: on the
project for a project's space (as above); across the organisation, from a binding with no project, for an
organisation's space; and for a user's space, the user always may, anyone else needs the role across the
organisation. An agent acts through its own open session and counts as an operator, never an admin, so a write
needing `admin` is never an agent's; agents still never create spaces, decide or import. Reads keep the rules above:
the organisation's members read its spaces. The cases: "write authority: writing to an organisation's space needs a
role across the organisation, not on one project", "write authority: a user writes to their own space without a
role; anyone else needs one across the organisation", "write authority: an agent proposes to an organisation's space
only through its own open session", and, with `writes: true`, "writes: a memory's authority sets the role each write
needs, and an agent never holds more than operator" and "writes: an authority needing admin to propose shuts agents
out, since an agent counts as an operator".

## Duplicates and paraphrases (M2-BE5)

`nearDuplicate` (`src/index.ts`) runs on every `remember`, `correct` and `supersede` replacement against the space's
active concepts, leaving out the concepts the write changes: first `similarity` of the statements at 0.6, then
`paraphraseScore` at `DEFAULT_PARAPHRASE_THRESHOLD` 0.5, the best of the Jaccard similarity of Porter-stemmed
statements, of stemmed titles with statements, and of how much of the shorter statement the other holds (from 0.85).
Statements of fewer than five stemmed words, or holding different numbers, are left to `similarity`: in them one
word is the fact. No model and no embeddings; against Sal's 920 active concepts (422,740 pairs) none scores 0.4.

A host adds a `ParaphraseCheck` (a model, embeddings) for what words miss: it runs only when Harbour's checks find
nothing, is shown the five active concepts nearest by words (never the whole space), and its answer counts only when
it names one of them with a score from 0 to 1. The case: "writes: a host's paraphrase check catches what words alone
miss, shown only the nearest active concepts".

## Publishing to a source (M2-BE5)

`withBundlePublishing({ memory, sourceFor, render?, audit?, clock? })` (`@harbour/memory/publish`) wraps any `Memory`.
After `decide` applies a write through the memory's own writer, it sends the space's whole bundle (every concept, any
status, so nothing needs deleting) to the space's `MemorySource.publish` and waits for it; publishes run one at a
time per space, and applies arriving during one share the next. A failed publish never fails or undoes the write: it
is audited `memory.bundle.publish_failed` with the error's code only (a message may hold a remote's URL), and the next
publish sends everything again. `publishBundle(ctx, spaceId)` publishes now, to retry (humans and services who can
read the space; `not_supported` without a source). A success is audited `memory.bundle.published` with the ref.
`render` replaces Harbour's own export with a host's files: Sal's (`examples/sal-worker/src/memory-source.ts`)
commits OKF concept files and the directory indexes Sal rewrites to a sal-memory branch, keeping the bytes of every
file that already says the same, so publishing an unchanged import commits nothing.

## Write operations (M2-BE5)

`@harbour/memory/writes` gives each write as a transport-neutral operation a later HTTP layer mounts:
`memory.createSpace`, `memory.propose`, `memory.decide`, `memory.importSnapshot` and `memory.publishBundle`. Each parses
untrusted JSON strictly (an unknown or missing field is `invalid` before the memory sees it), says whether agents may
call it (only `propose`), and runs on any `Memory` as the caller, so the memory's own rules apply.
`runMemoryWrite(memory, ctx, name, input)` does both; an unknown name is `not_found`.

## The in-memory implementation

`createMemoryMemory({ clock?, audit?, access?, renderer?, authority?, paraphrase? })` keeps spaces, concepts and proposals in maps, and the
recall index of the last set of spaces asked for, rebuilt when one of them changes. Applies on a space run through
a promise chain; inside it the proposal and the concept's version are checked again, then changed without an await,
so racing applies or an apply racing a reject settle once; `decide` checks the proposal is pending after the access
check. Without `access` it checks only the organisation; every target and conformance run passes one. It audits `memory.space.created`,
`memory.proposal.created`, `.applied` and `.rejected` with stable IDs (`memory:proposal:<id>:<event>`), and
`memory.snapshot.imported` (`memory:space:<id>:snapshot:<n>`, the space's nth import, so going back to an earlier ref
is audited too); importing the space's current snapshot again changes nothing, and a concept the new snapshot leaves
unchanged keeps its version. A space remembers the highest version each ID has had, so a concept a snapshot drops
and a later one brings back carries on from there and a proposal against its old version is `conflict`. Portable logic
(`similarity` with `DEFAULT_SIMILARITY_THRESHOLD` 0.6, `renderConcept`, `validateConceptId` in `src/index.ts`; the
index, terms and recall beside it) has no Node APIs. It leaves out durable storage and embeddings; publishing
is `withBundlePublishing` around any memory, and reading or writing a source's bundle is the host's adapter.

## The durable implementation (`@harbour/memory/sql`)

`createSqlMemory({ driver, clock?, audit?, access?, renderer?, authority?, paraphrase? })` runs on any `SqlDriver` from `@harbour/sql`
(Postgres self-hosted; D1 or a Durable Object's SQLite on Cloudflare). It applies the same rules as the in-memory
memory (`src/rules.ts`, shared by both) and passes the whole suite, with `projectAccess`, on PGlite, `node:sqlite`, D1
in Miniflare and (with `HARBOUR_TEST_POSTGRES_URL`) a real Postgres. `migrateMemory(driver)` creates the tables if
they are missing; `memorySchema(dialect)` gives the statements for a target's own migrations.

- Rows: `memory_spaces` (with the snapshot each was last imported from and its import count), `memory_concepts` (one
  per space and ID; a concept a snapshot drops stays as a row that is no longer held, so its ID keeps its highest
  version), `memory_proposals` and `memory_space_writes`.
- Every change to a space (an import, an apply, a reject) is one batch that first claims the space's next generation
  in `memory_space_writes` with `ON CONFLICT DO NOTHING`; every other statement in it runs only if that claim is this
  writer's. Of two writers that read the same generation exactly one changes anything; the other re-reads and tries
  again, so the version checks run against the current state as they do in the in-memory memory's one writer.
- Recall and search build the same in-process index from the named spaces' concepts, cached per process until a
  space's generation moves on, so they return what the in-memory memory returns for the same writes, and a restart
  loses only the cache.

## Capabilities

`memoryCapabilities` defines `memory.search` and `memory.read` (version 1, `replay: "safe"`, `runsIn: "host"`), which a
Pi host shows as `memory_search` and `memory_read`. `memoryCapabilityHandler({ memory, spaceIds, now })` serves both
from any `Memory` as the invoking agent, so the memory's own access checks apply; the host's `spaceIds` names the
spaces a session reads. Search returns each hit's `spaces` beside its `ids` (and names the space in its line when a
session reads more than one); `memory.read` takes a concept from its optional `space`, which must be one of the
session's, or else from the first space that has it. A missing, unknown or mistyped argument, an unknown concept or a
`HarbourError` (from the host's `spaceIds` too) is an `isError` result for the model, not a thrown error; anything
else throws. Search lines give the ID, title, description, status (current, stale, superseded, forgotten), scope, who
set it and the first source, then the snippet; a read gives the status, version, title, description, statement and
sources.

## Open questions

- Concept IDs need at least two segments (`personal/x`). Is a single segment ever wanted?
- A `remember` may reuse the ID of a superseded or forgotten concept; its version carries on from the old record. An
  agent may do this even when the owner set the old one. Should forgotten owner facts stay owner-only?
- Duplicate detection runs against active concepts in the same space, and only at proposal time: a concept that
  becomes active later, between proposal and apply, is not checked against.
- Settled (question 7) for project-owned spaces, which now check the project. Reads of user-owned spaces are still
  scoped by organisation only, not by the owning user; writes need the user or an organisation-wide role (M2-BE5).
- Publishing sends the whole bundle on every applied write. Fine for Sal's thousand concepts; a much larger space
  would want the changed concepts only.
- Proposals are not checked against `expectedVersion` until applied, so a stale proposal can sit pending.
- An imported snapshot replaces the space; proposals applied since are lost on the next import unless the source has
  them. Sal publishes its memory from the source, so its spaces are read-only mirrors in practice.
- Sal reranks recall with a model in conversations only; its workers, heartbeats and orchestrator recall by BM25
  alone, as Harbour does. A conversation host wanting the rerank would add it above `recall`.
