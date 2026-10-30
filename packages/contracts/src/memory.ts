/**
 * Memory: curated concepts with stable IDs, scopes, sources and freshness, recalled as a bounded profile plus topical
 * search, and changed only through proposals applied by one serial writer per memory space.
 *
 * Writes are remember, correct, supersede and forget. What the owner set cannot be overwritten by a learned fact.
 * Recall returns a manifest of what was recalled and why. Storage indexes are rebuildable from the canonical bundle;
 * Git publication is a `MemorySource` adapter. Embeddings and automatic extraction are optional extras, not core.
 *
 * Recall follows Sal's model, so a host moving its workers onto Harbour sees the same concepts: BM25 over a full-text
 * index of every concept in the named spaces (`porter unicode61` terms; ID, title, description, tags and statement
 * weighted 4, 4, 2.5, 3 and 1), gated by a keyword score, plus a profile with its own budget. A space may also hold a
 * snapshot a host's `MemorySource` loaded (`importSnapshot`), which replaces its concepts at a recorded ref.
 */
import type { Actor, CallContext, JsonValue, OwnerRef, Page, PageRequest, SessionId, Timestamp } from "./common.ts";
import type { Role } from "./identity.ts";

export interface MemorySpace {
	readonly id: string;
	readonly owner: OwnerRef;
	readonly name: string;
	readonly createdAt: Timestamp;
	/** Present once a snapshot was imported: where it came from, so every recall can name what it read. */
	readonly snapshot?: MemorySnapshotRef;
}

/** A snapshot's origin: the source and its ref (a commit, say), and when it was imported. */
export interface MemorySnapshotRef {
	readonly sourceId: string;
	readonly ref: string;
	readonly importedAt: Timestamp;
}

/** Where a concept applies. `job` concepts are exceptions for one named job or task and recalled only for it. */
export type ConceptScope =
	| { readonly kind: "global" }
	| { readonly kind: "project"; readonly project: string }
	| { readonly kind: "job"; readonly job: string };

export interface Concept {
	readonly spaceId: string;
	/** A stable path, such as `projects/harbour/vault-binding-codes` or `personal/pr-review-timing`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	readonly tags: readonly string[];
	readonly scope: ConceptScope;
	/** Sources that back it: URLs, `owner/repo@commit:path:lines`, ticket IDs. At least one. */
	readonly sources: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	/** Increases with every change; writes name the version they expect. */
	readonly version: number;
	readonly status: "active" | "superseded" | "forgotten";
	readonly supersededBy?: string;
	readonly updatedAt: Timestamp;
	/** After this, recall marks the concept stale and halves its score. */
	readonly staleAfter?: Timestamp;
	/**
	 * For a `job` concept, an exception: the general concept it departs from. Recall brings the exception along whenever
	 * it recalls the general concept for that job, so a session never sees the rule without its override.
	 */
	readonly overrides?: string;
	/** Namespaced host data Harbour keeps but does not read, such as Sal's `sal` block. */
	readonly extensions?: { readonly [namespace: string]: JsonValue };
}

export interface ConceptInput {
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	readonly statement: string;
	readonly tags?: readonly string[];
	readonly scope: ConceptScope;
	readonly sources: readonly string[];
	readonly staleAfter?: Timestamp;
	/** Only on a `job` concept. */
	readonly overrides?: string;
	readonly extensions?: { readonly [namespace: string]: JsonValue };
}

/** One concept of a snapshot, as its source holds it: any status, with who set it and when. */
export interface SnapshotConcept extends ConceptInput {
	readonly setBy: Concept["setBy"];
	readonly status: Concept["status"];
	readonly supersededBy?: string;
	readonly updatedAt: Timestamp;
}

/** A whole space's concepts at one ref of a source. */
export interface MemorySnapshot {
	readonly sourceId: string;
	readonly ref: string;
	readonly concepts: readonly SnapshotConcept[];
}

export type MemoryWrite =
	| { readonly op: "remember"; readonly concept: ConceptInput }
	| { readonly op: "correct"; readonly concept: ConceptInput; readonly expectedVersion: number }
	| {
			readonly op: "supersede";
			readonly conceptId: string;
			readonly expectedVersion: number;
			readonly replacement: ConceptInput;
	  }
	| { readonly op: "forget"; readonly conceptId: string; readonly expectedVersion: number; readonly reason: string };

export interface MemoryProposal {
	readonly id: string;
	readonly spaceId: string;
	readonly write: MemoryWrite;
	readonly proposedBy: Actor;
	readonly sessionId?: SessionId;
	readonly status: "pending" | "applied" | "rejected";
	/**
	 * A near-duplicate active concept found when the proposal was made: one whose statement a `remember`, a `correct`
	 * or a `supersede`'s replacement nearly repeats or paraphrases. Applying the proposal while it is active is
	 * `conflict`.
	 */
	readonly duplicateOf?: string;
	/** With `duplicateOf`: how near it is (0 to 1) and which check found it (`similarity`, `paraphrase` or a host's). */
	readonly duplicate?: { readonly score: number; readonly check: string };
	readonly createdAt: Timestamp;
	readonly decidedBy?: Actor;
	readonly decidedAt?: Timestamp;
	readonly note?: string;
}

export interface RecallRequest {
	readonly spaceIds: readonly string[];
	/** The task or message text to search by. */
	readonly query: string;
	/**
	 * Project and job scopes that apply; global concepts always apply. A job matches a `job` concept whose scope names
	 * it exactly, so a host passes every spelling it uses (`TASK-12` and `docket:TASK-12`).
	 */
	readonly scopes?: { readonly projects?: readonly string[]; readonly jobs?: readonly string[] };
	/**
	 * The profile: concept IDs recalled whatever the query, within their own limits. Should they not all fit, those the
	 * query matches go first, then the newest; the rest are named in `Recall.profileOmitted`. They render oldest first.
	 */
	readonly profile?: readonly string[];
	/** Concept IDs the session already has, such as concepts its prompt names; never recalled. */
	readonly exclude?: readonly string[];
	/** Default 5: search matches, not counting the profile or the exceptions that travel with a match. */
	readonly maxConcepts?: number;
	/**
	 * Default 4096: bytes of the rendered recall (`Recall.text`) outside the profile, its frame included. Matches fill what
	 * the frame and the omitted notice leave; those two are always shown, so on their own they may exceed it.
	 */
	readonly maxBytes?: number;
	/** Default no limit: profile concepts. 0 turns the profile off. */
	readonly maxProfileConcepts?: number;
	/** Default 24576: bytes of the rendered profile. */
	readonly maxProfileBytes?: number;
}

export interface RecallManifestEntry {
	readonly spaceId: string;
	readonly conceptId: string;
	readonly version: number;
	/** `exception`: a job's exception, recalled with the general concept it overrides. */
	readonly reason: "profile" | "search" | "exception";
	/** The BM25 score, for `search` and a profile concept the query matched. */
	readonly score?: number;
	/** Query terms that matched it, at most eight. */
	readonly matched?: readonly string[];
	readonly stale: boolean;
	/** True when the renderer cut the statement short. */
	readonly truncated: boolean;
	/** The space's snapshot ref when it holds one, so a session records exactly which revision it read. */
	readonly snapshotRef?: string;
}

export interface Recall {
	/** Profile concepts first (oldest first), then the matches, each followed by its exceptions. */
	readonly concepts: readonly Concept[];
	/** What was recalled and why, in the same order, so a session can record exactly what it saw. */
	readonly manifest: readonly RecallManifestEntry[];
	/** The recall as a prompt shows it, rendered by the implementation's renderer; empty when nothing is recalled. */
	readonly text: string;
	/** Concepts that matched and were left out, and why: inactive, another job's exception or over a limit. At most 10. */
	readonly skipped: readonly { readonly conceptId: string; readonly reason: string }[];
	/** Every profile concept left out for a limit. Never left out silently: the rendered text names them too. */
	readonly profileOmitted: readonly string[];
	/** True when more matched than the limits allowed. */
	readonly truncated: boolean;
}

export interface MemorySearchRequest {
	readonly spaceIds: readonly string[];
	readonly query: string;
	/** Default 5, at most 10. */
	readonly limit?: number;
	/** Also list superseded and forgotten concepts, scoring a quarter, to inspect history. */
	readonly includeInactive?: boolean;
}

export interface MemorySearchHit {
	readonly concept: Concept;
	/** Keyword score: 3 per term in the title or ID, 3 in a tag, 2 in the description, 1 in the statement. */
	readonly score: number;
	readonly stale: boolean;
	/** The first statement line holding a term, cut to 160 characters. */
	readonly snippet: string;
}

export interface Memory {
	/** Humans and services only. */
	createSpace(ctx: CallContext, input: { readonly owner: OwnerRef; readonly name: string }): Promise<MemorySpace>;
	/**
	 * The spaces of the caller's organisation it may read, oldest first: the organisation's, those of projects it may
	 * view, and a user's own. A person never sees another user's space here; services and Harbour see every one.
	 */
	listSpaces(ctx: CallContext, page?: PageRequest): Promise<Page<MemorySpace>>;
	/** One space, read as its concepts are: a project's needs viewer on it or a share (docs/design/sharing.md). */
	getSpace(ctx: CallContext, spaceId: string): Promise<MemorySpace>;
	getConcept(ctx: CallContext, spaceId: string, conceptId: string): Promise<Concept>;
	listConcepts(
		ctx: CallContext,
		spaceId: string,
		filter?: { readonly status?: Concept["status"] },
		page?: PageRequest,
	): Promise<Page<Concept>>;
	/** Read-only. Agents may recall from spaces their organisation owns. */
	recall(ctx: CallContext, request: RecallRequest): Promise<Recall>;
	/** Read-only keyword search over the named spaces, best first: what a `memory_search` tool shows. */
	search(ctx: CallContext, request: MemorySearchRequest): Promise<readonly MemorySearchHit[]>;
	/**
	 * Replaces a space's concepts with a source's snapshot, as one change, and records its ref on the space. Humans and
	 * services only. Importing the ref the space already holds changes nothing, and a concept the snapshot leaves
	 * unchanged keeps its version. A proposal still pending is checked against the new concepts when it is decided.
	 */
	importSnapshot(ctx: CallContext, spaceId: string, snapshot: MemorySnapshot): Promise<MemorySpace>;
	/**
	 * Proposes a write. Any actor may propose. A `remember` whose statement nearly duplicates an active concept is
	 * flagged with `duplicateOf`. A write that would change an owner-set concept, proposed by an agent, is `refused`.
	 */
	propose(ctx: CallContext, spaceId: string, write: MemoryWrite): Promise<MemoryProposal>;
	/**
	 * Applies or rejects a proposal. Humans and services only (`forbidden` for agents). Applying goes through the
	 * space's single writer: a stale `expectedVersion` is `conflict` and nothing changes. Applying an agent's proposal
	 * marks the concept `learned`; a human's or service's marks it `owner`.
	 */
	decide(
		ctx: CallContext,
		proposalId: string,
		input: { readonly outcome: "apply" | "reject"; readonly note?: string },
	): Promise<MemoryProposal>;
	listProposals(
		ctx: CallContext,
		spaceId: string,
		filter?: { readonly status?: MemoryProposal["status"] },
		page?: PageRequest,
	): Promise<Page<MemoryProposal>>;
	/** The canonical bundle: one Markdown file per concept, for a Git or object-store adapter. */
	exportBundle(
		ctx: CallContext,
		spaceId: string,
	): Promise<readonly { readonly path: string; readonly content: string }[]>;
}

/**
 * Who may write to memory, as the least role each write needs (M2-BE5). A memory takes one; without it every write
 * needs `operator`, as `DEFAULT_MEMORY_AUTHORITY` says. Where the role is held depends on the space's owner:
 *
 * - A project's space: on that project (`ProjectAccess`); an agent through its own open session in the project.
 * - An organisation's space: across the organisation, from a binding with no project; an agent through its own open
 *   session anywhere in the organisation.
 * - A user's space: that user always may; anyone else needs the role across the organisation, and an agent acts
 *   through its own open session.
 *
 * An agent counts as an operator, never an admin, so a write needing `admin` is never an agent's. Agents never decide
 * or import, whatever the authority says.
 */
export interface MemoryAuthority {
	readonly createSpace: Role;
	readonly propose: Role;
	readonly decide: Role;
	readonly importSnapshot: Role;
}

export const DEFAULT_MEMORY_AUTHORITY: MemoryAuthority = Object.freeze({
	createSpace: "operator",
	propose: "operator",
	decide: "operator",
	importSnapshot: "operator",
});

/**
 * A host's paraphrase check, run when Harbour's own checks find no near-duplicate: a model or embeddings judging
 * whether a proposed statement says what an existing concept says in other words ("wants check-ins to finish
 * silently" and "prefers not to receive check-in messages"). It is given the few active concepts nearest by words,
 * never the whole space.
 */
export interface ParaphraseCheck {
	/** Named in `MemoryProposal.duplicate.check`. */
	readonly name: string;
	check(
		candidate: { readonly id: string; readonly title: string; readonly statement: string },
		nearest: readonly Concept[],
	): Promise<{ readonly conceptId: string; readonly score: number } | undefined>;
}

/**
 * A host's memory source, such as Sal's sal-memory repo. Harbour pushes applied writes to it, and a host loads a
 * snapshot from it for `importSnapshot`.
 */
export interface MemorySource {
	readonly id: string;
	/**
	 * Writes a space's whole bundle (every concept, any status, so nothing ever needs deleting) and returns the ref it
	 * now stands at, such as a commit. Files equal to what the source holds are left as they are. Harbour calls it
	 * after applied writes, one call at a time per space (`@harbour/memory/publish`).
	 */
	publish(
		spaceId: string,
		files: readonly { readonly path: string; readonly content: string }[],
	): Promise<{ readonly ref: string }>;
	/** The concepts at `ref` (a commit, say), limited to what the host lets the space hold. */
	snapshot?(ref: string): Promise<MemorySnapshot>;
}

/**
 * How an implementation renders a recall (`Recall.text`), and so how `maxBytes` and `maxProfileBytes` are counted. A
 * deployment picks one; Sal's adapter renders as Sal does, so budgets cut where Sal's own recall cuts.
 *
 * The text is `open`, a newline, the concept groups joined by newlines (a group is a concept and its exceptions, joined
 * by newlines), then `omitted` on its own line when profile concepts were left out, a newline and `close`. A group
 * costs its concepts' UTF-8 bytes plus one each. `maxBytes` covers `open`, a newline and `close`, the omitted line and
 * a newline, and the match groups; `maxProfileBytes` covers the profile groups alone.
 */
export interface RecallRenderer {
	readonly open: string;
	readonly close: string;
	concept(
		concept: Concept,
		entry: { readonly reason: RecallManifestEntry["reason"]; readonly stale: boolean },
	): { readonly text: string; readonly truncated: boolean };
	omitted(conceptIds: readonly string[]): string;
}
