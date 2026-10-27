import { assertValidSite, isSupervisor, siteAllowed } from "@harbour/browser";
import { createFakeBrowserProvider, createMemoryBrowser } from "@harbour/browser/memory";
import { isHarbourError } from "@harbour/contracts";
import { describe, expect, it } from "vitest";

describe("siteAllowed", () => {
	const sites = ["github.com", "*.example.com"];
	it("matches an exact host over http or https, ignoring ports and case", () => {
		expect(siteAllowed(sites, "https://github.com/x")).toBe(true);
		expect(siteAllowed(sites, "http://GITHUB.com:8443/")).toBe(true);
		expect(siteAllowed(sites, "https://api.github.com/")).toBe(false);
		expect(siteAllowed(sites, "wss://github.com/")).toBe(false);
	});
	it("matches subdomains for a wildcard but not the bare host", () => {
		expect(siteAllowed(sites, "https://a.example.com/")).toBe(true);
		expect(siteAllowed(sites, "https://a.b.example.com/")).toBe(true);
		expect(siteAllowed(sites, "https://example.com/")).toBe(false);
		expect(siteAllowed([...sites, "example.com"], "https://example.com/")).toBe(true);
		expect(siteAllowed(sites, "https://badexample.com/")).toBe(false);
	});
	it("refuses lookalikes, credentials tricks and invalid URLs", () => {
		expect(siteAllowed(sites, "https://github.com.evil.example/")).toBe(false);
		expect(siteAllowed(sites, "https://github.com@evil.example/")).toBe(false);
		expect(siteAllowed(sites, "github.com")).toBe(false);
		expect(siteAllowed(sites, "")).toBe(false);
	});
});

describe("assertValidSite", () => {
	it("accepts lower-case hosts and leading wildcards only", () => {
		for (const site of ["github.com", "*.github.com", "localhost"]) expect(() => assertValidSite(site)).not.toThrow();
		for (const site of ["GitHub.com", "*github.com", "github.*", "a.*.b", "https://github.com", "github.com:443", ""]) {
			expect(() => assertValidSite(site), site).toThrow();
		}
	});
});

describe("isSupervisor", () => {
	const parentOf = (sessionId: string) => (sessionId === "child" ? "parent" : undefined);
	it("lets humans and services supervise any session", () => {
		expect(isSupervisor({ kind: "human", userId: "u" }, "child", parentOf)).toBe(true);
		expect(isSupervisor({ kind: "service", serviceId: "sal" }, "child", parentOf)).toBe(true);
	});
	it("lets an agent supervise only its child session", () => {
		expect(isSupervisor({ kind: "agent", agentId: "a", sessionId: "parent" }, "child", parentOf)).toBe(true);
		expect(isSupervisor({ kind: "agent", agentId: "a", sessionId: "child" }, "child", parentOf)).toBe(false);
		expect(isSupervisor({ kind: "agent", agentId: "a", sessionId: "other" }, "child", parentOf)).toBe(false);
		expect(isSupervisor({ kind: "agent", agentId: "a", sessionId: "parent" }, "parent", parentOf)).toBe(false);
		expect(isSupervisor({ kind: "agent", agentId: "a", sessionId: "self" }, "self", () => "self")).toBe(false);
	});
	it("does not treat system actors as supervisors", () => {
		expect(isSupervisor({ kind: "system", component: "sweeper" }, "child", parentOf)).toBe(false);
	});
});

describe("createFakeBrowserProvider", () => {
	it("records what it opened, serves wss://browser.invalid URLs and forgets released sessions", async () => {
		const fake = createFakeBrowserProvider();
		const opened = await fake.provider.open({ providerContextId: "ctx-1", persist: true, timeoutMs: 1000 });
		expect(opened.cdpUrl).toBe(`wss://browser.invalid/${opened.providerSessionId}`);
		expect(fake.opened()).toEqual([
			{ providerSessionId: opened.providerSessionId, providerContextId: "ctx-1", persist: true },
		]);
		expect(fake.live()).toEqual([opened.providerSessionId]);
		await fake.provider.release(opened.providerSessionId);
		expect(fake.live()).toEqual([]);
		expect(fake.opened()).toHaveLength(1);
	});
});

describe("createMemoryBrowser", () => {
	it("hands the provider the grant's provider context ID, persist flag and timeout", async () => {
		const fake = createFakeBrowserProvider();
		const browser = createMemoryBrowser({ provider: fake.provider });
		const human = { actor: { kind: "human", userId: "u" }, organisationId: "org" } as const;
		const context = await browser.putContext(human, {
			owner: { kind: "organisation", organisationId: "org" },
			name: "sal",
			providerContextId: "brwsr-1",
		});
		const grant = await browser.grant(human, {
			sessionId: "s",
			projectId: "p",
			agentId: "a",
			contextId: context.id,
			persist: true,
			timeoutMs: 5000,
			allowedSites: ["github.com"],
		});
		const agent = { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: "org" } as const;
		await browser.open(agent, { grantId: grant.id });
		expect(fake.opened().map(({ providerContextId, persist }) => ({ providerContextId, persist }))).toEqual([
			{ providerContextId: "brwsr-1", persist: true },
		]);
	});
	it("rejects grants with a bad timeout or site as invalid", async () => {
		const browser = createMemoryBrowser();
		const human = { actor: { kind: "human", userId: "u" }, organisationId: "org" } as const;
		const context = await browser.putContext(human, {
			owner: { kind: "organisation", organisationId: "org" },
			name: "sal",
			providerContextId: "brwsr-1",
		});
		const base = {
			sessionId: "s",
			projectId: "p",
			agentId: "a",
			contextId: context.id,
			persist: false,
			timeoutMs: 5000,
			allowedSites: ["github.com"],
		};
		for (const input of [
			{ ...base, timeoutMs: 0 },
			{ ...base, allowedSites: [] },
			{ ...base, allowedSites: ["*"] },
		]) {
			const error = await browser.grant(human, input).catch((caught: unknown) => caught);
			expect(isHarbourError(error, "invalid")).toBe(true);
		}
	});
});
