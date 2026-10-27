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
	type Recall,
	type RecallManifestEntry,
	systemClock,
} from "@harbour/contracts";
import {
	bm25,
	conceptBytes,
	conceptTokens,
	createBm25Index,
	DEFAULT_SIMILARITY_THRESHOLD,
	renderConcept,
	similarity,
	validateConceptId,
} from "./index.ts";

export interface MemoryMemoryOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
}

const DEFAULT_MAX_CONCEPTS = 5;
const DEFAULT_MAX_BYTES = 4096;

interface StoredSpace {
	readonly organisationId: OrganisationId;
	readonly space: MemorySpace;
	/** Every concept ever applied in the space, by ID, whatever its status. */
	readonly concepts: Map<string, Concept>;
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
	};
}

function copyInput(input: ConceptInput): ConceptInput {
	return {
		...input,
		...(input.tags === undefined ? {} : { tags: [...input.tags] }),
		scope: { ...input.scope },
		sources: [...input.sources],
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

	const spaces = new Map<string, StoredSpace>();
	const proposals = new Map<string, StoredProposal>();

	async function emit(event: Omit<AuditEventInput, "at" | "source">): Promise<void> {
		if (audit === undefined) return;
		await audit.append([{ ...event, at: clock.now(), source: "memory" }]);
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
		const put = (concept: Concept) => stored.concepts.set(concept.id, concept);
		switch (write.op) {
			case "remember": {
				assertNotActive(stored, write.concept.id);
				if (proposal.duplicateOf !== undefined && stored.concepts.get(proposal.duplicateOf)?.status === "active") {
					throw new HarbourError("conflict", `The statement nearly duplicates concept ${proposal.duplicateOf}`, {
						duplicateOf: proposal.duplicateOf,
					});
				}
				const previous = stored.concepts.get(write.concept.id);
				const concept = conceptFrom(stored.space.id, write.concept, setBy, (previous?.version ?? 0) + 1, now);
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
				const previous = stored.concepts.get(write.replacement.id);
				const replacement = conceptFrom(stored.space.id, write.replacement, setBy, (previous?.version ?? 0) + 1, now);
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
				writer: Promise.resolve(),
			});
			return space;
		},

		async getConcept(ctx, spaceId, conceptId) {
			const concept = spaceFor(ctx, spaceId).concepts.get(conceptId);
			if (concept === undefined) throw new HarbourError("not_found", `No concept ${conceptId}`);
			return concept;
		},

		async listConcepts(ctx, spaceId, filter, page) {
			const stored = spaceFor(ctx, spaceId);
			const matching = [...stored.concepts.values()]
				.filter((concept) => filter?.status === undefined || concept.status === filter.status)
				.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
			return paginate(matching, page);
		},

		async recall(ctx, request) {
			assertLimit(request.maxConcepts, "maxConcepts");
			assertLimit(request.maxBytes, "maxBytes");
			const maxConcepts = request.maxConcepts ?? DEFAULT_MAX_CONCEPTS;
			const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
			const projects = new Set(request.scopes?.projects ?? []);
			const jobs = new Set(request.scopes?.jobs ?? []);
			const inScope = (concept: Concept): boolean =>
				concept.scope.kind === "global" ||
				(concept.scope.kind === "project" && projects.has(concept.scope.project)) ||
				(concept.scope.kind === "job" && jobs.has(concept.scope.job));

			const candidates = new Map<string, Concept>();
			const keyOf = (concept: Concept) => `${concept.spaceId}\u0000${concept.id}`;
			for (const spaceId of new Set(request.spaceIds)) {
				for (const concept of spaceFor(ctx, spaceId).concepts.values()) {
					if (concept.status === "active" && inScope(concept)) candidates.set(keyOf(concept), concept);
				}
			}

			const ordered: { concept: Concept; reason: RecallManifestEntry["reason"]; score?: number }[] = [];
			const chosen = new Set<string>();
			for (const conceptId of request.profile ?? []) {
				for (const concept of candidates.values()) {
					if (concept.id !== conceptId || chosen.has(keyOf(concept))) continue;
					chosen.add(keyOf(concept));
					ordered.push({ concept, reason: "profile" });
				}
			}
			const index = createBm25Index(
				[...candidates.entries()].map(([key, concept]) => ({ key, tokens: conceptTokens(concept) })),
			);
			for (const { key, score } of bm25(index, request.query)) {
				const concept = candidates.get(key);
				if (concept === undefined || chosen.has(key)) continue;
				chosen.add(key);
				ordered.push({ concept, reason: "search", score });
			}

			const now = clock.now();
			const concepts: Concept[] = [];
			const manifest: RecallManifestEntry[] = [];
			let bytes = 0;
			for (const entry of ordered) {
				const size = conceptBytes(entry.concept);
				if (concepts.length >= maxConcepts || bytes + size > maxBytes) break;
				bytes += size;
				concepts.push(entry.concept);
				manifest.push({
					spaceId: entry.concept.spaceId,
					conceptId: entry.concept.id,
					version: entry.concept.version,
					reason: entry.reason,
					...(entry.score === undefined ? {} : { score: entry.score }),
					stale: entry.concept.staleAfter !== undefined && now >= entry.concept.staleAfter,
				});
			}
			const recall: Recall = { concepts, manifest, truncated: concepts.length < ordered.length };
			return recall;
		},

		async propose(ctx, spaceId, write) {
			const stored = spaceFor(ctx, spaceId);
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

			const space = spaceFor(ctx, record.proposal.spaceId);
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
			spaceFor(ctx, spaceId);
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
