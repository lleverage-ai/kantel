/**
 * Portable memory logic shared by every target: tokenising, BM25 search, near-duplicate similarity, recall byte
 * counting, concept ID checks and the Markdown rendering of the canonical bundle. No storage and no clock here.
 */
import { type Concept, type ConceptScope, HarbourError } from "@harbour/contracts";

/** Statements at least this similar (Jaccard over token sets) are near-duplicates. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.2;
/** BM25 length normalisation. */
export const BM25_B = 0.75;

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

/** Lower-case words of letters and digits, without English stopwords, in order. */
export function tokenize(text: string): string[] {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return words.filter((word) => !STOPWORDS.has(word));
}

/** The tokens BM25 indexes for a concept: title (twice), description, tags and statement. */
export function conceptTokens(
	concept: Pick<Concept, "title" | "description" | "tags" | "statement">,
): readonly string[] {
	const title = tokenize(concept.title);
	return [
		...title,
		...title,
		...tokenize(concept.description ?? ""),
		...concept.tags.flatMap((tag) => tokenize(tag)),
		...tokenize(concept.statement),
	];
}

interface Bm25Document {
	readonly key: string;
	readonly termFrequencies: ReadonlyMap<string, number>;
	readonly length: number;
}

export interface Bm25Index {
	readonly documents: readonly Bm25Document[];
	readonly averageLength: number;
	/** How many documents hold each term. */
	readonly documentFrequencies: ReadonlyMap<string, number>;
}

/** Builds a BM25 index over pre-tokenised documents, each named by a caller-chosen `key`. */
export function createBm25Index(
	documents: readonly { readonly key: string; readonly tokens: readonly string[] }[],
): Bm25Index {
	const documentFrequencies = new Map<string, number>();
	const indexed: Bm25Document[] = documents.map(({ key, tokens }) => {
		const termFrequencies = new Map<string, number>();
		for (const token of tokens) termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
		for (const term of termFrequencies.keys()) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
		return { key, termFrequencies, length: tokens.length };
	});
	const totalLength = indexed.reduce((sum, document) => sum + document.length, 0);
	return {
		documents: indexed,
		averageLength: indexed.length === 0 ? 0 : totalLength / indexed.length,
		documentFrequencies,
	};
}

/**
 * Scores every document against `query` with BM25 (k1 1.2, b 0.75) and returns those scoring above zero, best first.
 * Ties keep index order.
 */
export function bm25(index: Bm25Index, query: string): { readonly key: string; readonly score: number }[] {
	const terms = [...new Set(tokenize(query))];
	const count = index.documents.length;
	if (terms.length === 0 || count === 0) return [];
	const results: { key: string; score: number }[] = [];
	for (const document of index.documents) {
		let score = 0;
		for (const term of terms) {
			const frequency = document.termFrequencies.get(term);
			if (frequency === undefined) continue;
			const holders = index.documentFrequencies.get(term) ?? 0;
			const idf = Math.log(1 + (count - holders + 0.5) / (holders + 0.5));
			const norm = 1 - BM25_B + BM25_B * (index.averageLength === 0 ? 0 : document.length / index.averageLength);
			score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * norm));
		}
		if (score > 0) results.push({ key: document.key, score });
	}
	return results.sort((left, right) => right.score - left.score);
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

/** UTF-8 bytes of the title plus the statement: what recall's `maxBytes` counts. */
export function conceptBytes(concept: Pick<Concept, "title" | "statement">): number {
	return new TextEncoder().encode(concept.title + concept.statement).length;
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
		"---",
		"",
		concept.statement,
		"",
	];
	return lines.join("\n");
}
