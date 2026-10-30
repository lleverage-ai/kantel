import { describe, expect, test } from "bun:test";
import { placeholderIn, withInjection } from "../src/placeholder.ts";
import { REDACTED, Redactor } from "../src/redact.ts";

const placeholder = `harbour-ph-${"a1".repeat(16)}`;
const other = `harbour-ph-${"b2".repeat(16)}`;
const secret = "sk-live-0123456789abcdef";
const inject = { header: "Authorization", value: `Bearer ${secret}` };

describe("placeholderIn", () => {
	test("finds a placeholder in Authorization or x-api-key", () => {
		expect(placeholderIn(new Headers({ authorization: `Bearer ${placeholder}` }))).toEqual({
			kind: "one",
			header: "authorization",
			placeholder,
		});
		expect(placeholderIn(new Headers({ "x-api-key": placeholder }))).toEqual({
			kind: "one",
			header: "x-api-key",
			placeholder,
		});
	});

	test("never looks anywhere but the auth headers", () => {
		const headers = new Headers({
			"x-forwarded-key": placeholder,
			cookie: `key=${placeholder}`,
			"user-agent": placeholder,
		});
		expect(placeholderIn(headers)).toEqual({ kind: "none" });
	});

	test("refuses two different placeholders rather than picking one", () => {
		expect(placeholderIn(new Headers({ authorization: `Bearer ${placeholder}`, "x-api-key": other }))).toEqual({
			kind: "ambiguous",
		});
		expect(placeholderIn(new Headers({ authorization: `${placeholder} ${other}` }))).toEqual({ kind: "ambiguous" });
		expect(
			placeholderIn(new Headers({ authorization: `Bearer ${placeholder}`, "x-api-key": placeholder })),
		).toMatchObject({
			kind: "one",
		});
	});
});

describe("withInjection", () => {
	test("drops the header that carried the placeholder and sets the vault's one", () => {
		const sent = new Headers({ "x-api-key": placeholder, accept: "application/json" });
		const out = withInjection(sent, placeholderIn(sent), inject);
		expect(out.get("x-api-key")).toBeNull();
		expect(out.get("authorization")).toBe(`Bearer ${secret}`);
		expect(out.get("accept")).toBe("application/json");
	});

	test("a placeholder in the query string is left as it is: the key never goes into the URL", () => {
		const target = new URL(`https://api.example.com/v1/models?key=${placeholder}`);
		const sent = new Headers({ accept: "application/json" });
		const found = placeholderIn(sent);
		expect(found).toEqual({ kind: "none" });
		const out = withInjection(sent, found, undefined);
		expect(target.href).toContain(placeholder);
		expect(target.href).not.toContain(secret);
		expect(out.get("authorization")).toBeNull();
	});

	test("a placeholder in another header goes out as it is, never swapped for the key", () => {
		const sent = new Headers({ authorization: `Bearer ${placeholder}`, "x-debug": placeholder });
		const out = withInjection(sent, placeholderIn(sent), inject);
		expect(out.get("x-debug")).toBe(placeholder);
		expect([...out.values()].filter((value) => value.includes(secret))).toEqual([`Bearer ${secret}`]);
	});
});

describe("an echoing upstream", () => {
	test("sees the key only in the one injected header, and the sandbox gets back the placeholder or a redaction", () => {
		const url = `https://echo.example/anything?token=${placeholder}`;
		const body = JSON.stringify({ note: `my key is ${placeholder}` });
		const sent = new Headers({ authorization: `Bearer ${placeholder}`, "x-trace": placeholder });
		const out = withInjection(sent, placeholderIn(sent), inject);
		// What an echo service answers: everything it was sent, the injected header included.
		const echoed = JSON.stringify({ url, headers: Object.fromEntries(out.entries()), body });
		const answer = new Redactor([secret]).text(echoed);
		expect(answer.count).toBe(1);
		expect(answer.text).not.toContain(secret);
		expect(answer.text).toContain(REDACTED);
		expect(answer.text).toContain(placeholder);
	});
});
