import { type CallContext, systemContext } from "@kantel/contracts";
import { type HostGrant, importHostGrants } from "@kantel/vault/import";
import { createMemoryVault } from "@kantel/vault/memory";
import { describe, expect, it } from "vitest";

const admin: CallContext = { actor: { kind: "service", serviceId: "sal" }, organisationId: "org-a" };
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
	projectId: "proj-a",
};
const injection = { header: "Authorization", template: "Bearer {key}" };

const github: HostGrant = {
	name: "github-token",
	description: "Sal's GitHub token",
	hosts: ["api.github.com"],
	injection,
	value: "imported-github-value",
	routes: [
		{ host: "api.github.com", methods: ["GET"], pathPrefix: "/repos" },
		{ host: "api.github.com", methods: ["POST"], pathPrefix: "/repos/harbour/issues" },
	],
	selector: { organisationId: "org-a", projectId: "proj-a" },
};
const linear: HostGrant = {
	name: "linear-key",
	hosts: ["api.linear.app"],
	injection,
	routes: [{ host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" }],
	selector: { organisationId: "org-a" },
};
const localOnly: HostGrant = {
	name: "local-shell",
	hosts: [],
	injection,
	routes: [],
	selector: { organisationId: "org-a" },
};
const unmapped: HostGrant = {
	...linear,
	name: "mismatched",
	routes: [{ host: "evil.example", methods: ["GET"], pathPrefix: "/" }],
};

describe("importHostGrants", () => {
	it("creates an item per grant and a policy per route, and refuses local-only grants in the result", async () => {
		const vault = createMemoryVault();
		const result = await importHostGrants(vault, admin, [github, localOnly, linear, unmapped]);
		expect(result.imported.map((entry) => [entry.name, entry.item, entry.createdPolicies])).toEqual([
			["github-token", "created", 2],
			["linear-key", "created", 1],
		]);
		expect(result.refused).toEqual([
			{ name: "local-shell", code: "invalid", message: expect.stringContaining("no host mapping") },
			{ name: "mismatched", code: "invalid", message: expect.stringContaining("evil.example") },
		]);
		const items = (await vault.listItems(admin)).items;
		expect(items.map((item) => [item.name, item.owner.kind, item.hasValue])).toEqual([
			["github-token", "project", true],
			["linear-key", "organisation", false],
		]);
		expect((await vault.listPolicies(admin)).items).toHaveLength(3);
		expect(JSON.stringify(result)).not.toContain("imported-github-value");

		const allowed = await vault.decideEgress(systemContext("egress-gateway"), {
			organisationId: "org-a",
			projectId: "proj-a",
			method: "POST",
			url: "https://api.github.com/repos/harbour/issues",
		});
		expect(allowed).toMatchObject({ allow: true, inject: { value: "Bearer imported-github-value" } });
	});

	it("is idempotent: a re-run reuses every item and policy and creates nothing", async () => {
		const vault = createMemoryVault();
		const first = await importHostGrants(vault, admin, [github, linear]);
		const second = await importHostGrants(vault, admin, [github, linear, localOnly]);
		expect(second.imported).toEqual(first.imported.map((entry) => ({ ...entry, item: "reused", createdPolicies: 0 })));
		expect(second.refused.map((entry) => entry.name)).toEqual(["local-shell"]);
		expect((await vault.listItems(admin)).items).toHaveLength(2);
		expect((await vault.listPolicies(admin)).items).toHaveLength(3);
	});

	it("lists a grant the vault refuses, such as one outside the ceiling, and throws for a caller who may not import", async () => {
		const vault = createMemoryVault();
		await vault.setCeiling(admin, [{ host: "api.github.com", methods: ["GET"], pathPrefix: "/" }]);
		const result = await importHostGrants(vault, admin, [github]);
		expect(result.refused).toEqual([{ name: "github-token", code: "refused", message: expect.any(String) }]);
		await expect(importHostGrants(vault, agent, [linear])).rejects.toMatchObject({ code: "forbidden" });
	});
});
