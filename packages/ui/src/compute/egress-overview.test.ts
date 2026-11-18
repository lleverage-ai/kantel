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
				["allow", "github.com", "lleverage-github"],
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
		expect(log.find((entry) => entry.sandboxId === DEV_STACK.id)?.environments?.map((env) => env.name)).toEqual([
			"backend-dev",
		]);
		expect(log.find((entry) => entry.sandboxId === SCRATCH.id)?.environments).toBeUndefined();
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
		expect(overview.unreadIds).toEqual([SCRATCH.id]);
		expect(logOf(overview).some((entry) => entry.sandboxId === SCRATCH.id)).toBe(false);
	});

	it("lists protected variables with their environment", async () => {
		const variables = protectedVariablesOf(await read());
		expect(variables.map((row) => `${row.environment.name}/${row.name}`)).toEqual([
			"backend-dev/GH_TOKEN",
			"backend-dev/NPM_TOKEN",
			"backend-dev/OPENAI_API_KEY",
			"evals/ANTHROPIC_API_KEY",
			"lleverage-github/GH_TOKEN",
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
		environments: [{ id: "env_backend", name: "backend-dev" }],
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

	it("binds it in the environment that wins its name, of a sandbox's several", () => {
		const backend = { id: "env_backend", name: "backend-dev" };
		const other = { id: "env_other", name: "other" };
		const entry = {
			...base,
			environments: [backend, other],
			code: "placeholder-unbound",
			reason: "GH_TOKEN may not be sent to webhook.site",
		};
		// The later one has it, so its value is the one sent.
		expect(denialFixes(entry, variables)).toEqual([{ kind: "bind", variable: "GH_TOKEN", environment: other }]);
		// As the sandbox says, where it does.
		expect(denialFixes({ ...entry, protectedFrom: { GH_TOKEN: backend.id } }, variables)).toEqual([
			{ kind: "bind", variable: "GH_TOKEN", environment: backend },
		]);
		// No name, and several: no saying which.
		expect(denialFixes({ ...entry, reason: "placeholder-unbound" }, variables)).toEqual([]);
	});

	it("allows a host no rule allows, as the host records it", () => {
		// apps/host/internal/egress: `Decide`'s reason, recorded with the code `denied`.
		const miss = { ...base, code: "denied", reason: "not on the proxy settings' allow list" };
		expect(denialFixes(miss, [])).toEqual([{ kind: "allow" }]);
		// Sample data with no code.
		expect(denialFixes({ ...base, reason: "webhook.site isn't on the proxy settings' allow list." }, [])).toEqual([
			{ kind: "allow" },
		]);
		expect(denialFixes(base, [])).toEqual([{ kind: "allow" }]);
	});

	it("offers no allow where an allow rule wouldn't help", () => {
		const denied = { ...base, code: "denied" };
		expect(
			denialFixes({ ...denied, reason: "denied by a grant (deny webhook.site)", rule: "deny webhook.site" }, []),
		).toEqual([]);
		// The account's deny list: deny wins over an allow.
		expect(denialFixes({ ...denied, reason: "denied by the proxy settings (webhook.site)" }, [])).toEqual([]);
		expect(denialFixes({ ...denied, reason: "this sandbox has no network" }, [])).toEqual([]);
		expect(
			denialFixes({ ...denied, host: "169.254.169.254", reason: "not on the proxy settings' allow list" }, []),
		).toEqual([]);
		expect(denialFixes({ ...base, code: "protected-unavailable", reason: "can't be fetched right now" }, [])).toEqual(
			[],
		);
		expect(denialFixes({ ...base, decision: "allowed" }, [])).toEqual([]);
	});

	it("writes methods and paths as the table does", () => {
		expect(methodsAndPaths({ methods: [], paths: [] })).toBe("Any");
		expect(methodsAndPaths({ methods: ["DELETE"], paths: ["/repos/*"] })).toBe("DELETE /repos/*");
		expect(methodsAndPaths({ methods: [], paths: ["/v1/"] })).toBe("/v1/");
	});
});
