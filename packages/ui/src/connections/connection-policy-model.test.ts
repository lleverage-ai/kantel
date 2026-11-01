// "What agents may do" (#462): the grid reads what the contract's own decision says, and setting a cell or a repository
// list compiles to ordinary rules that the same decision then agrees with.
import {
	type ConnectionRule,
	type ConnectionRuleInput,
	type ConnectionRules,
	decideConnectionRules,
	defaultRuleInputs,
	type HttpMethod,
} from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import {
	cellKey,
	choiceOf,
	emptyPlan,
	GRID_NOTE,
	gridScope,
	type PolicyPlan,
	planPolicy,
	policyExceptions,
	policyLines,
	policySentence,
	readPolicyGrid,
	repositoryProblem,
	runPolicyPlan,
} from "./connection-policy-model.ts";
import { CONNECTIONS, createRulesScenario, FIXTURE_NOW, POLICY_RULES, policyFixture, VIEWER } from "./fixtures.ts";

const NOW = 1_793_459_000_000;
const HOST = "api.github.com";
const github = { templateId: "github", host: HOST, now: NOW } as const;

let made = 0;
function rule(input: ConnectionRuleInput, source: ConnectionRule["source"] = "person"): ConnectionRule {
	made += 1;
	return {
		id: `rule_${made}`,
		connectionId: "conn_github",
		uses: 0,
		source,
		createdBy: { kind: "human", userId: "usr_tom" } as ConnectionRule["createdBy"],
		createdAt: NOW + made,
		updatedAt: NOW + made,
		...input,
	};
}

/** GitHub's defaults, as a new connection gets them (#485). */
function defaults(): ConnectionRules {
	const hints = [
		{ method: "GET" as const, path: "/**", access: "read" as const },
		{ method: "*" as const, path: "/**", access: "write" as const },
	];
	return {
		connectionId: "conn_github",
		rules: defaultRuleInputs(hints).map((input) => rule(input, "default")),
		unmatched: "ask",
		version: 1,
	};
}

/** The rules after a plan, as the API would leave them. */
function apply(set: ConnectionRules, plan: PolicyPlan): ConnectionRules {
	const removed = new Set(plan.remove);
	const rules = set.rules
		.filter((each) => !removed.has(each.id))
		.map((each) => {
			const change = plan.update.find((update) => update.ruleId === each.id);
			return change === undefined ? each : { ...each, action: change.action };
		});
	return { ...set, rules: [...rules, ...plan.create.map((input) => rule(input))], version: set.version + 1 };
}

const decide = (set: ConnectionRules, method: HttpMethod, path: string) =>
	decideConnectionRules(set, gridScope(), { kind: "http", method, host: HOST, path }, NOW).action;

describe("reading the grid", () => {
	it("reads GitHub's defaults as reads allowed, writes ask and deletes blocked", () => {
		const grid = readPolicyGrid(defaults(), github);
		expect(grid.groups.map((group) => group.id)).toEqual(["profile", "repo", "workflow"]);
		expect(grid.cells).toEqual({
			"profile:read": "allow",
			"repo:read": "allow",
			"repo:write": "ask",
			"repo:delete": "deny",
			"workflow:read": "allow",
			"workflow:write": "ask",
			"workflow:delete": "deny",
		});
		expect(grid.repositories).toBeUndefined();
		expect(policySentence(grid)).toBe("Reads allowed, writes ask, deletes blocked");
		expect(policyLines(grid).map((line) => line.text)).toEqual([
			"Reads go through",
			"Writes ask you first",
			"Deletes are blocked",
		]);
	});

	it("lists a person's narrower rule as an exception and keeps the cell's broad answer", () => {
		const base = defaults();
		const merge = rule({
			who: { kind: "any" },
			what: { kind: "endpoint", method: "PUT", path: "/repos/*/*/pulls/*/merge" },
			action: "deny",
		});
		const set = { ...base, rules: [...base.rules, merge] };
		const grid = readPolicyGrid(set, github);
		// The grid reads one sample path per pattern, so a rule on one endpoint inside it leaves the cell as it was.
		expect(grid.cells["repo:write"]).toBe("ask");
		expect(policyExceptions(set).map((each) => each.id)).toEqual([merge.id]);
	});

	it("reads a cell as mixed when a rule covers only some of its methods", () => {
		const base = defaults();
		const put = rule({ who: { kind: "any" }, what: { kind: "endpoint", method: "PUT", path: "/**" }, action: "allow" });
		const grid = readPolicyGrid({ ...base, rules: [...base.rules, put] }, github);
		expect(grid.cells["repo:write"]).toBe("mixed");
		expect(policySentence(grid)).toBe("Reads allowed, writes vary, deletes blocked");
	});

	it("gives a template without groups one row for every request", () => {
		const grid = readPolicyGrid(defaults(), { templateId: "linear-api", host: "api.linear.app", now: NOW });
		expect(grid.groups.map((group) => group.label)).toEqual(["Every request"]);
		expect(grid.cells).toEqual({ "all:read": "allow", "all:write": "ask", "all:delete": "deny" });
	});
});

describe("setting a cell", () => {
	it("compiles writes allowed to rules the decision agrees with, and keeps Actions as they were", () => {
		const set = defaults();
		const grid = readPolicyGrid(set, github);
		const plan = planPolicy(set, choiceOf(grid, { cell: { key: cellKey("repo", "write"), action: "allow" } }), github);
		expect(plan.remove).toEqual([]);
		expect(plan.create.every((input) => input.note === GRID_NOTE && input.who.kind === "any")).toBe(true);
		const after = apply(set, plan);
		expect(decide(after, "POST", "/repos/tvdavies/harbour/issues")).toBe("allow");
		expect(decide(after, "PATCH", "/repos/tvdavies/harbour/pulls/1")).toBe("allow");
		expect(decide(after, "POST", "/graphql")).toBe("allow");
		// Actions sits inside every repository's path; it keeps its own answer.
		expect(decide(after, "POST", "/repos/tvdavies/harbour/actions/workflows/ci.yml/dispatches")).toBe("ask");
		expect(decide(after, "DELETE", "/repos/tvdavies/harbour")).toBe("deny");
		const reread = readPolicyGrid(after, github);
		expect(reread.cells["repo:write"]).toBe("allow");
		expect(reread.cells["workflow:write"]).toBe("ask");
		// Setting it again changes nothing.
		expect(emptyPlan(planPolicy(after, choiceOf(reread, {}), github))).toBe(true);
	});

	it("updates the grid's own rules in place and removes those no longer needed", () => {
		const set = defaults();
		const allowed = apply(
			set,
			planPolicy(set, choiceOf(readPolicyGrid(set, github), { cell: { key: "repo:write", action: "allow" } }), github),
		);
		const back = planPolicy(
			allowed,
			choiceOf(readPolicyGrid(allowed, github), { cell: { key: "repo:write", action: "ask" } }),
			github,
		);
		const after = apply(allowed, back);
		expect(decide(after, "POST", "/repos/tvdavies/harbour/issues")).toBe("ask");
		expect(readPolicyGrid(after, github).cells["repo:write"]).toBe("ask");
		// Back to the defaults: the grid needs none of its rules.
		expect(after.rules.filter((each) => each.note === GRID_NOTE)).toEqual([]);
	});

	it("never changes the template's defaults, a person's rules or an approval's", () => {
		const base = defaults();
		const approval = rule(
			{
				who: { kind: "any" },
				what: { kind: "endpoint", method: "POST", path: "/repos/tvdavies/harbour/pulls" },
				action: "allow",
			},
			"approval",
		);
		const set = { ...base, rules: [...base.rules, approval] };
		const plan = planPolicy(
			set,
			choiceOf(readPolicyGrid(set, github), { cell: { key: "repo:write", action: "deny" } }),
			github,
		);
		const untouchable = new Set(set.rules.map((each) => each.id));
		expect(plan.remove.some((id) => untouchable.has(id))).toBe(false);
		expect(plan.update.some((update) => untouchable.has(update.ruleId))).toBe(false);
		const after = apply(set, plan);
		expect(decide(after, "POST", "/repos/acme/atlas/issues")).toBe("deny");
		// The approval's rule is more specific, so it still decides its own request.
		expect(decide(after, "POST", "/repos/tvdavies/harbour/pulls")).toBe("allow");
	});
});

describe("only these repositories", () => {
	it("blocks every other repository and keeps each column's answer in the listed ones", () => {
		const set = defaults();
		const plan = planPolicy(
			set,
			choiceOf(readPolicyGrid(set, github), { repositories: ["tvdavies/harbour", "acme/atlas", "not a repo"] }),
			github,
		);
		const after = apply(set, plan);
		expect(decide(after, "GET", "/repos/tvdavies/harbour/pulls")).toBe("allow");
		expect(decide(after, "POST", "/repos/tvdavies/harbour/issues")).toBe("ask");
		expect(decide(after, "DELETE", "/repos/acme/atlas")).toBe("deny");
		expect(decide(after, "GET", "/repos/acme/atlas/actions/runs")).toBe("allow");
		expect(decide(after, "GET", "/repos/lleverage-ai/lleverage")).toBe("deny");
		expect(decide(after, "GET", "/repos/lleverage-ai/lleverage/actions/runs")).toBe("deny");
		// Outside repositories, the groups' other areas keep their answers.
		expect(decide(after, "GET", "/user")).toBe("allow");
		expect(decide(after, "GET", "/search/issues")).toBe("allow");
		const grid = readPolicyGrid(after, github);
		expect(grid.repositories).toEqual(["acme/atlas", "tvdavies/harbour"]);
		expect(grid.cells["repo:read"]).toBe("allow");
		expect(grid.cells["repo:write"]).toBe("ask");
		expect(policySentence(grid)).toBe("Reads allowed, writes ask, deletes blocked, only in 2 repositories");
	});

	it("keeps the list when a cell changes, and drops its rules when cleared", () => {
		const set = defaults();
		const listed = apply(
			set,
			planPolicy(set, choiceOf(readPolicyGrid(set, github), { repositories: ["tvdavies/harbour"] }), github),
		);
		const writes = apply(
			listed,
			planPolicy(
				listed,
				choiceOf(readPolicyGrid(listed, github), { cell: { key: "repo:write", action: "allow" } }),
				github,
			),
		);
		expect(decide(writes, "POST", "/repos/tvdavies/harbour/issues")).toBe("allow");
		expect(decide(writes, "POST", "/repos/acme/atlas/issues")).toBe("deny");
		expect(decide(writes, "POST", "/repos/tvdavies/harbour/actions/runs/1/rerun")).toBe("ask");
		expect(readPolicyGrid(writes, github).repositories).toEqual(["tvdavies/harbour"]);

		const cleared = apply(
			writes,
			planPolicy(writes, choiceOf(readPolicyGrid(writes, github), { repositories: null }), github),
		);
		expect(readPolicyGrid(cleared, github).repositories).toBeUndefined();
		expect(decide(cleared, "GET", "/repos/lleverage-ai/lleverage")).toBe("allow");
		expect(decide(cleared, "POST", "/repos/acme/atlas/issues")).toBe("allow");
		expect(
			cleared.rules.some((each) => each.what.kind === "endpoint" && each.what.path.includes("tvdavies/harbour")),
		).toBe(false);
	});
});

describe("making a plan", () => {
	const fixtureGithub = { templateId: "github", host: HOST, now: FIXTURE_NOW } as const;
	it("creates, then updates, then removes, one call at a time, and clears a grid rule's limits", async () => {
		const calls: string[] = [];
		let open = 0;
		const call = (name: string) => async () => {
			open += 1;
			expect(open).toBe(1);
			await Promise.resolve();
			calls.push(name);
			open -= 1;
		};
		const plan: PolicyPlan = {
			create: [
				{
					who: { kind: "any" },
					what: { kind: "endpoint", method: "POST", path: "/a" },
					action: "allow",
					note: GRID_NOTE,
				},
				{
					who: { kind: "any" },
					what: { kind: "endpoint", method: "PUT", path: "/a" },
					action: "allow",
					note: GRID_NOTE,
				},
			],
			update: [{ ruleId: "rule_u", action: "ask" }],
			remove: ["rule_r1", "rule_r2"],
		};
		const updates: unknown[] = [];
		await runPolicyPlan(
			{
				create: (_, input) => call(`create ${input.what.kind === "endpoint" ? input.what.method : ""}`)(),
				updateRule: (_, ruleId, input) => {
					updates.push(input);
					return call(`update ${ruleId}`)();
				},
				remove: (_, ruleId) => call(`remove ${ruleId}`)(),
			},
			"conn_github",
			plan,
		);
		expect(calls).toEqual(["create POST", "create PUT", "update rule_u", "remove rule_r1", "remove rule_r2"]);
		expect(updates).toEqual([{ action: "ask", expiresAt: null, maxUses: null }]);
	});

	it("stops at the first call that fails", async () => {
		const calls: string[] = [];
		const plan: PolicyPlan = {
			create: [{ who: { kind: "any" }, what: { kind: "endpoint", method: "POST", path: "/a" }, action: "ask" }],
			update: [],
			remove: ["rule_r1"],
		};
		await expect(
			runPolicyPlan(
				{
					create: async () => {
						calls.push("create");
						throw new Error("Outside the ceiling");
					},
					updateRule: async () => calls.push("update"),
					remove: async () => calls.push("remove"),
				},
				"conn_github",
				plan,
			),
		).rejects.toThrow("Outside the ceiling");
		expect(calls).toEqual(["create"]);
	});

	it("sets writes to Ask through the rules API, and the next write and the dry run both ask", async () => {
		const allowed = policyFixture(
			POLICY_RULES,
			choiceOf(readPolicyGrid(POLICY_RULES, fixtureGithub), { cell: { key: "repo:write", action: "allow" } }),
		);
		const source = createRulesScenario({
			connections: () => CONNECTIONS,
			viewer: VIEWER,
			wait: async (value) => value(),
			initial: { conn_github_tom: allowed },
		});
		const write = {
			method: "POST",
			url: "https://api.github.com/repos/acme/atlas/issues",
			audience: "private",
		} as const;
		expect((await source.dryRun("conn_github_tom", write)).action).toBe("allow");

		const before = await source.get("conn_github_tom");
		const plan = planPolicy(
			before,
			choiceOf(readPolicyGrid(before, fixtureGithub), { cell: { key: "repo:write", action: "ask" } }),
			fixtureGithub,
		);
		await runPolicyPlan(source, "conn_github_tom", plan);
		const after = await source.get("conn_github_tom");
		expect(readPolicyGrid(after, fixtureGithub).cells["repo:write"]).toBe("ask");
		// The decision a real request gets, and the dry run's.
		expect(
			decideConnectionRules(
				after,
				gridScope(),
				{ kind: "http", method: "POST", host: HOST, path: "/repos/acme/atlas/issues" },
				FIXTURE_NOW,
			).action,
		).toBe("ask");
		expect((await source.dryRun("conn_github_tom", write)).action).toBe("ask");
		// The approval's rule is an exception, and still decides its own request.
		expect(
			(await source.dryRun("conn_github_tom", { ...write, url: "https://api.github.com/repos/tvdavies/harbour/pulls" }))
				.action,
		).toBe("allow");
	});

	it("refuses a request to a repository outside the list, in the dry run as in the decision", async () => {
		const source = createRulesScenario({
			connections: () => CONNECTIONS,
			viewer: VIEWER,
			wait: async (value) => value(),
			initial: { conn_github_tom: POLICY_RULES },
		});
		const before = await source.get("conn_github_tom");
		const plan = planPolicy(
			before,
			choiceOf(readPolicyGrid(before, fixtureGithub), { repositories: ["tvdavies/harbour"] }),
			fixtureGithub,
		);
		await runPolicyPlan(source, "conn_github_tom", plan);
		const read = (path: string) =>
			source.dryRun("conn_github_tom", { method: "GET", url: `https://api.github.com${path}`, audience: "private" });
		expect((await read("/repos/tvdavies/harbour/pulls")).action).toBe("allow");
		expect(await read("/repos/lleverage-ai/lleverage")).toMatchObject({ action: "deny", by: { kind: "rule" } });
	});
});

describe("a repository's name", () => {
	it("is owner/name", () => {
		expect(repositoryProblem("tvdavies/harbour")).toBeUndefined();
		expect(repositoryProblem(" tvdavies/harbour ")).toBeUndefined();
		expect(repositoryProblem("")).toBe("Name a repository");
		expect(repositoryProblem("harbour")).toMatch(/owner\/name/);
		expect(repositoryProblem("https://github.com/tvdavies/harbour")).toMatch(/owner\/name/);
	});
});
