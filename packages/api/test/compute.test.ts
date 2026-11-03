// The compute plane's routes: each is in the v1 routes and the document, says it is experimental, and names the scope a
// key needs (or who may call it), and the scope presets only name real scopes.
import { describe, expect, it } from "vitest";
import { API_KEY_PRESETS, API_KEY_SCOPES } from "../src/compute-schema.ts";
import { computeRoutes, routes } from "../src/index.ts";

const PEOPLE_OR_ANY = new Set([
	"getCaller",
	"createOrganisation",
	"joinOrganisation",
	"deleteOrganisation",
	"startDeviceLogin",
	"pollDeviceLogin",
	"getDeviceLogin",
	"denyDeviceLogin",
]);

describe("compute routes", () => {
	it("are all v1 routes", () => {
		for (const [id, route] of Object.entries(computeRoutes)) {
			expect((routes as Record<string, unknown>)[id]).toBe(route);
		}
	});

	it("name a real scope, or who may call them", () => {
		for (const [id, route] of Object.entries(computeRoutes)) {
			if (PEOPLE_OR_ANY.has(id)) continue;
			const named = [...(route.description ?? "").matchAll(/`([a-z]+(?::[a-z]+)?)`/g)]
				.map((match) => match[1])
				.filter((name) => (API_KEY_SCOPES as readonly string[]).includes(name as string));
			expect(named.length, id).toBeGreaterThan(0);
		}
	});

	it("takes no credential only on a device sign-in's start and poll", () => {
		const open = Object.entries(computeRoutes)
			.filter(([, route]) => (route as { public?: true }).public === true)
			.map(([id]) => id);
		expect(open.sort()).toEqual(["pollDeviceLogin", "startDeviceLogin"]);
	});

	it("keeps hosts under /admin and super-admins only", () => {
		for (const route of Object.values(computeRoutes)) {
			if (route.tag !== "hosts") continue;
			expect(route.path.startsWith("/admin/hosts")).toBe(true);
			expect(route.description).toContain("`hosts:admin`");
		}
	});

	it("has presets of real scopes, none with hosts:admin", () => {
		for (const scopes of Object.values(API_KEY_PRESETS)) {
			for (const scope of scopes) expect(API_KEY_SCOPES).toContain(scope);
			expect(scopes).not.toContain("hosts:admin");
		}
	});
});
