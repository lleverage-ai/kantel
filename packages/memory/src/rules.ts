/**
 * The rules every `Memory` applies, whatever keeps its records: input checks, who may change what, applying a write to
 * a space's concepts, replacing them with a snapshot, the bundle and the audit events. Shared by the in-memory memory
 * (`./memory.ts`) and the SQL one (`./sql.ts`), so the two cannot drift apart. Not exported from the package.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type Concept,
	type ConceptInput,
	DEFAULT_MEMORY_AUTHORITY,
	HarbourError,
	type MemoryAuthority,
	type MemoryProposal,
	type MemorySearchRequest,
	type MemorySnapshot,
	type MemorySpace,
	type MemoryWrite,
	type OwnerRef,
	type Page,
	type PageRequest,
	type ParaphraseCheck,
	type ProjectAccess,
	type RecallRequest,
	type Role,
	type SnapshotConcept,
	systemContext,
} from "@harbour/contracts";
import { type DuplicateMatch, nearDuplicate, nearestConcepts, renderConcept, validateConceptId } from "./index.ts";
import { MAX_SEARCH_RESULTS, type RecallEntry } from "./recall.ts";

/** Memory appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("memory");

/** A space's concepts as a write sees them. */
export interface SpaceState {
	readonly spaceId: string;
	/** Every concept the space holds, by ID, whatever its status. */
	readonly concepts: Map<string, Concept>;
	/**
	 * The highest version each concept ID has had in the space, kept when a snapshot drops the concept, so an ID that
	 * comes back carries on from there and a proposal made against its old version stays stale.
	 */
	readonly versions: Map<string, number>;
}

export function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

export function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

export function nonEmpty(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

export function byId(left: Concept, right: Concept): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function assertConceptInput(input: ConceptInput): void {
	if (typeof input !== "object" || input === null) throw new HarbourError("invalid", "A write needs a concept");
	if (typeof input.id !== "string") throw new HarbourError("invalid", "A concept needs an ID");
	validateConceptId(input.id);
	if (!nonEmpty(input.title)) throw new HarbourError("invalid", "A concept needs a title");
	if (!nonEmpty(input.statement)) throw new HarbourError("invalid", "A concept needs a statement");
	if (input.description !== undefined && typeof input.description !== "string") {
		throw new HarbourError("invalid", "A description must be text");
	}
	if (!Array.isArray(input.sources) || input.sources.length === 0 || !input.sources.every(nonEmpty)) {
		throw new HarbourError("invalid", "A concept needs at least one source");
	}
	if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every(nonEmpty))) {
		throw new HarbourError("invalid", "Tags must be non-empty text");
	}
	const scope = input.scope;
	const scopeValid =
		scope?.kind === "global" ||
		(scope?.kind === "project" && nonEmpty(scope.project)) ||
		(scope?.kind === "job" && nonEmpty(scope.job));
	if (!scopeValid) throw new HarbourError("invalid", "A scope is global, a named project or a named job");
	if (input.staleAfter !== undefined && !Number.isFinite(input.staleAfter)) {
		throw new HarbourError("invalid", "staleAfter must be a timestamp");
	}
	if (input.overrides !== undefined) {
		if (scope.kind !== "job") throw new HarbourError("invalid", "Only a job concept overrides another");
		validateConceptId(input.overrides);
		if (input.overrides === input.id) throw new HarbourError("invalid", "A concept cannot override itself");
	}
	if (
		input.extensions !== undefined &&
		(typeof input.extensions !== "object" || input.extensions === null || Array.isArray(input.extensions))
	) {
		throw new HarbourError("invalid", "Extensions are an object keyed by namespace");
	}
}

function assertSnapshotConcept(concept: SnapshotConcept): void {
	assertConceptInput(concept);
	if (concept.setBy !== "owner" && concept.setBy !== "learned") {
		throw new HarbourError("invalid", `Concept ${concept.id} needs setBy owner or learned`);
	}
	if (concept.status !== "active" && concept.status !== "superseded" && concept.status !== "forgotten") {
		throw new HarbourError("invalid", `Concept ${concept.id} has an unknown status`);
	}
	if (concept.status === "superseded" && concept.supersededBy !== undefined) validateConceptId(concept.supersededBy);
	if (!Number.isFinite(concept.updatedAt)) throw new HarbourError("invalid", `Concept ${concept.id} needs updatedAt`);
}

/** Checks a snapshot before it is imported: a source, a ref and valid concepts, each once. */
export function assertSnapshot(snapshot: MemorySnapshot): void {
	if (!nonEmpty(snapshot?.sourceId) || !nonEmpty(snapshot.ref)) {
		throw new HarbourError("invalid", "A snapshot needs a source ID and a ref");
	}
	if (!Array.isArray(snapshot.concepts)) throw new HarbourError("invalid", "A snapshot needs a list of concepts");
	const seen = new Set<string>();
	for (const concept of snapshot.concepts) {
		assertSnapshotConcept(concept);
		if (seen.has(concept.id)) throw new HarbourError("invalid", `Concept ${concept.id} appears twice`);
		seen.add(concept.id);
	}
}

function assertExpectedVersion(version: number): void {
	if (!Number.isInteger(version) || version < 1) {
		throw new HarbourError("invalid", "expectedVersion must be a positive integer");
	}
}

function assertLimit(value: number | undefined, label: string): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
		throw new HarbourError("invalid", `${label} must be a positive integer`);
	}
}

/** Checks a recall request's limits and query before any space is read. */
export function assertRecallRequest(request: RecallRequest): void {
	assertLimit(request.maxConcepts, "maxConcepts");
	assertLimit(request.maxBytes, "maxBytes");
	assertLimit(request.maxProfileBytes, "maxProfileBytes");
	if (
		request.maxProfileConcepts !== undefined &&
		(!Number.isInteger(request.maxProfileConcepts) || request.maxProfileConcepts < 0)
	) {
		throw new HarbourError("invalid", "maxProfileConcepts must be a whole number");
	}
	if (typeof request.query !== "string") throw new HarbourError("invalid", "A recall needs a query");
}

/** Checks a search request's query and limit before any space is read. */
export function assertSearchRequest(request: MemorySearchRequest): void {
	if (typeof request.query !== "string") throw new HarbourError("invalid", "A search needs a query");
	if (
		request.limit !== undefined &&
		(!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_SEARCH_RESULTS)
	) {
		throw new HarbourError("invalid", `limit must be 1 to ${MAX_SEARCH_RESULTS}`);
	}
}

/** A memory's authority, checked: each write a role. Without one, `DEFAULT_MEMORY_AUTHORITY`. */
export function authorityOf(authority: MemoryAuthority | undefined): MemoryAuthority {
	if (authority === undefined) return DEFAULT_MEMORY_AUTHORITY;
	const roles = new Set<unknown>(["viewer", "operator", "admin"]);
	for (const write of Object.keys(DEFAULT_MEMORY_AUTHORITY) as (keyof MemoryAuthority)[]) {
		if (!roles.has(authority[write]))
			throw new HarbourError("invalid", `The memory authority needs a role for ${write}`);
	}
	return Object.freeze({ ...authority });
}

/**
 * Checks the role a write needs on a space of `owner` (`MemoryAuthority`): on the project for a project's space;
 * otherwise across the organisation, except that a user always may write to their own space. An agent acts through
 * its own open session, as an operator. Without `access` the memory checks only the organisation.
 */
export async function requireWrite(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	owner: OwnerRef,
	needed: Role,
	operation: string,
	subject?: { readonly kind: string; readonly id: string },
): Promise<void> {
	if (access === undefined || owner.kind === "platform") return;
	const actor = ctx.actor;
	if (owner.kind === "user" && actor.kind === "human" && actor.userId === owner.userId) return;
	await access.require(ctx, {
		...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
		...(actor.kind === "agent" ? { sessionId: actor.sessionId } : {}),
		needed,
		operation,
		...(subject === undefined ? {} : { subject }),
	});
}

/** The checks `createSpace` makes before it creates anything. */
export async function checkCreateSpace(
	access: ProjectAccess | undefined,
	authority: MemoryAuthority,
	ctx: CallContext,
	input: { readonly owner: OwnerRef; readonly name: string },
): Promise<void> {
	forbidAgent(ctx, "create a memory space");
	const owner = input?.owner;
	if (owner?.kind === "platform" || owner?.organisationId !== ctx.organisationId) {
		throw new HarbourError("invalid", "A memory space must be owned within the caller's organisation");
	}
	if (owner.kind !== "organisation" && owner.kind !== "project" && owner.kind !== "user") {
		throw new HarbourError("invalid", "A memory space is owned by an organisation, a project or a user");
	}
	if (!nonEmpty(input.name)) throw new HarbourError("invalid", "A memory space needs a name");
	await requireWrite(access, ctx, owner, authority.createSpace, "memory.createSpace");
}

/**
 * Checks project access on a project-owned space; organisation- and user-owned spaces keep their existing rules. An
 * agent acts through its own session.
 */
export async function requireSpace(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	space: MemorySpace,
	needed: Role,
	operation: string,
	subject: { readonly kind: string; readonly id: string } = { kind: "memory.space", id: space.id },
): Promise<void> {
	const owner = space.owner;
	if (access === undefined || owner.kind !== "project") return;
	await access.require(ctx, {
		projectId: owner.projectId,
		...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
		needed,
		operation,
		subject,
	});
}

/**
 * Whether `listSpaces` shows `space` to the caller: the organisation's spaces, a project's the caller may view, and a
 * user's to that user. Services and Harbour see every one; an agent sees no user's.
 */
export async function listsSpace(
	access: ProjectAccess | undefined,
	ctx: CallContext,
	space: MemorySpace,
): Promise<boolean> {
	const owner = space.owner;
	if (owner.kind === "user") {
		const actor = ctx.actor;
		return (
			actor.kind === "service" || actor.kind === "system" || (actor.kind === "human" && actor.userId === owner.userId)
		);
	}
	if (access === undefined || owner.kind !== "project") return true;
	return access.allows(ctx, {
		projectId: owner.projectId,
		...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
		needed: "viewer",
	});
}

/** Spaces oldest first, then by ID, as `listSpaces` returns them. */
export function bySpaceAge(left: MemorySpace, right: MemorySpace): number {
	return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function assertOutcome(outcome: unknown): void {
	if (outcome !== "apply" && outcome !== "reject") throw new HarbourError("invalid", "The outcome is apply or reject");
}

export function assertPending(proposal: MemoryProposal): void {
	if (proposal.status !== "pending") {
		throw new HarbourError("conflict", `Proposal ${proposal.id} is already ${proposal.status}`);
	}
}

/** The ID of the concept a write changes, or for `remember` the one it creates. */
export function targetId(write: MemoryWrite): string {
	switch (write.op) {
		case "remember":
		case "correct":
			return write.concept.id;
		case "supersede":
		case "forget":
			return write.conceptId;
	}
}

function setByFor(actor: Actor): Concept["setBy"] {
	return actor.kind === "agent" ? "learned" : "owner";
}

function conceptFrom(
	spaceId: string,
	input: ConceptInput,
	setBy: Concept["setBy"],
	version: number,
	updatedAt: number,
): Concept {
	return {
		spaceId,
		id: input.id,
		title: input.title,
		...(input.description === undefined ? {} : { description: input.description }),
		statement: input.statement,
		tags: [...(input.tags ?? [])],
		scope: { ...input.scope },
		sources: [...input.sources],
		setBy,
		version,
		status: "active",
		updatedAt,
		...(input.staleAfter === undefined ? {} : { staleAfter: input.staleAfter }),
		...(input.overrides === undefined ? {} : { overrides: input.overrides }),
		...(input.extensions === undefined ? {} : { extensions: structuredClone(input.extensions) }),
	};
}

/** The version a new record of `id` gets: one past the highest it has had in the space, held now or not. */
function nextVersion(state: SpaceState, id: string): number {
	return Math.max(state.versions.get(id) ?? 0, state.concepts.get(id)?.version ?? 0) + 1;
}

function copyInput(input: ConceptInput): ConceptInput {
	return {
		...input,
		...(input.tags === undefined ? {} : { tags: [...input.tags] }),
		scope: { ...input.scope },
		sources: [...input.sources],
		...(input.extensions === undefined ? {} : { extensions: structuredClone(input.extensions) }),
	};
}

/** A copy of the write, so a caller changing its own object later cannot change a pending proposal. */
function copyWrite(write: MemoryWrite): MemoryWrite {
	switch (write.op) {
		case "remember":
		case "correct":
			return { ...write, concept: copyInput(write.concept) };
		case "supersede":
			return { ...write, replacement: copyInput(write.replacement) };
		case "forget":
			return { ...write };
	}
}

function activeConcept(state: SpaceState, conceptId: string): Concept {
	const concept = state.concepts.get(conceptId);
	if (concept === undefined) throw new HarbourError("not_found", `No concept ${conceptId}`);
	if (concept.status !== "active") throw new HarbourError("conflict", `Concept ${conceptId} is ${concept.status}`);
	return concept;
}

function assertNotActive(state: SpaceState, conceptId: string): void {
	if (state.concepts.get(conceptId)?.status === "active") {
		throw new HarbourError("conflict", `Concept ${conceptId} already exists`);
	}
}

/** Learned facts never overwrite what the owner set. */
function assertMayChange(proposedBy: Actor, concept: Concept): void {
	if (proposedBy.kind === "agent" && concept.setBy === "owner") {
		throw new HarbourError("refused", `Concept ${concept.id} was set by the owner; an agent cannot change it`);
	}
}

function assertVersion(concept: Concept, expectedVersion: number): void {
	if (concept.version !== expectedVersion) {
		throw new HarbourError(
			"conflict",
			`Concept ${concept.id} is at version ${concept.version}, not ${expectedVersion}`,
			{
				version: concept.version,
				expectedVersion,
			},
		);
	}
}

/**
 * The statement a write puts into memory, with the IDs a duplicate may not be (the concepts it changes), or undefined
 * for a `forget`.
 */
function newStatement(
	write: MemoryWrite,
): { readonly candidate: ConceptInput; readonly exclude: ReadonlySet<string> } | undefined {
	switch (write.op) {
		case "remember":
		case "correct":
			return { candidate: write.concept, exclude: new Set([write.concept.id]) };
		case "supersede":
			return { candidate: write.replacement, exclude: new Set([write.conceptId, write.replacement.id]) };
		case "forget":
			return undefined;
	}
}

/**
 * The active concept a checked write's new statement nearly repeats, if any: Harbour's own checks (`nearDuplicate`),
 * then, when they find none and a host gave one, the host's `ParaphraseCheck` over the nearest concepts. A host check
 * naming a concept it was not shown, or a score outside 0 to 1, is ignored.
 */
export async function findDuplicate(
	state: SpaceState,
	write: MemoryWrite,
	paraphrase: ParaphraseCheck | undefined,
): Promise<DuplicateMatch | undefined> {
	const target = newStatement(write);
	if (target === undefined) return undefined;
	const found = nearDuplicate(target.candidate, state.concepts.values(), target.exclude);
	if (found !== undefined || paraphrase === undefined) return found;
	const nearest = nearestConcepts(target.candidate, state.concepts.values(), target.exclude);
	if (nearest.length === 0) return undefined;
	const { id, title, statement } = target.candidate;
	const judged = await paraphrase.check({ id, title, statement }, nearest);
	if (judged === undefined || !nearest.some((concept) => concept.id === judged.conceptId)) return undefined;
	if (!(judged.score >= 0 && judged.score <= 1)) return undefined;
	return { conceptId: judged.conceptId, score: judged.score, check: paraphrase.name };
}

/**
 * Checks a write against the space as it is, as `propose` must, before any duplicate check runs: valid input, the
 * concepts it names in the state it needs, and an agent changing nothing the owner set.
 */
export function checkWrite(ctx: CallContext, state: SpaceState, write: MemoryWrite): void {
	if (typeof write !== "object" || write === null) throw new HarbourError("invalid", "Unknown memory write");
	switch (write.op) {
		case "remember":
			assertConceptInput(write.concept);
			assertNotActive(state, write.concept.id);
			break;
		case "correct":
			assertConceptInput(write.concept);
			assertExpectedVersion(write.expectedVersion);
			assertMayChange(ctx.actor, activeConcept(state, write.concept.id));
			break;
		case "supersede":
			validateConceptId(write.conceptId);
			assertConceptInput(write.replacement);
			assertExpectedVersion(write.expectedVersion);
			if (write.replacement.id === write.conceptId) {
				throw new HarbourError("invalid", "A replacement needs a new concept ID; use correct to change one");
			}
			assertMayChange(ctx.actor, activeConcept(state, write.conceptId));
			assertNotActive(state, write.replacement.id);
			break;
		case "forget":
			validateConceptId(write.conceptId);
			assertExpectedVersion(write.expectedVersion);
			if (!nonEmpty(write.reason)) throw new HarbourError("invalid", "Forgetting needs a reason");
			assertMayChange(ctx.actor, activeConcept(state, write.conceptId));
			break;
		default:
			throw new HarbourError("invalid", "Unknown memory write");
	}
}

/**
 * Builds the pending proposal for a write `checkWrite` passed (without an ID's uniqueness, which the caller's store
 * settles), with the duplicate `findDuplicate` found.
 */
export function proposalFor(
	ctx: CallContext,
	state: SpaceState,
	write: MemoryWrite,
	id: string,
	createdAt: number,
	duplicate: DuplicateMatch | undefined,
): MemoryProposal {
	return {
		id,
		spaceId: state.spaceId,
		write: copyWrite(write),
		proposedBy: ctx.actor,
		...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
		status: "pending",
		...(duplicate === undefined
			? {}
			: { duplicateOf: duplicate.conceptId, duplicate: { score: duplicate.score, check: duplicate.check } }),
		createdAt,
	};
}

/**
 * A proposal whose duplicate is still active cannot be applied, nor one Harbour's own checks find nearly repeats an
 * active concept now: one applied since it was proposed (two pending corrections to the same statement, say). The
 * host's check is not run again here, since applying is synchronous.
 */
function assertNoActiveDuplicate(state: SpaceState, proposal: MemoryProposal): void {
	const target = newStatement(proposal.write);
	const recorded = proposal.duplicateOf;
	const duplicate =
		recorded !== undefined && state.concepts.get(recorded)?.status === "active"
			? recorded
			: target === undefined
				? undefined
				: nearDuplicate(target.candidate, state.concepts.values(), target.exclude)?.conceptId;
	if (duplicate !== undefined) {
		throw new HarbourError("conflict", `The statement nearly duplicates concept ${duplicate}`, {
			duplicateOf: duplicate,
		});
	}
}

/**
 * Checks a pending proposal against the space's current state and applies it to `state`. Synchronous: no await
 * inside. Returns the concept the write is about and every concept it changed, in the order it changed them.
 */
export function applyWrite(
	state: SpaceState,
	proposal: MemoryProposal,
	now: number,
): { readonly concept: Concept; readonly changed: readonly Concept[] } {
	const write = proposal.write;
	const setBy = setByFor(proposal.proposedBy);
	const changed: Concept[] = [];
	const put = (concept: Concept) => {
		state.concepts.set(concept.id, concept);
		state.versions.set(concept.id, Math.max(state.versions.get(concept.id) ?? 0, concept.version));
		changed.push(concept);
	};
	switch (write.op) {
		case "remember": {
			assertNotActive(state, write.concept.id);
			assertNoActiveDuplicate(state, proposal);
			const concept = conceptFrom(state.spaceId, write.concept, setBy, nextVersion(state, write.concept.id), now);
			put(concept);
			return { concept, changed };
		}
		case "correct": {
			const current = activeConcept(state, write.concept.id);
			assertMayChange(proposal.proposedBy, current);
			assertVersion(current, write.expectedVersion);
			assertNoActiveDuplicate(state, proposal);
			const concept = conceptFrom(state.spaceId, write.concept, setBy, current.version + 1, now);
			put(concept);
			return { concept, changed };
		}
		case "supersede": {
			const current = activeConcept(state, write.conceptId);
			assertMayChange(proposal.proposedBy, current);
			assertVersion(current, write.expectedVersion);
			assertNotActive(state, write.replacement.id);
			assertNoActiveDuplicate(state, proposal);
			const replacement = conceptFrom(
				state.spaceId,
				write.replacement,
				setBy,
				nextVersion(state, write.replacement.id),
				now,
			);
			put({
				...current,
				status: "superseded",
				supersededBy: replacement.id,
				version: current.version + 1,
				updatedAt: now,
			});
			put(replacement);
			return { concept: replacement, changed };
		}
		case "forget": {
			const current = activeConcept(state, write.conceptId);
			assertMayChange(proposal.proposedBy, current);
			assertVersion(current, write.expectedVersion);
			const forgotten: Concept = { ...current, status: "forgotten", version: current.version + 1, updatedAt: now };
			put(forgotten);
			return { concept: forgotten, changed };
		}
	}
}

/**
 * The concepts a snapshot leaves the space holding, and the version each now has. A concept the snapshot leaves
 * unchanged keeps its version, so a session's manifest still names the same one; any other gets one past the highest
 * its ID has had. Does not change `state`.
 */
export function snapshotConcepts(state: SpaceState, snapshot: MemorySnapshot): Map<string, Concept> {
	const concepts = new Map<string, Concept>();
	for (const input of snapshot.concepts) {
		const previous = state.concepts.get(input.id);
		const base = conceptFrom(state.spaceId, input, input.setBy, nextVersion(state, input.id), input.updatedAt);
		const next: Concept = {
			...base,
			status: input.status,
			...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
		};
		const same =
			previous !== undefined && JSON.stringify({ ...previous, version: 0 }) === JSON.stringify({ ...next, version: 0 });
		concepts.set(input.id, same ? previous : next);
	}
	return concepts;
}

/** The recall entries of the named spaces' concepts, any status, by ID then space, each with its space's snapshot ref. */
export function recallCorpusOf(
	named: readonly { readonly space: MemorySpace; readonly concepts: Iterable<Concept> }[],
): RecallEntry[] {
	const entries: RecallEntry[] = named.flatMap(({ space, concepts }) =>
		[...concepts].map((concept) => ({
			concept,
			...(space.snapshot === undefined ? {} : { snapshotRef: space.snapshot.ref }),
		})),
	);
	return entries.sort((left, right) =>
		left.concept.id < right.concept.id
			? -1
			: left.concept.id > right.concept.id
				? 1
				: left.concept.spaceId < right.concept.spaceId
					? -1
					: 1,
	);
}

function escapeLinkText(text: string): string {
	return text.replace(/[[\]\\]/g, (character) => `\\${character}`);
}

/** The canonical bundle: `<id>.md` per concept, by ID, and an `index.md` of the active ones. */
export function bundleOf(
	spaceName: string,
	concepts: readonly Concept[],
): readonly { readonly path: string; readonly content: string }[] {
	const sorted = [...concepts].sort(byId);
	const files = sorted.map((concept) => ({ path: `${concept.id}.md`, content: renderConcept(concept) }));
	const active = sorted.filter((concept) => concept.status === "active");
	const index = [
		`# ${spaceName}`,
		"",
		...active.map((concept) => {
			const summary = concept.description === undefined ? "" : `: ${concept.description}`;
			return `- [${escapeLinkText(concept.title)}](${concept.id}.md)${summary}`;
		}),
		"",
	].join("\n");
	return [...files, { path: "index.md", content: index }];
}

/** The audit events a memory appends, as itself, with stable IDs. */
export function memoryAudit(audit: AuditSink | undefined, clock: Clock) {
	async function emit(event: Omit<AuditEventInput, "at" | "source">): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [{ ...event, at: clock.now(), source: "memory" }]);
	}

	function contextFields(ctx: CallContext): Pick<AuditEventInput, "projectId" | "sessionId" | "agentId"> {
		return {
			...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
			...(ctx.actor.kind === "agent" ? { agentId: ctx.actor.agentId, sessionId: ctx.actor.sessionId } : {}),
		};
	}

	function proposalBase(ctx: CallContext, proposalId: string) {
		return {
			actor: ctx.actor,
			organisationId: ctx.organisationId,
			...contextFields(ctx),
			subject: { kind: "memory.proposal", id: proposalId },
		};
	}

	return {
		spaceCreated: (ctx: CallContext, space: MemorySpace) =>
			emit({
				id: `memory:space:${space.id}:created`,
				type: "memory.space.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(space.owner.kind === "project" ? { projectId: space.owner.projectId } : {}),
				subject: { kind: "memory.space", id: space.id },
				data: { name: space.name, owner: space.owner.kind },
			}),

		snapshotImported: (ctx: CallContext, space: MemorySpace, imports: number, concepts: number) =>
			emit({
				id: `memory:space:${space.id}:snapshot:${imports}`,
				type: "memory.snapshot.imported",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(space.owner.kind === "project" ? { projectId: space.owner.projectId } : {}),
				subject: { kind: "memory.space", id: space.id },
				data: { sourceId: space.snapshot?.sourceId ?? "", ref: space.snapshot?.ref ?? "", concepts },
			}),

		proposed: (ctx: CallContext, proposal: MemoryProposal) =>
			emit({
				...proposalBase(ctx, proposal.id),
				id: `memory:proposal:${proposal.id}:created`,
				type: "memory.proposal.created",
				data: {
					spaceId: proposal.spaceId,
					op: proposal.write.op,
					conceptId: targetId(proposal.write),
					...(proposal.duplicateOf === undefined ? {} : { duplicateOf: proposal.duplicateOf }),
				},
			}),

		rejected: (ctx: CallContext, proposal: MemoryProposal) =>
			emit({
				...proposalBase(ctx, proposal.id),
				id: `memory:proposal:${proposal.id}:rejected`,
				type: "memory.proposal.rejected",
				data: { spaceId: proposal.spaceId, op: proposal.write.op },
			}),

		applied: (ctx: CallContext, proposal: MemoryProposal, concept: Concept) =>
			emit({
				...proposalBase(ctx, proposal.id),
				id: `memory:proposal:${proposal.id}:applied`,
				type: "memory.proposal.applied",
				data: {
					spaceId: proposal.spaceId,
					op: proposal.write.op,
					conceptId: concept.id,
					version: concept.version,
					setBy: concept.setBy,
				},
			}),
	};
}

/** A decided proposal: its outcome, who decided and when, and the note. */
export function decided(
	ctx: CallContext,
	proposal: MemoryProposal,
	status: "applied" | "rejected",
	at: number,
	note: string | undefined,
): MemoryProposal {
	return { ...proposal, status, decidedBy: ctx.actor, decidedAt: at, ...(note === undefined ? {} : { note }) };
}
