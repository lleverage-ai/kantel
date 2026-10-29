/**
 * Publishing memory to a host's source (M2-BE5): after every applied write, the space's whole bundle goes to its
 * `MemorySource`, such as Sal's sal-memory repo, one publish at a time per space. Portable: no Node APIs.
 *
 * `withBundlePublishing` wraps any `Memory`. Its `decide` applies through the memory's own single writer first, so the
 * backing store holds the write before anything is published, then publishes the space's bundle and waits for it. A
 * publish that fails does not undo or fail the write: it is audited as `memory.bundle.publish_failed`, and the next
 * publish (the next applied write, or `publishBundle`) sends the whole bundle again, so the source catches up. Applies
 * that arrive while a publish runs share one publish after it.
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	type Concept,
	HarbourError,
	isHarbourError,
	type Memory,
	type MemorySource,
	systemClock,
	systemContext,
} from "@harbour/contracts";

/** A file of a published bundle. */
export interface BundleFile {
	readonly path: string;
	readonly content: string;
}

/** What one publish sent and where it landed. */
export interface BundlePublication {
	readonly spaceId: string;
	readonly sourceId: string;
	readonly ref: string;
	readonly files: number;
}

export interface BundlePublishingOptions {
	/** The memory whose writes are published. */
	readonly memory: Memory;
	/** The source a space publishes to, or undefined for a space that publishes nowhere. */
	readonly sourceFor: (spaceId: string) => MemorySource | undefined;
	/**
	 * The files for a space's concepts (every one, any status). Default the memory's own bundle (`exportBundle`); Sal's
	 * adapter renders OKF concept files instead.
	 */
	readonly render?: (
		spaceId: string,
		concepts: readonly Concept[],
	) => readonly BundleFile[] | Promise<readonly BundleFile[]>;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
}

export interface PublishingMemory extends Memory {
	/**
	 * Publishes the space's bundle now, after any publish already running, and returns where it landed: to retry one
	 * that failed or to publish a space for the first time. `not_supported` when the space has no source. Agents may not
	 * publish (`forbidden`); the caller must be able to read the space.
	 */
	publishBundle(ctx: CallContext, spaceId: string): Promise<BundlePublication>;
}

const AUDIT_CONTEXT = systemContext("memory");
const PAGE = 500;

/** Wraps `memory` so every applied write publishes its space's bundle. */
export function withBundlePublishing(options: BundlePublishingOptions): PublishingMemory {
	const memory = options.memory;
	const clock = options.clock ?? systemClock;
	/** Per space: the publish running, and the one queued behind it that every later caller shares. */
	const lanes = new Map<
		string,
		{ running?: Promise<BundlePublication> | undefined; queued?: Promise<BundlePublication> | undefined }
	>();

	async function conceptsOf(ctx: CallContext, spaceId: string): Promise<Concept[]> {
		const concepts: Concept[] = [];
		let cursor: string | undefined;
		do {
			const page = await memory.listConcepts(
				ctx,
				spaceId,
				undefined,
				cursor === undefined ? { limit: PAGE } : { limit: PAGE, cursor },
			);
			concepts.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return concepts;
	}

	async function publishNow(ctx: CallContext, spaceId: string, source: MemorySource): Promise<BundlePublication> {
		const files =
			options.render === undefined
				? await memory.exportBundle(ctx, spaceId)
				: await options.render(spaceId, await conceptsOf(ctx, spaceId));
		const { ref } = await source.publish(spaceId, files);
		if (typeof ref !== "string" || ref === "") throw new HarbourError("unavailable", `${source.id} published no ref`);
		const publication: BundlePublication = { spaceId, sourceId: source.id, ref, files: files.length };
		await options.audit?.append(AUDIT_CONTEXT, [
			{
				id: `memory:space:${spaceId}:published:${source.id}:${ref}`,
				at: clock.now(),
				source: "memory",
				type: "memory.bundle.published",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				subject: { kind: "memory.space", id: spaceId },
				data: { sourceId: source.id, ref, files: files.length },
			},
		]);
		return publication;
	}

	/** Runs a publish after the one running, if any; callers arriving while one is queued share it. */
	function schedule(ctx: CallContext, spaceId: string, source: MemorySource): Promise<BundlePublication> {
		let lane = lanes.get(spaceId);
		if (lane === undefined) {
			lane = {};
			lanes.set(spaceId, lane);
		}
		const current = lane;
		if (current.queued !== undefined) return current.queued;
		const start = (): Promise<BundlePublication> => {
			const run = publishNow(ctx, spaceId, source);
			current.running = run;
			const settle = () => {
				if (current.running === run) current.running = undefined;
				if (current.running === undefined && current.queued === undefined) lanes.delete(spaceId);
			};
			run.then(settle, settle);
			return run;
		};
		if (current.running === undefined) return start();
		const queued = current.running.then(
			() => undefined,
			() => undefined,
		);
		current.queued = queued.then(() => {
			current.queued = undefined;
			return start();
		});
		return current.queued;
	}

	async function failed(ctx: CallContext, spaceId: string, source: MemorySource, error: unknown): Promise<void> {
		// The error's message may hold a remote's URL or a host's details: only its code is recorded.
		await options.audit?.append(AUDIT_CONTEXT, [
			{
				id: `memory:space:${spaceId}:publish_failed:${crypto.randomUUID()}`,
				at: clock.now(),
				source: "memory",
				type: "memory.bundle.publish_failed",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				subject: { kind: "memory.space", id: spaceId },
				data: { sourceId: source.id, error: isHarbourError(error) ? error.code : "error" },
			},
		]);
	}

	return {
		createSpace: (ctx, input) => memory.createSpace(ctx, input),
		getConcept: (ctx, spaceId, conceptId) => memory.getConcept(ctx, spaceId, conceptId),
		listConcepts: (ctx, spaceId, filter, page) => memory.listConcepts(ctx, spaceId, filter, page),
		recall: (ctx, request) => memory.recall(ctx, request),
		search: (ctx, request) => memory.search(ctx, request),
		importSnapshot: (ctx, spaceId, snapshot) => memory.importSnapshot(ctx, spaceId, snapshot),
		propose: (ctx, spaceId, write) => memory.propose(ctx, spaceId, write),
		listProposals: (ctx, spaceId, filter, page) => memory.listProposals(ctx, spaceId, filter, page),
		exportBundle: (ctx, spaceId) => memory.exportBundle(ctx, spaceId),

		async decide(ctx, proposalId, input) {
			const decided = await memory.decide(ctx, proposalId, input);
			if (decided.status !== "applied") return decided;
			const source = options.sourceFor(decided.spaceId);
			if (source === undefined) return decided;
			try {
				await schedule(ctx, decided.spaceId, source);
			} catch (error) {
				await failed(ctx, decided.spaceId, source, error);
			}
			return decided;
		},

		async publishBundle(ctx, spaceId) {
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent cannot publish memory");
			// Reads first, so a caller who may not see the space learns nothing about its source.
			await memory.listConcepts(ctx, spaceId, undefined, { limit: 1 });
			const source = options.sourceFor(spaceId);
			if (source === undefined) throw new HarbourError("not_supported", `Memory space ${spaceId} has no source`);
			try {
				return await schedule(ctx, spaceId, source);
			} catch (error) {
				await failed(ctx, spaceId, source, error);
				throw isHarbourError(error)
					? error
					: new HarbourError("unavailable", `Memory space ${spaceId} could not be published to ${source.id}`);
			}
		},
	};
}
