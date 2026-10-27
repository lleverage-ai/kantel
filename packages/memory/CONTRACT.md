# Memory contract

## What it is for

Memory holds curated facts ("concepts") for an owner, recalls a small, explained set of them for a task, and changes
only through proposals that a human or service applies. Learned facts never overwrite what the owner set.

## Records

- **Space**: an owner within one organisation, a name. Every read and write is scoped to the space's organisation.
- **Concept**: a stable path ID (`projects/harbour/vault-binding-codes`), title, optional description, statement, tags,
  scope (`global`, a `project` or a `job`), at least one source, `setBy` (`owner` or `learned`), `version`, `status`
  (`active`, `superseded`, `forgotten`), `supersededBy`, `updatedAt` and an optional `staleAfter`.
- **Proposal**: one write (`remember`, `correct`, `supersede`, `forget`), who proposed it, `pending`, `applied` or
  `rejected`, and `duplicateOf` when a `remember` nearly repeats an active concept.

## Key operations

`propose` (any actor) → `decide` (humans and services) → `getConcept`, `listConcepts`, `recall` and `exportBundle`.
`recall` picks active, in-scope concepts: the `profile` IDs first, then BM25 search results (title counted twice; no
embeddings), up to `maxConcepts` (5) and `maxBytes` (4096 UTF-8 bytes of titles and statements). It returns a manifest
of version, reason, score and staleness. `exportBundle` returns `<id>.md` per concept (YAML frontmatter, then the
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
- Recall is bounded and explained: "bounds recall by maxConcepts and maxBytes, reports truncation and puts profile
  concepts first", "recalls the most relevant concept for a query first by BM25, without embeddings", "recalls project
  and job concepts only when their scope is asked for, and global ones always", "names each recalled concept's version
  and reason in the manifest and marks stale concepts", "never recalls superseded or forgotten concepts, and a
  superseded one points to its replacement".
- Valid input: "refuses a concept without a source as invalid", "refuses a malformed concept ID as invalid".
- Organisation isolation: "hides another organisation's spaces as not found for reads, recall, proposals and
  decisions".
- The bundle: "exports one Markdown file with frontmatter per concept and an index of active concepts".

## The in-memory implementation

`createMemoryMemory({ clock?, audit? })` keeps spaces, concepts and proposals in maps. Applies on a space run through
a promise chain; inside it the proposal and the concept's version are checked again, then changed without an await,
so racing applies or an apply racing a reject settle once. It audits `memory.space.created`,
`memory.proposal.created`, `.applied` and `.rejected` with stable IDs (`memory:proposal:<id>:<event>`). Portable logic (`tokenize`, `bm25`, `similarity` with
`DEFAULT_SIMILARITY_THRESHOLD` 0.6, `conceptBytes`, `renderConcept`, `validateConceptId`) lives in `src/index.ts`. It
leaves out durable storage, publishing to a `MemorySource`, rebuilding from a bundle, embeddings and role checks beyond
"not an agent".

## Open questions

- Concept IDs need at least two segments (`personal/x`). Is a single segment ever wanted?
- A `remember` may reuse the ID of a superseded or forgotten concept; its version carries on from the old record. An
  agent may do this even when the owner set the old one. Should forgotten owner facts stay owner-only?
- Duplicate detection compares statements only, against active concepts in the same space, and only at proposal time.
- Space reads are scoped by organisation only, not by the owning project or user.
- Proposals are not checked against `expectedVersion` until applied, so a stale proposal can sit pending.
