import {
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type Memory,
	type MemoryAuthority,
	type MemoryProposal,
	type MemorySpace,
	type OrganisationId,
	type ParaphraseCheck,
	type ProjectAccess,
	type RecallRenderer,
	systemClock,
} from "@harbour/contracts";
import { createRecallCorpus, defaultRecallRenderer, type RecallCorpus, recallFrom, searchFrom } from "./recall.ts";
import {
	applyWrite,
	assertNotProposer,
	assertOutcome,
	assertPending,
	assertRecallRequest,
	assertSearchRequest,
	assertSnapshot,
	authorityOf,
	bundleOf,
	byId,
	bySpaceAge,
	checkCreateSpace,
	checkWrite,
	decided,
	findDuplicate,
	forbidAgent,
	listsSpace,
	memoryAudit,
	paginate,
	proposalFor,
	recallCorpusOf,
	requireSpace,
	requireSpaceChange,
	type SpaceState,
	snapshotConcepts,
} from "./rules.ts";

export interface MemoryMemoryOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/**
	 * Project access (settled question 7): a project-owned space needs `viewer` to read or recall and `operator` to
	 * create, propose to or decide on. Without it the memory checks only the organisation; every target and every
	 * conformance run passes one.
	 */
	readonly access?: ProjectAccess;
	/**
	 * The role each write needs (`MemoryAuthority`), checked through `access` for every owner: on the project for a
	 * project's space, across the organisation otherwise (a user may always write to their own). Default
	 * `DEFAULT_MEMORY_AUTHORITY`.
	 */
	readonly authority?: MemoryAuthority;
	/** A host's paraphrase check, asked when Harbour's own checks find no near-duplicate. */
	readonly paraphrase?: ParaphraseCheck;
	/** How recall renders its text and counts its byte budgets. Default `defaultRecallRenderer`. */
	readonly renderer?: RecallRenderer;
}

interface StoredSpace {
	readonly organisationId: OrganisationId;
	space: MemorySpace;
	state: SpaceState;
	/** Counts changes to the concepts, so a recall index built from them knows when it is out of date. */
	generation: number;
	/** Snapshot imports so far, which names each import's audit event. */
	imports: number;
	/** The tail of the space's writer queue: applies run one at a time, in the order they were asked for. */
	writer: Promise<void>;
}

interface StoredProposal {
	readonly organisationId: OrganisationId;
	proposal: MemoryProposal;
}

/**
 * The reference `Memory`: spaces, concepts and proposals in maps. Applies on one space run through a promise chain,
 * so two never interleave; each re-reads the space's current state and checks versions inside the chain.
 */
export function createMemoryMemory(options: MemoryMemoryOptions = {}): Memory {
	const clock = options.clock ?? systemClock;
	const access = options.access;
	const authority = authorityOf(options.authority);
	const audits = memoryAudit(options.audit, clock);
	const renderer = options.renderer ?? defaultRecallRenderer;

	const spaces = new Map<string, StoredSpace>();
	const proposals = new Map<string, StoredProposal>();
	/** The last recall index built, keyed by its spaces and their generations. */
	let cached: { readonly key: string; readonly corpus: RecallCorpus } | undefined;

	/** Every concept of the spaces, any status, by ID then space, indexed for recall and search. */
	function corpusFor(named: readonly StoredSpace[]): RecallCorpus {
		const key = named.map((stored) => `${stored.space.id}:${stored.generation}`).join("\u0000");
		if (cached?.key === key) return cached.corpus;
		const corpus = createRecallCorpus(
			recallCorpusOf(named.map((stored) => ({ space: stored.space, concepts: stored.state.concepts.values() }))),
		);
		cached = { key, corpus };
		return corpus;
	}

	/** Finds every named space before checking any, so a foreign one is `not_found` whatever its place. */
	async function readableSpaces(ctx: CallContext, spaceIds: readonly string[], operation: string) {
		if (!Array.isArray(spaceIds)) throw new HarbourError("invalid", "spaceIds must be a list");
		const named = [...new Set(spaceIds)].map((spaceId) => spaceFor(ctx, spaceId));
		for (const stored of named) await requireSpace(access, ctx, stored.space, "viewer", operation);
		return named;
	}

	function spaceFor(ctx: CallContext, spaceId: string): StoredSpace {
		const stored = spaces.get(spaceId);
		if (stored === undefined || stored.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No memory space ${spaceId}`);
		}
		return stored;
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

	function proposalRecord(ctx: CallContext, proposalId: string): StoredProposal {
		const stored = proposals.get(proposalId);
		if (stored === undefined || stored.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No memory proposal ${proposalId}`);
		}
		return stored;
	}

	return {
		async createSpace(ctx, input) {
			await checkCreateSpace(access, authority, ctx, input);
			const space: MemorySpace = {
				id: `space_${crypto.randomUUID()}`,
				owner: { ...input.owner },
				name: input.name,
				createdAt: clock.now(),
			};
			spaces.set(space.id, {
				organisationId: ctx.organisationId,
				space,
				state: { spaceId: space.id, concepts: new Map(), versions: new Map() },
				generation: 0,
				imports: 0,
				writer: Promise.resolve(),
			});
			await audits.spaceCreated(ctx, space);
			return space;
		},

		async getSpace(ctx, spaceId) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(access, ctx, stored.space, "viewer", "memory.getSpace");
			return stored.space;
		},

		async listSpaces(ctx, page) {
			const shown: MemorySpace[] = [];
			for (const stored of spaces.values()) {
				if (stored.organisationId !== ctx.organisationId) continue;
				if (await listsSpace(access, ctx, stored.space)) shown.push(stored.space);
			}
			return paginate(shown.sort(bySpaceAge), page);
		},

		async getConcept(ctx, spaceId, conceptId) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(access, ctx, stored.space, "viewer", "memory.getConcept");
			const concept = stored.state.concepts.get(conceptId);
			if (concept === undefined) throw new HarbourError("not_found", `No concept ${conceptId}`);
			return concept;
		},

		async listConcepts(ctx, spaceId, filter, page) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpace(access, ctx, stored.space, "viewer", "memory.listConcepts");
			const matching = [...stored.state.concepts.values()]
				.filter((concept) => filter?.status === undefined || concept.status === filter.status)
				.sort(byId);
			return paginate(matching, page);
		},

		async recall(ctx, request) {
			assertRecallRequest(request);
			// One refused project space refuses the whole recall.
			const named = await readableSpaces(ctx, request.spaceIds, "memory.recall");
			return recallFrom(corpusFor(named), request, renderer, clock.now());
		},

		async search(ctx, request) {
			assertSearchRequest(request);
			const named = await readableSpaces(ctx, request.spaceIds, "memory.search");
			return searchFrom(corpusFor(named), request, clock.now());
		},

		async importSnapshot(ctx, spaceId, snapshot) {
			forbidAgent(ctx, "import a memory snapshot");
			const stored = spaceFor(ctx, spaceId);
			await requireSpaceChange(access, ctx, stored.space, "approve", authority.importSnapshot, "memory.importSnapshot");
			assertSnapshot(snapshot);
			return serially(stored, async () => {
				const current = stored.space.snapshot;
				if (current?.sourceId === snapshot.sourceId && current.ref === snapshot.ref) return stored.space;
				const concepts = snapshotConcepts(stored.state, snapshot);
				const versions = stored.state.versions;
				for (const concept of concepts.values()) {
					versions.set(concept.id, Math.max(versions.get(concept.id) ?? 0, concept.version));
				}
				stored.state = { spaceId, concepts, versions };
				stored.generation += 1;
				stored.imports += 1;
				stored.space = {
					...stored.space,
					snapshot: { sourceId: snapshot.sourceId, ref: snapshot.ref, importedAt: clock.now() },
				};
				await audits.snapshotImported(ctx, stored.space, stored.imports, concepts.size);
				return stored.space;
			});
		},

		async propose(ctx, spaceId, write) {
			const stored = spaceFor(ctx, spaceId);
			await requireSpaceChange(access, ctx, stored.space, "propose", authority.propose, "memory.propose");
			checkWrite(ctx, stored.state, write);
			const duplicate = await findDuplicate(stored.state, write, options.paraphrase);
			// A host check may take a while: check again against the space as it is now.
			checkWrite(ctx, stored.state, write);
			const proposal = proposalFor(ctx, stored.state, write, `memprop_${crypto.randomUUID()}`, clock.now(), duplicate);
			proposals.set(proposal.id, { organisationId: ctx.organisationId, proposal });
			await audits.proposed(ctx, proposal);
			return proposal;
		},

		async decide(ctx, proposalId, input) {
			forbidAgent(ctx, "apply or reject a memory proposal");
			const record = proposalRecord(ctx, proposalId);
			assertOutcome(input.outcome);
			const space = spaceFor(ctx, record.proposal.spaceId);
			const policy = await requireSpaceChange(access, ctx, space.space, "approve", authority.decide, "memory.decide");
			// Checked after the await: another decision may have settled the proposal meanwhile.
			assertPending(record.proposal);
			if (input.outcome === "apply") assertNotProposer(policy, ctx, record.proposal);

			if (input.outcome === "reject") {
				record.proposal = decided(ctx, record.proposal, "rejected", clock.now(), input.note);
				await audits.rejected(ctx, record.proposal);
				return record.proposal;
			}

			return serially(space, async () => {
				// Re-read inside the writer: an earlier apply or a reject may have settled this proposal meanwhile.
				assertPending(record.proposal);
				const { concept } = applyWrite(space.state, record.proposal, clock.now());
				space.generation += 1;
				record.proposal = decided(ctx, record.proposal, "applied", clock.now(), input.note);
				const applied = record.proposal;
				await audits.applied(ctx, applied, concept);
				return applied;
			});
		},

		async listProposals(ctx, spaceId, filter, page) {
			await requireSpace(access, ctx, spaceFor(ctx, spaceId).space, "viewer", "memory.listProposals");
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
			await requireSpace(access, ctx, stored.space, "viewer", "memory.exportBundle");
			return bundleOf(stored.space.name, [...stored.state.concepts.values()]);
		},
	};
}
