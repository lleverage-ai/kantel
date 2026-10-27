/**
 * The host side of skills, portable: publishing what a `SkillSource` offers at a ref, the listing a session is shown
 * from its pinned revisions, and that listing as a prompt block. No storage and no Node APIs; a host brings its source
 * (a Git checkout, an API) as a `SkillSource`.
 */
import type {
	CallContext,
	JsonValue,
	OwnerRef,
	SessionId,
	SessionSkillPin,
	SkillListing,
	SkillRevision,
	SkillSource,
	Skills,
	SkillVisibility,
} from "@harbour/contracts";
import { isHarbourError } from "@harbour/contracts";
import { SKILL_MD } from "./index.ts";

export interface SyncSkillSourceInput {
	readonly source: SkillSource;
	/** The source's ref to publish, such as a commit. Every skill is published with `{ sourceId, ref }`. */
	readonly ref: string;
	readonly owner: OwnerRef;
	/** Namespaced data for every revision, such as where in the source each came from. */
	readonly extensions?: (skill: { readonly name: string }) => { readonly [namespace: string]: JsonValue } | undefined;
}

export interface SyncSkillSourceResult {
	readonly revisions: readonly SkillRevision[];
	/** Skills the store refused (an invalid name or path, say), with why. Nothing is skipped silently. */
	readonly refused: readonly { readonly name: string; readonly reason: string }[];
}

export interface SyncSkillSourcesInput {
	/** In priority order: on a name offered by more than one, the first source's skill is published. */
	readonly sources: readonly { readonly source: SkillSource; readonly ref: string }[];
	readonly owner: OwnerRef;
	/** Names never published, such as the skills a host's role leaves out. */
	readonly exclude?: readonly string[];
	readonly extensions?: (skill: {
		readonly name: string;
		readonly sourceId: string;
	}) => { readonly [namespace: string]: JsonValue } | undefined;
}

export interface SyncSkillSourcesResult extends SyncSkillSourceResult {
	/** Skills not published because an earlier source offers the name, with the source that won. */
	readonly shadowed: readonly { readonly name: string; readonly sourceId: string; readonly by: string }[];
	readonly excluded: readonly { readonly name: string; readonly sourceId: string }[];
}

/**
 * Publishes several sources as one set, as a host that layers skill directories does (Pi takes the first skill of a
 * name it finds). Every skill is published with its own source and ref, so each revision says where it came from.
 */
export async function syncSkillSources(
	skills: Skills,
	ctx: CallContext,
	input: SyncSkillSourcesInput,
): Promise<SyncSkillSourcesResult> {
	const exclude = new Set(input.exclude ?? []);
	const winners = new Map<string, string>();
	const revisions: SkillRevision[] = [];
	const refused: { name: string; reason: string }[] = [];
	const shadowed: { name: string; sourceId: string; by: string }[] = [];
	const excluded: { name: string; sourceId: string }[] = [];
	for (const { source, ref } of input.sources) {
		const offered = await source.fetch(ref);
		for (const skill of offered) {
			if (exclude.has(skill.name)) {
				excluded.push({ name: skill.name, sourceId: source.id });
				continue;
			}
			const by = winners.get(skill.name);
			if (by !== undefined) {
				shadowed.push({ name: skill.name, sourceId: source.id, by });
				continue;
			}
			winners.set(skill.name, source.id);
			const extensions = input.extensions?.({ name: skill.name, sourceId: source.id });
			try {
				revisions.push(
					await skills.importRevision(ctx, {
						owner: input.owner,
						name: skill.name,
						description: skill.description,
						files: skill.files,
						source: { sourceId: source.id, ref },
						...(extensions === undefined ? {} : { extensions }),
					}),
				);
			} catch (error) {
				if (!isHarbourError(error, "invalid") && !isHarbourError(error, "conflict")) throw error;
				refused.push({ name: skill.name, reason: error.message });
			}
		}
	}
	return { revisions, refused, shadowed, excluded };
}

/**
 * Publishes every skill `source` offers at `ref` through `Skills.importRevision`, which is idempotent by source and
 * ref, so syncing the same ref again publishes nothing new. A new ref publishes a new revision of every skill, changed
 * or not; the digest shows which changed.
 */
export async function syncSkillSource(
	skills: Skills,
	ctx: CallContext,
	input: SyncSkillSourceInput,
): Promise<SyncSkillSourceResult> {
	const { revisions, refused } = await syncSkillSources(skills, ctx, {
		sources: [{ source: input.source, ref: input.ref }],
		owner: input.owner,
		...(input.extensions === undefined ? {} : { extensions: input.extensions }),
	});
	return { revisions, refused };
}

/**
 * What a session is shown: its pinned revisions (pinning them now if this is the first call), by name. Recording the
 * pins is the store's: later calls return the same revisions, whatever was published since.
 */
export async function sessionSkillListings(
	skills: Skills,
	ctx: CallContext,
	sessionId: SessionId,
	visibility: SkillVisibility,
	mountRoot = "/skills",
): Promise<{
	readonly pins: readonly SessionSkillPin[];
	readonly listings: readonly SkillListing[];
	/** The pinned revisions, in listing order, for what a host keeps in their extensions. */
	readonly revisions: readonly SkillRevision[];
}> {
	const pins = await skills.pinForSession(ctx, sessionId, visibility);
	const listings: SkillListing[] = [];
	const revisions = new Map<string, SkillRevision>();
	for (const pin of pins) {
		const revision = await skills.getRevision(ctx, pin.skillId, pin.revision);
		revisions.set(pin.skillId, revision);
		listings.push({
			skillId: pin.skillId,
			name: revision.name,
			description: revision.description,
			revision: pin.revision,
			path: `${mountRoot}/${revision.name}/${SKILL_MD}`,
		});
	}
	listings.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { pins, listings, revisions: listings.map((listing) => revisions.get(listing.skillId)!) };
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * The listing as Pi shows skills in a system prompt: an `<available_skills>` block of name, description and location,
 * after a short note on reading them. Empty when there are none.
 */
export function renderSkillListings(listings: readonly SkillListing[]): string {
	if (listings.length === 0) return "";
	return [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
		...listings.flatMap((listing) => [
			"  <skill>",
			`    <name>${escapeXml(listing.name)}</name>`,
			`    <description>${escapeXml(listing.description)}</description>`,
			`    <location>${escapeXml(listing.path)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}
