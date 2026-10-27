// Keeping injected secrets out of what the vault hands back to a sandbox.
//
// Redaction is defence in depth, not the boundary: an upstream that echoes a
// header could transform it in any way (base64, reversed, split), so the real
// rule is not to allow echoing upstreams with a secret on them outside tests.
// What this does catch: the secret as sent, as a JSON string encoder writes
// it, and percent-encoded. Secrets are limited to the characters API keys use,
// so those three forms are the only ones plain JSON, HTML or URL echoes produce.

export const REDACTED = "[vault:redacted]";

const SECRET_CHARS = /^[A-Za-z0-9._~+/=:-]{8,}$/;

/** Refuse a secret redaction could miss: too short, or with characters an encoder would escape unpredictably. */
export function assertRedactable(name: string, secret: string): void {
	if (!SECRET_CHARS.test(secret)) {
		throw new Error(`${name}: a vault secret must be at least 8 characters of [A-Za-z0-9._~+/=:-]`);
	}
}

/** The byte strings a secret can appear as in an echo. */
export function formsOf(secret: string): string[] {
	const forms = new Set([secret, secret.replaceAll("/", "\\/"), encodeURIComponent(secret)]);
	return [...forms];
}

export class Redactor {
	readonly #needles: Buffer[];

	constructor(secrets: string[]) {
		const forms = secrets.flatMap(formsOf);
		// Longest first, so a form that contains another is replaced whole.
		this.#needles = [...new Set(forms)].sort((a, b) => b.length - a.length).map((s) => Buffer.from(s));
	}

	text(input: string): { text: string; count: number } {
		const { bytes, count } = this.bytes(Buffer.from(input));
		return { text: bytes.toString(), count };
	}

	bytes(input: Buffer): { bytes: Buffer; count: number } {
		let out = input;
		let count = 0;
		for (const needle of this.#needles) {
			if (out.indexOf(needle) === -1) continue;
			const pieces: Buffer[] = [];
			let from = 0;
			for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, from)) {
				pieces.push(out.subarray(from, at), Buffer.from(REDACTED));
				from = at + needle.length;
				count++;
			}
			pieces.push(out.subarray(from));
			out = Buffer.concat(pieces);
		}
		return { bytes: out, count };
	}
}
