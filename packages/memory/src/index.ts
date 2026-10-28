/**
 * Portable memory logic shared by every target: near-duplicate similarity, concept ID checks and the Markdown
 * rendering of the canonical bundle here; the full-text index (`fts.ts`), Sal's query terms (`terms.ts`) and recall and
 * search (`recall.ts`) beside it. No storage and no clock.
 */
import { type Concept, type ConceptScope, HarbourError } from "@harbour/contracts";

export * from "./capabilities.ts";
export * from "./fts.ts";
export * from "./recall.ts";
export * from "./terms.ts";

/** Statements at least this similar (Jaccard over token sets) are near-duplicates. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

const STOPWORDS: ReadonlySet<string> = new Set([
	"a",
	"about",
	"after",
	"all",
	"also",
	"an",
	"and",
	"any",
	"are",
	"as",
	"at",
	"be",
	"been",
	"before",
	"but",
	"by",
	"can",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"me",
	"my",
	"no",
	"not",
	"of",
	"on",
	"or",
	"our",
	"so",
	"than",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"while",
	"who",
	"why",
	"will",
	"with",
	"you",
	"your",
]);

/** Lower-case words of letters and digits, without English stopwords, in order: what `similarity` compares. */
export function tokenize(text: string): string[] {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return words.filter((word) => !STOPWORDS.has(word));
}

/** Jaccard similarity of the two texts' token sets, from 0 to 1. Two texts without tokens score 0. */
export function similarity(a: string, b: string): number {
	const left = new Set(tokenize(a));
	const right = new Set(tokenize(b));
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	const union = left.size + right.size - shared;
	return union === 0 ? 0 : shared / union;
}

const CONCEPT_ID_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Rejects with `invalid` unless `id` is two or more `/`-separated segments of lower-case letters, digits and dashes,
 * each starting with a letter or digit. Such an ID is also a safe relative bundle path.
 */
export function validateConceptId(id: string): void {
	const segments = id.split("/");
	if (segments.length < 2 || !segments.every((segment) => CONCEPT_ID_SEGMENT.test(segment))) {
		throw new HarbourError("invalid", `"${id}" is not a concept ID such as projects/harbour/vault-binding-codes`);
	}
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
	return `[${values.map(yamlString).join(", ")}]`;
}

function scopeLines(scope: ConceptScope): string[] {
	switch (scope.kind) {
		case "global":
			return ["scope:", "  kind: global"];
		case "project":
			return ["scope:", "  kind: project", `  project: ${yamlString(scope.project)}`];
		case "job":
			return ["scope:", "  kind: job", `  job: ${yamlString(scope.job)}`];
	}
}

/**
 * A concept as a Markdown file: YAML frontmatter (id, title, description, tags, scope, sources, setBy, version,
 * status, supersededBy, staleAfter as an ISO time), then the statement. Absent optional fields are left out.
 */
export function renderConcept(concept: Concept): string {
	const lines = [
		"---",
		`id: ${yamlString(concept.id)}`,
		`title: ${yamlString(concept.title)}`,
		...(concept.description === undefined ? [] : [`description: ${yamlString(concept.description)}`]),
		`tags: ${yamlList(concept.tags)}`,
		...scopeLines(concept.scope),
		`sources: ${yamlList(concept.sources)}`,
		`setBy: ${concept.setBy}`,
		`version: ${concept.version}`,
		`status: ${concept.status}`,
		...(concept.supersededBy === undefined ? [] : [`supersededBy: ${yamlString(concept.supersededBy)}`]),
		...(concept.staleAfter === undefined
			? []
			: [`staleAfter: ${yamlString(new Date(concept.staleAfter).toISOString())}`]),
		...(concept.overrides === undefined ? [] : [`overrides: ${yamlString(concept.overrides)}`]),
		...(concept.extensions === undefined ? [] : [`extensions: ${JSON.stringify(concept.extensions)}`]),
		"---",
		"",
		concept.statement,
		"",
	];
	return lines.join("\n");
}
