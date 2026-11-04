import { describe, expect, it } from "vitest";
import {
	denialFixes,
	type EgressOverview,
	type LoggedEntry,
	loadEgressOverview,
	logOf,
	methodsAndPaths,
	protectedVariablesOf,
	rulesOf,
} from "./egress-overview.ts";
import { createComputeFixtures, DEV_STACK, LLEVERAGE, SCRATCH } from "./fixtures.ts";

const read = (options?: Parameters<typeof createComputeFixtures>[0]) =>
	loadEgressOverview(createComputeFixtures(options), LLEVERAGE.id);

describe("the account's egress", () => {
	it("puts every level's rules in one list, the account's first", async () => {
		const rules = rulesOf(await read());
		expect(rules.map((rule) => [rule.action, rule.host, rule.scope.kind === "account" ? "" : rule.scope.name])).toEqual(
			[
				["allow", "api.github.com", ""],
				["allow", "*.githubusercontent.com", ""],
				["allow", "registry.npmjs.org", ""],
				["allow", "pypi.org", ""],
				["allow", "*.pythonhosted.org", ""],
				["deny", "169.254.169.254", ""],
				["allow", "api.github.com", "backend-dev"],
				["deny", "api.github.com", "backend-dev"],
				["allow", "registry.npmjs.org", "backend-dev"],
				["deny", "*.example-tracker.io", "backend-dev"],
				["allow", "api.anthropic.com", "evals"],
				["allow", "pypi.org", "dev-stack"],
			],
		);
		expect(new Set(rules.map((rule) => rule.key)).size).toBe(rules.length);
	});

	it("allows nothing for every sandbox when the policy is closed", async () => {
		const overview = await read();
		const closed: EgressOverview = { ...overview, proxy: { ...overview.proxy, policy: "closed" } };
		expect(rulesOf(closed).filter((rule) => rule.scope.kind === "account" && rule.action === "allow")).toEqual([]);
	});

	it("reads every sandbox's log as one, newest first, with where each came from", async () => {
		const log = logOf(await read());
		expect(log.length).toBeGreaterThan(9);
		expect(log.map((entry) => entry.at)).toEqual([...log.map((entry) => entry.at)].sort((a, b) => b - a));
		expect(new Set(log.map((entry) => entry.sandboxName))).toEqual(new Set(["dev-stack", "scratch", "eval-runner-12"]));
		expect(log.find((entry) => entry.sandboxId === DEV_STACK.id)?.environment?.name).toBe("backend-dev");
		expect(log.find((entry) => entry.sandboxId === SCRATCH.id)?.environment).toBeUndefined();
	});

	it("leaves out a sandbox it can't read, and says which", async () => {
		const source = createComputeFixtures();
		const broken = {
			...source,
			egress: {
				...source.egress,
				get: (id: string) => (id === SCRATCH.id ? Promise.reject(new Error("down")) : source.egress.get(id)),
			},
		};
		const overview = await loadEgressOverview(broken, LLEVERAGE.id);
		expect(overview.unread).toEqual(["scratch"]);
		expect(logOf(overview).some((entry) => entry.sandboxId === SCRATCH.id)).toBe(false);
	});

	it("lists protected variables with their environment", async () => {
		const variables = protectedVariablesOf(await read());
		expect(variables.map((row) => `${row.environment.name}/${row.name}`)).toEqual([
			"backend-dev/GH_TOKEN",
			"backend-dev/NPM_TOKEN",
			"backend-dev/OPENAI_API_KEY",
			"evals/ANTHROPIC_API_KEY",
		]);
	});
});

describe("a denial's fixes", () => {
	const base: LoggedEntry = {
		id: "e",
		at: 0,
		method: "POST",
		host: "webhook.site",
		port: 443,
		decision: "denied",
		swapped: [],
		inspected: true,
		bytesUp: 0,
		bytesDown: 0,
		sandboxId: DEV_STACK.id,
		sandboxName: DEV_STACK.name,
		environment: { id: "env_backend", name: "backend-dev" },
	};
	const variables = [
		{ name: "GH_TOKEN", bindings: [], environment: { id: "env_backend", name: "backend-dev" } },
		{ name: "GH_TOKEN", bindings: [], environment: { id: "env_other", name: "other" } },
	];

	it("binds the variable whose placeholder it carried, in its environment", () => {
		const entry = { ...base, code: "placeholder-unbound", reason: "GH_TOKEN may not be sent to webhook.site" };
		expect(denialFixes(entry, variables)).toEqual([
			{ kind: "bind", variable: "GH_TOKEN", environment: { id: "env_backend", name: "backend-dev" } },
		]);
		// No name in the reason: the environment still.
		expect(denialFixes({ ...entry, reason: "placeholder-unbound" }, variables)).toEqual([
			{ kind: "bind", environment: { id: "env_backend", name: "backend-dev" } },
		]);
	});

	it("allows a host no rule allows, and offers nothing for a deny rule or the metadata address", () => {
		expect(denialFixes({ ...base, reason: "not on the proxy settings' allow list" }, [])).toEqual([{ kind: "allow" }]);
		expect(denialFixes({ ...base, rule: "deny webhook.site" }, [])).toEqual([]);
		expect(denialFixes({ ...base, host: "169.254.169.254" }, [])).toEqual([]);
		expect(denialFixes({ ...base, decision: "allowed" }, [])).toEqual([]);
	});

	it("writes methods and paths as the table does", () => {
		expect(methodsAndPaths({ methods: [], paths: [] })).toBe("Any");
		expect(methodsAndPaths({ methods: ["DELETE"], paths: ["/repos/*"] })).toBe("DELETE /repos/*");
		expect(methodsAndPaths({ methods: [], paths: ["/v1/"] })).toBe("/v1/");
	});
});
