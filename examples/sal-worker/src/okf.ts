/**
 * Sal's memory bundle (OKF v0.2 concept files, tvdavies/sal-memory) as a Kantel memory snapshot. Each concept file
 * `knowledge/<id>.md` is YAML frontmatter and a Markdown body; this reads the fields Sal's `summarise`
 * (tvdavies/sal `src/context/memory.ts`) reads, the same way:
 *
 * - `status: deprecated`, `sal.superseded_by` and `sal.forgotten` make a concept inactive; `draft` and `stable` are
 *   both active.
 * - `sal.applies_to` makes a job exception (Kantel scope `job`), with `sal.overrides` naming the general concept;
 *   `projects/<project>/…` is project scope; everything else (`personal/…`, `projects/<one>`) is global.
 * - Concepts tagged `profile` form the owner profile, recalled every turn.
 * - `sal.learned_from` other than the owner is `learned`.
 *
 * The body is the statement, whole: recall and search index it as Sal does. What Kantel has no field for (Sal's
 * scope name, learned_from, the `generated.at` text, deprecation, all source records) goes in the `sal` extension so
 * the Sal renderer can print it as Sal does.
 */
import { createHash } from "node:crypto";
import type { Concept, JsonValue, MemorySnapshot, SnapshotConcept } from "@kantel/contracts";
import { parse } from "yaml";

/** Sal's concept IDs: two to four segments; `index` and `log` are the bundle's own files. */
const CONCEPT_ID = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){1,3}$/;
const RESERVED = new Set(["index", "log"]);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** Sal keeps the first ten sources of a concept. */
const MAX_SOURCES = 10;
export const PROFILE_TAG = "profile";

export interface OkfFile {
	/** Relative to the bundle directory (`knowledge/`), `/`-separated, such as `personal/timezone.md`. */
	readonly path: string;
	readonly text: string;
}

/** What Sal knows of a concept that Kantel has no field for. */
export interface SalConceptExtension {
	readonly type: string;
	/** Sal's scope: `personal`, `project` or `exception`. */
	readonly scope: "personal" | "project" | "exception";
	readonly learnedFrom: "owner" | "task" | "observation" | "session";
	/** `generated.at` as written, for the `updated` attribute. */
	readonly updated: string | null;
	readonly status: "draft" | "stable" | "deprecated";
	readonly appliesTo: string | null;
	readonly sources: readonly string[];
	/** SHA-256 of the whole concept file, as Sal's manifests record it. */
	readonly sha256: string;
	readonly bytes: number;
}

export interface OkfSnapshot {
	readonly snapshot: MemorySnapshot;
	/** Concept IDs tagged `profile`, for `RecallRequest.profile`. */
	readonly profile: readonly string[];
	/** Every project a concept is scoped to: a Sal worker's recall takes all of them, as Sal's does. */
	readonly projects: readonly string[];
	/**
	 * Files left out, with why: ones Sal would not read as concepts, and the few Sal reads that Kantel's snapshot cannot
	 * hold (an empty title or body, an `overrides` or `superseded_by` that is not a concept ID). Nothing is dropped
	 * silently.
	 */
	readonly refused: readonly { readonly path: string; readonly reason: string }[];
	/**
	 * Concepts imported whose recall may not match Sal's: a `generated.at` that is not in the form YAML gives a date
	 * (`2026-10-12T09:35:38.357Z`). Sal orders the profile by that text and Kantel by the time it names; the two agree
	 * only when every timestamp has that form.
	 */
	readonly warnings: readonly { readonly path: string; readonly reason: string }[];
}

/** The text of a timestamp in the one form whose text order is its time order. */
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** In the form Sal writes and YAML dates give, and a real time: then its text and its time sort alike. */
function canonicalTime(value: string): boolean {
	if (!CANONICAL_TIME.test(value)) return false;
	const at = Date.parse(value);
	return Number.isFinite(at) && new Date(at).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dateString(value: unknown): string | null {
	if (value instanceof Date) return value.toISOString();
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function time(value: string | null): number | undefined {
	const at = value === null ? Number.NaN : Date.parse(value);
	return Number.isFinite(at) ? at : undefined;
}

/** The concept ID a bundle path holds, or null when Sal would not read it as one. */
export function conceptIdOf(path: string): string | null {
	if (!path.endsWith(".md")) return null;
	const id = path.slice(0, -3);
	return CONCEPT_ID.test(id) && !RESERVED.has(id.split("/").at(-1) ?? "") ? id : null;
}

/** One concept file as a snapshot concept. Throws with the reason when Sal would not read it. */
export function okfConcept(id: string, text: string): { readonly concept: SnapshotConcept; readonly profile: boolean } {
	const match = FRONTMATTER.exec(text);
	if (match === null) throw new Error("concept has no YAML frontmatter block");
	const frontmatter: unknown = parse(match[1] ?? "");
	if (!isRecord(frontmatter)) throw new Error("concept frontmatter must be a mapping");
	if (typeof frontmatter.type !== "string" || frontmatter.type.trim() === "") {
		throw new Error("concept frontmatter must have a non-empty type");
	}
	const body = text.slice(match[0].length);
	const status = frontmatter.status === "draft" || frontmatter.status === "deprecated" ? frontmatter.status : "stable";
	const sal = isRecord(frontmatter.sal) ? frontmatter.sal : {};
	const appliesTo = typeof sal.applies_to === "string" ? sal.applies_to : null;
	const overrides = typeof sal.overrides === "string" ? sal.overrides : null;
	const supersededBy = typeof sal.superseded_by === "string" ? sal.superseded_by : null;
	if (appliesTo !== null && appliesTo.trim() === "") {
		throw new Error("Kantel needs sal.applies_to to name a job, and this concept's is empty (Sal would read it)");
	}
	for (const [field, value] of [
		["sal.overrides", appliesTo === null ? null : overrides],
		["sal.superseded_by", supersededBy],
	] as const) {
		if (value !== null && (!CONCEPT_ID.test(value) || value === id)) {
			throw new Error(
				`Kantel needs ${field} to name another concept, not ${JSON.stringify(value)} (Sal would read it)`,
			);
		}
	}
	const forgotten = isRecord(sal.forgotten);
	const generated = isRecord(frontmatter.generated) ? frontmatter.generated : {};
	const updated = dateString(generated.at);
	const staleAfter = time(dateString(frontmatter.stale_after));
	if (typeof frontmatter.title === "string" && frontmatter.title.trim() === "") {
		throw new Error("Kantel needs a title, and this concept's is empty (Sal would read it)");
	}
	if (body.trim() === "")
		throw new Error("Kantel needs a statement, and this concept's body is empty (Sal would read it)");
	const sources = (Array.isArray(frontmatter.sources) ? frontmatter.sources : [])
		.filter((source): source is Record<string, unknown> => isRecord(source) && typeof source.resource === "string")
		.slice(0, MAX_SOURCES)
		.map((source) => String(source.resource));
	const tags = Array.isArray(frontmatter.tags)
		? frontmatter.tags.filter((tag): tag is string => typeof tag === "string")
		: [];
	const learnedFrom =
		sal.learned_from === "task" || sal.learned_from === "observation" || sal.learned_from === "session"
			? sal.learned_from
			: "owner";
	const segments = id.split("/");
	const project = segments[0] === "projects" && segments.length >= 3 ? segments[1]! : null;
	const scope: SnapshotConcept["scope"] =
		appliesTo !== null
			? { kind: "job", job: appliesTo }
			: project !== null
				? { kind: "project", project }
				: { kind: "global" };
	const extension: SalConceptExtension = {
		type: frontmatter.type,
		scope: appliesTo !== null ? "exception" : id.startsWith("personal/") ? "personal" : "project",
		learnedFrom,
		updated,
		status,
		appliesTo,
		sources,
		sha256: createHash("sha256").update(text).digest("hex"),
		bytes: Buffer.byteLength(text),
	};
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	const concept: SnapshotConcept = {
		id,
		title: typeof frontmatter.title === "string" ? frontmatter.title : (segments.at(-1) ?? id),
		...(description === "" ? {} : { description }),
		statement: body,
		// Kantel wants non-empty tags; Sal indexes an empty one as nothing, so leaving it out changes no score.
		tags: tags.filter((tag) => tag.trim() !== ""),
		scope,
		// Kantel wants non-empty sources; a concept written by hand without one points at its own file. The extension
		// keeps Sal's list as it is, for rendering.
		sources: sources.some((source) => source.trim() !== "")
			? sources.filter((source) => source.trim() !== "")
			: [`okf:${id}`],
		setBy: learnedFrom === "owner" ? "owner" : "learned",
		status:
			forgotten || (status === "deprecated" && supersededBy === null)
				? "forgotten"
				: supersededBy !== null
					? "superseded"
					: "active",
		...(supersededBy === null || forgotten ? {} : { supersededBy }),
		// Sal orders the profile by the `generated.at` text, an empty one first: 0 keeps that order.
		updatedAt: time(updated) ?? 0,
		...(staleAfter === undefined ? {} : { staleAfter }),
		...(appliesTo !== null && overrides !== null ? { overrides } : {}),
		extensions: { sal: extension as unknown as JsonValue },
	};
	return { concept, profile: tags.includes(PROFILE_TAG) };
}

/**
 * A whole bundle at one ref as a snapshot, concepts in ID order as Sal lists them. `files` are the bundle directory's
 * Markdown files; anything that is not a concept Sal reads is in `refused`.
 */
export function okfSnapshot(
	files: readonly OkfFile[],
	source: { readonly sourceId: string; readonly ref: string },
): OkfSnapshot {
	const concepts: SnapshotConcept[] = [];
	const profile: string[] = [];
	const projects = new Set<string>();
	const refused: { path: string; reason: string }[] = [];
	const warnings: { path: string; reason: string }[] = [];
	for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const id = conceptIdOf(file.path);
		if (id === null) {
			if (!/(^|\/)(index|log)\.md$/.test(file.path)) refused.push({ path: file.path, reason: "not a concept ID" });
			continue;
		}
		try {
			const { concept, profile: inProfile } = okfConcept(id, file.text);
			concepts.push(concept);
			const updated = salExtension(concept)?.updated ?? null;
			if (updated !== null && !canonicalTime(updated)) {
				warnings.push({
					path: file.path,
					reason: `generated.at ${JSON.stringify(updated)} is not in the form 2026-10-12T09:35:38.357Z, so its place in the profile may differ from Sal's`,
				});
			}
			if (inProfile) profile.push(id);
			if (concept.scope.kind === "project") projects.add(concept.scope.project);
		} catch (error) {
			refused.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	concepts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return {
		snapshot: { sourceId: source.sourceId, ref: source.ref, concepts },
		profile,
		projects: [...projects].sort(),
		refused,
		warnings,
	};
}

/** The `sal` extension of a concept imported by `okfSnapshot`. */
export function salExtension(concept: { readonly extensions?: { readonly [namespace: string]: JsonValue } }) {
	return concept.extensions?.sal as unknown as SalConceptExtension | undefined;
}

// Writing: Kantel's concepts back as Sal's concept files and directory indexes (M2-BE5), as Sal's own writer
// (tvdavies/sal `src/context/memory-writer.ts`) writes them, so Sal reads what Kantel publishes as its own.

/** Sal writes frontmatter as one `key: <JSON>` line per field. */
function renderConceptText(frontmatter: Record<string, unknown>, body: string): string {
	const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`);
	return `---\n${lines.join("")}---\n\n${body.trim()}\n`;
}

const SUPERSEDED_NOTE = /^> Superseded by .*\r?\n\r?\n/;

/** What a concept states, without the note Sal puts above a superseded one. */
function plainStatement(statement: string): string {
	return statement.replace(SUPERSEDED_NOTE, "").trim();
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** The sources Kantel holds for a concept, without the stand-in `okfConcept` gives one that has none. */
function realSources(concept: Pick<Concept, "id" | "sources">): string[] {
	return concept.sources.filter((source) => source !== `okf:${concept.id}`);
}

/**
 * Whether a concept file already says what `concept` says, as `okfConcept` reads it: then publishing leaves its bytes
 * alone. Only Kantel's own fields count; when they were written (`generated.at`) does not.
 */
function alreadySays(concept: Concept, existing: string): boolean {
	let parsed: SnapshotConcept;
	try {
		parsed = okfConcept(concept.id, existing).concept;
	} catch {
		return false;
	}
	if (parsed.status !== concept.status || parsed.setBy !== concept.setBy) return false;
	if (concept.status === "forgotten") return true;
	return (
		parsed.title === concept.title &&
		(parsed.description ?? "") === (concept.description ?? "") &&
		plainStatement(parsed.statement) === plainStatement(concept.statement) &&
		sameList(
			parsed.tags ?? [],
			(concept.tags ?? []).filter((tag) => tag.trim() !== ""),
		) &&
		JSON.stringify(parsed.scope) === JSON.stringify(concept.scope) &&
		sameList(realSources(parsed), realSources(concept)) &&
		parsed.supersededBy === concept.supersededBy &&
		parsed.staleAfter === concept.staleAfter &&
		parsed.overrides === concept.overrides
	);
}

function frontmatterOf(text: string | undefined): Record<string, unknown> {
	const match = text === undefined ? null : FRONTMATTER.exec(text);
	if (match === null) return {};
	try {
		const parsed: unknown = parse(match[1] ?? "");
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function iso(at: number): string {
	return new Date(at).toISOString();
}

export interface OkfWriteOptions {
	/** Written as `generated.by`. Default `harbour`. */
	readonly producer?: string;
	/** Who asked to forget, as `sal.forgotten.by`. Default the producer. */
	readonly forgottenBy?: string;
}

/**
 * One concept as Sal's concept file. `existing` is the file the source holds now, if any: when it already says what the
 * concept says it is returned as it is, byte for byte; otherwise its unknown fields, its `sal` fields and the details
 * of sources it shares (title, author) are kept, as Sal's writer keeps them (OKF §4.1). `titleOf` names a superseding
 * concept for the note Sal puts above a superseded one.
 */
export function okfConceptText(
	concept: Concept,
	existing: string | undefined,
	titleOf: (conceptId: string) => string | undefined = () => undefined,
	options: OkfWriteOptions = {},
): string {
	if (existing !== undefined && alreadySays(concept, existing)) return existing;
	const producer = options.producer ?? "harbour";
	const previous = frontmatterOf(existing);
	const { verified: _verified, stale_after: _staleAfter, ...kept } = previous;
	const previousSal = isRecord(previous.sal) ? previous.sal : {};
	const extension = salExtension(concept);
	const at = iso(concept.updatedAt);
	const learnedFrom =
		concept.setBy === "owner"
			? "owner"
			: extension !== undefined && extension.learnedFrom !== "owner"
				? extension.learnedFrom
				: "session";
	const segments = concept.id.split("/");
	const project = segments[0] === "projects" && segments.length >= 3 ? segments[1] : undefined;
	const job = concept.scope.kind === "job" ? concept.scope.job : undefined;
	const place = {
		learned_from: learnedFrom,
		scope: job !== undefined ? "exception" : concept.id.startsWith("personal/") ? "personal" : "project",
		...(project === undefined ? {} : { project }),
		...(job === undefined
			? {}
			: { applies_to: job, ...(concept.overrides === undefined ? {} : { overrides: concept.overrides }) }),
	};
	const type =
		typeof previous.type === "string" && previous.type.trim() !== "" ? previous.type : (extension?.type ?? "Fact");
	const oldSources = (Array.isArray(previous.sources) ? previous.sources : []).filter(isRecord);
	const ids = new Set<string>();
	const sources = realSources(concept).map((resource) => {
		const entry = oldSources.find((source) => source.resource === resource) ?? { id: "harbour", resource };
		const base = typeof entry.id === "string" && entry.id !== "" ? entry.id : "source";
		let id = base;
		for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
		ids.add(id);
		return { ...entry, id };
	});

	if (concept.status === "forgotten") {
		const salKept = Object.fromEntries(
			Object.entries(previousSal).filter(([key]) => ["scope", "project", "applies_to", "overrides"].includes(key)),
		);
		return renderConceptText(
			{
				type,
				title: concept.title,
				status: "deprecated",
				generated: { by: producer, at },
				sources,
				sal: { ...salKept, ...place, forgotten: { at, by: options.forgottenBy ?? producer } },
			},
			`Forgotten on ${at.slice(0, 10)}. Earlier revisions remain in this repository's Git history, its remote and backups until those are rewritten or expire.`,
		);
	}

	const {
		forgotten: _forgotten,
		superseded_by: _supersededBy,
		applies_to: _job,
		overrides: _overrides,
		...salKept
	} = previousSal;
	const frontmatter: Record<string, unknown> = {
		type,
		title: concept.title,
		...(concept.description === undefined || concept.description === "" ? {} : { description: concept.description }),
		...(concept.tags === undefined || concept.tags.length === 0 ? {} : { tags: concept.tags }),
		status: concept.status === "superseded" ? "deprecated" : "stable",
		generated: { by: producer, at },
		...(concept.staleAfter === undefined ? {} : { stale_after: iso(concept.staleAfter) }),
		sources,
		sal: {
			...salKept,
			...place,
			...(concept.status === "superseded" && concept.supersededBy !== undefined
				? { superseded_by: concept.supersededBy }
				: {}),
		},
	};
	for (const [key, value] of Object.entries(kept)) {
		if (!(key in frontmatter) && key !== "description" && key !== "tags") frontmatter[key] = value;
	}
	const statement = plainStatement(concept.statement);
	if (concept.status === "superseded" && concept.supersededBy !== undefined) {
		const successor = concept.supersededBy;
		return renderConceptText(
			frontmatter,
			`> Superseded by [${titleOf(successor) ?? successor}](/${successor}.md) on ${at.slice(0, 10)}.\n\n${statement}`,
		);
	}
	return renderConceptText(frontmatter, statement);
}

/**
 * Every concept as its file, `<id>.md`, keeping any file the source holds (`existing`, by path) that already says the
 * same. Directory indexes are the source's to write (`okfIndexes`), from the whole tree.
 */
export function okfConceptFiles(
	concepts: readonly Concept[],
	existing: ReadonlyMap<string, string>,
	options: OkfWriteOptions = {},
): OkfFile[] {
	const titles = new Map(concepts.map((concept) => [concept.id, concept.title]));
	return concepts.map((concept) => {
		const path = `${concept.id}.md`;
		return { path, text: okfConceptText(concept, existing.get(path), (id) => titles.get(id), options) };
	});
}

/** The heading Sal gives a new directory's index: its name, capitalised, dashes as spaces. */
function headingFor(dir: string): string {
	const name = dir.split("/").at(-1) ?? "Knowledge";
	return `# ${name.charAt(0).toUpperCase()}${name.slice(1).replace(/-/g, " ")}`;
}

/**
 * A directory's `index.md` as Sal renders it, from `tree` (every file of the bundle, by path): the existing heading, then
 * its subdirectories and its active concepts, by name.
 */
export function okfIndex(dir: string, tree: ReadonlyMap<string, string>): string {
	const prefix = dir === "" ? "" : `${dir}/`;
	const heading = /^# .+$/m.exec(tree.get(`${prefix}index.md`) ?? "")?.[0] ?? headingFor(dir);
	const entries = new Map<string, "dir" | "file">();
	for (const path of tree.keys()) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash === -1) entries.set(rest, "file");
		else entries.set(rest.slice(0, slash), "dir");
	}
	const lines: string[] = [];
	for (const [name, kind] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
		if (name.startsWith(".")) continue;
		if (kind === "dir") {
			const title = /^# (.+)$/m.exec(tree.get(`${prefix}${name}/index.md`) ?? "")?.[1] ?? name;
			lines.push(`- [${title}](${name}/index.md)`);
			continue;
		}
		if (!name.endsWith(".md") || name === "index.md" || name === "log.md") continue;
		const id = `${prefix}${name.slice(0, -3)}`;
		try {
			const text = tree.get(`${prefix}${name}`) ?? "";
			if (okfConcept(id, text).concept.status !== "active") continue;
			const frontmatter = frontmatterOf(text);
			const title = typeof frontmatter.title === "string" ? frontmatter.title : name.slice(0, -3);
			const description = typeof frontmatter.description === "string" ? ` - ${frontmatter.description}` : "";
			lines.push(`- [${title}](${name})${description}`);
		} catch {
			// An invalid concept is not advertised.
		}
	}
	return `${heading}\n\n${lines.length === 0 ? "No concepts have been added yet." : lines.join("\n")}\n`;
}

/**
 * The indexes Sal rewrites when the concepts at `changed` change: each one's directory and every directory above it,
 * but never the bundle's root index, which Sal keeps by hand. Deepest first, so a parent lists its children's new
 * headings. Returns each index's path and text, from `tree` as it will be.
 */
export function okfIndexes(changed: readonly string[], tree: ReadonlyMap<string, string>): OkfFile[] {
	const dirs = new Set<string>();
	for (const path of changed) {
		const parts = path.split("/").slice(0, -1);
		for (let index = 1; index <= parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
	}
	const working = new Map(tree);
	const out: OkfFile[] = [];
	for (const dir of [...dirs].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))) {
		const text = okfIndex(dir, working);
		working.set(`${dir}/index.md`, text);
		out.push({ path: `${dir}/index.md`, text });
	}
	return out;
}
