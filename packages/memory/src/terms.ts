/**
 * Query and keyword terms, as Sal's memory reads them, so recall and search pick what Sal's own would. Words are runs
 * of ASCII letters and digits after lower-casing and dropping apostrophes (a possessive `'s` goes whole); simple
 * English suffixes are stripped. Deliberately simple and explainable.
 */

const STOPWORDS: ReadonlySet<string> = new Set(
	(
		"a an and are as at be been being but by can could did do does doing for from had has have having he her his how i if in into is it its " +
		"just me my of on or our ours she should so than that the their them then there these they this those to too us was we were what when " +
		"where which while who whom why will with would you your yours about also any each more most other some such only own same very " +
		"please prefer prefers preferred like likes want wants always never not no nothing"
	).split(" "),
);

/** Conversational filler that says nothing about which memory is relevant. */
const RECALL_FILLER: ReadonlySet<string> = new Set(
	(
		"hi hey hello thanks thank cheers yes yeah ok okay sure sal tell know think get got let need make going go really thing things " +
		"something anything everything much many lot bit quick question now today right well"
	).split(" "),
);

const SUFFIXES = ["ations", "ation", "ings", "ing", "edly", "ies", "ied", "ers", "est", "ed", "es", "er", "ly", "s"];

/** Strips one simple suffix from a word longer than four letters, keeping at least three. */
export function stem(word: string): string {
	if (word.length <= 4) return word;
	for (const suffix of SUFFIXES) {
		if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
			const base = word.slice(0, -suffix.length);
			return suffix === "ies" || suffix === "ied" ? `${base}y` : base;
		}
	}
	return word;
}

function words(text: string): string[] {
	return (
		text
			.toLowerCase()
			.replace(/['’]s\b/g, "")
			.replace(/['’]/g, "")
			.match(/[a-z0-9]+/g) ?? []
	);
}

/** Search terms: stemmed content words, without short stop words. In order of first appearance. */
export function searchTerms(text: string): string[] {
	const terms = new Set<string>();
	for (const raw of words(text)) {
		if (raw.length < 2 || (STOPWORDS.has(raw) && raw.length < 5)) continue;
		terms.add(stem(raw));
	}
	return [...terms];
}

function isRecallWord(raw: string): boolean {
	return raw.length >= 2 && !STOPWORDS.has(raw) && !RECALL_FILLER.has(raw) && !/^\d+$/.test(raw);
}

/** Terms for automatic recall: like `searchTerms`, but every stop word, filler word and bare number is dropped. */
export function recallTerms(text: string): string[] {
	const terms = new Set<string>();
	for (const raw of words(text)) if (isRecallWord(raw)) terms.add(stem(raw));
	return [...terms];
}

/** The same content words as `recallTerms`, unstemmed and in order, for the full-text index, which stems them. */
export function recallWords(text: string): string[] {
	const found = new Set<string>();
	for (const raw of words(text)) if (isRecallWord(raw)) found.add(raw);
	return [...found];
}

/** Terms kept per field of a concept. */
export const MAX_FIELD_TERMS = 400;

/** A concept's search terms by field. */
export interface ConceptTerms {
	readonly title: readonly string[];
	readonly tags: readonly string[];
	readonly description: readonly string[];
	readonly statement: readonly string[];
}

export function conceptTerms(concept: {
	readonly title: string;
	readonly tags: readonly string[];
	readonly description?: string;
	readonly statement: string;
}): ConceptTerms {
	const bounded = (terms: string[]) => terms.slice(0, MAX_FIELD_TERMS);
	return {
		title: bounded(searchTerms(concept.title)),
		tags: bounded(concept.tags.flatMap((tag) => searchTerms(tag.replace(/-/g, " ")))),
		description: bounded(searchTerms(concept.description ?? "")),
		statement: bounded(searchTerms(concept.statement)),
	};
}

/**
 * How well a concept matches terms: per term, 3 for the title or an ID segment starting with it, 3 for a tag, 2 for
 * the description and 1 for the statement. Also returns which terms matched, in query order.
 */
export function termScore(
	id: string,
	terms: ConceptTerms,
	query: readonly string[],
): { readonly score: number; readonly matched: readonly string[] } {
	const parts = id.split(/[/-]/);
	let score = 0;
	const matched: string[] = [];
	for (const term of query) {
		const before = score;
		if (terms.title.includes(term) || parts.some((part) => part.startsWith(term))) score += 3;
		if (terms.tags.includes(term)) score += 3;
		if (terms.description.includes(term)) score += 2;
		if (terms.statement.includes(term)) score += 1;
		if (score > before) matched.push(term);
	}
	return { score, matched };
}
