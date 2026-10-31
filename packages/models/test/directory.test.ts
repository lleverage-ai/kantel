import { KantelError, type ModelConnector, systemContext } from "@kantel/contracts";
import { createMemoryModelConnectors } from "@kantel/models/directory";
import {
	actors,
	assertAccessDenied,
	assertWorkerCallRefused,
	contextFor,
	createDeps,
	createExpectAssertions,
} from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const operator = contextFor(actors.system("operator"), ORG);
const admin = contextFor(actors.human("admin-a"), ORG);
const projectAdmin = contextFor(actors.human("project-admin-a"), ORG, PROJECT);
const viewer = contextFor(actors.human("viewer-a"), ORG, PROJECT);
const agent = contextFor(actors.agent("agent-1", "sess-1"), ORG, PROJECT);
const otherAdmin = contextFor(actors.human("admin-b"), OTHER_ORG);
const scope = { organisationId: ORG, projectId: PROJECT, agentId: "agent-1", sessionId: "sess-1" };

type ConnectorInput = Omit<ModelConnector, "createdAt" | "updatedAt">;

function connectorInput(
	id: string,
	owner: ModelConnector["owner"],
	extra: Partial<ConnectorInput> = {},
): ConnectorInput {
	return {
		id,
		owner,
		preset: "litellm",
		baseUrl: "https://llm.example.com/v1",
		vaultItemId: `item-${id}`,
		catalogue: { refresh: "gateway" },
		...extra,
	};
}

function setup() {
	const deps = createDeps();
	deps.tenancy.bind(actors.human("admin-a"), ORG, "admin");
	deps.tenancy.bind(actors.human("project-admin-a"), ORG, "admin", PROJECT);
	deps.tenancy.bind(actors.human("viewer-a"), ORG, "viewer", PROJECT);
	deps.tenancy.bind(actors.human("admin-b"), OTHER_ORG, "admin");
	deps.tenancy.session({ id: "sess-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	const directory = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	return { deps, directory, a: createExpectAssertions(expect) };
}

/** Starts `call` after `assertAccessDenied` has counted the audit, since a refusal may be audited synchronously. */
const later = <T>(call: () => Promise<T>) => Promise.resolve().then(call);

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof KantelError ? error.code : String(error);
	}
}

describe("createMemoryModelConnectors", () => {
	it("lets only a system caller change the platform's connectors and routes", async () => {
		const { deps, directory, a } = setup();
		await assertAccessDenied(
			a,
			deps,
			later(() => directory.putConnector(admin, connectorInput("cpa", { kind: "platform" }))),
			{
				operation: "models.putConnector",
			},
		);
		await directory.putConnector(operator, connectorInput("cpa", { kind: "platform" }));
		await assertAccessDenied(
			a,
			deps,
			later(() =>
				directory.putRoute(admin, { name: "default", owner: { kind: "platform" }, connectorId: "cpa", modelId: "m" }),
			),
			{ operation: "models.putRoute" },
		);
		await directory.putRoute(operator, {
			name: "default",
			owner: { kind: "platform" },
			connectorId: "cpa",
			modelId: "m",
		});
		expect(deps.audit.ofType("models.connector.put")).toHaveLength(1);
		expect(deps.audit.ofType("models.route.put")[0]).toMatchObject({ source: "control", actor: operator.actor });
	});

	it("needs an organisation-wide admin for an organisation's connectors and policies", async () => {
		const { deps, directory, a } = setup();
		const owner = { kind: "organisation", organisationId: ORG } as const;
		await assertAccessDenied(
			a,
			deps,
			later(() => directory.putConnector(projectAdmin, connectorInput("lite", owner))),
			{
				operation: "models.putConnector",
			},
		);
		await assertAccessDenied(
			a,
			deps,
			later(() => directory.putConnector(agent, connectorInput("lite", owner))),
			{
				operation: "models.putConnector",
			},
		);
		await assertAccessDenied(
			a,
			deps,
			later(() => directory.putConnector(otherAdmin, connectorInput("lite", owner))),
			{
				operation: "models.putConnector",
			},
		);
		await directory.putConnector(admin, connectorInput("lite", owner));
		await assertAccessDenied(
			a,
			deps,
			later(() => directory.setProjectPolicy(projectAdmin, { organisationId: ORG, projectId: PROJECT, models: ["m"] })),
			{ operation: "models.setProjectPolicy" },
		);
		const policy = await directory.setProjectPolicy(admin, { organisationId: ORG, projectId: PROJECT, models: ["m"] });
		expect(policy).toMatchObject({ projectId: PROJECT, models: ["m"] });
		expect(await directory.getProjectPolicy(viewer, PROJECT)).toEqual(policy);
		expect(await directory.getProjectPolicy(admin, "proj-none")).toMatchObject({
			projectId: "proj-none",
			updatedAt: 0,
		});
		expect(deps.audit.ofType("models.policy.set")).toHaveLength(1);
	});

	it("lets a project admin own routes over the platform's or the organisation's connectors only", async () => {
		const { directory } = setup();
		await directory.putConnector(operator, connectorInput("cpa", { kind: "platform" }));
		await directory.putConnector(admin, connectorInput("lite", { kind: "organisation", organisationId: ORG }));
		await directory.putConnector(
			otherAdmin,
			connectorInput("theirs", { kind: "organisation", organisationId: OTHER_ORG }),
		);
		const owner = { kind: "project", organisationId: ORG, projectId: PROJECT } as const;
		await directory.putRoute(projectAdmin, { name: "fast", owner, connectorId: "cpa", modelId: "m" });
		await directory.putRoute(projectAdmin, { name: "own", owner, connectorId: "lite", modelId: "m" });
		expect(
			await code(directory.putRoute(projectAdmin, { name: "x", owner, connectorId: "theirs", modelId: "m" })),
		).toBe("refused");
		expect(
			await code(directory.putRoute(projectAdmin, { name: "x", owner, connectorId: "missing", modelId: "m" })),
		).toBe("refused");
		await directory.setProjectPolicy(admin, { organisationId: ORG, projectId: PROJECT, connectors: ["cpa"] });
		expect(await code(directory.putRoute(projectAdmin, { name: "x", owner, connectorId: "lite", modelId: "m" }))).toBe(
			"refused",
		);
		expect(await code(directory.putRoute(projectAdmin, { name: "a:b", owner, connectorId: "cpa", modelId: "m" }))).toBe(
			"invalid",
		);
		const routes = await directory.listRoutes(viewer);
		expect(routes.items.map((route) => route.name)).toEqual(["fast", "own"]);
	});

	it("validates connectors", async () => {
		const { directory } = setup();
		const platform = { kind: "platform" } as const;
		expect(await code(directory.putConnector(operator, connectorInput("x", platform, { baseUrl: "ftp://x" })))).toBe(
			"invalid",
		);
		expect(
			await code(directory.putConnector(operator, connectorInput("x", platform, { preset: "bedrock" as never }))),
		).toBe("invalid");
		expect(await code(directory.putConnector(operator, connectorInput("x", platform, { vaultItemId: "" })))).toBe(
			"invalid",
		);
		await directory.putConnector(admin, connectorInput("taken", { kind: "organisation", organisationId: ORG }));
		expect(
			await code(
				directory.putConnector(
					otherAdmin,
					connectorInput("taken", { kind: "organisation", organisationId: OTHER_ORG }),
				),
			),
		).toBe("conflict");
		expect(await code(directory.getConnector(otherAdmin, "taken"))).toBe("not_found");
	});

	it("keeps agents out of reads and makes resolve a worker call", async () => {
		const { deps, directory, a } = setup();
		await assertAccessDenied(
			a,
			deps,
			later(() => directory.listConnectors(agent)),
			{ operation: "models.listConnectors" },
		);
		await assertWorkerCallRefused(a, deps, "models.resolve", (ctx) => directory.resolve(ctx, scope), ORG);
		await directory.putConnector(operator, connectorInput("cpa", { kind: "platform" }));
		await directory.putRoute(operator, {
			name: "default",
			owner: { kind: "platform" },
			connectorId: "cpa",
			modelId: "m",
		});
		const resolved = await directory.resolve(systemContext("model-gateway"), scope);
		expect(resolved.map(({ route, connector }) => [route.name, connector.id])).toEqual([["default", "cpa"]]);
		await directory.deleteRoute(operator, { kind: "platform" }, "default");
		expect(await directory.resolve(systemContext("model-gateway"), scope)).toEqual([]);
		await directory.deleteConnector(operator, "cpa");
		expect(deps.audit.ofType("models.route.delete")).toHaveLength(1);
		expect(deps.audit.ofType("models.connector.delete")).toHaveLength(1);
	});
});
