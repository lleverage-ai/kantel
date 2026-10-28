import { REDACTED, Redactor, StreamRedactor } from "@harbour/models/redact";
import { describe, expect, it } from "vitest";

const SECRET = "sk-live-0123456789abcdef/xyz";

const decodeEscapes = (text: string) =>
	text.replace(/\\[uU]([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

describe("Redactor", () => {
	it("replaces a secret literally and in its JSON escapes", () => {
		const redactor = new Redactor([SECRET]);
		expect(redactor.text(`key ${SECRET} and ${SECRET}.`)).toBe(`key ${REDACTED} and ${REDACTED}.`);
		expect(redactor.text(JSON.stringify({ message: `bad key ${SECRET}` }))).not.toContain("0123456789abcdef");
		expect(redactor.text("sk-live-0123456789abcdef\\/xyz")).toBe(REDACTED);
		expect(redactor.text("sk\\u002dlive-0123456789abcdef/xyz")).toBe(REDACTED);
		expect(redactor.text("nothing secret here")).toBe("nothing secret here");
	});

	it("redacts every string in a JSON value, keys included", () => {
		const redactor = new Redactor([SECRET]);
		expect(redactor.json({ query: SECRET, nested: [{ [SECRET]: 1 }], n: 2 })).toEqual({
			query: REDACTED,
			nested: [{ [REDACTED]: 1 }],
			n: 2,
		});
	});

	it("ignores secrets too short to redact safely", () => {
		expect(new Redactor(["abc", ""]).text("abc")).toBe("abc");
		expect(new Redactor([]).maxSecretLength).toBe(0);
	});
});

describe("StreamRedactor", () => {
	it("catches a secret split across deltas, holding back no more than it must", () => {
		const stream = new StreamRedactor(new Redactor([SECRET]));
		const text = `Here: ${SECRET} done. ${"x".repeat(60)}`;
		let released = "";
		for (let at = 0; at < text.length; at += 5) {
			const chunk = stream.push(0, text.slice(at, at + 5));
			expect(chunk).not.toContain("0123456789abcdef");
			released += chunk;
		}
		expect(released.length).toBeGreaterThan(0);
		released += stream.end(0);
		expect(released).toBe(`Here: ${REDACTED} done. ${"x".repeat(60)}`);
	});

	it("catches a secret split inside its JSON escapes, which pi's client would decode", () => {
		// The reviewer's case: `s` escaped, then the rest in two deltas.
		const short = new StreamRedactor(new Redactor(["sk-test"]));
		let released = ["\\u0073", "k-", "test"].map((delta) => short.push(0, delta)).join("");
		expect(released + short.end(0)).toBe(REDACTED);

		// Every character escaped, split mid-escape, and an escaped `/`.
		const escaped = [...SECRET]
			.map((char, at) =>
				char === "/" ? "\\/" : `\\${at % 2 === 0 ? "u" : "U"}${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
			)
			.join("");
		const json = `{"query":"${escaped}","limit":3}`;
		const stream = new StreamRedactor(new Redactor([SECRET]));
		released = "";
		for (let at = 0; at < json.length; at += 4) {
			released += stream.push(0, json.slice(at, at + 4));
			expect(decodeEscapes(released)).not.toContain("sk-l");
		}
		released += stream.end(0);
		expect(released).toBe(`{"query":"${REDACTED}","limit":3}`);
	});

	it("holds back only text that could begin a secret", () => {
		const stream = new StreamRedactor(new Redactor([SECRET]));
		expect(stream.push(0, "plain words, ")).toBe("plain words, ");
		expect(stream.push(0, "then sk-li")).toBe("then ");
		expect(stream.push(0, "ght reading")).toBe("sk-light reading");
		expect(stream.push(0, " and \\u00")).toBe(" and ");
		expect(stream.push(0, "41.")).toBe("\\u0041.");
		expect(stream.end(0)).toBe("");
	});

	it("keeps content blocks apart and releases everything with no secrets", () => {
		const stream = new StreamRedactor(new Redactor([]));
		expect(stream.push(0, "hello")).toBe("hello");
		const redacting = new StreamRedactor(new Redactor([SECRET]));
		expect(redacting.push(0, SECRET.slice(0, 10))).toBe("");
		expect(redacting.push(1, "other block")).toBe("other block");
		expect(redacting.end(1)).toBe("");
		expect(redacting.push(0, SECRET.slice(10))).toBe(REDACTED);
		expect(redacting.end(0)).toBe("");
	});
});
