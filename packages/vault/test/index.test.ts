import type { ProposalTerms, RouteScope } from "@harbour/contracts";
import {
	BINDING_CODE_ALPHABET,
	canonicalJson,
	classifyProposal,
	codeChoices,
	deriveBindingCode,
	hashTerms,
	narrow,
	routeAllows,
	routeWithin,
} from "@harbour/vault";
import { describe, expect, it } from "vitest";

const route: RouteScope = { host: "api.github.com", methods: ["GET", "POST"], pathPrefix: "/repos/" };
const terms: ProposalTerms = { itemId: "item-1", route, lifetime: { ttlMs: 60_000 }, reason: "Read issues" };

describe("canonicalJson", () => {
	it("sorts keys recursively and drops whitespace and undefined fields", () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: "x" }, u: undefined })).toBe(
			'{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
		);
	});
});

describe("hashTerms", () => {
	it("hashes equal terms alike whatever their key order", async () => {
		const reordered = { reason: "Read issues", lifetime: { ttlMs: 60_000 }, route, itemId: "item-1" };
		const hash = await hashTerms(terms);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashTerms(reordered)).toBe(hash);
		expect(await hashTerms({ ...terms, reason: "Write issues" })).not.toBe(hash);
	});
});

describe("deriveBindingCode", () => {
	it("derives a stable XXX-XXX Crockford code from the proposal ID and terms hash", async () => {
		const hash = await hashTerms(terms);
		const code = await deriveBindingCode("proposal-1", hash);
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
		expect(await deriveBindingCode("proposal-1", hash)).toBe(code);
		expect(await deriveBindingCode("proposal-2", hash)).not.toBe(code);
		expect(BINDING_CODE_ALPHABET).toHaveLength(32);
	});
});

describe("classifyProposal", () => {
	const withRoute = (methods: RouteScope["methods"], maxUses?: number): ProposalTerms => ({
		...terms,
		route: { ...route, methods },
		lifetime: maxUses === undefined ? {} : { maxUses },
	});
	it("derives read, write, route and secret from the terms", () => {
		expect(classifyProposal(withRoute(["GET", "HEAD"], 1))).toBe("read");
		expect(classifyProposal(withRoute(["GET", "POST"], 1))).toBe("write");
		expect(classifyProposal(withRoute(["GET"], 2))).toBe("route");
		expect(classifyProposal(withRoute(["GET"]))).toBe("route");
		expect(
			classifyProposal({
				...withRoute(["GET"], 1),
				secret: { name: "k", hosts: ["api.github.com"], injection: { header: "A", template: "{key}" } },
			}),
		).toBe("secret");
	});
});

describe("routeAllows and routeWithin", () => {
	it("matches host, method and path prefix", () => {
		expect(routeAllows(route, "GET", "API.github.com", "/repos/x")).toBe(true);
		expect(routeAllows(route, "DELETE", "api.github.com", "/repos/x")).toBe(false);
		expect(routeAllows(route, "GET", "api.github.com", "/user")).toBe(false);
		expect(routeAllows(route, "GET", "github.com", "/repos/x")).toBe(false);
	});
	it("holds only when the inner route is no wider than the outer", () => {
		expect(routeWithin({ ...route, methods: ["GET"], pathPrefix: "/repos/a/" }, route)).toBe(true);
		expect(routeWithin({ ...route, pathPrefix: "/" }, route)).toBe(false);
		expect(routeWithin({ ...route, methods: ["PUT"] }, route)).toBe(false);
		expect(routeWithin({ ...route, host: "github.com" }, route)).toBe(false);
	});
});

describe("narrow", () => {
	it("tightens methods, path, uses and lifetime", () => {
		const narrowed = narrow(
			{ ...terms, lifetime: { ttlMs: 60_000, maxUses: 5 } },
			{
				methods: ["GET"],
				pathPrefix: "/repos/a/",
				ttlMs: 1_000,
				maxUses: 2,
			},
		);
		expect(narrowed.route).toEqual({ host: "api.github.com", methods: ["GET"], pathPrefix: "/repos/a/" });
		expect(narrowed.lifetime).toEqual({ ttlMs: 1_000, maxUses: 2 });
		expect(narrow(terms, undefined)).toBe(terms);
	});
	it("rejects any widening as invalid", () => {
		for (const narrowing of [
			{ methods: ["DELETE"] as const },
			{ methods: [] },
			{ pathPrefix: "/" },
			{ ttlMs: 120_000 },
			{ maxUses: 0 },
		]) {
			expect(() => narrow({ ...terms, lifetime: { ttlMs: 60_000, maxUses: 5 } }, narrowing)).toThrow(
				expect.objectContaining({ code: "invalid" }),
			);
		}
		expect(() => narrow({ ...terms, lifetime: { maxUses: 1 } }, { maxUses: 2 })).toThrow(
			expect.objectContaining({ code: "invalid" }),
		);
	});
});

describe("codeChoices", () => {
	it("includes the real code once among distinct decoys, the same every time", () => {
		const choices = codeChoices("ABC-DEF", "proposal-1");
		expect(choices.length).toBeGreaterThanOrEqual(4);
		expect(choices.filter((choice) => choice === "ABC-DEF")).toHaveLength(1);
		expect(new Set(choices).size).toBe(choices.length);
		expect(codeChoices("ABC-DEF", "proposal-1")).toEqual(choices);
		expect(codeChoices("ABC-DEF", "proposal-1", 5)).toHaveLength(6);
	});
});
