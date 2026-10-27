import {
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type JsonValue,
	type OwnerRef,
	type Page,
	type PageRequest,
	type SessionSkillPin,
	type SkillFile,
	type SkillListing,
	type SkillPackage,
	type SkillRevision,
	type Skills,
	type SkillVisibility,
	systemClock,
} from "@harbour/contracts";
import { normaliseSkillPath, parseSkillFrontmatter, SKILL_MD, skillDigest, validateSkillName } from "./index.ts";

export interface MemorySkillsOptions {
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** Where skills are mounted in the sandbox; a listing's path is `<mountRoot>/<name>/SKILL.md`. Default `/skills`. */
	readonly mountRoot?: string;
}

type Extensions = { readonly [namespace: string]: JsonValue };
type Source = { readonly sourceId: string; readonly ref: string };

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
}

/** Name clashes in a listing go to the most specific owner. */
const OWNER_RANK: { readonly [kind in OwnerRef["kind"]]: number } = {
	platform: 0,
	organisation: 1,
	project: 2,
	user: 3,
};

function ownerKey(owner: OwnerRef): string {
	switch (owner.kind) {
		case "platform":
			return "platform";
		case "organisation":
			return `organisation:${owner.organisationId}`;
		case "project":
			return `project:${owner.organisationId}:${owner.projectId}`;
		case "user":
			return `user:${owner.organisationId}:${owner.userId}`;
	}
}

function copyOwner(owner: OwnerRef): OwnerRef {
	switch (owner.kind) {
		case "platform":
			return { kind: "platform" };
		case "organisation":
			return { kind: "organisation", organisationId: owner.organisationId };
		case "project":
			return { kind: "project", organisationId: owner.organisationId, projectId: owner.projectId };
		case "user":
			return { kind: "user", organisationId: owner.organisationId, userId: owner.userId };
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

/** Platform skills are Harbour's own: only a `system` actor may create or change them. */
function assertMayOwn(ctx: CallContext, owner: OwnerRef): void {
	if (owner.kind === "platform") {
		if (ctx.actor.kind !== "system") throw new HarbourError("forbidden", "Only Harbour may change platform skills");
		return;
	}
	if (owner.organisationId !== ctx.organisationId) {
		throw new HarbourError("invalid", "A skill must be owned within the caller's organisation");
	}
}

function assertDescription(description: string): void {
	if (typeof description !== "string" || description.trim() === "") {
		throw new HarbourError("invalid", "A skill needs a description");
	}
}

/** Normalised, frozen copies of a package's files; `invalid` without `SKILL.md` or with a duplicate path. */
function prepareFiles(files: readonly SkillFile[]): readonly SkillFile[] {
	const seen = new Set<string>();
	const prepared: SkillFile[] = [];
	for (const file of files) {
		if (typeof file.content !== "string") throw new HarbourError("invalid", `${file.path} needs text content`);
		const path = normaliseSkillPath(file.path);
		if (seen.has(path)) throw new HarbourError("invalid", `${path} appears twice`);
		seen.add(path);
		prepared.push(Object.freeze({ path, content: file.content }));
	}
	if (!seen.has(SKILL_MD)) throw new HarbourError("invalid", `A skill package needs ${SKILL_MD} at its root`);
	return Object.freeze(prepared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
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

/**
 * The reference `Skills`: packages, drafts, revisions and pins in maps. A published revision is a frozen copy, with
 * its file contents in a separate frozen map, so nothing after publishing can change it.
 */
export function createMemorySkills(options: MemorySkillsOptions = {}): Skills {
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const mountRoot = (options.mountRoot ?? "/skills").replace(/\/+$/, "");

	const skills = new Map<string, StoredSkill>();
	/** `<ownerKey>\0<name>` to skill ID: names are unique per owner. */
	const byOwnerName = new Map<string, string>();
	/** `<organisationId>\0<sessionId>` to the session's pins. */
	const pins = new Map<string, readonly SessionSkillPin[]>();

	function skillFor(ctx: CallContext, skillId: string): StoredSkill {
		const stored = skills.get(skillId);
		if (stored !== undefined) {
			const owner = stored.pkg.owner;
			if (owner.kind === "platform" || owner.organisationId === ctx.organisationId) return stored;
		}
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
			files: input.files.map((file) => ({ path: file.path, size: new TextEncoder().encode(file.content).length })),
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

	/** Audits a change to a package by its actor. Data holds names, digests and counts, never file contents. */
	async function auditChange(
		ctx: CallContext,
		event: {
			readonly id: string;
			readonly type: string;
			readonly subjectId: string;
			readonly data: { readonly [key: string]: JsonValue };
		},
	): Promise<void> {
		if (audit === undefined) return;
		await audit.append([
			{
				id: event.id,
				at: clock.now(),
				source: "skills",
				type: event.type,
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "skills.skill", id: event.subjectId },
				data: event.data,
			},
		]);
	}

	async function auditPublished(ctx: CallContext, revision: SkillRevision): Promise<void> {
		if (audit === undefined) return;
		await audit.append([
			{
				id: `skills:revision:${revision.skillId}:${revision.revision}`,
				at: revision.publishedAt,
				source: "skills",
				type: "skills.revision.published",
				actor: ctx.actor,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "skills.skill", id: revision.skillId },
				data: {
					name: revision.name,
					revision: revision.revision,
					digest: revision.digest,
					...(revision.source === undefined ? {} : { source: { ...revision.source } }),
				},
			},
		]);
	}

	function visibleListings(ctx: CallContext, visibility: SkillVisibility): SkillListing[] {
		const chosen = new Map<string, StoredSkill>();
		for (const stored of skills.values()) {
			const owner = stored.pkg.owner;
			if (stored.revisions.length === 0) continue;
			const visible =
				owner.kind === "platform" ||
				(owner.organisationId === ctx.organisationId &&
					(owner.kind === "organisation" ||
						(owner.kind === "project" &&
							visibility.projectId !== undefined &&
							owner.projectId === visibility.projectId) ||
						(owner.kind === "user" && visibility.userId !== undefined && owner.userId === visibility.userId)));
			if (!visible) continue;
			const current = chosen.get(stored.pkg.name);
			if (current === undefined || OWNER_RANK[owner.kind] > OWNER_RANK[current.pkg.owner.kind]) {
				chosen.set(stored.pkg.name, stored);
			}
		}
		return [...chosen.values()]
			.map((stored) => {
				const latest = latestOf(stored)!;
				return {
					skillId: stored.pkg.id,
					name: stored.pkg.name,
					description: latest.description,
					revision: latest.revision,
					path: `${mountRoot}/${stored.pkg.name}/${SKILL_MD}`,
				};
			})
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	return {
		async create(ctx, input) {
			forbidAgent(ctx, "create skills");
			assertMayOwn(ctx, input.owner);
			validateSkillName(input.name);
			assertDescription(input.description);
			const pkg = { ...createPackage(input.owner, input.name, input.description).pkg };
			await auditChange(ctx, {
				id: `skills:package:${pkg.id}:created`,
				type: "skills.package.created",
				subjectId: pkg.id,
				data: { name: pkg.name, owner: pkg.owner.kind },
			});
			return pkg;
		},

		async get(ctx, skillId) {
			return { ...skillFor(ctx, skillId).pkg };
		},

		async saveDraft(ctx, skillId, input) {
			const before = skillFor(ctx, skillId);
			assertMayOwn(ctx, before.pkg.owner);
			if (input.description !== undefined) assertDescription(input.description);
			const files = prepareFiles(input.files);
			const digest = await skillDigest(files);
			// Re-read after the await; the latest save wins.
			const stored = skillFor(ctx, skillId);
			const skillMd = files.find((file) => file.path === SKILL_MD)!.content;
			const description = input.description ?? parseSkillFrontmatter(skillMd).description ?? stored.pkg.description;
			stored.draft = { files, digest, description };
			stored.pkg = { ...stored.pkg, draftDigest: digest, updatedAt: clock.now() };
			await auditChange(ctx, {
				id: `skills:draft:${skillId}:${digest}`,
				type: "skills.draft.saved",
				subjectId: skillId,
				data: { name: stored.pkg.name, digest, files: files.length },
			});
			return { digest };
		},

		async readDraft(ctx, skillId) {
			const stored = skillFor(ctx, skillId);
			assertMayOwn(ctx, stored.pkg.owner);
			if (stored.draft === undefined) throw new HarbourError("not_found", `Skill ${skillId} has no open draft`);
			return stored.draft.files;
		},

		async publish(ctx, skillId, input) {
			forbidAgent(ctx, "publish skills");
			const stored = skillFor(ctx, skillId);
			assertMayOwn(ctx, stored.pkg.owner);
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
			await auditPublished(ctx, revision);
			return revision;
		},

		async getRevision(ctx, skillId, revision) {
			return revisionFor(skillFor(ctx, skillId), revision);
		},

		async readFile(ctx, skillId, revision, path) {
			const stored = skillFor(ctx, skillId);
			revisionFor(stored, revision);
			const content = stored.contents.get(revision)?.get(normaliseSkillPath(path));
			if (content === undefined) throw new HarbourError("not_found", `No ${path} in revision ${revision}`);
			return content;
		},

		async listRevisions(ctx, skillId, page) {
			return paginate([...skillFor(ctx, skillId).revisions].reverse(), page);
		},

		async list(ctx, visibility, page) {
			return paginate(visibleListings(ctx, visibility), page);
		},

		async pinForSession(ctx, sessionId, visibility) {
			if (ctx.actor.kind === "agent" && ctx.actor.sessionId !== sessionId) {
				throw new HarbourError("forbidden", "An agent may pin skills only for its own session");
			}
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
			if (audit !== undefined) {
				await audit.append([
					{
						id: `skills:session:${ctx.organisationId}:${sessionId}:pinned`,
						at: pinnedAt,
						source: "skills",
						type: "skills.session.pinned",
						actor: ctx.actor,
						organisationId: ctx.organisationId,
						...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
						sessionId,
						data: { pins: pinned.map((pin) => ({ skillId: pin.skillId, revision: pin.revision })) },
					},
				]);
			}
			return pinned;
		},

		async importRevision(ctx, input) {
			forbidAgent(ctx, "import skills");
			assertMayOwn(ctx, input.owner);
			validateSkillName(input.name);
			assertDescription(input.description);
			if (input.source.sourceId === "" || input.source.ref === "") {
				throw new HarbourError("invalid", "An import needs a source ID and a ref");
			}
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
			await auditPublished(ctx, revision);
			return revision;
		},
	};
}
