import { describe, expect, test } from "bun:test";
import { assertRedactable, REDACTED, Redactor } from "../src/redact.ts";

const secret = "sk-live/abc+DEF=123:x.y_z";

const NAMED: Record<string, string[]> = {
	".": ["period"],
	"/": ["sol"],
	":": ["colon"],
	"+": ["plus"],
	"=": ["equals"],
	_: ["lowbar", "UnderBar"],
};
const redactor = new Redactor([secret]);

/** Every way of writing one character that the redactor must see through. */
const spellings = (char: string): string[] => {
	const code = char.charCodeAt(0);
	const h2 = code.toString(16).padStart(2, "0");
	const h4 = code.toString(16).padStart(4, "0");
	const all = [
		char,
		`\\u${h4}`,
		`\\u${h4.toUpperCase()}`,
		`%${h2}`,
		`%${h2.toUpperCase()}`,
		`&#${code};`,
		`&#x${code.toString(16)};`,
		`&#X${code.toString(16).toUpperCase()};`,
		`&#00${code};`,
		...(NAMED[char] ?? []).map((name) => `&${name};`),
	];
	if (char === "/") all.push("\\/");
	return all;
};

describe("vault redaction", () => {
	test("the secret as sent, JSON-escaped, percent-encoded and as HTML references is replaced", () => {
		for (const echo of [
			JSON.stringify({ headers: { "x-harbour-vault": secret } }),
			JSON.stringify({ headers: { "x-harbour-vault": secret } }).replaceAll("/", "\\/"),
			`{"v":"${secret.replace("/", "\\u002f")}"}`,
			`{"v":"${[...secret].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}`,
			`https://example.com/?k=${encodeURIComponent(secret)}`,
			`https://example.com/?k=${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())}`,
			`/?k=${secret.replace("/", "%2f")}`,
			`<p>${secret}</p>`,
			`<p>${[...secret].map((c) => `&#${c.charCodeAt(0)};`).join("")}</p>`,
			`<p>${secret.replace("/", "&sol;").replace(":", "&colon;").replace("_", "&lowbar;")}</p>`,
			`<p>${secret.replace("/", "&#47")}</p>`,
		]) {
			const { text, count } = redactor.text(echo);
			expect(count, echo).toBe(1);
			expect(text).toContain(REDACTED);
			expect(decodeAll(text)).not.toContain(secret);
		}
	});

	test("any mix of spellings, one per character, is replaced", () => {
		for (let round = 0; round < 200; round++) {
			const mixed = [...secret]
				.map((char) => {
					const options = spellings(char);
					return options[Math.floor(Math.random() * options.length)];
				})
				.join("");
			const { text, count } = redactor.text(`{"v":"${mixed}"}`);
			expect(count, mixed).toBe(1);
			expect(text).toBe(`{"v":"${REDACTED}"}`);
		}
	});

	test("decoding a JSON echo cannot recover the secret", () => {
		for (const body of [
			JSON.stringify({ v: secret }),
			JSON.stringify({ v: secret }).replaceAll("/", "\\/"),
			JSON.stringify({ v: secret }).replace("/", "\\u002F"),
		]) {
			const decoded = JSON.parse(redactor.text(body).text) as { v: string };
			expect(decoded.v).toBe(REDACTED);
		}
	});

	test("&fjlig;, the one reference for two characters, is seen through", () => {
		const fj = new Redactor(["abcdfj12"]);
		for (const body of ["abcd&fjlig;12", "abcdfj12", "abcd&#102;j12", "abcdf%6a12"]) {
			expect(fj.text(body), body).toEqual({ text: REDACTED, count: 1 });
		}
		expect(new Redactor(["fjfjfjfj"]).text("&fjlig;fj&fjlig;f&#106;")).toEqual({ text: REDACTED, count: 1 });
	});

	test("every occurrence is counted, and other text and bytes are untouched", () => {
		const { text, count } = redactor.text(`a ${secret} b ${secret} c`);
		expect(count).toBe(2);
		expect(text).toBe(`a ${REDACTED} b ${REDACTED} c`);
		const binary = Buffer.from([0xff, 0x00, 0xc3, 0xa9, 0x80]);
		expect(redactor.bytes(binary).bytes.equals(binary)).toBe(true);
		const utf8 = Buffer.from(`é ${secret} ü`);
		expect(redactor.bytes(utf8).bytes.toString()).toBe(`é ${REDACTED} ü`);
	});

	test("matching is case-sensitive for the secret itself", () => {
		expect(redactor.text(secret.toUpperCase()).count).toBe(0);
	});

	test("secrets an encoder would escape unpredictably are refused at startup", () => {
		expect(() => assertRedactable("S", 'canary"quoted')).toThrow();
		expect(() => assertRedactable("S", "back\\slash-secret")).toThrow();
		expect(() => assertRedactable("S", "with space1")).toThrow();
		expect(() => assertRedactable("S", "short")).toThrow();
		expect(() => assertRedactable("S", secret)).not.toThrow();
	});
});

/** What a sandbox could do to the response: undo JSON, percent and HTML escaping. */
function decodeAll(text: string): string {
	return text
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
		.replace(/\\\//g, "/")
		.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
		.replace(/&#[xX]([0-9a-fA-F]+);?/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
		.replace(/&#([0-9]+);?/g, (_, d) => String.fromCharCode(Number(d)))
		.replace(/&([A-Za-z]+);/g, (whole, name) => {
			const entry = Object.entries(NAMED).find(([, names]) => names.includes(name));
			return entry === undefined ? whole : entry[0];
		});
}
