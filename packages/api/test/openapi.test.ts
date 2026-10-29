// The OpenAPI document: every route is in it once, every reference resolves, and the committed file is the one the
// routes make (CI's `generate:check` also checks the SDK, formatted).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openApi } from "../src/document.ts";
import { pathParameters, routes } from "../src/index.ts";

type Json = { [key: string]: unknown };

const doc = openApi();

function references(node: unknown, found: string[] = []): string[] {
	if (Array.isArray(node)) for (const item of node) references(item, found);
	else if (typeof node === "object" && node !== null) {
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref" && typeof value === "string") found.push(value);
			else references(value, found);
		}
	}
	return found;
}

describe("OpenAPI document", () => {
	it("is the committed generated/openapi.json", () => {
		const committed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "generated", "openapi.json"), "utf8"));
		expect(committed).toEqual(doc);
	});

	it("has every route once, under its method and path, with a unique operation ID", () => {
		const paths = doc.paths as { [path: string]: { [method: string]: Json } };
		const ids = Object.values(paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
		expect(new Set(ids).size).toBe(ids.length);
		for (const route of Object.values(routes)) {
			const op = paths[route.path]?.[route.method.toLowerCase()];
			expect(op?.operationId).toBe(route.operationId);
		}
		expect(ids).toHaveLength(Object.keys(routes).length);
	});

	it("documents each path parameter, the success answer, 401 and each error code's status", () => {
		const paths = doc.paths as { [path: string]: { [method: string]: Json } };
		for (const route of Object.values(routes)) {
			const op = paths[route.path]?.[route.method.toLowerCase()] as Json;
			const params = ((op.parameters as Json[] | undefined) ?? []).filter((param) => param.in === "path");
			expect(params.map((param) => param.name)).toEqual(pathParameters(route.path));
			const responses = op.responses as { [status: string]: Json };
			expect(responses[String(route.answer.status)]).toBeDefined();
			expect(responses["401"]).toBeDefined();
		}
		const abort = paths["/sessions/{sessionId}/abort"]?.post as Json;
		expect(Object.keys(abort.responses as Json).sort()).toEqual(["204", "400", "401", "403", "404", "409"]);
	});

	it("resolves every reference to a component", () => {
		const schemas = (doc.components as { schemas: Json }).schemas;
		const refs = references(doc);
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs) {
			expect(ref.startsWith("#/components/schemas/")).toBe(true);
			expect(schemas[ref.slice("#/components/schemas/".length)]).toBeDefined();
		}
	});

	it("names the bearer scheme for host apps' API keys", () => {
		expect(doc.security).toEqual([{ bearer: [] }]);
		expect((doc.components as { securitySchemes: Json }).securitySchemes).toMatchObject({
			bearer: { type: "http", scheme: "bearer" },
		});
		expect(doc.servers).toEqual([{ url: "/v1" }]);
	});
});
