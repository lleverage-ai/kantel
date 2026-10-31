import { canonicalJson, capabilityCovered, fingerprint, isCapabilityPattern, selectorMatches } from "@kantel/codemode";
import { describe, expect, it } from "vitest";

describe("canonicalJson", () => {
	it("sorts keys recursively and drops whitespace and undefined fields", () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: "x" }, u: undefined })).toBe(
			'{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
		);
	});
	it("rejects values JSON cannot hold", () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(expect.objectContaining({ code: "invalid" }));
		expect(() => canonicalJson(() => 1)).toThrow(expect.objectContaining({ code: "invalid" }));
	});
});

describe("fingerprint", () => {
	it("is the hex SHA-256 of the canonical JSON, whatever the key order", async () => {
		// SHA-256 of `{"a":1,"b":2}`.
		const expected = "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
		expect(await fingerprint({ a: 1, b: 2 })).toBe(expected);
		expect(await fingerprint({ b: 2, a: 1 })).toBe(expected);
		expect(await fingerprint({ a: 1, b: 3 })).not.toBe(expected);
	});
});

describe("capabilityCovered", () => {
	it("matches exact names and namespaces by whole segments", () => {
		expect(capabilityCovered(["github.issue.read"], "github.issue.read")).toBe(true);
		expect(capabilityCovered(["github.issue.read"], "github.issue.write")).toBe(false);
		expect(capabilityCovered(["github.*"], "github.issue")).toBe(true);
		expect(capabilityCovered(["github.*"], "github.issue.read")).toBe(true);
		expect(capabilityCovered(["github.*"], "github")).toBe(false);
		expect(capabilityCovered(["github.*"], "githubx.read")).toBe(false);
		expect(capabilityCovered(["*"], "github.issue")).toBe(false);
		expect(capabilityCovered([], "github.issue")).toBe(false);
	});
});

describe("isCapabilityPattern", () => {
	it("accepts names and trailing namespaces only", () => {
		expect(isCapabilityPattern("github.issue.read")).toBe(true);
		expect(isCapabilityPattern("github.*")).toBe(true);
		for (const pattern of ["*", ".*", "github.*.read", "github*", "github..read", ""]) {
			expect(isCapabilityPattern(pattern)).toBe(false);
		}
	});
});

describe("selectorMatches", () => {
	const caller = { projectId: "p", agentId: "a", sessionId: "s" };
	it("matches absent fields as anything and present fields exactly", () => {
		expect(selectorMatches({}, caller)).toBe(true);
		expect(selectorMatches({ projectId: "p", agentId: "a", sessionId: "s" }, caller)).toBe(true);
		expect(selectorMatches({ sessionId: "other" }, caller)).toBe(false);
		expect(selectorMatches({ agentId: "other" }, caller)).toBe(false);
		expect(selectorMatches({ projectId: "other" }, caller)).toBe(false);
		expect(selectorMatches({ projectId: "p" }, { agentId: "a", sessionId: "s" })).toBe(false);
	});
});
