// The skills page's logic, apart from React: what it reads from `Skills` (bound to the viewer by the host), how the
// listed skills group by scope, and how a revision's SKILL.md splits into its frontmatter and its body.

import {
	type CallContext,
	isKantelError,
	type OwnerRef,
	type Page,
	type PageRequest,
	type SkillFile,
	type SkillListing,
	type SkillPackage,
	type SkillRevision,
	type Skills,
	type SkillVisibility,
} from "@kantel/contracts";
import { parseSkillFrontmatter, SKILL_MD } from "@kantel/skills";
import { type OwnerNames, type OwnerScope, ownerKey, ownerName } from "../primitives/owner.ts";

/**
 * What the page reads: `Skills`' read calls with the viewer's call context already bound. `bindSkills` makes one from
 * any implementation, the in-memory store or the console's API client.
 */
export interface SkillsSource {
	list(visibility: SkillVisibility, page?: PageRequest): Promise<Page<SkillListing>>;
	get(skillId: string): Promise<SkillPackage>;
	listRevisions(skillId: string, page?: PageRequest): Promise<Page<SkillRevision>>;
	getRevision(skillId: string, revision: number): Promise<SkillRevision>;
	readFile(skillId: string, revision: number, path: string): Promise<string>;
}

export type SkillsApi = Pick<Skills, "list" | "get" | "listRevisions" | "getRevision" | "readFile">;

/** The page's source over `Skills`, as the viewer `ctx`. */
export function bindSkills(skills: SkillsApi, ctx: CallContext): SkillsSource {
	return {
		list: (visibility, page) => skills.list(ctx, visibility, page),
		get: (id) => skills.get(ctx, id),
		listRevisions: (id, page) => skills.listRevisions(ctx, id, page),
		getRevision: (id, revision) => skills.getRevision(ctx, id, revision),
		readFile: (id, revision, path) => skills.readFile(ctx, id, revision, path),
	};
}

/**
 * What the page writes, for a viewer who may author skills: `Skills`' create, draft and publish calls with the viewer's
 * call context bound. Agents may save drafts but not create or publish, so a host binds this only for people.
 */
export interface SkillsAuthor {
	create(input: {
		readonly owner: OwnerRef;
		readonly name: string;
		readonly description: string;
	}): Promise<SkillPackage>;
	saveDraft(
		skillId: string,
		input: { readonly files: readonly SkillFile[]; readonly description?: string },
	): Promise<{ readonly digest: string }>;
	readDraft(skillId: string): Promise<readonly SkillFile[]>;
	publish(skillId: string, input: { readonly expectedDigest: string }): Promise<SkillRevision>;
}

export type SkillsAuthorApi = Pick<Skills, "create" | "saveDraft" | "readDraft" | "publish">;

/** The page's authoring calls over `Skills`, as the viewer `ctx`. */
export function bindSkillsAuthor(skills: SkillsAuthorApi, ctx: CallContext): SkillsAuthor {
	return {
		create: (input) => skills.create(ctx, input),
		saveDraft: (id, input) => skills.saveDraft(ctx, id, input),
		readDraft: (id) => skills.readDraft(ctx, id),
		publish: (id, input) => skills.publish(ctx, id, input),
	};
}

/** An owner a new skill may go under, as the host offers them: "Yours", "Billing project", "Organisation". */
export interface OwnerChoice {
	readonly label: string;
	readonly owner: OwnerRef;
}

/** A new skill's SKILL.md: the frontmatter Agent Skills need, then a heading to write under. */
export function skillTemplate(name: string, description: string): string {
	const title = name === "" ? "New skill" : name.replace(/-/g, " ").replace(/^./, (first) => first.toUpperCase());
	return `---\nname: ${name}\ndescription: ${yamlValue(description)}\n---\n\n# ${title}\n\n`;
}

/** A one-line YAML value, quoted when plain would misread it. */
const yamlValue = (value: string) =>
	value === "" || /^[\s\w.,;()'/-][^:#]*$/.test(value) ? value : JSON.stringify(value);

const SKILL_NAME = /^[a-z0-9-]{1,64}$/;

/** What is wrong with a draft before it is sent, by field; empty when nothing is. The store checks again. */
export function draftProblems(input: {
	readonly name: string;
	readonly description: string;
	readonly skillMd: string;
}): { name?: string; description?: string; skillMd?: string } {
	const problems: { name?: string; description?: string; skillMd?: string } = {};
	if (!SKILL_NAME.test(input.name)) problems.name = "Use 1 to 64 lowercase letters, digits or dashes.";
	if (input.description.trim() === "") problems.description = "Say what it does and when to use it.";
	const front = parseSkillFrontmatter(input.skillMd);
	if (input.skillMd.trim() === "") problems.skillMd = "SKILL.md can't be empty.";
	else if (front.name === undefined) problems.skillMd = "Start SKILL.md with frontmatter that names the skill.";
	else if (front.name !== input.name) problems.skillMd = `The frontmatter names it ${front.name}, not ${input.name}.`;
	return problems;
}

/** The draft's files: SKILL.md as written, with the revision's other files unchanged. */
export function draftFiles(skillMd: string, others: readonly SkillFile[]): SkillFile[] {
	return [{ path: SKILL_MD, content: skillMd }, ...others.filter((file) => file.path !== SKILL_MD)];
}

/** What went wrong with a write, in a sentence, from the store's error. */
export function authoringError(error: unknown, action: "create" | "save" | "publish"): string {
	if (isKantelError(error, "conflict")) {
		return action === "create"
			? "That owner already has a skill with this name. Pick another name, or edit that skill."
			: "Someone changed the draft since you opened it. Open the skill again to see their change.";
	}
	if (isKantelError(error, "forbidden")) return "You can't change skills for this owner.";
	if (isKantelError(error, "invalid")) return `Kantel refused it: ${(error as Error).message}.`;
	return action === "publish"
		? "Couldn't publish it. The draft is saved; try again."
		: "Couldn't save it. Nothing was written; try again.";
}

/** A listed skill with its package, which says who owns it: `SkillListing` alone doesn't. */
export interface ListedSkill {
	readonly listing: SkillListing;
	readonly pkg: SkillPackage;
}

/**
 * The skills a session in `visibility` sees, each with its package. `Skills.list` names no owner, so the page reads
 * each package too; a listing whose package can't be read is left out rather than failing the page.
 */
export async function loadListedSkills(source: SkillsSource, visibility: SkillVisibility): Promise<ListedSkill[]> {
	const listings: SkillListing[] = [];
	let cursor: string | undefined;
	for (let index = 0; index < 20; index += 1) {
		const page = await source.list(visibility, cursor === undefined ? { limit: 100 } : { limit: 100, cursor });
		listings.push(...page.items);
		if (page.nextCursor === undefined) break;
		cursor = page.nextCursor;
	}
	const packages = await Promise.allSettled(listings.map((listing) => source.get(listing.skillId)));
	return listings.flatMap((listing, index) => {
		const result = packages[index]!;
		return result.status === "fulfilled" ? [{ listing, pkg: result.value }] : [];
	});
}

/** Narrowest first: what a person or project set for themselves before what everyone sees. */
const SCOPE_ORDER: Readonly<Record<OwnerScope, number>> = { user: 0, project: 1, organisation: 2, platform: 3 };

export interface SkillGroup {
	readonly key: string;
	readonly label: string;
	readonly scope: OwnerScope;
	readonly skills: readonly ListedSkill[];
}

/** "Yours" for the viewer's own skills; otherwise the owner's name. */
export function scopeLabel(owner: OwnerRef, names: OwnerNames, viewerId?: string): string {
	if (owner.kind === "user" && owner.userId === viewerId) return "Yours";
	if (owner.kind === "platform") return "Built in";
	return ownerName(owner, names);
}

/** The skills grouped by owner, narrowest scope first, each group by name. */
export function groupSkills(skills: readonly ListedSkill[], names: OwnerNames = {}, viewerId?: string): SkillGroup[] {
	const groups = new Map<string, { label: string; scope: OwnerScope; skills: ListedSkill[] }>();
	for (const skill of skills) {
		const key = ownerKey(skill.pkg.owner);
		let group = groups.get(key);
		if (group === undefined) {
			group = { label: scopeLabel(skill.pkg.owner, names, viewerId), scope: skill.pkg.owner.kind, skills: [] };
			groups.set(key, group);
		}
		group.skills.push(skill);
	}
	return [...groups.entries()]
		.map(([key, group]) => ({
			key,
			...group,
			skills: group.skills.sort((left, right) => left.listing.name.localeCompare(right.listing.name)),
		}))
		.sort((left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope] || left.label.localeCompare(right.label));
}

/** Skills whose name or description holds every word of `query`, case-insensitively. */
export function filterSkills(skills: readonly ListedSkill[], query: string): ListedSkill[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...skills];
	return skills.filter((skill) => {
		const text = `${skill.listing.name} ${skill.listing.description}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

export interface SkillMarkdown {
	/** The frontmatter's fields, in order, as written. */
	readonly fields: readonly { readonly key: string; readonly value: string }[];
	/** The Markdown after the frontmatter. */
	readonly body: string;
}

/**
 * Splits a SKILL.md into its YAML frontmatter (simple `key: value` lines, as Agent Skills write them) and its body,
 * so the page shows the name and description as fields and renders the rest as a note. No frontmatter: all body.
 */
export function splitSkillMarkdown(text: string): SkillMarkdown {
	const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (match === null) return { fields: [], body: text };
	const fields: { key: string; value: string }[] = [];
	for (const line of match[1]!.split(/\r?\n/)) {
		const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (field !== null) {
			fields.push({ key: field[1]!, value: unquote(field[2]!.trim()) });
		} else if (fields.length > 0 && /^\s+\S/.test(line)) {
			// A folded continuation line belongs to the field above it.
			const last = fields.at(-1)!;
			fields[fields.length - 1] = { key: last.key, value: `${last.value} ${line.trim()}`.trim() };
		}
	}
	return { fields, body: text.slice(match[0].length).replace(/^\s*\n/, "") };
}

const unquote = (value: string) =>
	(value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
		? value.slice(1, -1)
		: value === ">" || value === "|" || value === ">-" || value === "|-"
			? ""
			: value;

/** The first 12 hex digits of a digest, as the page shows it. */
export function shortDigest(digest: string): string {
	return digest.slice(0, 12);
}

/** SKILL.md first, then the rest by path. */
export function sortFiles<T extends { readonly path: string }>(files: readonly T[]): T[] {
	return [...files].sort((left, right) =>
		left.path === "SKILL.md" ? -1 : right.path === "SKILL.md" ? 1 : left.path.localeCompare(right.path),
	);
}

/** The namespaces a revision carries host data under, such as `lleverage`. */
export function extensionNames(revision: SkillRevision): string[] {
	return Object.keys(revision.extensions ?? {}).sort();
}

/** "team-skills at 4f2c1e9": where an imported skill came from. */
export function sourceText(
	source: { readonly sourceId: string; readonly ref: string } | undefined,
): string | undefined {
	if (source === undefined) return undefined;
	const ref = /^[0-9a-f]{40}$/.test(source.ref) ? source.ref.slice(0, 7) : source.ref;
	return `${source.sourceId} at ${ref}`;
}
