// Keeping injected secrets out of what the vault hands back to a sandbox.
//
// Redaction is defence in depth, not the boundary: an upstream that echoes a
// header could transform it in any way (base64, reversed, split), so the real
// rule is not to allow echoing upstreams with a secret on them outside tests.
// What this does catch is every spelling the standard text encodings give a
// secret, character by character and mixed: the character itself, a JSON
// `\uXXXX` escape (and `\/`), a percent escape, and an HTML numeric (with or
// without its `;`) or named character reference, with hex digits in either
// case. Secrets are limited to the characters API keys use, so no other common
// encoding changes them.

export const REDACTED = "[vault:redacted]";

const SECRET_CHARS = /^[A-Za-z0-9._~+/=:-]{8,}$/;

/** Refuse a secret redaction could miss: too short, or with characters an encoder would escape unpredictably. */
export function assertRedactable(name: string, secret: string): void {
	if (!SECRET_CHARS.test(secret)) {
		throw new Error(`${name}: a vault secret must be at least 8 characters of [A-Za-z0-9._~+/=:-]`);
	}
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Hex digits matching in either case, with optional leading zeros where the encoding allows them. */
const hex = (value: number, width: number) =>
	value
		.toString(16)
		.padStart(width, "0")
		.split("")
		.map((digit) => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit))
		.join("");

/**
 * Every HTML named character reference that decodes to characters a secret may
 * contain: the whole WHATWG table filtered to [A-Za-z0-9._~+/=:-]. `-` and `~`
 * have none; `&fjlig;` is the only one that stands for two characters.
 */
const NAMED: Record<string, string[]> = {
	".": ["period"],
	"/": ["sol"],
	":": ["colon"],
	"+": ["plus"],
	"=": ["equals"],
	_: ["lowbar", "UnderBar"],
};

/** Every encoded spelling of one ASCII character. */
function charPattern(char: string): string {
	const code = char.charCodeAt(0);
	const spellings = [
		escapeRegex(char),
		`\\\\[uU]${hex(code, 4)}`, // JSON \u002f
		`%${hex(code, 2)}`, // percent encoding, %2F or %2f
		`&#0*${code};?`, // HTML decimal reference; browsers accept it without the `;`
		`&#[xX]0*${hex(code, 1)};?`, // HTML hex reference
		...(NAMED[char] ?? []).map((name) => `&${name};`),
	];
	if (char === "/") spellings.push("\\\\/"); // JSON \/
	return `(?:${spellings.join("|")})`;
}

/** A pattern matching the secret in any mix of its encoded spellings. */
export function patternOf(secret: string): RegExp {
	const parts: string[] = [];
	for (let i = 0; i < secret.length; i++) {
		if (secret.startsWith("fj", i)) {
			parts.push(`(?:${charPattern("f")}${charPattern("j")}|&fjlig;)`);
			i++;
		} else parts.push(charPattern(secret.charAt(i)));
	}
	return new RegExp(parts.join(""), "g");
}

export class Redactor {
	readonly #patterns: RegExp[];

	constructor(secrets: string[]) {
		// Longest first, so a secret that contains another is replaced whole.
		this.#patterns = [...new Set(secrets)].sort((a, b) => b.length - a.length).map(patternOf);
	}

	text(input: string): { text: string; count: number } {
		const { bytes, count } = this.bytes(Buffer.from(input));
		return { text: bytes.toString(), count };
	}

	/** Works on the bytes as latin1, so any body (UTF-8 or not) passes through unchanged apart from the matches. */
	bytes(input: Buffer): { bytes: Buffer; count: number } {
		let text = input.toString("latin1");
		let count = 0;
		for (const pattern of this.#patterns) {
			text = text.replace(pattern, () => {
				count++;
				return REDACTED;
			});
		}
		return count === 0 ? { bytes: input, count } : { bytes: Buffer.from(text, "latin1"), count };
	}
}
