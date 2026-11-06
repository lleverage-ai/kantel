import { describe, expect, it } from "vitest";
import { createComputeFixtures } from "./fixtures.ts";
import { looksLikeOrigin } from "./host-join.tsx";
import { limitBytes, limitText, parseLabels } from "./hosts-page.tsx";

describe("the public URL field", () => {
	it("takes an origin, with or without its trailing slash", () => {
		expect(looksLikeOrigin("https://kantel.example.com")).toBe(true);
		expect(looksLikeOrigin(" http://10.0.0.5:58090/ ")).toBe(true);
	});

	it("refuses a path, a query or something that isn't http(s)", () => {
		expect(looksLikeOrigin("https://kantel.example.com/console")).toBe(false);
		expect(looksLikeOrigin("https://kantel.example.com?x=1")).toBe(false);
		expect(looksLikeOrigin("kantel.example.com")).toBe(false);
		expect(looksLikeOrigin("ftp://kantel.example.com")).toBe(false);
	});
});

describe("a new host's labels", () => {
	it("reads key=value pairs, skipping empty ones", () => {
		expect(parseLabels("site=fsn1, tier=microvm,")).toEqual({ labels: { site: "fsn1", tier: "microvm" } });
	});

	it("says which pair is wrong", () => {
		expect(parseLabels("site=fsn1, tier").error).toBe("Write tier as key=value, such as site=fsn1.");
	});
});

describe("a saved snapshot limit as typed", () => {
	it("reads whole and decimal GB", () => {
		expect(limitBytes("50")).toBe(50 * 1024 ** 3);
		expect(limitBytes(" 1.5 ")).toBe(1.5 * 1024 ** 3);
	});

	it("refuses nothing, zero, a negative number and a unit", () => {
		for (const text of ["", "0", "-5", "50 GB", "abc"]) expect(limitBytes(text)).toBeUndefined();
	});
});

describe("a saved snapshot limit to edit", () => {
	it("shows the limit unrounded, so reading it back gives the same bytes", () => {
		expect(limitText(50 * 1024 ** 3)).toBe("50");
		expect(limitText(1.25 * 1024 ** 3)).toBe("1.25");
		for (const bytes of [1, 1_000, Math.round(0.01 * 1024 ** 3), 1.25 * 1024 ** 3 + 7, 123_456_789_012]) {
			const text = limitText(bytes);
			expect(text).toMatch(/^\d+(\.\d+)?$/);
			expect(limitBytes(text)).toBe(bytes);
		}
	});
});

describe("the sample hosts' public URL", () => {
	it("starts at a default install's loopback, and the join command carries it", async () => {
		const hosts = createComputeFixtures({ hosting: "self-hosted" }).hosts;
		const url = await hosts?.publicUrl?.get();
		expect(url).toMatchObject({ publicUrl: "http://127.0.0.1:58090", setHere: false, loopback: true });
		expect((await hosts?.join({}))?.command).toContain("--url http://127.0.0.1:58090 ");
	});

	it("sets one hosts can reach, then goes back to the deployment's", async () => {
		const hosts = createComputeFixtures({ hosting: "self-hosted" }).hosts;
		const set = await hosts?.publicUrl?.set("https://kantel.example.com/");
		expect(set).toMatchObject({ publicUrl: "https://kantel.example.com", setHere: true, loopback: false });
		expect((await hosts?.join({}))?.command).toContain("--url https://kantel.example.com ");
		const cleared = await hosts?.publicUrl?.set(null);
		expect(cleared).toMatchObject({ publicUrl: "http://127.0.0.1:58090", setHere: false });
	});
});
