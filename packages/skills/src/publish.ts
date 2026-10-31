/**
 * Writing skills back to a host's source (M2-BE5): after a native publish (the console's drafts, say), the revision's
 * whole package goes to the skill's `SkillSource`, such as Sal's Git-backed skills, one export at a time per skill.
 * Portable: no Node APIs.
 *
 * `withSourcePublishing` wraps any `Skills`. Its `publish` publishes through the store first, so the revision exists
 * before anything is exported, then reads the revision's files and hands them to `source.publish`, and waits for it.
 * An export that fails never undoes or fails the publish: it is audited as `skills.revision.export_failed` (the error
 * code only, never the message), and `exportRevision` retries it. A revision that came from a source (an import), and
 * one this wrapper has exported already (an unchanged draft gives back the latest revision), are not exported. Every
 * other method passes straight through.
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	isKantelError,
	KantelError,
	type SkillFile,
	type SkillPackage,
	type SkillRevision,
	type SkillSource,
	type Skills,
	systemClock,
	systemContext,
} from "@kantel/contracts";

/** Where an exported revision landed. */
export interface SkillExport {
	readonly sourceId: string;
	readonly ref: string;
}

export interface SourcePublishingOptions {
	/** The store whose native publishes are exported. */
	readonly skills: Skills;
	/** The source a package writes back to, or undefined (or one without `publish`) for one that goes nowhere. */
	readonly sourceFor: (pkg: SkillPackage) => SkillSource | undefined;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
}

export interface SourcePublishingSkills extends Skills {
	/**
	 * Exports the skill's latest revision to its package's source now, after any export of the skill already running,
	 * and returns where it landed: to retry one that failed. An older revision is `conflict`, so the source never goes
	 * back. `not_supported` when the package has no source or its source cannot be written to. A failure is the source's
	 * error code with a message of Kantel's own, never the source's. Agents may not export (`forbidden`); the caller
	 * must be able to read the skill, and re-exporting the latest revision changes nothing a reader could not see.
	 *
	 * Exports are ordered within one wrapper. Processes sharing a store each skip a revision a newer one has replaced,
	 * but two may still race; a source that can should refuse a revision older than the one it holds.
	 */
	exportRevision(ctx: CallContext, skillId: string, revision: number): Promise<SkillExport>;
}

const AUDIT_CONTEXT = systemContext("skills");

type WritableSource = SkillSource & { publish: NonNullable<SkillSource["publish"]> };

function writable(source: SkillSource | undefined): source is WritableSource {
	return source !== undefined && typeof source.publish === "function";
}

/** Wraps `skills` so every native publish is written back to its package's source. */
export function withSourcePublishing(options: SourcePublishingOptions): SourcePublishingSkills {
	const skills = options.skills;
	const clock = options.clock ?? systemClock;
	/** Per skill: the tail of its export queue, so exports run one at a time in the order they were asked for. */
	const lanes = new Map<string, Promise<void>>();
	/** Per skill: the newest revision exported, so a publish that lost a race never exports over a newer one. */
	const newest = new Map<string, number>();

	function serialise<T>(skillId: string, job: () => Promise<T>): Promise<T> {
		const run = (lanes.get(skillId) ?? Promise.resolve()).then(job);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		lanes.set(skillId, tail);
		tail.then(() => {
			if (lanes.get(skillId) === tail) lanes.delete(skillId);
		});
		return run;
	}

	async function exportNow(
		ctx: CallContext,
		skillId: string,
		revisionNumber: number,
		source: WritableSource,
	): Promise<SkillExport> {
		const revision = await skills.getRevision(ctx, skillId, revisionNumber);
		const files: SkillFile[] = [];
		for (const file of revision.files) {
			files.push({ path: file.path, content: await skills.readFile(ctx, skillId, revision.revision, file.path) });
		}
		const { ref } = await source.publish({
			name: revision.name,
			description: revision.description,
			files,
			revision: { skillId, revision: revision.revision, digest: revision.digest },
		});
		if (typeof ref !== "string" || ref === "") throw new KantelError("unavailable", `${source.id} returned no ref`);
		newest.set(skillId, Math.max(newest.get(skillId) ?? 0, revision.revision));
		await options.audit?.append(AUDIT_CONTEXT, [
			{
				id: `skills:revision:${skillId}:${revision.revision}:exported:${source.id}:${ref}`,
				at: clock.now(),
				source: "skills",
				type: "skills.revision.exported",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "skills.skill", id: skillId },
				data: { sourceId: source.id, ref, revision: revision.revision, digest: revision.digest },
			},
		]);
		return { sourceId: source.id, ref };
	}

	/** Throws `conflict` unless `revision` is still the skill's latest, so an export never takes the source back. */
	async function assertLatest(ctx: CallContext, skillId: string, revision: number): Promise<void> {
		const latest = (await skills.get(ctx, skillId)).latestRevision ?? 0;
		if (latest !== revision) {
			throw new KantelError("conflict", `Only the latest revision of skill ${skillId}, ${latest}, can be exported`);
		}
	}

	/** Audits a failed export. Never throws: the publish it follows stands whatever happens here. */
	async function failed(
		ctx: CallContext,
		skillId: string,
		revision: number,
		sourceId: string | undefined,
		error: unknown,
	): Promise<void> {
		// The error's message may hold a remote's URL or a host's details: only its code is recorded.
		await options.audit
			?.append(AUDIT_CONTEXT, [
				{
					id: `skills:revision:${skillId}:${revision}:export_failed:${crypto.randomUUID()}`,
					at: clock.now(),
					source: "skills",
					type: "skills.revision.export_failed",
					actor: ctx.actor,
					organisationId: ctx.organisationId,
					...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
					subject: { kind: "skills.skill", id: skillId },
					data: { sourceId: sourceId ?? null, revision, error: isKantelError(error) ? error.code : "error" },
				},
			])
			.catch(() => undefined);
	}

	return {
		create: (ctx, input) => skills.create(ctx, input),
		get: (ctx, skillId) => skills.get(ctx, skillId),
		saveDraft: (ctx, skillId, input) => skills.saveDraft(ctx, skillId, input),
		readDraft: (ctx, skillId) => skills.readDraft(ctx, skillId),
		getRevision: (ctx, skillId, revision) => skills.getRevision(ctx, skillId, revision),
		readFile: (ctx, skillId, revision, path) => skills.readFile(ctx, skillId, revision, path),
		listRevisions: (ctx, skillId, page) => skills.listRevisions(ctx, skillId, page),
		list: (ctx, visibility, page) => skills.list(ctx, visibility, page),
		pinForSession: (ctx, sessionId, visibility) => skills.pinForSession(ctx, sessionId, visibility),
		importRevision: (ctx, input) => skills.importRevision(ctx, input),

		async publish(ctx, skillId, input) {
			// The store checks the caller; nothing is read on its behalf first.
			const revision: SkillRevision = await skills.publish(ctx, skillId, input);
			if (revision.source !== undefined) return revision;
			// An unchanged draft gives back the latest revision: exported already, unless this process has not seen it, and
			// then the source finds its files unchanged.
			if ((newest.get(skillId) ?? 0) >= revision.revision) return revision;
			// From here on nothing fails the publish, which has happened: a failure is audited, and exportRevision retries.
			let source: SkillSource | undefined;
			try {
				source = options.sourceFor(await skills.get(ctx, skillId));
				const writing = source;
				if (!writable(writing)) return revision;
				await serialise(skillId, async () => {
					// A later revision exported while this one waited stays; the source never goes back. One published since,
					// here or by another process sharing the store, exports itself.
					if ((newest.get(skillId) ?? 0) >= revision.revision) return;
					if (((await skills.get(ctx, skillId)).latestRevision ?? 0) > revision.revision) return;
					await exportNow(ctx, skillId, revision.revision, writing);
				});
			} catch (error) {
				await failed(ctx, skillId, revision.revision, source?.id, error);
			}
			return revision;
		},

		async exportRevision(ctx, skillId, revision) {
			if (ctx.actor.kind === "agent") throw new KantelError("forbidden", "An agent cannot export skills");
			// Reads first, so a caller who may not see the skill learns nothing about its source.
			const pkg = await skills.get(ctx, skillId);
			const source = options.sourceFor(pkg);
			if (!writable(source)) {
				throw new KantelError("not_supported", `Skill ${skillId} has no source to write to`);
			}
			// A revision that does not exist, or one a newer revision has replaced, is the caller's mistake, not a failed
			// export: re-exporting the latest is the only retry, so the source never goes back.
			await skills.getRevision(ctx, skillId, revision);
			await assertLatest(ctx, skillId, revision);
			let stale: unknown;
			try {
				return await serialise(skillId, async () => {
					try {
						await assertLatest(ctx, skillId, revision);
					} catch (error) {
						stale = error;
						throw error;
					}
					return exportNow(ctx, skillId, revision, source);
				});
			} catch (error) {
				if (error === stale) throw error;
				await failed(ctx, skillId, revision, source.id, error);
				// The source's error may carry a remote's URL or credentials in its message or details: only its code goes
				// back to the caller.
				throw new KantelError(
					isKantelError(error) ? error.code : "unavailable",
					`Revision ${revision} of skill ${skillId} could not be exported to ${source.id}`,
				);
			}
		},
	};
}
