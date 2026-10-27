import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type Concept,
	type ConceptInput,
	HarbourError,
	type Memory,
	type MemoryProposal,
	type MemorySpace,
	type MemoryWrite,
	type OrganisationId,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type RecallRenderer,
	type Role,
	type SnapshotConcept,
	systemClock,
	systemContext,
} from "@harbour/contracts";

/** Memory appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("memory");

import { DEFAULT_SIMILARITY_THRESHOLD, renderConcept, similarity, validateConceptId } from "./index.ts";
import {
	createRecallCorpus,
	defaultRecallRenderer,
	MAX_SEARCH_RESULTS,
	type RecallCorpus,
	type RecallEntry,
	recallFrom,
	searchFrom,
} from "./recall.ts";

export interface MemoryMemoryOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/**
	 * Project access (settled question 7): a project-owned space needs `viewer` to read or recall and `operator` to
	 * create, propose to or decide on. Without it the memory checks only the organisation; every target and every
	 * conformance run passes one.
	 */
	readonly access?: ProjectAccess;
	/** How recall renders its text and counts its byte budgets. Default `defaultRecallRenderer`. */
	readonly renderer?: RecallRenderer;
}

interface StoredSpace {
	readonly organisationId: OrganisationId;
	space: MemorySpace;
	/** Every concept ever applied in the space, by ID, whatever its status. */
	concepts: Map<string, Concept>;
	/** Counts changes to `concepts`, so a recall index built from them knows when it is out of date. */
	generation: number;
	/**
	 * The highest version each concept ID has had in the space, kept when a snapshot drops the concept, so an ID that
	 * comes back carries on from there and a proposal made against its old version stays stale.
	 */
	readonly versions: Map<string, number>;
	/** Snapshot imports so far, which names each import's audit event. */
	imports: number;
	/** The tail of the space's writer queue: applies run one at a time, in the order they were asked for. */
	writer: Promise<void>;
}

interface StoredProposal {
	readonly organisationId: OrganisationId;
	proposal: MemoryProposal;
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

function paginate<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
	const start = page?.cursor === undefined ? 0 : Number(page.cursor);
	if (!Number.isInteger(start) || start < 0) throw new HarbourError("invalid", "Unknown page cursor");
	const end = start + limit;
	return end < items.length
		? { items: items.slice(start, end), nextCursor: String(end) }
		: { items: items.slice(start, end) };
}

function nonEmpty(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function assertConceptInput(input: ConceptInput): void {
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

/** The ID of the concept a write changes, or for `remember` the one it creates. */
function targetId(write: MemoryWrite): string {
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
function nextVersion(stored: StoredSpace, id: string): number {
	return Math.max(stored.versions.get(id) ?? 0, stored.concepts.get(id)?.version ?? 0) + 1;
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

function escapeLinkText(text: string): string {
	return text.replace(/[[\]\\]/g, (character) => `\\${character}`);
}

/**
 * The reference `Memory`: spaces, concepts and proposals in maps. Applies on one space run through a promise chain,
 * so two never interleave; each re-reads the space's current state and checks versions inside the chain.
 */
export function createMemoryMemory(options: MemoryMemoryOptions = {}): Memory {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const access = options.access;
	const renderer = options.renderer ?? defaultRecallRenderer;

	const spaces = new Map<string, StoredSpace>();
	const proposals = new Map<string, StoredProposal>();
	/** The last recall index built, keyed by its spaces and their generations. */
	let cached: { readonly key: string; readonly corpus: RecallCorpus } | undefined;

	/** Every concept of the spaces, any status, by ID then space, indexed for recall and search. */
	function corpusFor(named: readonly StoredSpace[]): RecallCorpus {
		const key = named.map((stored) => `${stored.space.id}:${stored.generation}`).join("\u0000");
		if (cached?.key === key) return cached.corpus;
		const entries: RecallEntry[] = named.flatMap((stored) =>
			[...stored.concepts.values()].map((concept) => ({
				concept,
				...(stored.space.snapshot === undefined ? {} : { snapshotRef: stored.space.snapshot.ref }),
			})),
		);
		entries.sort((left, right) =>
			left.concept.id < right.concept.id
				? -1
				: left.concept.id > right.concept.id
					? 1
					: left.concept.spaceId < right.concept.spaceId
						? -1
						: 1,
		);
		const corpus = createRecallCorpus(entries);
		cached = { key, corpus };
		return corpus;
	}

	/** Finds every named space before checking any, so a foreign one is `not_found` whatever its place. */
	async function readableSpaces(ctx: CallContext, spaceIds: readonly string[], operation: string) {
		if (!Array.isArray(spaceIds)) throw new HarbourError("invalid", "spaceIds must be a list");
		const named = [...new Set(spaceIds)].map((spaceId) => spaceFor(ctx, spaceId));
		for (const stored of named) await requireSpace(ctx, stored, "viewer", operation);
		return named;
	}

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

	function spaceFor(ctx: CallContext, spaceId: string): StoredSpace {
		const stored = spaces.get(spaceId);
		if (stored === undefined || stored.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No memory space ${spaceId}`);
		}
		return stored;
	}

	/**
	 * Checks project access on a project-owned space; organisation- and user-owned spaces keep their existing rules. An
	 * agent acts through its own session.
	 */
	async function requireSpace(
		ctx: CallContext,
		stored: StoredSpace,
		needed: Role,
		operation: string,
		subject: { readonly kind: string; readonly id: string } = { kind: "memory.space", id: stored.space.id },
	): Promise<void> {
		const owner = stored.space.owner;
		if (access === undefined || owner.kind !== "project") return;
		await access.require(ctx, {
			projectId: owner.projectId,
			...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
			needed,
			operation,
			subject,
		});
	}

	function activeConcept(stored: StoredSpace, conceptId: string): Concept {
		const concept = stored.concepts.get(conceptId);
		if (concept === undefined) throw new HarbourError("not_found", `No concept ${conceptId}`);
		if (concept.status !== "active") throw new HarbourError("conflict", `Concept ${conceptId} is ${concept.status}`);
		return concept;
	}

	function assertNotActive(stored: StoredSpace, conceptId: string): void {
		if (stored.concepts.get(conceptId)?.status === "active") {
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
				{ version: concept.version, expectedVersion },
			);
		}
	}

	/** The most similar active concept whose statement nearly duplicates `statement`, if any. */
	function duplicateOf(stored: StoredSpace, conceptId: string, statement: string): string | undefined {
		let best: { id: string; score: number } | undefined;
		for (const concept of stored.concepts.values()) {
			if (concept.status !== "active" || concept.id === conceptId) continue;
			const score = similarity(statement, concept.statement);
			if (score >= DEFAULT_SIMILARITY_THRESHOLD && (best === undefined || score > best.score)) {
				best = { id: concept.id, score };
			}
		}
		return best?.id;
	}

	/** Runs `task` after every earlier task on the space has settled. */
	function serially<T>(stored: StoredSpace, task: () => T | Promise<T>): Promise<T> {
		const result = stored.writer.then(task);
		stored.writer = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Checks a pending proposal against the space's current state and applies it. Synchronous: no await inside. */
	function applyWrite(stored: StoredSpace, proposal: MemoryProposal): Concept {
		const write = proposal.write;
		const now = clock.now();
		const setBy = setByFor(proposal.proposedBy);
		const put = (concept: Concept) => {
			stored.concepts.set(concept.id, concept);
			stored.versions.set(concept.id, Math.max(stored.versions.get(concept.id) ?? 0, concept.version));
			stored.generation += 1;
		};
		switch (write.op) {
			case "remember": {
				assertNotActive(stored, write.concept.id);
				if (proposal.duplicateOf !== undefined && stored.concepts.get(proposal.duplicateOf)?.status === "active") {
					throw new HarbourError("conflict", `The statement nearly duplicates concept ${proposal.duplicateOf}`, {
						duplicateOf: proposal.duplicateOf,
					});
				}
				const concept = conceptFrom(stored.space.id, write.concept, setBy, nextVersion(stored, write.concept.id), now);
				put(concept);
				return concept;
			}
			case "correct": {
				const current = activeConcept(stored, write.concept.id);
				assertMayChange(proposal.proposedBy, current);
				assertVersion(current, write.expectedVersion);
				const concept = conceptFrom(stored.space.id, write.concept, setBy, current.version + 1, now);
				put(concept);
				return concept;
			}
			case "supersede": {
				const current = activeConcept(stored, write.conceptId);
				assertMayChange(proposal.proposedBy, current);
				assertVersion(current, write.expectedVersion);
				assertNotActive(stored, write.replacement.id);
				const replacement = conceptFrom(
					stored.space.id,
					write.replacement,
					setBy,
					nextVersion(stored, write.replacement.id),
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
				return replacement;
			}
			case "forget": {
				const current = activeConcept(stored, write.conceptId);
				assertMayChange(proposal.proposedBy, current);
				assertVersion(current, write.expectedVersion);
				const forgotten: Concept = { ...current, status: "forgotten", version: current.version + 1, updatedAt: now };
				put(forgotten);
				return forgotten;
			}
		}
	}

	function proposalFor(ctx: CallContext, proposalId: string): StoredProposal {
		const stored = proposals.get(proposalId);
		if (stored === undefined || stored.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No memory proposal ${proposalId}`);
		}
		return stored;
	}

	function assertPending(proposal: MemoryProposal): void {
		if (proposal.status !== "pending") {
			throw new HarbourError("conflict", `Proposal ${proposal.id} is already ${proposal.status}`);
		}
	}

	return {
		async createSpace(ctx, input) {
			forbidAgent(ctx, "create a memory space");
			const owner = input.owner;
			if (owner.kind === "platform" || owner.organisationId !== ctx.organisationId) {
				throw new HarbourError("invalid", "A memory space must be owned within the caller's organisation");
			}
			if (!nonEmpty(input.name)) throw new HarbourError("invalid", "A memory space needs a name");
			if (access !== undefined && owner.kind === "project") {
				await access.require(ctx, { projectId: owner.projectId, needed: "operator", operation: "memory.createSpace" });
			}
			const space: MemorySpace = {
				id: `space_${crypto.randomUUID()}`,
				owner: { ...owner },
				name: input.name,
				createdAt: clock.now(),
			};
			spaces.set(space.id, {
				organisationId: ctx.organisationId,
				space,
				concepts: new Map(),
				generation: 0,
				versions: new Map(),
				imports: 0,
				writer: Promise.resolve(),
			});
			await emit({
				id: `memory:space:${space.id}:created`,
				type: "memory.space.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(owner.kind === "project" ? { projectId: owner.projectId } : {}),
				subject: { kind: "memory.space", id: space.id },
				data: { name: space.name, owner: owner.kind },
			});
			return space;
		},

		async getConcept(ctx, spaceId, conceptId) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(ctx, stored, "viewer", "memory.getConcept");
			const concept = stored.concepts.get(conceptId);
			if (concept === undefined) throw new HarbourError("not_found", `No concept ${conceptId}`);
			return concept;
		},

		async listConcepts(ctx, spaceId, filter, page) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(ctx, stored, "viewer", "memory.listConcepts");
			const matching = [...stored.concepts.values()]
				.filter((concept) => filter?.status === undefined || concept.status === filter.status)
				.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
			return paginate(matching, page);
		},

		async recall(ctx, request) {
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
			// One refused project space refuses the whole recall.
			const named = await readableSpaces(ctx, request.spaceIds, "memory.recall");
			return recallFrom(corpusFor(named), request, renderer, clock.now());
		},

		async search(ctx, request) {
			if (typeof request.query !== "string") throw new HarbourError("invalid", "A search needs a query");
			if (
				request.limit !== undefined &&
				(!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_SEARCH_RESULTS)
			) {
				throw new HarbourError("invalid", `limit must be 1 to ${MAX_SEARCH_RESULTS}`);
			}
			const named = await readableSpaces(ctx, request.spaceIds, "memory.search");
			return searchFrom(corpusFor(named), request, clock.now());
		},

		async importSnapshot(ctx, spaceId, snapshot) {
			forbidAgent(ctx, "import a memory snapshot");
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(ctx, stored, "operator", "memory.importSnapshot");
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
			return serially(stored, async () => {
				const current = stored.space.snapshot;
				if (current?.sourceId === snapshot.sourceId && current.ref === snapshot.ref) return stored.space;
				const concepts = new Map<string, Concept>();
				for (const input of snapshot.concepts) {
					const previous = stored.concepts.get(input.id);
					const base = conceptFrom(stored.space.id, input, input.setBy, nextVersion(stored, input.id), input.updatedAt);
					const next: Concept = {
						...base,
						status: input.status,
						...(input.supersededBy === undefined ? {} : { supersededBy: input.supersededBy }),
					};
					// An unchanged concept keeps its version, so a session's manifest still names the same one.
					const same =
						previous !== undefined &&
						JSON.stringify({ ...previous, version: 0 }) === JSON.stringify({ ...next, version: 0 });
					const kept = same ? previous : next;
					concepts.set(input.id, kept);
					stored.versions.set(input.id, kept.version);
				}
				stored.concepts = concepts;
				stored.generation += 1;
				stored.imports += 1;
				stored.space = {
					...stored.space,
					snapshot: { sourceId: snapshot.sourceId, ref: snapshot.ref, importedAt: clock.now() },
				};
				await emit({
					id: `memory:space:${stored.space.id}:snapshot:${stored.imports}`,
					type: "memory.snapshot.imported",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(stored.space.owner.kind === "project" ? { projectId: stored.space.owner.projectId } : {}),
					subject: { kind: "memory.space", id: stored.space.id },
					data: { sourceId: snapshot.sourceId, ref: snapshot.ref, concepts: concepts.size },
				});
				return stored.space;
			});
		},

		async propose(ctx, spaceId, write) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(ctx, stored, "operator", "memory.propose");
			let duplicate: string | undefined;
			switch (write.op) {
				case "remember":
					assertConceptInput(write.concept);
					assertNotActive(stored, write.concept.id);
					duplicate = duplicateOf(stored, write.concept.id, write.concept.statement);
					break;
				case "correct":
					assertConceptInput(write.concept);
					assertExpectedVersion(write.expectedVersion);
					assertMayChange(ctx.actor, activeConcept(stored, write.concept.id));
					break;
				case "supersede":
					validateConceptId(write.conceptId);
					assertConceptInput(write.replacement);
					assertExpectedVersion(write.expectedVersion);
					if (write.replacement.id === write.conceptId) {
						throw new HarbourError("invalid", "A replacement needs a new concept ID; use correct to change one");
					}
					assertMayChange(ctx.actor, activeConcept(stored, write.conceptId));
					assertNotActive(stored, write.replacement.id);
					break;
				case "forget":
					validateConceptId(write.conceptId);
					assertExpectedVersion(write.expectedVersion);
					if (!nonEmpty(write.reason)) throw new HarbourError("invalid", "Forgetting needs a reason");
					assertMayChange(ctx.actor, activeConcept(stored, write.conceptId));
					break;
				default:
					throw new HarbourError("invalid", "Unknown memory write");
			}
			const proposal: MemoryProposal = {
				id: `memprop_${crypto.randomUUID()}`,
				spaceId,
				write: copyWrite(write),
				proposedBy: ctx.actor,
				...(ctx.actor.kind === "agent" ? { sessionId: ctx.actor.sessionId } : {}),
				status: "pending",
				...(duplicate === undefined ? {} : { duplicateOf: duplicate }),
				createdAt: clock.now(),
			};
			proposals.set(proposal.id, { organisationId: ctx.organisationId, proposal });
			await emit({
				id: `memory:proposal:${proposal.id}:created`,
				type: "memory.proposal.created",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "memory.proposal", id: proposal.id },
				data: {
					spaceId,
					op: write.op,
					conceptId: targetId(write),
					...(duplicate === undefined ? {} : { duplicateOf: duplicate }),
				},
			});
			return proposal;
		},

		async decide(ctx, proposalId, input) {
			forbidAgent(ctx, "apply or reject a memory proposal");
			const record = proposalFor(ctx, proposalId);
			if (input.outcome !== "apply" && input.outcome !== "reject") {
				throw new HarbourError("invalid", "The outcome is apply or reject");
			}
			const space = spaceFor(ctx, record.proposal.spaceId);
			await requireSpace(ctx, space, "operator", "memory.decide", { kind: "memory.proposal", id: proposalId });
			// Checked after the await: another decision may have settled the proposal meanwhile.
			assertPending(record.proposal);
			const decided = (status: "applied" | "rejected"): MemoryProposal => ({
				...record.proposal,
				status,
				decidedBy: ctx.actor,
				decidedAt: clock.now(),
				...(input.note === undefined ? {} : { note: input.note }),
			});
			const base = {
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...contextFields(ctx),
				subject: { kind: "memory.proposal", id: proposalId },
			};

			if (input.outcome === "reject") {
				record.proposal = decided("rejected");
				await emit({
					...base,
					id: `memory:proposal:${proposalId}:rejected`,
					type: "memory.proposal.rejected",
					data: { spaceId: record.proposal.spaceId, op: record.proposal.write.op },
				});
				return record.proposal;
			}

			return serially(space, async () => {
				// Re-read inside the writer: an earlier apply or a reject may have settled this proposal meanwhile.
				assertPending(record.proposal);
				const concept = applyWrite(space, record.proposal);
				record.proposal = decided("applied");
				const applied = record.proposal;
				await emit({
					...base,
					id: `memory:proposal:${proposalId}:applied`,
					type: "memory.proposal.applied",
					data: {
						spaceId: applied.spaceId,
						op: applied.write.op,
						conceptId: concept.id,
						version: concept.version,
						setBy: concept.setBy,
					},
				});
				return applied;
			});
		},

		async listProposals(ctx, spaceId, filter, page) {
			await requireSpace(ctx, spaceFor(ctx, spaceId), "viewer", "memory.listProposals");
			const matching = [...proposals.values()]
				.map((stored) => stored.proposal)
				.filter(
					(proposal) =>
						proposal.spaceId === spaceId && (filter?.status === undefined || proposal.status === filter.status),
				);
			return paginate(matching, page);
		},

		async exportBundle(ctx, spaceId) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(ctx, stored, "viewer", "memory.exportBundle");
			const concepts = [...stored.concepts.values()].sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			);
			const files = concepts.map((concept) => ({ path: `${concept.id}.md`, content: renderConcept(concept) }));
			const active = concepts.filter((concept) => concept.status === "active");
			const index = [
				`# ${stored.space.name}`,
				"",
				...active.map((concept) => {
					const summary = concept.description === undefined ? "" : `: ${concept.description}`;
					return `- [${escapeLinkText(concept.title)}](${concept.id}.md)${summary}`;
				}),
				"",
			].join("\n");
			return [...files, { path: "index.md", content: index }];
		},
	};
}
