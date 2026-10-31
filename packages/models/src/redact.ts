/**
 * Redaction of known secret values from the model gateway's event stream (docs/model-connectors.md, "Redaction").
 *
 * The provider key is never in anything the runtime sends or receives by construction; what remains is an upstream
 * echoing it back, typically in an error body. `Redactor` replaces every known secret in a string, in every spelling
 * it matches, and `StreamRedactor` does it across a stream of deltas: per content block it holds back the end of the
 * text from the first character that could begin a spelling of a secret, so a secret split across deltas is still
 * caught, even inside a JSON escape, and flushes the rest at the block's end.
 *
 * How this relates to `apps/vault-proxy/src/redact.ts`: the vault proxy redacts whole upstream bodies at byte level
 * and matches every encoded spelling a text encoder could give a secret (JSON and HTML escapes, percent encoding),
 * since a sandbox may receive any body. Here the input is pi's already-parsed events, so the secret appears as plain
 * text: the gateway matches it literally, and the JSON `\u` or `\/` escapes a JSON-in-text error echo, or a tool
 * call's raw argument JSON, can carry. It is portable (no `Buffer`) and does not import from apps.
 */
import type { JsonValue } from "@kantel/contracts";

export const REDACTED = "[harbour:redacted]";

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** The longest spelling of one character: a JSON `\uXXXX` escape. */
const LONGEST_CHAR_SPELLING = 6;

/** One way of spelling a character. An escape matches its `u` and hex digits in either case. */
interface CharSpelling {
	readonly text: string;
	readonly escape: boolean;
}

/** The spellings `charPattern` matches for `char`: itself, its `\uXXXX` escape, and `\/` for `/`. */
function charSpellings(char: string): readonly CharSpelling[] {
	const code = char.charCodeAt(0).toString(16).padStart(4, "0");
	const spellings: CharSpelling[] = [
		{ text: char, escape: false },
		{ text: `\\u${code}`, escape: true },
	];
	if (char === "/") spellings.push({ text: "\\/", escape: true });
	return spellings;
}

/** One character, literally or as a JSON `\uXXXX` escape (and `\/` for `/`). */
function charPattern(char: string): string {
	const code = char.charCodeAt(0).toString(16).padStart(4, "0");
	const hex = code
		.split("")
		.map((digit) => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit))
		.join("");
	const spellings = [escapeRegex(char), `\\\\[uU]${hex}`];
	if (char === "/") spellings.push("\\\\/");
	return `(?:${spellings.join("|")})`;
}

/** Whether `text` from `at` on spells `secret` from character `from` on, cut short: it ends before the spelling does. */
function isCutShortSpelling(
	text: string,
	at: number,
	secret: readonly (readonly CharSpelling[])[],
	from: number,
): boolean {
	if (at === text.length) return true;
	if (from === secret.length) return false;
	for (const spelling of secret[from]!) {
		const length = Math.min(spelling.text.length, text.length - at);
		const seen = text.slice(at, at + length);
		const expected = spelling.text.slice(0, length);
		if (spelling.escape ? seen.toLowerCase() !== expected.toLowerCase() : seen !== expected) continue;
		if (length < spelling.text.length) return true;
		if (isCutShortSpelling(text, at + length, secret, from + 1)) return true;
	}
	return false;
}

export class Redactor {
	readonly #patterns: readonly RegExp[];
	readonly #spellings: readonly (readonly (readonly CharSpelling[])[])[];
	/** The longest secret's length, in characters. */
	readonly maxSecretLength: number;
	/** The longest spelling the redactor matches: the longest secret with every character as a `\uXXXX` escape. */
	readonly maxSpellingLength: number;

	/** Secrets shorter than 4 characters are ignored; redacting them would only mangle text. */
	constructor(secrets: readonly string[]) {
		const usable = [...new Set(secrets)].filter((secret) => secret.length >= 4);
		// Longest first, so a secret that contains another is replaced whole.
		usable.sort((a, b) => b.length - a.length);
		this.#patterns = usable.map((secret) => new RegExp([...secret].map(charPattern).join(""), "g"));
		this.#spellings = usable.map((secret) => [...secret].map(charSpellings));
		this.maxSecretLength = usable[0]?.length ?? 0;
		this.maxSpellingLength = this.maxSecretLength * LONGEST_CHAR_SPELLING;
	}

	text(input: string): string {
		let text = input;
		for (const pattern of this.#patterns) text = text.replace(pattern, REDACTED);
		return text;
	}

	/**
	 * Where the end of `text` could begin a spelling of a secret that more text would complete: the index of the first
	 * such character, or `text.length` when none could. `text` is already redacted, so it holds no whole spelling.
	 */
	partialSecretStart(text: string): number {
		const earliest = Math.max(0, text.length - (this.maxSpellingLength - 1));
		for (let at = earliest; at < text.length; at += 1) {
			if (this.#spellings.some((secret) => isCutShortSpelling(text, at, secret, 0))) return at;
		}
		return text.length;
	}

	/** Redacts every string in a JSON value, keys included. */
	json<T extends JsonValue>(value: T): T {
		if (typeof value === "string") return this.text(value) as T;
		if (Array.isArray(value)) return value.map((item) => this.json(item)) as unknown as T;
		if (typeof value === "object" && value !== null) {
			const out: { [key: string]: JsonValue } = {};
			for (const [key, inner] of Object.entries(value)) out[this.text(key)] = this.json(inner);
			return out as T;
		}
		return value;
	}
}

/**
 * Redacts the deltas of a stream of content blocks. `push` returns what may be released now (possibly empty); `end`
 * returns the rest of a block when it ends. Released text never holds a secret in any spelling the redactor matches,
 * even one split across deltas or inside an escape, because everything from the first character that could begin a
 * spelling stays back until more arrives or the block ends.
 */
export class StreamRedactor {
	readonly #redactor: Redactor;
	readonly #pending = new Map<number, string>();

	constructor(redactor: Redactor) {
		this.#redactor = redactor;
	}

	push(block: number, delta: string): string {
		const text = this.#redactor.text((this.#pending.get(block) ?? "") + delta);
		const cut = this.#redactor.partialSecretStart(text);
		this.#pending.set(block, text.slice(cut));
		return text.slice(0, cut);
	}

	end(block: number): string {
		const rest = this.#pending.get(block) ?? "";
		this.#pending.delete(block);
		return this.#redactor.text(rest);
	}
}
