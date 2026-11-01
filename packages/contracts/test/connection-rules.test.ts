// Conformance cases for connection access rules (#332): the order of specificity, deny winning a tie, unmatched
// requests, whole-segment paths, and the ceiling.

import { describe, expect, it } from "vitest";
import {
	ambiguousPath,
	type ConnectionCeiling,
	type ConnectionRule,
	type ConnectionRuleInput,
	canonicalPath,
	DEFAULT_UNMATCHED,
	decideConnectionRules,
	defaultRuleInputs,
	defaultToolRuleInputs,
	methodAccess,
	pathMatches,
	pathPatternProblem,
	type RuleRequest,
	requestWithinCeiling,
	ruleOutsideCeiling,
} from "../src/index.ts";

let next = 0;
const rule = (input: ConnectionRuleInput & { uses?: number; createdAt?: number }): ConnectionRule => {
	next += 1;
	return {
		id: `cr_${next}`,
		connectionId: "conn_1",
		uses: input.uses ?? 0,
		source: "person",
		createdBy: { kind: "human", userId: "alice" },
		createdAt: input.createdAt ?? next,
		updatedAt: next,
		...input,
	};
};
const set = (rules: ConnectionRule[], unmatched: "allow" | "ask" | "deny" = "ask") => ({
	rules,
	unmatched,
	version: 3,
});
const scope = { agentId: "triage", sessionId: "ses_1", projectId: "prj_1" };
const http = (method: RuleRequest["method"], path: string): RuleRequest => ({
	kind: "http",
	method,
	host: "api.github.com",
	path,
});
const endpoint = (method: "GET" | "POST" | "DELETE" | "*", path: string) =>
	({ kind: "endpoint", method, path }) as const;
const anyone = { kind: "any" } as const;

describe("paths servers read loosely", () => {
	it("are made canonical before matching: escaped unreserved characters decoded, runs of / made one", () => {
		expect(canonicalPath("/repos/%61cme//web")).toBe("/repos/acme/web");
		expect(canonicalPath("/a%2fb%2ac")).toBe("/a%2Fb%2Ac");
		expect(pathMatches("/repos/acme/**", "/repos//%61cme/web")).toBe(true);
	});

	it("can't slip past a deny or an ask by case, but an allow stays exact", () => {
		const deny = rule({ who: anyone, what: endpoint("DELETE", "/repos/acme/**"), action: "deny" });
		const allow = rule({ who: anyone, what: endpoint("GET", "/repos/acme/**"), action: "allow" });
		const rules = set([deny, allow], "allow");
		expect(decideConnectionRules(rules, scope, http("DELETE", "/Repos/ACME/web"), 0).action).toBe("deny");
		expect(decideConnectionRules(rules, scope, http("DELETE", "/repos//acme/web"), 0).action).toBe("deny");
		expect(decideConnectionRules(set([allow], "deny"), scope, http("GET", "/Repos/ACME/web"), 0).action).toBe("deny");
	});

	it("says which paths can't be judged at all", () => {
		expect(ambiguousPath("/repos/acme/web")).toBeUndefined();
		expect(ambiguousPath("/repos/acme%2Fsecret")).toBeDefined();
		expect(ambiguousPath("/repos/acme%5csecret")).toBeDefined();
		expect(ambiguousPath("/repos\\acme")).toBeDefined();
		expect(ambiguousPath("/repos/%2E%2E/x")).toBeDefined();
		expect(ambiguousPath("/repos/./x")).toBeDefined();
	});
});

describe("paths", () => {
	it("match whole segments only", () => {
		expect(pathMatches("/repos", "/repos")).toBe(true);
		expect(pathMatches("/repos", "/repositories")).toBe(false);
		expect(pathMatches("/repos", "/repos/x")).toBe(false);
		expect(pathMatches("/repos/*", "/repos/x")).toBe(true);
		expect(pathMatches("/repos/*", "/repos/x/y")).toBe(false);
		expect(pathMatches("/repos/**", "/repos")).toBe(true);
		expect(pathMatches("/repos/**", "/repos/x/y")).toBe(true);
		expect(pathMatches("/repos/**", "/repositories/x")).toBe(false);
		expect(pathMatches("/repos/*/issues", "/repos/acme/issues")).toBe(true);
		expect(pathMatches("/repos/*/issues", "/repos/acme/pulls")).toBe(false);
		expect(pathMatches("/", "/")).toBe(true);
		expect(pathMatches("/**", "/anything/at/all")).toBe(true);
	});

	it("reject bad patterns", () => {
		expect(pathPatternProblem("repos")).toBeDefined();
		expect(pathPatternProblem("/repos/**/x")).toBeDefined();
		expect(pathPatternProblem("/repos/a*")).toBeDefined();
		expect(pathPatternProblem("/repos?x=1")).toBeDefined();
		expect(pathPatternProblem("/repos/*/issues")).toBeUndefined();
	});
});

describe("deciding a request", () => {
	it("asks when no rule matches, or answers the set's unmatched", () => {
		expect(decideConnectionRules(set([]), scope, http("GET", "/user"), 0)).toMatchObject({
			action: "ask",
			by: { kind: "unmatched" },
			rulesVersion: 3,
		});
		expect(decideConnectionRules(set([], "allow"), scope, http("GET", "/user"), 0).action).toBe("allow");
	});

	it("lets the more specific what win", () => {
		const broad = rule({ who: anyone, what: endpoint("*", "/repos/**"), action: "ask" });
		const narrow = rule({ who: anyone, what: endpoint("GET", "/repos/**"), action: "allow" });
		const narrower = rule({ who: anyone, what: endpoint("GET", "/repos/*/issues"), action: "deny" });
		const rules = set([broad, narrow, narrower]);
		expect(decideConnectionRules(rules, scope, http("GET", "/repos/a/pulls"), 0).rule?.id).toBe(narrow.id);
		expect(decideConnectionRules(rules, scope, http("GET", "/repos/a/issues"), 0).rule?.id).toBe(narrower.id);
		expect(decideConnectionRules(rules, scope, http("POST", "/repos/a"), 0).rule?.id).toBe(broad.id);
	});

	it("lets the more specific who win", () => {
		const everyone = rule({ who: anyone, what: endpoint("POST", "/repos/*/issues"), action: "ask" });
		const project = rule({ who: { kind: "project", projectId: "prj_1" }, what: everyone.what, action: "deny" });
		const agent = rule({ who: { kind: "agent", agentId: "triage" }, what: everyone.what, action: "allow" });
		const session = rule({ who: { kind: "session", sessionId: "ses_1" }, what: everyone.what, action: "ask" });
		const request = http("POST", "/repos/a/issues");
		expect(decideConnectionRules(set([everyone, project]), scope, request, 0).rule?.id).toBe(project.id);
		expect(decideConnectionRules(set([everyone, project, agent]), scope, request, 0).rule?.id).toBe(agent.id);
		expect(decideConnectionRules(set([everyone, project, agent, session]), scope, request, 0).rule?.id).toBe(
			session.id,
		);
		// Another agent's session only gets the project's rule.
		expect(
			decideConnectionRules(set([everyone, project, agent]), { ...scope, agentId: "other" }, request, 0).rule?.id,
		).toBe(project.id);
	});

	it("names organisation-level agents as sessions in no project", () => {
		const org = rule({ who: { kind: "organisation" }, what: anyone, action: "allow" });
		expect(decideConnectionRules(set([org]), { agentId: "a", sessionId: "s" }, http("GET", "/"), 0).action).toBe(
			"allow",
		);
		expect(decideConnectionRules(set([org]), scope, http("GET", "/"), 0).by.kind).toBe("unmatched");
	});

	it("lets deny beat ask beat allow between equally specific rules", () => {
		const what = endpoint("GET", "/user");
		const allow = rule({ who: anyone, what, action: "allow" });
		const ask = rule({ who: anyone, what, action: "ask" });
		const deny = rule({ who: anyone, what, action: "deny" });
		const request = http("GET", "/user");
		expect(decideConnectionRules(set([allow, ask]), scope, request, 0).action).toBe("ask");
		expect(decideConnectionRules(set([allow, ask, deny]), scope, request, 0).action).toBe("deny");
	});

	it("lets the stricter win when neither rule is narrower on both who and what", () => {
		const agentAll = rule({ who: { kind: "agent", agentId: "triage" }, what: anyone, action: "allow" });
		const everyoneWrites = rule({ who: anyone, what: endpoint("POST", "/repos/**"), action: "ask" });
		expect(decideConnectionRules(set([agentAll, everyoneWrites]), scope, http("POST", "/repos/a"), 0).action).toBe(
			"ask",
		);
		expect(decideConnectionRules(set([agentAll, everyoneWrites]), scope, http("GET", "/repos/a"), 0).action).toBe(
			"allow",
		);
	});

	it("skips expired and used-up rules", () => {
		const expired = rule({ who: anyone, what: anyone, action: "allow", expiresAt: 100 });
		const spent = rule({ who: anyone, what: anyone, action: "allow", maxUses: 2, uses: 2 });
		const live = rule({ who: anyone, what: anyone, action: "allow", maxUses: 2, uses: 1 });
		expect(decideConnectionRules(set([expired]), scope, http("GET", "/"), 99).action).toBe("allow");
		expect(decideConnectionRules(set([expired]), scope, http("GET", "/"), 100).by.kind).toBe("unmatched");
		expect(decideConnectionRules(set([spent]), scope, http("GET", "/"), 0).by.kind).toBe("unmatched");
		expect(decideConnectionRules(set([live]), scope, http("GET", "/"), 0).rule?.id).toBe(live.id);
	});

	it("matches tools on MCP calls only, and lets listing through unless an any rule says otherwise", () => {
		const tool = rule({ who: anyone, what: { kind: "tool", tool: "delete_repo" }, action: "deny" });
		const call: RuleRequest = { kind: "mcp_call", method: "POST", host: "mcp.test", path: "/mcp", tool: "delete_repo" };
		const list: RuleRequest = { kind: "mcp_tools", method: "POST", host: "mcp.test", path: "/mcp" };
		expect(decideConnectionRules(set([tool]), scope, call, 0).action).toBe("deny");
		expect(decideConnectionRules(set([tool]), scope, { ...call, tool: "echo" }, 0).by.kind).toBe("unmatched");
		expect(decideConnectionRules(set([tool]), scope, list, 0)).toMatchObject({
			action: "allow",
			by: { kind: "listing" },
		});
		const blocked = rule({ who: { kind: "agent", agentId: "triage" }, what: anyone, action: "deny" });
		expect(decideConnectionRules(set([blocked]), scope, list, 0).action).toBe("deny");
		// A tool rule beats an any rule on the same call.
		const allowAll = rule({ who: anyone, what: anyone, action: "allow" });
		expect(decideConnectionRules(set([allowAll, tool]), scope, call, 0).action).toBe("deny");
	});
});

describe("the ceiling", () => {
	const ceiling: ConnectionCeiling = {
		set: true,
		routes: [{ host: "api.github.com", methods: ["GET", "HEAD"], pathPrefix: "/repos" }],
	};
	const connection = { hosts: ["api.github.com"] };

	it("bounds allow and ask rules, never deny", () => {
		expect(ruleOutsideCeiling(ceiling, { what: endpoint("GET", "/repos/*/issues"), action: "allow" }, connection)).toBe(
			undefined,
		);
		expect(ruleOutsideCeiling(ceiling, { what: endpoint("POST", "/repos/**"), action: "ask" }, connection)).toContain(
			"POST",
		);
		expect(ruleOutsideCeiling(ceiling, { what: endpoint("GET", "/user"), action: "allow" }, connection)).toBeDefined();
		expect(
			ruleOutsideCeiling(ceiling, { what: endpoint("*", "/repos/**"), action: "allow" }, connection),
		).toBeDefined();
		expect(ruleOutsideCeiling(ceiling, { what: anyone, action: "deny" }, connection)).toBeUndefined();
		expect(
			ruleOutsideCeiling({ set: false, routes: [] }, { what: anyone, action: "allow" }, connection),
		).toBeUndefined();
		// Whole segments: the ceiling's /repos does not cover /repositories.
		expect(
			ruleOutsideCeiling(ceiling, { what: endpoint("GET", "/repositories"), action: "allow" }, connection),
		).toBeDefined();
	});

	it("bounds tool rules by the server's URL", () => {
		const mcp = { hosts: ["mcp.test"], mcpUrl: "https://mcp.test/mcp" };
		const open: ConnectionCeiling = {
			set: true,
			routes: [{ host: "mcp.test", methods: ["POST"], pathPrefix: "/mcp" }],
		};
		expect(ruleOutsideCeiling(open, { what: { kind: "tool", tool: "echo" }, action: "allow" }, mcp)).toBeUndefined();
		expect(ruleOutsideCeiling(ceiling, { what: { kind: "tool", tool: "echo" }, action: "allow" }, mcp)).toBeDefined();
	});

	it("lets a request out only inside it", () => {
		expect(requestWithinCeiling(ceiling, http("GET", "/repos/a"))).toBe(true);
		expect(requestWithinCeiling(ceiling, http("POST", "/repos/a"))).toBe(false);
		expect(requestWithinCeiling(ceiling, http("GET", "/repositories"))).toBe(false);
		expect(requestWithinCeiling({ set: false, routes: [] }, http("DELETE", "/"))).toBe(true);
	});
});

describe("template defaults", () => {
	const decide = (inputs: readonly ConnectionRuleInput[], request: RuleRequest) =>
		decideConnectionRules(
			{
				rules: inputs.map((input) => ({ ...rule(input), source: "default" as const })),
				unmatched: DEFAULT_UNMATCHED,
				version: 1,
			},
			scope,
			request,
			0,
		).action;

	it("reads allow, writes ask and deletes are blocked for a template with read and write hints", () => {
		const github = defaultRuleInputs([
			{ method: "GET", path: "/**", access: "read" },
			{ method: "*", path: "/**", access: "write" },
		]);
		for (const [method, action] of [
			["GET", "allow"],
			["HEAD", "allow"],
			["POST", "ask"],
			["PUT", "ask"],
			["PATCH", "ask"],
			["OPTIONS", "ask"],
			["DELETE", "deny"],
		] as const) {
			expect(decide(github, http(method, "/repos/acme/x"))).toBe(action);
		}
	});

	it("blocks a delete under a narrower write hint, and with no hints at all", () => {
		const narrow = defaultRuleInputs([{ method: "*", path: "/repos/**", access: "write" }]);
		expect(decide(narrow, http("DELETE", "/repos/acme/x"))).toBe("deny");
		expect(decide(narrow, http("POST", "/repos/acme/x"))).toBe("ask");
		const none = defaultRuleInputs([]);
		expect(decide(none, http("GET", "/v1/models"))).toBe("allow");
		expect(decide(none, http("POST", "/v1/responses"))).toBe("ask");
		expect(decide(none, http("DELETE", "/v1/files/x"))).toBe("deny");
		expect(defaultRuleInputs(undefined)).toEqual(none);
	});

	it("keeps a GraphQL POST a write until #465 tells a query from a mutation", () => {
		const linear = defaultRuleInputs([{ method: "POST", path: "/graphql", access: "write" }]);
		expect(decide(linear, http("POST", "/graphql"))).toBe("ask");
	});

	it("tells read, write and delete by method", () => {
		expect(["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS", "DELETE"].map((m) => methodAccess(m as never))).toEqual([
			"read",
			"read",
			"write",
			"write",
			"write",
			"write",
			"delete",
		]);
	});

	it("gives annotated MCP tools defaults only while the rules are all defaults, and leaves unannotated ones to ask", () => {
		const tools = [
			{ name: "read", annotations: { readOnlyHint: true } },
			{ name: "drop", annotations: { destructiveHint: true } },
			{ name: "both", annotations: { readOnlyHint: true, destructiveHint: true } },
			{ name: "plain" },
		];
		const fresh = { rules: [], unmatched: "ask" as const, defaults: { reason: "created" as const, at: 0 } };
		expect(defaultToolRuleInputs(fresh, tools).map((input) => [input.what, input.action])).toEqual([
			[{ kind: "tool", tool: "read" }, "allow"],
			[{ kind: "tool", tool: "drop" }, "deny"],
			[{ kind: "tool", tool: "both" }, "deny"],
		]);
		const personal = rule({ who: anyone, what: { kind: "any" }, action: "deny" });
		expect(defaultToolRuleInputs({ ...fresh, rules: [personal] }, tools)).toEqual([]);
		expect(defaultToolRuleInputs({ ...fresh, unmatched: "allow" }, tools)).toEqual([]);
		expect(defaultToolRuleInputs({ rules: [], unmatched: "ask" }, tools)).toEqual([]);
	});
});
