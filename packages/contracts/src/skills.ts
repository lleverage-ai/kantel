/**
 * Skills: Agent Skills packages (a directory with `SKILL.md`) with a stable ID, an owner, and immutable revisions.
 *
 * Harbour standardises the package and its lifecycle, not any host's authoring flow. A host keeps its own flow and
 * publishes the result through a `SkillSource` adapter; the console has a native create and edit flow. Sessions see
 * skills by name, description and path, read them on demand, and pin the revision they used. A skill never grants
 * credentials or authority: nothing in a revision changes a vault, capability or browser grant.
 */
import type {
	Actor,
	CallContext,
	JsonValue,
	OwnerRef,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	Timestamp,
	UserId,
} from "./common.ts";

export interface SkillFile {
	/** Normalised relative path inside the package, such as `SKILL.md` or `scripts/run.sh`. */
	readonly path: string;
	readonly content: string;
}

export interface SkillPackage {
	readonly id: string;
	readonly owner: OwnerRef;
	/** Unique per owner; lowercase letters, digits and dashes, as Agent Skills require. */
	readonly name: string;
	readonly description: string;
	/** The newest published revision, if any. */
	readonly latestRevision?: number;
	/** Present while a draft is open. */
	readonly draftDigest?: string;
	/** Where it came from, when a host's adapter imported it. */
	readonly source?: { readonly sourceId: string; readonly ref: string };
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export interface SkillRevision {
	readonly skillId: string;
	/** 1, 2, 3… per skill. A published revision never changes. */
	readonly revision: number;
	/** Hex SHA-256 over the sorted paths and contents. */
	readonly digest: string;
	readonly name: string;
	readonly description: string;
	readonly files: readonly { readonly path: string; readonly size: number }[];
	/** Namespaced host data, such as Lleverage's workflows and integrations (`lleverage.workflows`). */
	readonly extensions?: { readonly [namespace: string]: JsonValue };
	readonly publishedBy: Actor;
	readonly publishedAt: Timestamp;
	readonly source?: { readonly sourceId: string; readonly ref: string };
}

/** What a session is shown: enough to decide whether to read the skill. */
export interface SkillListing {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	readonly revision: number;
	/** Where the skill is mounted read-only in the sandbox, such as `/skills/pr-review/SKILL.md`. */
	readonly path: string;
}

export interface SkillVisibility {
	readonly projectId?: ProjectId;
	readonly userId?: UserId;
}

export interface SessionSkillPin {
	readonly sessionId: SessionId;
	readonly skillId: string;
	readonly revision: number;
	readonly pinnedAt: Timestamp;
}

export interface Skills {
	/** Agents may not create packages (`forbidden`); a duplicate name for the owner is `conflict`. */
	create(
		ctx: CallContext,
		input: { readonly owner: OwnerRef; readonly name: string; readonly description: string },
	): Promise<SkillPackage>;
	get(ctx: CallContext, skillId: string): Promise<SkillPackage>;
	/**
	 * Replaces the open draft's files. Agents may save drafts (a worker proposes; a human or the orchestrator
	 * publishes). `SKILL.md` must be present.
	 */
	saveDraft(
		ctx: CallContext,
		skillId: string,
		input: { readonly files: readonly SkillFile[]; readonly description?: string },
	): Promise<{ readonly digest: string }>;
	readDraft(ctx: CallContext, skillId: string): Promise<readonly SkillFile[]>;
	/**
	 * Publishes the draft as the next revision. `expectedDigest` must match the draft (`conflict` otherwise), so what
	 * was reviewed is what is published. Agents may not publish (`forbidden`). Publishing a draft identical to the
	 * latest revision returns that revision and creates none.
	 */
	publish(
		ctx: CallContext,
		skillId: string,
		input: { readonly expectedDigest: string; readonly extensions?: { readonly [namespace: string]: JsonValue } },
	): Promise<SkillRevision>;
	getRevision(ctx: CallContext, skillId: string, revision: number): Promise<SkillRevision>;
	readFile(ctx: CallContext, skillId: string, revision: number, path: string): Promise<string>;
	listRevisions(ctx: CallContext, skillId: string, page?: PageRequest): Promise<Page<SkillRevision>>;
	/**
	 * The published skills a session in `visibility` may see: platform skills, the organisation's, the project's and
	 * the user's own. Never another project's or another user's.
	 */
	list(ctx: CallContext, visibility: SkillVisibility, page?: PageRequest): Promise<Page<SkillListing>>;
	/**
	 * Pins the latest published revision of each listed skill for a session, once: later calls return the same pins
	 * even after newer revisions are published.
	 */
	pinForSession(
		ctx: CallContext,
		sessionId: SessionId,
		visibility: SkillVisibility,
	): Promise<readonly SessionSkillPin[]>;
	/**
	 * A host adapter's publish path: creates the package if needed and publishes the files as a revision, idempotent
	 * by `(sourceId, ref)`. Humans and services only.
	 */
	importRevision(
		ctx: CallContext,
		input: {
			readonly owner: OwnerRef;
			readonly name: string;
			readonly description: string;
			readonly files: readonly SkillFile[];
			readonly source: { readonly sourceId: string; readonly ref: string };
			readonly extensions?: { readonly [namespace: string]: JsonValue };
		},
	): Promise<SkillRevision>;
}

/** A host's skill source, such as Sal's Git-backed skills or Lleverage's builder. Harbour pulls from it. */
export interface SkillSource {
	readonly id: string;
	/** Skills the source offers at `ref` (a commit or a version), with their files. */
	fetch(
		ref: string,
	): Promise<readonly { readonly name: string; readonly description: string; readonly files: readonly SkillFile[] }[]>;
}
