/**
 * A full-text index that ranks like SQLite FTS5 with `tokenize = 'porter unicode61'` and `bm25()` column weights, in
 * portable TypeScript, so recall ranks the same in a Worker isolate, on Node and against Sal's local FTS5 index.
 *
 * - Tokens follow FTS5's `unicode61` tokenizer with its defaults: runs of letters, numbers and private-use characters
 *   (categories `L* N* Co`, plus code points SQLite's tables leave unassigned), folded to lower case and stripped of
 *   simple diacritics (`remove_diacritics=1`), combining diacritics inside a token dropped.
 * - Each token then goes through FTS5's Porter stemmer, which leaves tokens shorter than 3 or longer than 64 UTF-8
 *   bytes as they are.
 * - Ranking is FTS5's `bm25()`: k1 1.2, b 0.75, IDF `ln((N - n + 0.5) / (n + 0.5))` floored at 1e-6, each phrase's
 *   frequency the sum of its instances' column weights, and the row length the token count of every column.
 *
 * The category, case folding and diacritic tables are SQLite's (`ext/fts5/fts5_unicode2.c`, public domain), so a
 * newer Unicode version in JavaScript does not change how text tokenises.
 */
import { FOLD_ENTRIES, FOLD_OFFSETS, UNICODE_BLOCK, UNICODE_DATA, UNICODE_MAP } from "./unicode61-data.ts";

/** BM25 term-frequency saturation, as FTS5's `bm25()`. */
export const FTS_K1 = 1.2;
/** BM25 length normalisation, as FTS5's `bm25()`. */
export const FTS_B = 0.75;
/** FTS5's Porter stemmer leaves longer tokens, in UTF-8 bytes, as they are. */
const PORTER_MAX_TOKEN = 64;

// fts5_remove_diacritic's tables from SQLite's ext/fts5/fts5_unicode2.c.
const DIACRITIC_KEYS: readonly number[] = [
	0, 1797, 1848, 1859, 1891, 1928, 1940, 1995, 2024, 2040, 2060, 2110, 2168, 2206, 2264, 2286, 2344, 2383, 2472, 2488,
	2516, 2596, 2668, 2732, 2782, 2842, 2894, 2954, 2984, 3000, 3028, 3336, 3456, 3696, 3712, 3728, 3744, 3766, 3832,
	3896, 3912, 3928, 3944, 3968, 4008, 4040, 4056, 4106, 4138, 4170, 4202, 4234, 4266, 4296, 4312, 4344, 4408, 4424,
	4442, 4472, 4488, 4504, 6148, 6198, 6264, 6280, 6360, 6429, 6505, 6529, 61448, 61468, 61512, 61534, 61592, 61610,
	61642, 61672, 61688, 61704, 61726, 61784, 61800, 61816, 61836, 61880, 61896, 61914, 61948, 61998, 62062, 62122, 62154,
	62184, 62200, 62218, 62252, 62302, 62364, 62410, 62442, 62478, 62536, 62554, 62584, 62604, 62640, 62648, 62656, 62664,
	62730, 62766, 62830, 62890, 62924, 62974, 63032, 63050, 63082, 63118, 63182, 63242, 63274, 63310, 63368, 63390,
];
/** Base letters; an upper-case letter marks one that only the complex mode strips, and `_` none. */
const DIACRITIC_BASES =
	"_aceinouyyacdeeghijklnorstuuwyzouaiouUAgkoOjgnAaeiorusthaeOoOy________abCddEeEfghhiIklLlmnOprRrsStuUvwwxyzhtwyaAAAeEEioOOOuUUy";

function removeDiacritic(code: number): number {
	const key = (code << 3) | 7;
	let low = 0;
	let high = DIACRITIC_KEYS.length - 1;
	let found = 0;
	while (high >= low) {
		const middle = (high + low) >> 1;
		if (key >= DIACRITIC_KEYS[middle]!) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	const base = DIACRITIC_BASES[found]!;
	// Simple mode (remove_diacritics=1) leaves letters with more than one diacritic alone.
	if (base !== base.toLowerCase()) return code;
	const entry = DIACRITIC_KEYS[found]!;
	if (code > (entry >> 3) + (entry & 7)) return code;
	return base === "_" ? 0 : base.charCodeAt(0);
}

/** Combining diacritical marks FTS5 folds away inside a token (sqlite3Fts5UnicodeIsdiacritic). */
function isDiacritic(code: number): boolean {
	if (code < 768 || code > 817) return false;
	return code < 800 ? (0x08029fdf & (1 << (code - 768))) !== 0 : (0x000361f8 & (1 << (code - 800))) !== 0;
}

/** sqlite3Fts5UnicodeCategory: SQLite's category number for a code point, 0 when its table has none. */
function category(code: number): number {
	if (code >= 1 << 20) return 0;
	let low = UNICODE_BLOCK[code >> 16]!;
	let high = UNICODE_BLOCK[(code >> 16) + 1]!;
	const key = code & 0xffff;
	let found = -1;
	while (high > low) {
		const middle = (high + low) >> 1;
		if (key >= UNICODE_MAP[middle]!) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	if (found < 0) return 0;
	const data = UNICODE_DATA[found]!;
	if (key >= UNICODE_MAP[found]! + (data >> 5)) return 0;
	const result = data & 0x1f;
	if (result !== 30) return result;
	return (key - UNICODE_MAP[found]!) & 1 ? 5 : 9;
}

/** Categories `unicode61` treats as token characters by default: none (0), `L*` (5-9, 30), `N*` (13-15), `Co` (31). */
const TOKEN_CATEGORIES = new Set([0, 5, 6, 7, 8, 9, 30, 13, 14, 15, 31]);

function isTokenCharacter(code: number): boolean {
	if (code < 128) {
		return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
	}
	// SQLite to 3.53 reads U+FFFE and U+FFFF as U+FFFD, a symbol, so they separate tokens. 3.54 keeps them as
	// unassigned code points, which join tokens. Sal's Bun (3.53) and Node 24 do the former, so Kantel does too.
	if (code === 0xfffe || code === 0xffff) return false;
	return TOKEN_CATEGORIES.has(category(code));
}

/** Folds one non-ASCII code point as unicode61 does: lower case, then without a simple diacritic. 0 drops it. */
function foldCode(code: number): number {
	if (code < 65536) {
		let low = 0;
		let high = FOLD_ENTRIES.length / 3 - 1;
		let found = 0;
		while (high >= low) {
			const middle = (high + low) >> 1;
			if (code - FOLD_ENTRIES[middle * 3]! >= 0) {
				found = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		const start = FOLD_ENTRIES[found * 3]!;
		const flags = FOLD_ENTRIES[found * 3 + 1]!;
		const range = FOLD_ENTRIES[found * 3 + 2]!;
		let folded = code;
		if (code < start + range && (1 & flags & (start ^ code)) === 0) {
			folded = (code + FOLD_OFFSETS[flags >> 1]!) & 0xffff;
		}
		return removeDiacritic(folded);
	}
	// Deseret capitals are the one folding unicode61 does above the Basic Multilingual Plane.
	if (code >= 66560 && code < 66600) return code + 40;
	return code;
}

/** The tokens FTS5's `unicode61` tokenizer finds in `text`, folded, in order. */
export function unicode61Tokens(text: string): string[] {
	const tokens: string[] = [];
	// Built a character at a time: a long token must not become the arguments of one call.
	let current: string | null = null;
	for (const character of text) {
		const code = character.codePointAt(0)!;
		const tokenCharacter = isTokenCharacter(code);
		if (current === null) {
			if (!tokenCharacter) continue;
			current = "";
		} else if (!tokenCharacter && !(code >= 128 && isDiacritic(code))) {
			tokens.push(current);
			current = null;
			continue;
		}
		if (code < 128) {
			current += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
		} else {
			const folded = foldCode(code);
			if (folded !== 0) current += String.fromCodePoint(folded);
		}
	}
	if (current !== null) tokens.push(current);
	return tokens;
}

// FTS5's Porter stemmer (ext/fts5/fts5_tokenize.c), over UTF-8 bytes as SQLite runs it.

const A = 97;
const E = 101;
const I = 105;
const O = 111;
const U = 117;
const Y = 121;

function isVowel(byte: number, yIsVowel: boolean): boolean {
	return byte === A || byte === E || byte === I || byte === O || byte === U || (yIsVowel && byte === Y);
}

/** Skips one vowel-consonant sequence from `start`; returns the offset after it, or 0 when there is none. */
function gobbleVowelConsonant(word: Uint8Array, start: number, length: number, previousConsonant: boolean): number {
	let consonant = previousConsonant;
	let index = 0;
	for (; index < length; index += 1) {
		consonant = !isVowel(word[start + index]!, consonant);
		if (!consonant) break;
	}
	for (index += 1; index < length; index += 1) {
		consonant = !isVowel(word[start + index]!, consonant);
		if (consonant) return index + 1;
	}
	return 0;
}

/** m > 0 */
function measureAbove0(word: Uint8Array, stem: number): boolean {
	return gobbleVowelConsonant(word, 0, stem, false) !== 0;
}

/** m > 1 */
function measureAbove1(word: Uint8Array, stem: number): boolean {
	const first = gobbleVowelConsonant(word, 0, stem, false);
	return first !== 0 && gobbleVowelConsonant(word, first, stem - first, true) !== 0;
}

/** m = 1 */
function measureIs1(word: Uint8Array, stem: number): boolean {
	const first = gobbleVowelConsonant(word, 0, stem, false);
	return first !== 0 && gobbleVowelConsonant(word, first, stem - first, true) === 0;
}

/** *o: the stem ends consonant-vowel-consonant, the last not w, x or y. */
function endsCvc(word: Uint8Array, stem: number): boolean {
	const last = word[stem - 1];
	if (last === 119 || last === 120 || last === Y) return false;
	let mask = 0;
	let consonant = false;
	for (let index = 0; index < stem; index += 1) {
		consonant = !isVowel(word[index]!, consonant);
		mask = ((mask << 1) + (consonant ? 1 : 0)) & 7;
	}
	return mask === 5;
}

/** m > 1 and (*S or *T) */
function measureAbove1EndsST(word: Uint8Array, stem: number): boolean {
	const last = word[stem - 1];
	return (last === 115 || last === 116) && measureAbove1(word, stem);
}

/** *v*: the stem holds a vowel. */
function hasVowel(word: Uint8Array, stem: number): boolean {
	for (let index = 0; index < stem; index += 1) if (isVowel(word[index]!, index > 0)) return true;
	return false;
}

type Condition = (word: Uint8Array, stem: number) => boolean;
/** A step's rules: suffix, condition and replacement, tried in order until a suffix matches. */
type Rule = readonly [suffix: string, condition: Condition | null, replacement: string];

const STEP_2: readonly Rule[] = [
	["ational", measureAbove0, "ate"],
	["tional", measureAbove0, "tion"],
	["enci", measureAbove0, "ence"],
	["anci", measureAbove0, "ance"],
	["izer", measureAbove0, "ize"],
	["logi", measureAbove0, "log"],
	["bli", measureAbove0, "ble"],
	["alli", measureAbove0, "al"],
	["entli", measureAbove0, "ent"],
	["eli", measureAbove0, "e"],
	["ousli", measureAbove0, "ous"],
	["ization", measureAbove0, "ize"],
	["ation", measureAbove0, "ate"],
	["ator", measureAbove0, "ate"],
	["alism", measureAbove0, "al"],
	["iveness", measureAbove0, "ive"],
	["fulness", measureAbove0, "ful"],
	["ousness", measureAbove0, "ous"],
	["aliti", measureAbove0, "al"],
	["iviti", measureAbove0, "ive"],
	["biliti", measureAbove0, "ble"],
];

const STEP_3: readonly Rule[] = [
	["ical", measureAbove0, "ic"],
	["ness", measureAbove0, ""],
	["icate", measureAbove0, "ic"],
	["iciti", measureAbove0, "ic"],
	["ful", measureAbove0, ""],
	["ative", measureAbove0, ""],
	["alize", measureAbove0, "al"],
];

const STEP_4: readonly Rule[] = [
	["al", measureAbove1, ""],
	["ance", measureAbove1, ""],
	["ence", measureAbove1, ""],
	["er", measureAbove1, ""],
	["ic", measureAbove1, ""],
	["able", measureAbove1, ""],
	["ible", measureAbove1, ""],
	["ant", measureAbove1, ""],
	["ement", measureAbove1, ""],
	["ment", measureAbove1, ""],
	["ent", measureAbove1, ""],
	["ion", measureAbove1EndsST, ""],
	["ou", measureAbove1, ""],
	["ism", measureAbove1, ""],
	["ate", measureAbove1, ""],
	["iti", measureAbove1, ""],
	["ous", measureAbove1, ""],
	["ive", measureAbove1, ""],
	["ize", measureAbove1, ""],
];

const STEP_1B2: readonly Rule[] = [
	["at", null, "ate"],
	["bl", null, "ble"],
	["iz", null, "ize"],
];

function endsWith(word: Uint8Array, length: number, suffix: string): boolean {
	if (length <= suffix.length) return false;
	for (let index = 0; index < suffix.length; index += 1) {
		if (word[length - suffix.length + index] !== suffix.charCodeAt(index)) return false;
	}
	return true;
}

/**
 * Applies the first rule whose suffix the word ends with (SQLite's generated steps switch on the second-last letter,
 * so only rules sharing it compete, and the first such match decides). Returns the new length and whether a rule's
 * replacement was made.
 */
function applyStep(word: Uint8Array, length: number, rules: readonly Rule[]): { length: number; changed: boolean } {
	const key = word[length - 2];
	for (const [suffix, condition, replacement] of rules) {
		if (suffix.charCodeAt(suffix.length - 2) !== key) continue;
		if (!endsWith(word, length, suffix)) continue;
		const stem = length - suffix.length;
		if (condition !== null && !condition(word, stem)) return { length, changed: false };
		for (let index = 0; index < replacement.length; index += 1) word[stem + index] = replacement.charCodeAt(index);
		return { length: stem + replacement.length, changed: true };
	}
	return { length, changed: false };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** FTS5's Porter stemmer over one folded token. */
export function porterStem(token: string): string {
	const bytes = encoder.encode(token);
	if (bytes.length > PORTER_MAX_TOKEN || bytes.length < 3) return token;
	// Room for the longest replacement growth ("at" to "ate" and the like).
	const word = new Uint8Array(bytes.length + 4);
	word.set(bytes);
	let length = bytes.length;

	// Step 1a.
	if (word[length - 1] === 115) {
		if (word[length - 2] === E) {
			if (
				(length > 4 && word[length - 4] === 115 && word[length - 3] === 115) ||
				(length > 3 && word[length - 3] === I)
			) {
				length -= 2;
			} else {
				length -= 1;
			}
		} else if (word[length - 2] !== 115) {
			length -= 1;
		}
	}

	// Step 1b: "eed" becomes "ee"; removing "ed" or "ing" leads on to the clean-up below.
	let removed = false;
	if (word[length - 2] === E) {
		if (endsWith(word, length, "eed")) {
			if (measureAbove0(word, length - 3)) length -= 1;
		} else if (endsWith(word, length, "ed") && hasVowel(word, length - 2)) {
			length -= 2;
			removed = true;
		}
	} else if (word[length - 2] === 110 && endsWith(word, length, "ing") && hasVowel(word, length - 3)) {
		length -= 3;
		removed = true;
	}
	if (removed) {
		const step1b2 = applyStep(word, length, STEP_1B2);
		length = step1b2.length;
		if (!step1b2.changed) {
			const last = word[length - 1]!;
			if (!isVowel(last, false) && last !== 108 && last !== 115 && last !== 122 && last === word[length - 2]) {
				length -= 1;
			} else if (measureIs1(word, length) && endsCvc(word, length)) {
				word[length] = E;
				length += 1;
			}
		}
	}

	// Step 1c.
	if (word[length - 1] === Y && hasVowel(word, length - 1)) word[length - 1] = I;

	length = applyStep(word, length, STEP_2).length;
	length = applyStep(word, length, STEP_3).length;
	length = applyStep(word, length, STEP_4).length;

	// Step 5a.
	if (word[length - 1] === E) {
		if (measureAbove1(word, length - 1) || (measureIs1(word, length - 1) && !endsCvc(word, length - 1))) length -= 1;
	}
	// Step 5b.
	if (length > 1 && word[length - 1] === 108 && word[length - 2] === 108 && measureAbove1(word, length - 1)) {
		length -= 1;
	}
	return decoder.decode(word.subarray(0, length));
}

/** The terms FTS5 with `tokenize = 'porter unicode61'` indexes for `text`, in order. */
export function ftsTerms(text: string): string[] {
	return unicode61Tokens(text).map(porterStem);
}

interface IndexedRow {
	readonly key: string;
	/** Per column, each term's positions in order. */
	readonly columns: readonly ReadonlyMap<string, readonly number[]>[];
	/** Tokens in every column. */
	readonly length: number;
}

/** A full-text index over rows of text columns, as an FTS5 table holds them. */
export interface FtsIndex {
	readonly rows: readonly IndexedRow[];
	/** The rows holding each term, in row order. */
	readonly postings: ReadonlyMap<string, readonly number[]>;
	readonly averageLength: number;
}

/** Indexes rows of text columns, as inserting them into an FTS5 table would. Every row needs the same columns. */
export function createFtsIndex(
	rows: readonly { readonly key: string; readonly columns: readonly string[] }[],
): FtsIndex {
	const columnCount = rows[0]?.columns.length ?? 0;
	const postings = new Map<string, number[]>();
	let total = 0;
	const indexed = rows.map(({ key, columns }, rowIndex) => {
		if (columns.length !== columnCount) throw new Error("Every row of a full-text index needs the same columns");
		let length = 0;
		const positioned = columns.map((text) => {
			const positions = new Map<string, number[]>();
			ftsTerms(text).forEach((term, position) => {
				const list = positions.get(term);
				if (list === undefined) positions.set(term, [position]);
				else list.push(position);
				length += 1;
				const rowsWith = postings.get(term);
				if (rowsWith === undefined) postings.set(term, [rowIndex]);
				else if (rowsWith[rowsWith.length - 1] !== rowIndex) rowsWith.push(rowIndex);
			});
			return positions;
		});
		total += length;
		return { key, columns: positioned, length };
	});
	return { rows: indexed, postings, averageLength: indexed.length === 0 ? 0 : total / indexed.length };
}

/** Instances of `phrase` (consecutive terms) in one column. */
function phraseCount(column: ReadonlyMap<string, readonly number[]>, phrase: readonly string[]): number {
	const starts = column.get(phrase[0]!);
	if (starts === undefined) return 0;
	if (phrase.length === 1) return starts.length;
	const rest = phrase.slice(1).map((term) => new Set(column.get(term) ?? []));
	let count = 0;
	for (const start of starts) {
		if (rest.every((positions, offset) => positions.has(start + offset + 1))) count += 1;
	}
	return count;
}

export interface FtsSearchOptions {
	/** `bm25()` weight per column, in column order; a missing weight is 1. */
	readonly weights?: readonly number[];
	/** Results to return, best first. Default every match. */
	readonly limit?: number;
}

/**
 * Rows matching any of `phrases` (an FTS5 query `"a" OR "b" …`), scored as FTS5's `bm25()` negated, so higher is
 * better, best first; ties keep row order. Each phrase is tokenised like the indexed text; one that yields no terms
 * matches nothing.
 */
export function searchFts(
	index: FtsIndex,
	phrases: readonly string[],
	options: FtsSearchOptions = {},
): { readonly key: string; readonly score: number }[] {
	const rowCount = index.rows.length;
	const terms = phrases.map(ftsTerms).filter((phrase) => phrase.length > 0);
	if (rowCount === 0 || terms.length === 0) return [];
	const weight = (column: number) => options.weights?.[column] ?? 1;
	// Each phrase's weighted frequency in each row that holds it.
	const frequencies = terms.map((phrase) => {
		const byRow = new Map<number, number>();
		for (const rowIndex of index.postings.get(phrase[0]!) ?? []) {
			let frequency = 0;
			let found = false;
			index.rows[rowIndex]!.columns.forEach((column, columnIndex) => {
				const count = phraseCount(column, phrase);
				if (count > 0) found = true;
				frequency += weight(columnIndex) * count;
			});
			if (found) byRow.set(rowIndex, frequency);
		}
		return byRow;
	});
	const idf = frequencies.map((byRow) => {
		const value = Math.log((rowCount - byRow.size + 0.5) / (byRow.size + 0.5));
		return value <= 0 ? 1e-6 : value;
	});
	const matched = new Set<number>();
	for (const byRow of frequencies) for (const rowIndex of byRow.keys()) matched.add(rowIndex);
	const results: { key: string; score: number; order: number }[] = [];
	for (const rowIndex of matched) {
		const row = index.rows[rowIndex]!;
		const norm = FTS_K1 * (1 - FTS_B + (FTS_B * row.length) / index.averageLength);
		let score = 0;
		frequencies.forEach((byRow, phraseIndex) => {
			const frequency = byRow.get(rowIndex) ?? 0;
			score += idf[phraseIndex]! * ((frequency * (FTS_K1 + 1)) / (frequency + norm));
		});
		results.push({ key: row.key, score, order: rowIndex });
	}
	results.sort((left, right) => right.score - left.score || left.order - right.order);
	const limited = options.limit === undefined ? results : results.slice(0, Math.max(0, options.limit));
	return limited.map(({ key, score }) => ({ key, score }));
}
