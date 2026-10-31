import { assertValidSite, isSupervisor, siteAllowed, siteCovered, sitesWithConsent } from "@kantel/browser";
import { createFakeBrowserProvider, createMemoryBrowser } from "@kantel/browser/memory";
import { isKantelError, type SessionEndHook, type SessionTeardown } from "@kantel/contracts";
import { describe, expect, it } from "vitest";

describe("siteAllowed", () => {
	const sites = ["github.com", "*.example.com"];
	it("matches an exact host over http or https, ignoring ports and case", () => {
		expect(siteAllowed(sites, "https://github.com/x")).toBe(true);
		expect(siteAllowed(sites, "http://GITHUB.com:8443/")).toBe(true);
		expect(siteAllowed(sites, "https://api.github.com/")).toBe(false);
		expect(siteAllowed(sites, "wss://github.com/")).toBe(false);
	});
	it("lets an exact host cover its www. host, and nothing else under it", () => {
		expect(siteAllowed(["google.com"], "https://www.google.com/travel/flights")).toBe(true);
		expect(siteAllowed(["skyscanner.net"], "https://WWW.skyscanner.net/")).toBe(true);
		expect(siteAllowed(["google.com"], "https://mail.google.com/")).toBe(false);
		expect(siteAllowed(["google.com"], "https://www.www.google.com/")).toBe(false);
		expect(siteAllowed(["google.com"], "https://wwwgoogle.com/")).toBe(false);
		expect(siteAllowed(["google.com"], "https://www.google.com.evil.example/")).toBe(false);
		// Only the bare host widens: www. covers neither its bare host nor anything under it.
		expect(siteAllowed(["www.kayak.co.uk"], "https://kayak.co.uk/")).toBe(false);
		expect(siteAllowed(["www.kayak.co.uk"], "https://www.www.kayak.co.uk/")).toBe(false);
		// A wildcard is unchanged: its bare host stays out.
		expect(siteAllowed(["*.example.com"], "https://www.example.com/")).toBe(true);
		expect(siteAllowed(["*.example.com"], "https://example.com/")).toBe(false);
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

describe("sitesWithConsent", () => {
	it("adds Google's consent host for the same country to a Google site, and nothing else", () => {
		expect(sitesWithConsent(["www.google.com", "www.kayak.co.uk"])).toEqual([
			"www.google.com",
			"www.kayak.co.uk",
			"consent.google.com",
		]);
		expect(sitesWithConsent(["google.com"])).toEqual(["google.com", "consent.google.com"]);
		expect(sitesWithConsent(["www.google.co.uk"])).toEqual(["www.google.co.uk", "consent.google.co.uk"]);
		expect(sitesWithConsent(["www.google.de"])).toEqual(["www.google.de", "consent.google.de"]);
		expect(sitesWithConsent(["www.google.com.au"])).toEqual(["www.google.com.au", "consent.google.com.au"]);
		expect(sitesWithConsent(["consent.google.com", "www.google.com"])).toEqual([
			"consent.google.com",
			"www.google.com",
		]);
	});
	it("leaves other Google hosts and lookalikes alone", () => {
		for (const site of [
			"mail.google.com",
			"www.google.evil.com",
			"google.example.org",
			"notgoogle.com",
			"github.com",
		]) {
			expect(sitesWithConsent([site])).toEqual([site]);
		}
	});
});

describe("siteAllowed with Google's consent redirect", () => {
	it("lets a Google grant land on that country's consent page, but nowhere else on Google", () => {
		const sites = ["www.google.com"];
		expect(siteAllowed(sites, "https://consent.google.com/m?continue=https://www.google.com/travel/flights")).toBe(
			true,
		);
		expect(siteAllowed(sites, "https://consent.google.co.uk/m")).toBe(false);
		expect(siteAllowed(sites, "https://accounts.google.com/")).toBe(false);
		expect(siteAllowed(sites, "https://consent.youtube.com/")).toBe(false);
		expect(siteAllowed(["www.google.co.uk"], "https://consent.google.co.uk/m")).toBe(true);
		expect(siteAllowed(["github.com"], "https://consent.google.com/m")).toBe(false);
	});
});

describe("assertValidSite", () => {
	it("accepts lower-case hosts and leading wildcards only", () => {
		for (const site of ["github.com", "*.github.com", "localhost"]) expect(() => assertValidSite(site)).not.toThrow();
		for (const site of ["GitHub.com", "*github.com", "github.*", "a.*.b", "https://github.com", "github.com:443", ""]) {
			expect(() => assertValidSite(site), site).toThrow();
		}
	});
	it("rejects a wildcard over a single label and accepts one over two, with no public suffix list", () => {
		for (const site of ["*.com", "*", "*.localhost"]) expect(() => assertValidSite(site), site).toThrow();
		expect(() => assertValidSite("*.co.uk")).not.toThrow();
	});
});

describe("siteCovered", () => {
	const parent = ["github.com", "*.api.github.com"];
	it("covers an exact host in the list or under one of its wildcards", () => {
		expect(siteCovered(parent, "github.com")).toBe(true);
		expect(siteCovered(parent, "v3.api.github.com")).toBe(true);
		expect(siteCovered(parent, "api.github.com")).toBe(false);
		expect(siteCovered(parent, "gitlab.com")).toBe(false);
		expect(siteCovered(parent, "evilapi.github.com")).toBe(false);
	});
	it("covers a wildcard equal to or under one of its wildcards, never under an exact host", () => {
		expect(siteCovered(parent, "*.api.github.com")).toBe(true);
		expect(siteCovered(parent, "*.eu.api.github.com")).toBe(true);
		expect(siteCovered(parent, "*.github.com")).toBe(false);
		expect(siteCovered(parent, "*.evilapi.github.com")).toBe(false);
		expect(siteCovered(["github.com"], "*.github.com")).toBe(false);
		expect(siteCovered([], "github.com")).toBe(false);
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
	it("fails the next releases it is told to, leaving those sessions live", async () => {
		const fake = createFakeBrowserProvider();
		const opened = await fake.provider.open({ providerContextId: "ctx-1", persist: false, timeoutMs: 1000 });
		fake.failReleases(1);
		await expect(fake.provider.release(opened.providerSessionId)).rejects.toThrow();
		expect(fake.live()).toEqual([opened.providerSessionId]);
		await fake.provider.release(opened.providerSessionId);
		expect(fake.live()).toEqual([]);
	});
	it("holds the next open until released", async () => {
		const fake = createFakeBrowserProvider();
		const letOpen = fake.holdNextOpen();
		let done = false;
		const pending = fake.provider.open({ providerContextId: "ctx-1", persist: false, timeoutMs: 1000 }).then(() => {
			done = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(done).toBe(false);
		expect(fake.live()).toEqual([]);
		letOpen();
		await pending;
		expect(fake.live()).toHaveLength(1);
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
	it("lets a step on a Google grant follow the redirect to Google's consent page, and still refuses other Google hosts", async () => {
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
			persist: false,
			timeoutMs: 5000,
			allowedSites: ["www.google.com"],
		});
		const agent = { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: "org" } as const;
		const opened = await browser.open(agent, { grantId: grant.id });
		await browser.act(agent, opened.id, { kind: "goto", url: "https://www.google.com/travel/flights" });
		fake.nextClickLandsOn("https://consent.google.com/m?continue=https://www.google.com/travel/flights");
		const consent = await browser.act(agent, opened.id, { kind: "click", element: "1" });
		expect(consent.url).toBe("https://consent.google.com/m?continue=https://www.google.com/travel/flights");
		fake.nextClickLandsOn("https://accounts.google.com/signin");
		await expect(browser.act(agent, opened.id, { kind: "click", element: "1" })).rejects.toMatchObject({
			code: "refused",
		});
	});
	it("registers its teardown with the session-end hook once, as browser, and the teardown ends the session's holdings", async () => {
		const registered: { readonly name: string; readonly teardown: SessionTeardown }[] = [];
		const sessionEnd: SessionEndHook = {
			register(name, teardown) {
				registered.push({ name, teardown });
				return { close: async () => undefined };
			},
		};
		const fake = createFakeBrowserProvider();
		const browser = createMemoryBrowser({ provider: fake.provider, sessionEnd });
		expect(registered.map(({ name }) => name)).toEqual(["browser"]);
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
			persist: false,
			timeoutMs: 5000,
			allowedSites: ["github.com"],
		});
		const agent = { actor: { kind: "agent", agentId: "a", sessionId: "s" }, organisationId: "org" } as const;
		const opened = await browser.open(agent, { grantId: grant.id });
		await registered[0]!.teardown(
			{ actor: { kind: "system", component: "session" }, organisationId: "org" },
			{
				sessionId: "s",
				organisationId: "org",
				projectId: "p",
				agentId: "a",
				reason: "aborted",
				endedBy: human.actor,
				at: 0,
			},
		);
		expect(await browser.get(human, opened.id)).toMatchObject({ status: "closed", endReason: "aborted" });
		expect((await browser.listGrants(human, {})).map(({ status }) => status)).toEqual(["ended"]);
		expect(fake.live()).toEqual([]);
		expect(registered).toHaveLength(1);
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
			expect(isKantelError(error, "invalid")).toBe(true);
		}
	});
});
