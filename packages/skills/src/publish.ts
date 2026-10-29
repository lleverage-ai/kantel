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
	HarbourError,
	isHarbourError,
	type SkillFile,
	type SkillPackage,
	type SkillRevision,
	type SkillSource,
	type Skills,
	systemClock,
	systemContext,
} from "@harbour/contracts";

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
	 * Exports a published revision to its package's source now, after any export of the skill already running, and
	 * returns where it landed: to retry one that failed. `not_supported` when the package has no source or its source
	 * cannot be written to. Agents may not export (`forbidden`); the caller must be able to read the skill.
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
		if (typeof ref !== "string" || ref === "") throw new HarbourError("unavailable", `${source.id} returned no ref`);
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

	async function failed(
		ctx: CallContext,
		skillId: string,
		revision: number,
		source: SkillSource,
		error: unknown,
	): Promise<void> {
		// The error's message may hold a remote's URL or a host's details: only its code is recorded.
		await options.audit?.append(AUDIT_CONTEXT, [
			{
				id: `skills:revision:${skillId}:${revision}:export_failed:${crypto.randomUUID()}`,
				at: clock.now(),
				source: "skills",
				type: "skills.revision.export_failed",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "skills.skill", id: skillId },
				data: { sourceId: source.id, revision, error: isHarbourError(error) ? error.code : "error" },
			},
		]);
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
			const source = options.sourceFor(await skills.get(ctx, skillId));
			if (!writable(source)) return revision;
			try {
				await serialise(skillId, async () => {
					// A later revision exported while this one waited stays; the source never goes back.
					if ((newest.get(skillId) ?? 0) >= revision.revision) return;
					await exportNow(ctx, skillId, revision.revision, source);
				});
			} catch (error) {
				await failed(ctx, skillId, revision.revision, source, error);
			}
			return revision;
		},

		async exportRevision(ctx, skillId, revision) {
			if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "An agent cannot export skills");
			// Reads first, so a caller who may not see the skill learns nothing about its source.
			const pkg = await skills.get(ctx, skillId);
			const source = options.sourceFor(pkg);
			if (!writable(source)) {
				throw new HarbourError("not_supported", `Skill ${skillId} has no source to write to`);
			}
			// A revision that does not exist is the caller's mistake, not a failed export.
			await skills.getRevision(ctx, skillId, revision);
			try {
				return await serialise(skillId, () => exportNow(ctx, skillId, revision, source));
			} catch (error) {
				await failed(ctx, skillId, revision, source, error);
				throw isHarbourError(error)
					? error
					: new HarbourError("unavailable", `Revision ${revision} of skill ${skillId} could not be exported`);
			}
		},
	};
}
