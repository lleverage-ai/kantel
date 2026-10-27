import { describe, expect, test } from "vitest";
import { containsSecret, REDACTED, redactText } from "../src/redact.ts";

describe("vault redaction", () => {
	const secret = 'canary"with\\escapes&<x>';
	const html = (value: string) =>
		value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

	test("redacts the literal value", () => {
		expect(redactText(`a ${secret} b`, secret)).toEqual({ text: `a ${REDACTED} b`, redactions: 1 });
	});

	test("redacts a JSON echo, which escapes quotes and backslashes", () => {
		const echoed = JSON.stringify({ headers: { "x-harbour-vault": secret } });
		const clean = redactText(echoed, secret);
		expect(clean.redactions).toBe(1);
		expect(JSON.parse(clean.text).headers["x-harbour-vault"]).toBe(REDACTED);
	});

	test("redacts URL, base64 and HTML encodings", () => {
		const encoded = [encodeURIComponent(secret), btoa(secret), html(secret)];
		expect(redactText(encoded.join(" "), secret).text).toBe([REDACTED, REDACTED, REDACTED].join(" "));
	});

	test("finds the value in a binary body", () => {
		const bytes = new Uint8Array([0, 1, ...new TextEncoder().encode(JSON.stringify(secret)), 255]);
		expect(containsSecret(bytes, secret)).toBe(true);
		expect(containsSecret(new Uint8Array([0, 1, 2]), secret)).toBe(false);
	});
});
