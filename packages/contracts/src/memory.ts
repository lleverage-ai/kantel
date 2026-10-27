/**
 * Memory: curated concepts with stable IDs, scopes, sources and freshness, recalled as a bounded profile plus topical
 * search, and changed only through proposals applied by one serial writer per memory space.
 *
 * Writes are remember, correct, supersede and forget. What the owner set cannot be overwritten by a learned fact.
 * Recall returns a manifest of what was recalled and why. Storage indexes are rebuildable from the canonical bundle;
 * Git publication is a `MemorySource` adapter. Embeddings and automatic extraction are optional extras, not core.
 */
import type { Actor, CallContext, OwnerRef, Page, PageRequest, SessionId, Timestamp } from "./common.ts";

export interface MemorySpace {
	readonly id: string;
	readonly owner: OwnerRef;
	readonly name: string;
	readonly createdAt: Timestamp;
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
	/** After this, recall marks the concept stale. */
	readonly staleAfter?: Timestamp;
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
	/** A near-duplicate active concept found when the proposal was made. Approving a `remember` with one is `conflict`. */
	readonly duplicateOf?: string;
	readonly createdAt: Timestamp;
	readonly decidedBy?: Actor;
	readonly decidedAt?: Timestamp;
	readonly note?: string;
}

export interface RecallRequest {
	readonly spaceIds: readonly string[];
	/** The task or message text to search by. */
	readonly query: string;
	/** Project and job scopes that apply; global concepts always apply. */
	readonly scopes?: { readonly projects?: readonly string[]; readonly jobs?: readonly string[] };
	/** Concept IDs always recalled first (the profile), within the limits. */
	readonly profile?: readonly string[];
	/** Default 5. */
	readonly maxConcepts?: number;
	/** Default 4096: total bytes of recalled titles and statements. */
	readonly maxBytes?: number;
}

export interface RecallManifestEntry {
	readonly spaceId: string;
	readonly conceptId: string;
	readonly version: number;
	readonly reason: "profile" | "search";
	/** The search score, for `search`. */
	readonly score?: number;
	readonly stale: boolean;
}

export interface Recall {
	readonly concepts: readonly Concept[];
	/** What was recalled and why, in order, so a session can record exactly what it saw. */
	readonly manifest: readonly RecallManifestEntry[];
	/** True when more matched than the limits allowed. */
	readonly truncated: boolean;
}

export interface Memory {
	/** Humans and services only. */
	createSpace(ctx: CallContext, input: { readonly owner: OwnerRef; readonly name: string }): Promise<MemorySpace>;
	getConcept(ctx: CallContext, spaceId: string, conceptId: string): Promise<Concept>;
	listConcepts(
		ctx: CallContext,
		spaceId: string,
		filter?: { readonly status?: Concept["status"] },
		page?: PageRequest,
	): Promise<Page<Concept>>;
	/** Read-only. Agents may recall from spaces their organisation owns. */
	recall(ctx: CallContext, request: RecallRequest): Promise<Recall>;
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

/** A host's memory source, such as Sal's sal-memory repo. Harbour pushes applied writes to it. */
export interface MemorySource {
	readonly id: string;
	publish(
		spaceId: string,
		files: readonly { readonly path: string; readonly content: string }[],
	): Promise<{ readonly ref: string }>;
}
