import { describe, expect, it } from "vitest";
import { FIXTURE_NOW as now, vaultCard } from "./fixtures.ts";
import { isRouteGrant, isUrgent, lifetimeText, methodText, mustPickCode, vaultHost } from "./vault-model.ts";

const MINUTE = 60_000;

describe("vaultHost", () => {
	it("reads the host from the link", () => {
		expect(vaultHost("https://vault.harbour.dev/p/prop_7Kq2")).toBe("vault.harbour.dev");
		expect(vaultHost("https://vault.example:8443/p/abc?x=1")).toBe("vault.example:8443");
		expect(vaultHost(vaultCard().link)).toBe("harbour.dev");
	});

	it("gives up on something that is not a URL", () => {
		expect(vaultHost("not a link")).toBeUndefined();
		expect(vaultHost("")).toBeUndefined();
	});
});

describe("lifetimeText", () => {
	it("says the time left coarsely", () => {
		expect(lifetimeText(now + 14 * MINUTE + 59_000, now)).toBe("15 minutes left");
		expect(lifetimeText(now + 61_000, now)).toBe("2 minutes left");
		expect(lifetimeText(now + MINUTE, now)).toBe("1 minute left");
		expect(lifetimeText(now + 30_000, now)).toBe("Less than a minute left");
		expect(lifetimeText(now + 130 * MINUTE, now)).toBe("2h 10m left");
		expect(lifetimeText(now + 3 * 24 * 60 * MINUTE + 5 * MINUTE, now)).toBe("3 days left");
		expect(lifetimeText(now + 25 * 60 * MINUTE, now)).toBe("1 day left");
	});

	it("says when it has run out", () => {
		expect(lifetimeText(now, now)).toBe("Expired");
		expect(lifetimeText(now - 1, now)).toBe("Expired");
	});
});

describe("isUrgent", () => {
	it("is urgent under two minutes, and not once expired", () => {
		expect(isUrgent(now + 3 * MINUTE, now)).toBe(false);
		expect(isUrgent(now + 2 * MINUTE, now)).toBe(false);
		expect(isUrgent(now + 2 * MINUTE - 1, now)).toBe(true);
		expect(isUrgent(now + 1000, now)).toBe(true);
		expect(isUrgent(now, now)).toBe(false);
		expect(isUrgent(now - 1000, now)).toBe(false);
	});
});

describe("methodText", () => {
	it("lists methods, or says any method", () => {
		expect(methodText(["POST"])).toBe("POST");
		expect(methodText(["GET", "post"])).toBe("GET, POST");
		expect(methodText([])).toBe("Any method");
		expect(methodText(["*"])).toBe("Any method");
		expect(methodText(["GET", "*"])).toBe("Any method");
	});
});

describe("the binding-code rule", () => {
	it("treats a card without an injection template as a route grant", () => {
		expect(isRouteGrant({})).toBe(true);
		expect(isRouteGrant({ injectionTemplate: " " })).toBe(true);
		expect(isRouteGrant({ injectionTemplate: "Authorization: Bearer {{secret}}" })).toBe(false);
	});

	it("asks for the code on writes, route grants and secret pastes", () => {
		const template = "Authorization: Bearer {{secret}}";
		expect(mustPickCode({ methods: ["POST"], injectionTemplate: template })).toBe(true);
		expect(mustPickCode({ methods: ["GET", "DELETE"], injectionTemplate: template })).toBe(true);
		expect(mustPickCode({ methods: ["*"], injectionTemplate: template })).toBe(true);
		expect(mustPickCode({ methods: [], injectionTemplate: template })).toBe(true);
		expect(mustPickCode({ methods: ["GET"] })).toBe(true);
		expect(mustPickCode({ methods: ["GET"], injectionTemplate: template, secretPaste: true })).toBe(true);
	});

	it("only displays the code on reads", () => {
		const template = "Authorization: Bearer {{secret}}";
		expect(mustPickCode({ methods: ["GET"], injectionTemplate: template })).toBe(false);
		expect(mustPickCode({ methods: ["get", "HEAD", "OPTIONS"], injectionTemplate: template })).toBe(false);
	});
});
