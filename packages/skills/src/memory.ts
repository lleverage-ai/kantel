import {
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type OwnerRef,
	type ProjectAccess,
	type SessionSkillPin,
	type SkillFile,
	type SkillListing,
	type SkillPackage,
	type SkillRevision,
	type Skills,
	type SkillsAuthority,
	type SkillVisibility,
	systemClock,
} from "@harbour/contracts";
import { normaliseSkillPath, parseSkillFrontmatter, SKILL_MD, skillDigest, validateSkillName } from "./index.ts";
import {
	assertDescription,
	assertMayOwn,
	authorityOf,
	checkImport,
	checkList,
	checkPin,
	chooseByName,
	copyOwner,
	deepFreeze,
	type Extensions,
	forbidAgent,
	ownerKey,
	ownerVisibleTo,
	paginate,
	prepareFiles,
	requireOwner,
	requireWrite,
	type Source,
	skillsAudit,
	utf8Size,
	visibleOwner,
} from "./rules.ts";

export interface MemorySkillsOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/**
	 * Project access (settled question 7): project-owned skills need `viewer` to read and the `authority`'s role to
	 * change, organisation- and user-owned skills that role across the organisation, a `list` naming a project needs
	 * `viewer` on it, `pinForSession` needs `operator` on the session's project, and a visibility may name only the
	 * calling human's own user. Without it the store checks only the organisation; every target and every conformance
	 * run passes one.
	 */
	readonly access?: ProjectAccess;
	/**
	 * The role each change needs (`SkillsAuthority`), checked through `access` for every owner but the platform: on the
	 * project for a project's skill, across the organisation otherwise, and none for a human changing their own user's
	 * skill. Default `DEFAULT_SKILLS_AUTHORITY` (`operator` for all); one missing a role is `invalid`.
	 */
	readonly authority?: SkillsAuthority;
	/** Where skills are mounted in the sandbox; a listing's path is `<mountRoot>/<name>/SKILL.md`. Default `/skills`. */
	readonly mountRoot?: string;
}

interface Draft {
	readonly files: readonly SkillFile[];
	readonly digest: string;
	readonly description: string;
}

interface StoredSkill {
	pkg: SkillPackage;
	draft?: Draft;
	/** Oldest first; each one frozen. */
	readonly revisions: SkillRevision[];
	/** File contents per revision, by path. */
	readonly contents: Map<number, ReadonlyMap<string, string>>;
	/** Drafts saved so far, numbering `skills.draft.saved` so a repeated digest is still audited. */
	draftSaves: number;
}

/**
 * The reference `Skills`: packages, drafts, revisions and pins in maps. A published revision is a frozen copy, with
 * its file contents in a separate frozen map, so nothing after publishing can change it.
 */
export function createMemorySkills(options: MemorySkillsOptions = {}): Skills {
	const clock = options.clock ?? systemClock;
	const access = options.access;
	const authority = authorityOf(options.authority);
	const audits = skillsAudit(options.audit, clock);
	const mountRoot = (options.mountRoot ?? "/skills").replace(/\/+$/, "");

	const skills = new Map<string, StoredSkill>();
	/** `<ownerKey>\0<name>` to skill ID: names are unique per owner. */
	const byOwnerName = new Map<string, string>();
	/** `<organisationId>\0<sessionId>` to the session's pins. */
	const pins = new Map<string, readonly SessionSkillPin[]>();

	function skillFor(ctx: CallContext, skillId: string): StoredSkill {
		const stored = skills.get(skillId);
		if (stored !== undefined && ownerVisibleTo(ctx, stored.pkg.owner)) return stored;
		throw new HarbourError("not_found", `No skill ${skillId}`);
	}

	function revisionFor(stored: StoredSkill, revision: number): SkillRevision {
		const found = stored.revisions[revision - 1];
		if (found === undefined || found.revision !== revision) {
			throw new HarbourError("not_found", `No revision ${revision} of skill ${stored.pkg.id}`);
		}
		return found;
	}

	function latestOf(stored: StoredSkill): SkillRevision | undefined {
		return stored.revisions[stored.revisions.length - 1];
	}

	function createPackage(owner: OwnerRef, name: string, description: string): StoredSkill {
		const key = `${ownerKey(owner)}\0${name}`;
		if (byOwnerName.has(key)) throw new HarbourError("conflict", `The owner already has a skill named ${name}`);
		const now = clock.now();
		const stored: StoredSkill = {
			pkg: {
				id: `skill_${crypto.randomUUID()}`,
				owner: copyOwner(owner),
				name,
				description,
				createdAt: now,
				updatedAt: now,
			},
			revisions: [],
			contents: new Map(),
			draftSaves: 0,
		};
		skills.set(stored.pkg.id, stored);
		byOwnerName.set(key, stored.pkg.id);
		return stored;
	}

	/** Records the next revision and updates the package; no awaits, so concurrent calls cannot interleave. */
	function recordRevision(
		ctx: CallContext,
		stored: StoredSkill,
		input: {
			readonly files: readonly SkillFile[];
			readonly digest: string;
			readonly description: string;
			readonly extensions?: Extensions;
			readonly source?: Source;
		},
	): SkillRevision {
		const now = clock.now();
		const revision: SkillRevision = deepFreeze({
			skillId: stored.pkg.id,
			revision: stored.revisions.length + 1,
			digest: input.digest,
			name: stored.pkg.name,
			description: input.description,
			files: input.files.map((file) => ({ path: file.path, size: utf8Size(file.content) })),
			...(input.extensions === undefined ? {} : { extensions: structuredClone(input.extensions) }),
			publishedBy: structuredClone(ctx.actor),
			publishedAt: now,
			...(input.source === undefined ? {} : { source: { sourceId: input.source.sourceId, ref: input.source.ref } }),
		});
		stored.revisions.push(revision);
		stored.contents.set(revision.revision, new Map(input.files.map((file) => [file.path, file.content])));
		// An open draft survives an import, so `get` and `readDraft` agree; only publishing it closes it.
		const { draftDigest: _draftDigest, ...withoutDraft } = stored.pkg;
		const pkg = stored.draft === undefined ? withoutDraft : stored.pkg;
		stored.pkg = {
			...pkg,
			description: input.description,
			latestRevision: revision.revision,
			...(revision.source === undefined ? {} : { source: revision.source }),
			updatedAt: now,
		};
		return revision;
	}

	function visibleListings(ctx: CallContext, visibility: SkillVisibility): SkillListing[] {
		const candidates = [...skills.values()]
			.filter((stored) => stored.revisions.length > 0 && visibleOwner(ctx, visibility, stored.pkg.owner))
			.map((stored) => ({ owner: stored.pkg.owner, name: stored.pkg.name, stored }));
		return chooseByName(candidates).map(({ stored }) => {
			const latest = latestOf(stored)!;
			return {
				skillId: stored.pkg.id,
				name: stored.pkg.name,
				description: latest.description,
				revision: latest.revision,
				path: `${mountRoot}/${stored.pkg.name}/${SKILL_MD}`,
			};
		});
	}

	return {
		async create(ctx, input) {
			forbidAgent(ctx, "create skills");
			assertMayOwn(ctx, input.owner);
			await requireWrite(access, ctx, input.owner, authority.create, "skills.create");
			validateSkillName(input.name);
			assertDescription(input.description);
			const pkg = { ...createPackage(input.owner, input.name, input.description).pkg };
			await audits.created(ctx, pkg);
			return pkg;
		},

		async get(ctx, skillId) {
			const stored = skillFor(ctx, skillId);
			await requireOwner(access, ctx, stored.pkg.owner, "viewer", "skills.get", skillId);
			return { ...stored.pkg };
		},

		async saveDraft(ctx, skillId, input) {
			const before = skillFor(ctx, skillId);
			assertMayOwn(ctx, before.pkg.owner);
			await requireWrite(access, ctx, before.pkg.owner, authority.saveDraft, "skills.saveDraft", skillId);
			if (input.description !== undefined) assertDescription(input.description);
			const files = prepareFiles(input.files);
			const digest = await skillDigest(files);
			// Re-read after the await; the latest save wins.
			const stored = skillFor(ctx, skillId);
			const skillMd = files.find((file) => file.path === SKILL_MD)!.content;
			const description = input.description ?? parseSkillFrontmatter(skillMd).description ?? stored.pkg.description;
			stored.draft = { files, digest, description };
			stored.pkg = { ...stored.pkg, draftDigest: digest, updatedAt: clock.now() };
			stored.draftSaves += 1;
			await audits.draftSaved(ctx, { skillId, name: stored.pkg.name, digest, files: files.length }, stored.draftSaves);
			return { digest };
		},

		async readDraft(ctx, skillId) {
			const stored = skillFor(ctx, skillId);
			assertMayOwn(ctx, stored.pkg.owner);
			await requireOwner(access, ctx, stored.pkg.owner, "viewer", "skills.readDraft", skillId);
			if (stored.draft === undefined) throw new HarbourError("not_found", `Skill ${skillId} has no open draft`);
			return stored.draft.files;
		},

		async publish(ctx, skillId, input) {
			forbidAgent(ctx, "publish skills");
			const before = skillFor(ctx, skillId);
			assertMayOwn(ctx, before.pkg.owner);
			await requireWrite(access, ctx, before.pkg.owner, authority.publish, "skills.publish", skillId);
			// Re-read after the await; everything below changes the package without another await until the audit.
			const stored = skillFor(ctx, skillId);
			const latest = latestOf(stored);
			const draft = stored.draft;
			if (draft === undefined) {
				// A retried publish finds its draft already published.
				if (latest !== undefined && latest.digest === input.expectedDigest) return latest;
				throw new HarbourError("conflict", `Skill ${skillId} has no open draft to publish`);
			}
			if (draft.digest !== input.expectedDigest) {
				throw new HarbourError("conflict", "The draft changed since it was reviewed", { digest: draft.digest });
			}
			if (latest !== undefined && latest.digest === draft.digest) {
				delete stored.draft;
				const { draftDigest: _draftDigest, ...pkg } = stored.pkg;
				stored.pkg = { ...pkg, updatedAt: clock.now() };
				return latest;
			}
			delete stored.draft;
			const revision = recordRevision(ctx, stored, {
				files: draft.files,
				digest: draft.digest,
				description: draft.description,
				...(input.extensions === undefined ? {} : { extensions: input.extensions }),
			});
			await audits.published(ctx, revision);
			return revision;
		},

		async getRevision(ctx, skillId, revision) {
			const stored = skillFor(ctx, skillId);
			await requireOwner(access, ctx, stored.pkg.owner, "viewer", "skills.getRevision", skillId);
			return revisionFor(stored, revision);
		},

		async readFile(ctx, skillId, revision, path) {
			const stored = skillFor(ctx, skillId);
			await requireOwner(access, ctx, stored.pkg.owner, "viewer", "skills.readFile", skillId);
			revisionFor(stored, revision);
			const content = stored.contents.get(revision)?.get(normaliseSkillPath(path));
			if (content === undefined) throw new HarbourError("not_found", `No ${path} in revision ${revision}`);
			return content;
		},

		async listRevisions(ctx, skillId, page) {
			const stored = skillFor(ctx, skillId);
			await requireOwner(access, ctx, stored.pkg.owner, "viewer", "skills.listRevisions", skillId);
			return paginate([...stored.revisions].reverse(), page);
		},

		async list(ctx, visibility, page) {
			await checkList(access, ctx, visibility);
			return paginate(visibleListings(ctx, visibility), page);
		},

		async pinForSession(ctx, sessionId, visibility) {
			await checkPin(access, ctx, sessionId, visibility);
			const key = `${ctx.organisationId}\0${sessionId}`;
			const existing = pins.get(key);
			if (existing !== undefined) return existing;
			const pinnedAt = clock.now();
			const pinned: readonly SessionSkillPin[] = deepFreeze(
				visibleListings(ctx, visibility).map((listing) => ({
					sessionId,
					skillId: listing.skillId,
					revision: listing.revision,
					pinnedAt,
				})),
			);
			pins.set(key, pinned);
			await audits.pinned(ctx, sessionId, pinned, pinnedAt);
			return pinned;
		},

		async importRevision(ctx, input) {
			await checkImport(access, authority, ctx, input, validateSkillName);
			const files = prepareFiles(input.files);
			const digest = await skillDigest(files);
			// Everything below is synchronous, so a concurrent import of the same ref finds this one's revision.
			const existingId = byOwnerName.get(`${ownerKey(input.owner)}\0${input.name}`);
			const stored =
				existingId === undefined ? createPackage(input.owner, input.name, input.description) : skills.get(existingId)!;
			const imported = stored.revisions.find(
				(revision) => revision.source?.sourceId === input.source.sourceId && revision.source.ref === input.source.ref,
			);
			if (imported !== undefined) return imported;
			const revision = recordRevision(ctx, stored, {
				files,
				digest,
				description: input.description,
				source: input.source,
				...(input.extensions === undefined ? {} : { extensions: input.extensions }),
			});
			await audits.published(ctx, revision);
			return revision;
		},
	};
}
