// The compute plane's routes: each is in the v1 routes and the document, says it is experimental, and names the scope a
// key needs (or who may call it), and the scope presets only name real scopes. A template's spec names Kantel's base
// image only, never a Dockerfile, an image reference or a registry.
import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { API_KEY_PRESETS, API_KEY_SCOPES, PublishTemplateBaseBody, TemplateSpec } from "../src/compute-schema.ts";
import { computeRoutes, routes } from "../src/index.ts";

const PEOPLE_OR_ANY = new Set([
	"getCaller",
	"createOrganisation",
	"joinOrganisation",
	"deleteOrganisation",
	"deleteCaller",
	"startDeviceLogin",
	"pollDeviceLogin",
	"getDeviceLogin",
	"denyDeviceLogin",
	"listTemplateBases",
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
			expect(route.path.startsWith("/admin/")).toBe(true);
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

describe("a template's spec", () => {
	const digest = `sha256:${"1".repeat(64)}`;

	it("takes Kantel's base image, a Dockerfile, an image reference, or no image at all", () => {
		expect(Value.Check(TemplateSpec, {})).toBe(true);
		expect(Value.Check(TemplateSpec, { image: { kind: "kantel-base" } })).toBe(true);
		expect(Value.Check(TemplateSpec, { image: { kind: "dockerfile", dockerfile: "FROM alpine\n" } })).toBe(true);
		expect(Value.Check(TemplateSpec, { image: { kind: "image", ref: "ghcr.io/acme/agent:1" } })).toBe(true);
		expect(Value.Check(TemplateSpec, { image: { kind: "image", ref: `python@${digest}` } })).toBe(true);
		expect(Value.Check(TemplateSpec, { image: { kind: "dockerfile", dockerfile: "" } })).toBe(false);
		expect(Value.Check(TemplateSpec, { image: { kind: "dockerfile", dockerfile: "#".repeat(65_537) } })).toBe(false);
		for (const ref of ["", "Python:3", "python:3 && curl x", "--network=host", "python@sha256:feed"]) {
			expect(Value.Check(TemplateSpec, { image: { kind: "image", ref } }), ref).toBe(false);
		}
		expect(Value.Check(TemplateSpec, { image: { kind: "oci-layout", path: "/" } })).toBe(false);
	});

	it("names a base image by its repository path alone, with no registry port, tag or digest", () => {
		for (const image of ["kantel/sandbox", "kantel/sandbox-gpu", "acme/tools/base", "sandbox"]) {
			expect(Value.Check(TemplateSpec, { base: { image, channel: "stable" } }), image).toBe(true);
			expect(Value.Check(TemplateSpec, { base: { image, digest } }), image).toBe(true);
			expect(Value.Check(PublishTemplateBaseBody, { image, channel: "stable", digest }), image).toBe(true);
		}
		for (const image of ["registry.example.com:5000/acme/base", "kantel/sandbox:latest", `kantel/sandbox@${digest}`]) {
			expect(Value.Check(TemplateSpec, { base: { image, channel: "stable" } }), image).toBe(false);
			expect(Value.Check(PublishTemplateBaseBody, { image, channel: "stable", digest }), image).toBe(false);
		}
		expect(Value.Check(TemplateSpec, { base: { image: "kantel/sandbox", digest: "sha256:feed" } })).toBe(false);
	});
});
