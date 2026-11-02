// The memory page's logic, apart from React: what it reads from `Memory` (bound to the viewer by the host), how
// concepts group by scope, how a proposal reads as a sentence, a concept's history from the proposals that touched it,
// and what a recall's manifest says about each concept it recalled.

import {
	type CallContext,
	type Concept,
	type ConceptScope,
	isKantelError,
	type Memory,
	type MemoryProposal,
	type MemorySearchHit,
	type MemorySearchRequest,
	type MemoryWrite,
	type Page,
	type PageRequest,
	type Recall,
	type RecallManifestEntry,
	type RecallRequest,
} from "@kantel/contracts";
import type { BadgeTone } from "../primitives/status.tsx";

/**
 * What the page reads and decides: `Memory`'s calls with the viewer's call context already bound. `bindMemory` makes
 * one from any implementation, the in-memory one or the console's API client. A source without `listProposals` and
 * `decide` is read-only: the page has no Proposals view and a concept no history, as on an API that serves no
 * proposals yet.
 */
export interface MemoryPageSource {
	listConcepts(
		spaceId: string,
		filter?: { readonly status?: Concept["status"] },
		page?: PageRequest,
	): Promise<Page<Concept>>;
	getConcept(spaceId: string, conceptId: string): Promise<Concept>;
	search(request: MemorySearchRequest): Promise<readonly MemorySearchHit[]>;
	recall(request: RecallRequest): Promise<Recall>;
	listProposals?(
		spaceId: string,
		filter?: { readonly status?: MemoryProposal["status"] },
		page?: PageRequest,
	): Promise<Page<MemoryProposal>>;
	decide?(
		proposalId: string,
		input: { readonly outcome: "apply" | "reject"; readonly note?: string },
	): Promise<MemoryProposal>;
	/** Absent, the page can't correct or forget a concept, only decide what others proposed. */
	propose?(spaceId: string, write: MemoryWrite): Promise<MemoryProposal>;
}

export type MemoryApi = Pick<
	Memory,
	"listConcepts" | "getConcept" | "search" | "recall" | "listProposals" | "decide" | "propose"
>;

/** The page's source over `Memory`, as the viewer `ctx`. */
export function bindMemory(memory: MemoryApi, ctx: CallContext): Required<MemoryPageSource> {
	return {
		listConcepts: (spaceId, filter, page) => memory.listConcepts(ctx, spaceId, filter, page),
		getConcept: (spaceId, conceptId) => memory.getConcept(ctx, spaceId, conceptId),
		search: (request) => memory.search(ctx, request),
		recall: (request) => memory.recall(ctx, request),
		listProposals: (spaceId, filter, page) => memory.listProposals(ctx, spaceId, filter, page),
		decide: (proposalId, input) => memory.decide(ctx, proposalId, input),
		propose: (spaceId, write) => memory.propose(ctx, spaceId, write),
	};
}

/**
 * A person's own change, made the only way `Memory` changes a concept: proposed, then applied by the same person, so it
 * is audited and shows in the concept's history like any other. If applying fails the proposal is left pending, for
 * the person to decide in Proposals.
 */
export async function applyAsPerson(
	source: MemoryPageSource,
	spaceId: string,
	write: MemoryWrite,
): Promise<{ readonly proposal: MemoryProposal; readonly applied: boolean; readonly error?: unknown }> {
	const { propose, decide } = source;
	if (propose === undefined || decide === undefined) throw new Error("This page can't propose changes");
	const proposal = await propose(spaceId, write);
	try {
		return { proposal: await decide(proposal.id, { outcome: "apply" }), applied: true };
	} catch (error) {
		return { proposal, applied: false, error };
	}
}

/** A source per line, blank lines dropped. */
export function parseSources(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export interface CorrectionDraft {
	readonly title: string;
	readonly statement: string;
	readonly sources: string;
}

/** What is wrong with a correction before it is sent, by field; empty when nothing is. */
export function correctionProblems(draft: CorrectionDraft): { title?: string; statement?: string; sources?: string } {
	const problems: { title?: string; statement?: string; sources?: string } = {};
	if (draft.title.trim() === "") problems.title = "Give it a title.";
	if (draft.statement.trim() === "") problems.statement = "Say the fact itself.";
	if (parseSources(draft.sources).length === 0)
		problems.sources = "Name at least one source: a link, a commit or a ticket.";
	return problems;
}

/**
 * The write that corrects `concept` to the draft, at the version it was read at. Everything else carries over; a date
 * for checking that has passed is dropped, since correcting it is the check.
 */
export function correctionWrite(concept: Concept, draft: CorrectionDraft, now: number): MemoryWrite {
	return {
		op: "correct",
		expectedVersion: concept.version,
		concept: {
			id: concept.id,
			title: draft.title.trim(),
			statement: draft.statement.trim(),
			sources: parseSources(draft.sources),
			scope: concept.scope,
			tags: concept.tags,
			...(concept.description === undefined ? {} : { description: concept.description }),
			...(concept.staleAfter === undefined || concept.staleAfter <= now ? {} : { staleAfter: concept.staleAfter }),
			...(concept.overrides === undefined ? {} : { overrides: concept.overrides }),
			...(concept.extensions === undefined ? {} : { extensions: concept.extensions }),
		},
	};
}

export function forgetWrite(concept: Concept, reason: string): MemoryWrite {
	return { op: "forget", conceptId: concept.id, expectedVersion: concept.version, reason: reason.trim() };
}

/**
 * Why a person's change didn't apply, in a sentence. `stage` says how far it got: refused when proposed, nothing
 * exists; refused when applied, the proposal waits in Proposals.
 */
export function changeError(error: unknown, stage: "propose" | "apply"): string {
	const left = stage === "apply" ? " The proposal waits in Proposals." : "";
	if (isKantelError(error, "conflict")) {
		return `It changed since you opened it, so nothing was changed. Open it again to see the new version.${left}`;
	}
	if (isKantelError(error, "forbidden")) return `You can't change concepts in this space.${left}`;
	if (isKantelError(error, "invalid")) return `Kantel refused it: ${(error as Error).message}.${left}`;
	return stage === "apply"
		? `Proposed, but not applied.${left}`
		: "Couldn't change it. Nothing was written; try again.";
}

/** Every item of a paged read, up to 20 pages of 100. */
export async function readAll<T>(read: (page: PageRequest) => Promise<Page<T>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < 20; index += 1) {
		const page = await read(cursor === undefined ? { limit: 100 } : { limit: 100, cursor });
		items.push(...page.items);
		if (page.nextCursor === undefined) break;
		cursor = page.nextCursor;
	}
	return items;
}

/** "Everywhere", "Project kantel", "Job TASK-12". */
export function scopeText(scope: ConceptScope, projectName?: (project: string) => string | undefined): string {
	switch (scope.kind) {
		case "global":
			return "Everywhere";
		case "project":
			return `Project ${projectName?.(scope.project) ?? scope.project}`;
		case "job":
			return `Job ${scope.job}`;
	}
}

const scopeKey = (scope: ConceptScope) =>
	scope.kind === "global" ? "global" : scope.kind === "project" ? `project:${scope.project}` : `job:${scope.job}`;

const SCOPE_ORDER: Readonly<Record<ConceptScope["kind"], number>> = { global: 0, project: 1, job: 2 };

export interface ConceptGroup {
	readonly key: string;
	readonly label: string;
	readonly concepts: readonly Concept[];
}

/** Concepts grouped by scope: everywhere first, then each project, then each job's exceptions; each group by ID. */
export function groupConcepts(
	concepts: readonly Concept[],
	projectName?: (project: string) => string | undefined,
): ConceptGroup[] {
	const groups = new Map<string, { scope: ConceptScope; concepts: Concept[] }>();
	for (const concept of concepts) {
		const key = scopeKey(concept.scope);
		const group = groups.get(key) ?? { scope: concept.scope, concepts: [] };
		group.concepts.push(concept);
		groups.set(key, group);
	}
	return [...groups.entries()]
		.sort(
			([leftKey, left], [rightKey, right]) =>
				SCOPE_ORDER[left.scope.kind] - SCOPE_ORDER[right.scope.kind] || leftKey.localeCompare(rightKey),
		)
		.map(([key, group]) => ({
			key,
			label: scopeText(group.scope, projectName),
			concepts: group.concepts.sort((left, right) => left.id.localeCompare(right.id)),
		}));
}

/** Past its `staleAfter`: recall marks it stale and halves its score. */
export function isStale(concept: Concept, now: number): boolean {
	return concept.staleAfter !== undefined && concept.staleAfter <= now;
}

export interface StateText {
	readonly label: string;
	readonly tone: BadgeTone;
}

export const CONCEPT_STATUS: Readonly<Record<Concept["status"], StateText>> = {
	active: { label: "Active", tone: "done" },
	superseded: { label: "Superseded", tone: "neutral" },
	forgotten: { label: "Forgotten", tone: "neutral" },
};

export const SET_BY: Readonly<Record<Concept["setBy"], StateText>> = {
	owner: { label: "Set by the owner", tone: "accent" },
	learned: { label: "Learned", tone: "neutral" },
};

export const PROPOSAL_STATUS: Readonly<Record<MemoryProposal["status"], StateText>> = {
	pending: { label: "Pending", tone: "approval" },
	applied: { label: "Applied", tone: "done" },
	rejected: { label: "Rejected", tone: "neutral" },
};

export const WRITE_LABELS: Readonly<Record<MemoryWrite["op"], string>> = {
	remember: "Remember",
	correct: "Correct",
	supersede: "Supersede",
	forget: "Forget",
};

/** The concept a write is about: the one it remembers or corrects, or the one it supersedes or forgets. */
export function writeTarget(write: MemoryWrite): string {
	switch (write.op) {
		case "remember":
		case "correct":
			return write.concept.id;
		case "supersede":
		case "forget":
			return write.conceptId;
	}
}

/** What a write would do, as a sentence without its proposer: "remember projects/kantel/vault-binding-codes". */
export function writeSentence(write: MemoryWrite): string {
	switch (write.op) {
		case "remember":
			return `remember ${write.concept.id}`;
		case "correct":
			return `correct ${write.concept.id} (version ${write.expectedVersion})`;
		case "supersede":
			return `replace ${write.conceptId} with ${write.replacement.id}`;
		case "forget":
			return `forget ${write.conceptId}`;
	}
}

/** The concept text a write carries: the new or corrected concept, or the replacement. A forget carries none. */
export function writeConcept(write: MemoryWrite) {
	return write.op === "remember" || write.op === "correct"
		? write.concept
		: write.op === "supersede"
			? write.replacement
			: undefined;
}

/**
 * A concept's history, newest first, from the proposals that touched it: `Memory` keeps no history of its own, so
 * the page reads it from the space's proposals, applied and rejected. Changes made outside proposals (a snapshot
 * import) don't show.
 */
export function conceptHistory(proposals: readonly MemoryProposal[], conceptId: string): MemoryProposal[] {
	return proposals
		.filter((proposal) => {
			if (proposal.status === "pending") return false;
			const { write } = proposal;
			return writeTarget(write) === conceptId || (write.op === "supersede" && write.replacement.id === conceptId);
		})
		.sort((left, right) => (right.decidedAt ?? right.createdAt) - (left.decidedAt ?? left.createdAt));
}

/** Pending first, oldest first, as they wait; then decided ones, newest first. */
export function sortProposals(proposals: readonly MemoryProposal[]): {
	pending: MemoryProposal[];
	decided: MemoryProposal[];
} {
	return {
		pending: proposals.filter((proposal) => proposal.status === "pending").sort((a, b) => a.createdAt - b.createdAt),
		decided: proposals
			.filter((proposal) => proposal.status !== "pending")
			.sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt)),
	};
}

export const RECALL_REASON: Readonly<Record<RecallManifestEntry["reason"], StateText>> = {
	profile: { label: "Profile", tone: "accent" },
	search: { label: "Match", tone: "done" },
	exception: { label: "Exception", tone: "approval" },
};

/** "Score 7.4, matched vault, binding": why a concept was recalled, beyond its reason. */
export function manifestDetail(entry: RecallManifestEntry): string | undefined {
	const parts: string[] = [];
	if (entry.score !== undefined) parts.push(entry.score < 0.05 ? "Score under 0.1" : `Score ${entry.score.toFixed(1)}`);
	if (entry.matched !== undefined && entry.matched.length > 0) parts.push(`matched ${entry.matched.join(", ")}`);
	if (entry.truncated) parts.push("cut short");
	return parts.length === 0 ? undefined : parts.join(", ");
}

/** A source as a link when it is one; otherwise text (a ticket ID, `owner/repo@commit:path`). */
export function sourceHref(source: string): string | undefined {
	return /^https?:\/\//.test(source) ? source : undefined;
}

/** A recall request's scopes from the page's two fields, comma or space separated; empty fields name no scope. */
export function recallScopes(projects: string, jobs: string): RecallRequest["scopes"] | undefined {
	const split = (value: string) =>
		value
			.split(/[\s,]+/)
			.map((part) => part.trim())
			.filter(Boolean);
	const projectList = split(projects);
	const jobList = split(jobs);
	if (projectList.length === 0 && jobList.length === 0) return undefined;
	return {
		...(projectList.length === 0 ? {} : { projects: projectList }),
		...(jobList.length === 0 ? {} : { jobs: jobList }),
	};
}
