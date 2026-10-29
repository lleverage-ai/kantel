// How the model picker orders a catalogue: by provider, then newest and largest first. Pure, so it is tested without a
// page (model-order.test.ts).
//
// The catalogue's own order is the host's config order, which reads as random ("Claude Sonnet 5.5, Claude Sonnet 5,
// GPT-6 Sol, Claude Opus 5.5, ..."). The picker reorders it from the labels alone, since the catalogue carries no
// release dates or sizes:
//
// - Providers keep the order they first appear in, so the catalogue's default model's provider comes first.
// - Within a provider, models group by family (the label's name before its version, less any size word: "Claude",
//   "GPT", "Gemini", "o"), the family with the newest version first.
// - Within a family the newest version comes first ("Claude Opus 5.5" before "Claude Opus 5"), and within a version
//   the largest variant first ("Opus" before "Sonnet" before "Haiku"; "GPT-5.4 Pro" before "GPT-5.4" before
//   "GPT-5.4 mini"). A preview, a dated snapshot or an alias follows the plain model.
// - Anything else (no version in its label) keeps the catalogue's order, after the versioned families.

/** One entry the order reads: a label, and the provider it is grouped under. */
export type OrderableModel = { readonly label: string; readonly provider?: string | undefined };

/**
 * Size words, larger first, as a score: higher is larger. A label without one is the family's plain model (score 5),
 * which sits between its larger variants ("Pro") and its smaller ones ("mini"). A label with two takes the smaller
 * ("Flash Lite" is smaller than "Flash"). Sourced from each provider's own line-up and list prices.
 */
const SIZE_WORDS: Readonly<Record<string, number>> = {
	// Anthropic: Fable above Opus above Sonnet above Haiku.
	fable: 9,
	opus: 8,
	sonnet: 4,
	haiku: 2,
	// OpenAI's GPT-6 and 5.6 tiers: Astra above Sol above Terra above Luna.
	astra: 9,
	sol: 7,
	terra: 4,
	luna: 2,
	// Common size words.
	ultra: 9,
	max: 8,
	pro: 7,
	large: 6,
	plus: 6,
	medium: 4,
	flash: 3,
	small: 2,
	lite: 1,
	mini: 1,
	nano: 0,
	tiny: 0,
};
const PLAIN_SIZE = 5;

/** Words that mark a variant to list after the plain model: a preview, an alias, a snapshot. */
const LATER_WORDS = new Set(["preview", "latest", "exp", "experimental", "beta", "alpha"]);

/** What the order reads from a label. Exported for the tests. */
export type ModelName = {
	/** The family: the words before the version, less size words, lower case ("claude", "gpt", "o"). */
	readonly family: string;
	/** The version's numbers ("4.5" is [4, 5]); empty for a label without one. */
	readonly version: readonly number[];
	/** The size score (SIZE_WORDS), PLAIN_SIZE without a size word. */
	readonly size: number;
	/** A parameter count in billions ("31B"), for open-weight models; 0 when the label has none. */
	readonly params: number;
	/** 1 for a preview, alias or snapshot, 0 otherwise. */
	readonly later: number;
	/** How many words the label has beyond its family, version and size: "Codex Spark" is 2. Fewer first. */
	readonly extra: number;
};

const VERSION = /^v?(\d+(?:\.\d+)*)([a-z]?)$/i;
const PARAMS = /^(\d+(?:\.\d+)?)([bm])$/i;
const DATE = /^\d{4}-?\d{2}(?:-?\d{2})?$/;

/** Reads a label: "Claude Opus 4.5", "GPT-5.4 mini", "o3-pro", "Gemini 2.5 Flash-Lite", "Gemma 4 31B IT". */
export function parseModelName(label: string): ModelName {
	let later = /\((?:[^)]*\d{4}[^)]*|latest|preview)\)/i.test(label) ? 1 : 0;
	const words = label
		.replace(/\([^)]*\)/g, " ")
		.split(/[\s\-_/:]+/)
		.filter(Boolean);
	const family: string[] = [];
	let version: number[] = [];
	const sizes: number[] = [];
	let params = 0;
	let extra = 0;
	for (const raw of words) {
		const word = raw.toLowerCase();
		if (DATE.test(word)) {
			later = 1;
			continue;
		}
		const params_ = PARAMS.exec(word);
		if (params_?.[1] !== undefined) {
			params = Number(params_[1]) / (params_[2]?.toLowerCase() === "m" ? 1000 : 1);
			continue;
		}
		if (version.length === 0) {
			const number = VERSION.exec(word);
			if (number?.[1] !== undefined) {
				version = number[1].split(".").map(Number);
				// "4o" is GPT-4o: a variant of 4, after 4 itself would be. Ignore the letter for the order.
				continue;
			}
			// A version glued to the family: "o3", "gpt5".
			const glued = /^([a-z]+)(\d+(?:\.\d+)*)$/i.exec(word);
			if (glued?.[1] !== undefined && glued[2] !== undefined && family.length === 0) {
				family.push(glued[1]);
				version = glued[2].split(".").map(Number);
				continue;
			}
		}
		const size = SIZE_WORDS[word];
		if (size !== undefined) {
			sizes.push(size);
			continue;
		}
		if (LATER_WORDS.has(word)) {
			later = 1;
			continue;
		}
		if (version.length === 0) family.push(word);
		else extra += 1;
	}
	return {
		family: family.join(" "),
		version,
		size: sizes.length === 0 ? PLAIN_SIZE : Math.min(...sizes),
		params,
		later,
		extra,
	};
}

/** Newer first: [5, 5] before [5] before [4, 8]. A missing part counts as 0, so 5 and 5.0 tie. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (b[index] ?? 0) - (a[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** A provider's key for grouping: what the catalogue calls it, or "" for a model without one. */
export const providerKey = (model: OrderableModel): string => model.provider?.trim() ?? "";

/** The providers in the order they first appear in the catalogue: the default model's provider, usually, first. */
export function providerOrder(models: readonly OrderableModel[]): string[] {
	const seen: string[] = [];
	for (const model of models) {
		const key = providerKey(model);
		if (!seen.includes(key)) seen.push(key);
	}
	return seen;
}

/**
 * The catalogue as the picker lists it: grouped by provider, each provider's models newest and largest first (see the
 * file's head). Stable: models the order can't tell apart keep the catalogue's order.
 */
export function orderModels<T extends OrderableModel>(models: readonly T[]): T[] {
	const providers = providerOrder(models);
	const entries = models.map((model, index) => ({ model, index, name: parseModelName(model.label) }));
	// Each family's newest version and first place in the catalogue, per provider.
	const families = new Map<string, { newest: readonly number[]; first: number }>();
	for (const entry of entries) {
		if (entry.name.version.length === 0) continue;
		const key = `${providerKey(entry.model)}\n${entry.name.family}`;
		const family = families.get(key);
		if (family === undefined) families.set(key, { newest: entry.name.version, first: entry.index });
		else if (compareVersions(entry.name.version, family.newest) < 0) family.newest = entry.name.version;
	}
	const familyOf = (entry: (typeof entries)[number]) =>
		families.get(`${providerKey(entry.model)}\n${entry.name.family}`);
	return entries
		.sort((a, b) => {
			const byProvider = providers.indexOf(providerKey(a.model)) - providers.indexOf(providerKey(b.model));
			if (byProvider !== 0) return byProvider;
			const familyA = familyOf(a);
			const familyB = familyOf(b);
			// Versioned families first; a label without a version keeps the catalogue's order after them.
			if (familyA === undefined || familyB === undefined) {
				if (familyA !== familyB) return familyA === undefined ? 1 : -1;
				return a.index - b.index;
			}
			if (familyA !== familyB) return compareVersions(familyA.newest, familyB.newest) || familyA.first - familyB.first;
			return (
				compareVersions(a.name.version, b.name.version) ||
				b.name.size - a.name.size ||
				b.name.params - a.name.params ||
				a.name.later - b.name.later ||
				a.name.extra - b.name.extra ||
				a.index - b.index
			);
		})
		.map((entry) => entry.model);
}
