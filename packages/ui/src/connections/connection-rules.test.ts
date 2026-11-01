// The rules editor's words and order, and the fixture source the stories and the console's recorded mode use: it
// decides with the contract's functions, so what the stories show is what the API answers.
import { describe, expect, it } from "vitest";
import { byPrecedence, whatText, whoText } from "./connection-rules.tsx";
import { canManage } from "./connections-model.ts";
import { CONNECTIONS, createRulesScenario, FIXTURE_RULES, MEMBER_VIEWER, VIEWER } from "./fixtures.ts";

const github = CONNECTIONS.find((c) => c.id === "conn_github_tom");
const scenario = (ceiling?: Parameters<typeof createRulesScenario>[0]["ceiling"]) =>
	createRulesScenario({
		connections: () => CONNECTIONS,
		viewer: VIEWER,
		wait: async (value) => value(),
		...(ceiling === undefined ? {} : { ceiling }),
	});

describe("the rules' words", () => {
	it("names who a rule is for, with project names", () => {
		expect(whoText({ kind: "any" }, VIEWER)).toBe("Any agent");
		expect(whoText({ kind: "organisation" }, VIEWER)).toBe("Agents outside projects");
		expect(whoText({ kind: "project", projectId: "proj_support" }, VIEWER)).toBe("In Support");
		expect(whoText({ kind: "project", projectId: "proj_gone" }, VIEWER)).toBe("In proj_gone");
		expect(whoText({ kind: "agent", agentId: "triage" }, VIEWER)).toBe("Agent triage");
	});

	it("writes what a rule covers as a request line", () => {
		expect(whatText({ kind: "any" })).toBe("Any request");
		expect(whatText({ kind: "tool", tool: "create_issue" })).toBe("create_issue");
		expect(whatText({ kind: "endpoint", method: "*", path: "/**" })).toBe("Any /**");
		expect(whatText({ kind: "endpoint", method: "GET", host: "api.github.com", path: "/user" })).toBe(
			"GET api.github.com/user",
		);
	});

	it("lists the rules in the order they decide: narrowest what, then who, then the strictest", () => {
		const ordered = byPrecedence(FIXTURE_RULES.conn_github_tom?.rules ?? []).map((rule) => rule.id);
		expect(ordered).toEqual(["cr_gh_release", "cr_gh_issues", "cr_gh_delete", "cr_gh_reads", "cr_gh_writes"]);
	});
});

describe("who may change a connection's rules", () => {
	it("is whoever manages the connection", () => {
		const user = CONNECTIONS.find((c) => c.owner.kind === "user" && c.owner.userId === "usr_tom");
		const org = CONNECTIONS.find((c) => c.owner.kind === "organisation");
		if (user === undefined || org === undefined) throw new Error("fixtures changed");
		expect(canManage(user, MEMBER_VIEWER)).toBe(true);
		expect(canManage(org, VIEWER)).toBe(true);
		expect(canManage(org, MEMBER_VIEWER)).toBe(false);
	});
});

describe("the fixture rules source", () => {
	it("decides a dry run the way the API does: the narrowest rule, then the unmatched answer", async () => {
		const source = scenario();
		const at = (method: "GET" | "POST" | "DELETE", path: string, agentId?: string) =>
			source.dryRun("conn_github_tom", {
				method,
				url: `https://api.github.com${path}`,
				audience: "private",
				...(agentId === undefined ? {} : { agentId }),
			});
		expect((await at("GET", "/user")).action).toBe("allow");
		expect(await at("DELETE", "/repos/acme/web")).toMatchObject({
			action: "deny",
			by: { kind: "rule", ruleId: "cr_gh_delete" },
		});
		expect(await at("POST", "/repos/acme/web/issues", "triage")).toMatchObject({
			action: "allow",
			by: { kind: "rule", ruleId: "cr_gh_issues" },
		});
		expect((await at("POST", "/repos/acme/web/issues", "writer")).action).toBe("ask");
	});

	it("refuses before the rules: a personal connection in a shared session, another host, outside the ceiling", async () => {
		const source = scenario({
			set: true,
			routes: [{ host: "api.github.com", methods: ["GET"], pathPrefix: "/" }],
		});
		const shared = await source.dryRun("conn_github_tom", { method: "GET", url: "https://api.github.com/user" });
		expect(shared.by.kind).toBe("usage");
		const host = await source.dryRun("conn_github_tom", {
			method: "GET",
			url: "https://evil.example/",
			audience: "private",
		});
		expect(host.by.kind).toBe("connection");
		const ceiling = await source.dryRun("conn_github_tom", {
			method: "POST",
			url: "https://api.github.com/repos/acme/web/issues",
			audience: "private",
			agentId: "triage",
		});
		expect(ceiling).toMatchObject({ action: "deny", by: { kind: "ceiling" } });
	});

	it("bumps the version on each change, refuses a bad path, and won't allow past the ceiling", async () => {
		const source = scenario({
			set: true,
			routes: [{ host: "api.github.com", methods: ["GET"], pathPrefix: "/" }],
		});
		const before = (await source.get("conn_github_tom")).version;
		await source.update("conn_github_tom", { unmatched: "deny" });
		expect((await source.get("conn_github_tom")).version).toBe(before + 1);
		await expect(
			source.create("conn_github_tom", {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "GET", path: "repos" },
				action: "allow",
			}),
		).rejects.toThrow();
		await expect(
			source.create("conn_github_tom", {
				who: { kind: "any" },
				what: { kind: "endpoint", method: "POST", path: "/repos/**" },
				action: "allow",
			}),
		).rejects.toThrow(/can't be saved/);
		const denied = await source.create("conn_github_tom", {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "POST", path: "/repos/**" },
			action: "deny",
		});
		expect(denied.action).toBe("deny");
	});

	it("starts a connection made before rules with none, letting everything through", async () => {
		const rules = await scenario().get("conn_slack_org");
		expect(rules).toEqual({ connectionId: "conn_slack_org", rules: [], unmatched: "allow", version: 0 });
		expect(github).toBeDefined();
	});

	it("resets to the template's defaults: reads allow, writes ask, deletes are blocked, and a person's rules stay", async () => {
		const source = scenario();
		const reset = await source.update("conn_github_tom", { reset: "template" });
		expect(reset.unmatched).toBe("ask");
		expect(reset.defaults?.reason).toBe("reset");
		expect(reset.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["cr_gh_issues", "cr_gh_delete"]));
		const ask = (method: "GET" | "POST" | "DELETE", path: string) =>
			source.dryRun("conn_github_tom", { method, url: `https://api.github.com${path}`, audience: "private" });
		expect((await ask("GET", "/user")).action).toBe("allow");
		expect((await ask("POST", "/gists")).action).toBe("ask");
		expect((await ask("DELETE", "/gists/1")).action).toBe("deny");
	});
});
