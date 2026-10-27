/**
 * Redaction of a vault secret from what upstream sends back. Literal matching alone misses an echo that re-encodes
 * the value (a JSON echo escapes quotes and backslashes), so the common encodings are matched too. Best effort: a real
 * vault should also refuse to inject into hosts that reflect request headers.
 */
export const REDACTED = "[vault:redacted]";

/**
 * Sets `name: value` on `headers` only if it will go out exactly as `value`. Headers trim surrounding whitespace and
 * reject some characters, and redaction looks for the value as stored, so a value the headers would change must not be
 * sent at all. Returns false (and leaves the header unset) in that case.
 */
export function injectHeader(headers: Headers, name: string, value: string): boolean {
	try {
		headers.set(name, value);
	} catch {
		return false;
	}
	if (headers.get(name) === value) return true;
	headers.delete(name);
	return false;
}

export function secretForms(secret: string): string[] {
	const bytes = new TextEncoder().encode(secret);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const forms = new Set<string>([
		secret,
		JSON.stringify(secret).slice(1, -1),
		encodeURIComponent(secret),
		btoa(binary),
		btoa(binary).replace(/=+$/, ""),
		secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
	]);
	// Longest first, so a form that contains another is replaced whole.
	return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

export function redactText(text: string, secret: string): { text: string; redactions: number } {
	let redactions = 0;
	for (const form of secretForms(secret)) {
		const parts = text.split(form);
		redactions += parts.length - 1;
		text = parts.join(REDACTED);
	}
	return { text, redactions };
}

/** For bodies that cannot be rewritten (binary): does any form of the secret appear in the bytes? */
export function containsSecret(bytes: Uint8Array, secret: string): boolean {
	let latin1 = "";
	for (let i = 0; i < bytes.length; i += 0x8000) latin1 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return secretForms(secret).some((form) => {
		let encoded = "";
		for (const byte of new TextEncoder().encode(form)) encoded += String.fromCharCode(byte);
		return latin1.includes(encoded);
	});
}
