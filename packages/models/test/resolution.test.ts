import type { ModelCallScope, ModelConnector, ModelRoute } from "@harbour/contracts";
import {
	nearestRoutes,
	overrideId,
	parseModelRequestId,
	policyAllows,
	resolveRoutes,
} from "@harbour/models/resolution";
import { describe, expect, it } from "vitest";

const scope: ModelCallScope = { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "sess-1" };

function connector(id: string, owner: ModelConnector["owner"]): ModelConnector {
	return {
		id,
		owner,
		preset: "cliproxyapi",
		baseUrl: "http://cpa.internal:8317/v1",
		vaultItemId: `item-${id}`,
		catalogue: { refresh: "static" },
		createdAt: 0,
		updatedAt: 0,
	};
}

function route(name: string, owner: ModelRoute["owner"], connectorId: string, modelId: string): ModelRoute {
	return { name, owner, connectorId, modelId, updatedAt: 0 };
}

const platform = { kind: "platform" } as const;
const orgA = { kind: "organisation", organisationId: "org-a" } as const;
const orgB = { kind: "organisation", organisationId: "org-b" } as const;
const projA = { kind: "project", organisationId: "org-a", projectId: "proj-a" } as const;
const projOther = { kind: "project", organisationId: "org-a", projectId: "proj-other" } as const;

describe("parseModelRequestId", () => {
	it("reads a route, or a route and a model split at the first colon", () => {
		expect(parseModelRequestId("default")).toEqual({ route: "default" });
		expect(parseModelRequestId("default:gpt-5")).toEqual({ route: "default", modelId: "gpt-5" });
		expect(parseModelRequestId("deep:ollama/qwen3:32b")).toEqual({ route: "deep", modelId: "ollama/qwen3:32b" });
		expect(overrideId("deep", "ollama/qwen3:32b")).toBe("deep:ollama/qwen3:32b");
	});

	it("rejects an empty route or an empty model", () => {
		expect(parseModelRequestId("")).toBeUndefined();
		expect(parseModelRequestId(":gpt-5")).toBeUndefined();
		expect(parseModelRequestId("default:")).toBeUndefined();
	});
});

describe("resolution", () => {
	const connectors = [connector("cpa", platform), connector("lite-a", orgA), connector("lite-b", orgB)];

	it("resolves platform → organisation → project, the nearest name winning", () => {
		const routes = [
			route("default", platform, "cpa", "claude-sonnet-4-5"),
			route("default", orgA, "lite-a", "org-default"),
			route("fast", platform, "cpa", "gemini-2.5-pro"),
			route("fast", projA, "cpa", "gpt-5-mini"),
			route("fast", projOther, "cpa", "not-mine"),
			route("deep", orgB, "lite-b", "theirs"),
		];
		const resolved = resolveRoutes({ routes, connectors, scope });
		expect(resolved.map(({ route: r }) => [r.name, r.modelId])).toEqual([
			["default", "org-default"],
			["fast", "gpt-5-mini"],
		]);
		expect(nearestRoutes(routes, { ...scope, organisationId: "org-b" }).map((r) => [r.name, r.modelId])).toEqual([
			["deep", "theirs"],
			["default", "claude-sonnet-4-5"],
			["fast", "gemini-2.5-pro"],
		]);
	});

	it("filters by the project's policy, without falling back to a farther route", () => {
		const routes = [route("default", platform, "cpa", "claude-sonnet-4-5"), route("default", orgA, "lite-a", "m")];
		expect(resolveRoutes({ routes, connectors, scope, policy: { connectors: ["cpa"] } })).toEqual([]);
		expect(
			resolveRoutes({ routes: routes.slice(0, 1), connectors, scope, policy: { models: ["claude-sonnet-4-5"] } }),
		).toHaveLength(1);
		expect(resolveRoutes({ routes: routes.slice(0, 1), connectors, scope, policy: { models: ["other"] } })).toEqual([]);
	});

	it("drops a route whose connector is gone or belongs to another organisation", () => {
		const routes = [route("gone", platform, "missing", "m"), route("sideways", projA, "lite-b", "m")];
		expect(resolveRoutes({ routes, connectors, scope })).toEqual([]);
	});

	it("treats an absent policy or list as no narrowing", () => {
		expect(policyAllows(undefined, "cpa", "m")).toBe(true);
		expect(policyAllows({}, "cpa", "m")).toBe(true);
		expect(policyAllows({ connectors: ["cpa"] }, "cpa", "m")).toBe(true);
		expect(policyAllows({ connectors: ["cpa"], models: [] }, "cpa", "m")).toBe(false);
	});
});
