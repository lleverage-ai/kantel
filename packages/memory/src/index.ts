/**
 * Portable memory logic shared by every target: near-duplicate similarity, concept ID checks and the Markdown
 * rendering of the canonical bundle here; the full-text index (`fts.ts`), Sal's query terms (`terms.ts`) and recall and
 * search (`recall.ts`) beside it. No storage and no clock.
 */
import { type Concept, type ConceptScope, HarbourError } from "@harbour/contracts";
import { porterStem } from "./fts.ts";

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

/**
 * Titles with statements, or statements alone, at least this similar (Jaccard over Porter-stemmed words) are
 * paraphrases: "Deploy harbour only on weekday mornings" and "Harbour deploys happen only on weekday mornings". Of the
 * 422,740 pairs of the 920 active concepts in Sal's curated memory (29 Oct 2026), all distinct, none scores 0.4.
 */
export const DEFAULT_PARAPHRASE_THRESHOLD = 0.5;
/** A statement this much of whose stemmed words appear in another's is a paraphrase of it. */
export const DEFAULT_CONTAINMENT_THRESHOLD = 0.85;
/**
 * Statements with fewer stemmed words than this are compared by `similarity` alone: in a short statement one word is
 * the fact ("Harbour runs sessions on Node" and "Harbour sessions run on a VPS" share three words of four).
 */
export const MIN_PARAPHRASE_TERMS = 5;
/** How many of the nearest concepts a host's `ParaphraseCheck` is shown. */
export const PARAPHRASE_CANDIDATES = 5;

/** The set of a text's words as `tokenize` gives them, each Porter-stemmed as recall's index stems it. */
export function paraphraseTerms(text: string): Set<string> {
	return new Set(tokenize(text).map(porterStem));
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let shared = 0;
	for (const term of left) if (right.has(term)) shared += 1;
	return shared;
}

/** Whether two statements hold the same numbers: "step 1" and "step 2", or 30 and 60 minutes, are different facts. */
function sameNumbers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	const numbers = (terms: ReadonlySet<string>) => [...terms].filter((term) => /\p{N}/u.test(term));
	const ours = numbers(left);
	const theirs = numbers(right);
	return ours.length === theirs.length && ours.every((term) => right.has(term));
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	const shared = overlap(left, right);
	const union = left.size + right.size - shared;
	return union === 0 ? 0 : shared / union;
}

/** What a duplicate check compares: a concept's title and statement. */
export interface ParaphraseText {
	readonly title: string;
	readonly statement: string;
}

/**
 * How nearly `a` restates `b`, from 0 to 1, by words alone: the best of the Jaccard similarity of their stemmed
 * statements, of their stemmed titles and statements together, and of the share of the shorter statement's stemmed
 * words the other holds, when that reaches `DEFAULT_CONTAINMENT_THRESHOLD`. 0 when either statement has fewer than
 * `MIN_PARAPHRASE_TERMS` stemmed words. No model and no embeddings, so it catches rewordings and inflections, not
 * synonyms; a host adds a `ParaphraseCheck` for those.
 */
export function paraphraseScore(a: ParaphraseText, b: ParaphraseText): number {
	const left = paraphraseTerms(a.statement);
	const right = paraphraseTerms(b.statement);
	const smaller = Math.min(left.size, right.size);
	if (smaller < MIN_PARAPHRASE_TERMS || !sameNumbers(left, right)) return 0;
	const statements = jaccard(left, right);
	const whole = jaccard(paraphraseTerms(`${a.title} ${a.statement}`), paraphraseTerms(`${b.title} ${b.statement}`));
	const contained = overlap(left, right) / smaller;
	return Math.max(statements, whole, contained >= DEFAULT_CONTAINMENT_THRESHOLD ? contained : 0);
}

/** A near-duplicate found for a proposed statement. */
export interface DuplicateMatch {
	readonly conceptId: string;
	readonly score: number;
	/** `similarity` (statements' words, as `similarity` scores them) or `paraphrase` (`paraphraseScore`). */
	readonly check: string;
}

/**
 * The active concept `candidate` most nearly repeats, leaving out `exclude` (the concept a write changes): first by
 * `similarity` of the statements at `DEFAULT_SIMILARITY_THRESHOLD`, then by `paraphraseScore` at
 * `DEFAULT_PARAPHRASE_THRESHOLD`. Ties go to the lower ID, so every store flags the same concept.
 */
export function nearDuplicate(
	candidate: ParaphraseText,
	concepts: Iterable<Concept>,
	exclude: ReadonlySet<string> = new Set(),
): DuplicateMatch | undefined {
	const active = [...concepts]
		.filter((concept) => concept.status === "active" && !exclude.has(concept.id))
		.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	const best = (check: string, score: (concept: Concept) => number, threshold: number) => {
		let found: DuplicateMatch | undefined;
		for (const concept of active) {
			const value = score(concept);
			if (value >= threshold && (found === undefined || value > found.score)) {
				found = { conceptId: concept.id, score: value, check };
			}
		}
		return found;
	};
	return (
		best("similarity", (concept) => similarity(candidate.statement, concept.statement), DEFAULT_SIMILARITY_THRESHOLD) ??
		best("paraphrase", (concept) => paraphraseScore(candidate, concept), DEFAULT_PARAPHRASE_THRESHOLD)
	);
}

/**
 * The active concepts nearest `candidate` by the Jaccard similarity of their stemmed titles and statements, best
 * first, leaving out `exclude` and any sharing no word with it: what a host's `ParaphraseCheck` is shown.
 */
export function nearestConcepts(
	candidate: ParaphraseText,
	concepts: Iterable<Concept>,
	exclude: ReadonlySet<string> = new Set(),
	limit = PARAPHRASE_CANDIDATES,
): Concept[] {
	const terms = paraphraseTerms(`${candidate.title} ${candidate.statement}`);
	return [...concepts]
		.filter((concept) => concept.status === "active" && !exclude.has(concept.id))
		.map((concept) => ({ concept, score: jaccard(terms, paraphraseTerms(`${concept.title} ${concept.statement}`)) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || (left.concept.id < right.concept.id ? -1 : 1))
		.slice(0, limit)
		.map((entry) => entry.concept);
}

const CONCEPT_ID_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Rejects with `invalid` unless `id` is two or more `/`-separated segments of lower-case letters, digits and dashes,
 * each starting with a letter or digit. Such an ID is also a safe relative bundle path.
 */
export function validateConceptId(id: string): void {
	if (typeof id !== "string") throw new HarbourError("invalid", "A concept ID is text");
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
