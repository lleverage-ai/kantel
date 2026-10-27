/**
 * Sal's memory bundle (OKF v0.2 concept files, tvdavies/sal-memory) as a Harbour memory snapshot. Each concept file
 * `knowledge/<id>.md` is YAML frontmatter and a Markdown body; this reads the fields Sal's `summarise`
 * (tvdavies/sal `src/context/memory.ts`) reads, the same way:
 *
 * - `status: deprecated`, `sal.superseded_by` and `sal.forgotten` make a concept inactive; `draft` and `stable` are
 *   both active.
 * - `sal.applies_to` makes a job exception (Harbour scope `job`), with `sal.overrides` naming the general concept;
 *   `projects/<project>/…` is project scope; everything else (`personal/…`, `projects/<one>`) is global.
 * - Concepts tagged `profile` form the owner profile, recalled every turn.
 * - `sal.learned_from` other than the owner is `learned`.
 *
 * The body is the statement, whole: recall and search index it as Sal does. What Harbour has no field for (Sal's
 * scope name, learned_from, the `generated.at` text, deprecation, all source records) goes in the `sal` extension so
 * the Sal renderer can print it as Sal does.
 */
import { createHash } from "node:crypto";
import type { JsonValue, MemorySnapshot, SnapshotConcept } from "@harbour/contracts";
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

/** What Sal knows of a concept that Harbour has no field for. */
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
	 * Files left out, with why: ones Sal would not read as concepts, and the few Sal reads that Harbour's snapshot cannot
	 * hold (an empty title or body, an `overrides` or `superseded_by` that is not a concept ID). Nothing is dropped
	 * silently.
	 */
	readonly refused: readonly { readonly path: string; readonly reason: string }[];
	/**
	 * Concepts imported whose recall may not match Sal's: a `generated.at` that is not in the form YAML gives a date
	 * (`2026-10-12T09:35:38.357Z`). Sal orders the profile by that text and Harbour by the time it names; the two agree
	 * only when every timestamp has that form.
	 */
	readonly warnings: readonly { readonly path: string; readonly reason: string }[];
}

/** The text of a timestamp in the one form whose text order is its time order. */
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
	for (const [field, value] of [
		["sal.overrides", appliesTo === null ? null : overrides],
		["sal.superseded_by", supersededBy],
	] as const) {
		if (value !== null && (!CONCEPT_ID.test(value) || value === id)) {
			throw new Error(
				`Harbour needs ${field} to name another concept, not ${JSON.stringify(value)} (Sal would read it)`,
			);
		}
	}
	const forgotten = isRecord(sal.forgotten);
	const generated = isRecord(frontmatter.generated) ? frontmatter.generated : {};
	const updated = dateString(generated.at);
	const staleAfter = time(dateString(frontmatter.stale_after));
	if (typeof frontmatter.title === "string" && frontmatter.title.trim() === "") {
		throw new Error("Harbour needs a title, and this concept's is empty (Sal would read it)");
	}
	if (body.trim() === "")
		throw new Error("Harbour needs a statement, and this concept's body is empty (Sal would read it)");
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
		// Harbour wants non-empty tags; Sal indexes an empty one as nothing, so leaving it out changes no score.
		tags: tags.filter((tag) => tag.trim() !== ""),
		scope,
		// Harbour wants non-empty sources; a concept written by hand without one points at its own file. The extension
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
			if (updated !== null && !CANONICAL_TIME.test(updated)) {
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
