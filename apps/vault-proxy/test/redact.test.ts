import { describe, expect, test } from "bun:test";
import { assertRedactable, REDACTED, Redactor } from "../src/redact.ts";

const secret = "sk-live/abc+DEF=123:xyz";

describe("vault redaction", () => {
	const redactor = new Redactor([secret]);

	test("the secret as sent, JSON-escaped and percent-encoded is replaced", () => {
		for (const echo of [
			JSON.stringify({ headers: { "x-harbour-vault": secret } }),
			JSON.stringify({ headers: { "x-harbour-vault": secret } }).replaceAll("/", "\\/"),
			`https://example.com/?k=${encodeURIComponent(secret)}`,
			`<p>${secret}</p>`,
		]) {
			const { text, count } = redactor.text(echo);
			expect(count).toBe(1);
			expect(text).toContain(REDACTED);
			expect(text).not.toContain(secret);
			expect(text).not.toContain(encodeURIComponent(secret));
			expect(text).not.toContain(secret.replaceAll("/", "\\/"));
		}
	});

	test("decoding a JSON echo cannot recover the secret", () => {
		for (const body of [JSON.stringify({ v: secret }), JSON.stringify({ v: secret }).replaceAll("/", "\\/")]) {
			const decoded = JSON.parse(redactor.text(body).text) as { v: string };
			expect(decoded.v).toBe(REDACTED);
		}
	});

	test("every occurrence is counted, and other text is untouched", () => {
		const { text, count } = redactor.text(`a ${secret} b ${secret} c`);
		expect(count).toBe(2);
		expect(text).toBe(`a ${REDACTED} b ${REDACTED} c`);
	});

	test("secrets an encoder would escape unpredictably are refused at startup", () => {
		expect(() => assertRedactable("S", 'canary"quoted')).toThrow();
		expect(() => assertRedactable("S", "back\\slash-secret")).toThrow();
		expect(() => assertRedactable("S", "short")).toThrow();
		expect(() => assertRedactable("S", secret)).not.toThrow();
	});
});
