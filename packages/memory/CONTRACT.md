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
  `rejected`, and `duplicateOf` when a `remember` nearly repeats an active concept.

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
- Near-duplicates are flagged and cannot be applied while the original is active: "flags a near-duplicate remember
  with duplicateOf and refuses to apply it while the original is active". A `remember` of an active ID is `conflict`:
  "refuses a remember for a concept ID that is already active".
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

## The in-memory implementation

`createMemoryMemory({ clock?, audit?, access?, renderer? })` keeps spaces, concepts and proposals in maps, and the
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
index, terms and recall beside it) has no Node APIs. It leaves out durable storage, publishing to a `MemorySource`
and embeddings; reading a source's bundle into a snapshot is the host's adapter.

## Capabilities

`memoryCapabilities` defines `memory.search` and `memory.read` (version 1, `replay: "safe"`, `runsIn: "host"`), which a
Pi host shows as `memory_search` and `memory_read`. `memoryCapabilityHandler({ memory, spaceIds, now })` serves both
from any `Memory` as the invoking agent, so the memory's own access checks apply; the host's `spaceIds` names the
spaces a session reads, and `memory.read` takes a concept from the first that has it. A bad argument, an unknown
concept or a `HarbourError` is an `isError` result for the model, not a thrown error; anything else throws. Search
lines give the ID, title, description, status (current, stale, superseded, forgotten), scope, who set it and the
first source, then the snippet; a read gives the status, version, title, description, statement and sources.

## Open questions

- Concept IDs need at least two segments (`personal/x`). Is a single segment ever wanted?
- A `remember` may reuse the ID of a superseded or forgotten concept; its version carries on from the old record. An
  agent may do this even when the owner set the old one. Should forgotten owner facts stay owner-only?
- Duplicate detection compares statements only, against active concepts in the same space, and only at proposal time.
- Settled (question 7) for project-owned spaces, which now check the project. User-owned spaces are still scoped
  by organisation only, not by the owning user.
- Proposals are not checked against `expectedVersion` until applied, so a stale proposal can sit pending.
- An imported snapshot replaces the space; proposals applied since are lost on the next import unless the source has
  them. Sal publishes its memory from the source, so its spaces are read-only mirrors in practice.
- Sal reranks recall with a model in conversations only; its workers, heartbeats and orchestrator recall by BM25
  alone, as Harbour does. A conversation host wanting the rerank would add it above `recall`.
