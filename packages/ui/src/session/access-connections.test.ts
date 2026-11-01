// The access menu's connections (#463): each connection's policy line says what the rules decide, checked against the
// contract's own decision and the dry run; a session's allowances are its own rules; revoking one makes the next
// matching request ask.
import {
	type ConnectionRuleAction,
	type ConnectionRules,
	decideConnectionRules,
	type HttpMethod,
} from "@kantel/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { choiceOf, readPolicyGrid } from "../connections/connection-policy-model.ts";
import {
	CONNECTIONS,
	createRulesScenario,
	createSessionAccessScenario,
	FIXTURE_NOW,
	FIXTURE_RULES,
	FIXTURE_SESSION_ID,
	MEMBER_VIEWER,
	MIGRATED_RULES,
	OPEN_RULES,
	POLICY_RULES,
	policyFixture,
	VIEWER,
} from "../connections/fixtures.ts";
import { accessPolicyLine, SessionAccessConnections, sessionAllowances } from "./access-connections.tsx";
import { AccessPicker } from "./access-picker.tsx";

const HOST = "api.github.com";
const github = { templateId: "github", host: HOST, now: FIXTURE_NOW } as const;
const http = (rules: ConnectionRules) => ({ kind: "http" as const, templateId: "github", hosts: [HOST], rules });

/** Requests of each column, as an agent would make them. */
const REQUESTS: Record<"reads" | "writes" | "deletes", readonly (readonly [HttpMethod, string])[]> = {
	reads: [
		["GET", "/user"],
		["GET", "/repos/tvdavies/sal/issues"],
		["HEAD", "/repos/tvdavies/sal"],
		["GET", "/repos/tvdavies/sal/actions/runs"],
	],
	writes: [
		["POST", "/repos/tvdavies/sal/issues"],
		["PATCH", "/repos/tvdavies/sal/pulls/3"],
		["POST", "/graphql"],
		["POST", "/repos/tvdavies/sal/actions/workflows/ci.yml/dispatches"],
	],
	deletes: [
		["DELETE", "/repos/tvdavies/sal"],
		["DELETE", "/repos/tvdavies/sal/issues/comments/9"],
	],
};
const WORD: Record<string, ConnectionRuleAction> = { allowed: "allow", ask: "ask", blocked: "deny" };

/** What the line says each column gets: "Reads allowed, writes ask, deletes blocked". */
function said(line: string): Record<string, ConnectionRuleAction | "vary"> {
	return Object.fromEntries(
		line
			.split(", ")
			.filter((part) => !part.startsWith("only in"))
			.map((part) => {
				const [noun, word] = part.toLowerCase().split(" ") as [string, string];
				return [noun, WORD[word] ?? "vary"];
			}),
	);
}

const SETS: Record<string, ConnectionRules> = {
	"GitHub's defaults, with exceptions": POLICY_RULES,
	"migrated to the defaults": { ...MIGRATED_RULES, connectionId: "conn_github_tom" },
	"writes allowed in the grid": policyFixture(
		POLICY_RULES,
		choiceOf(readPolicyGrid(POLICY_RULES, github), { cell: { key: "repo:write", action: "allow" } }),
	),
	"everything allowed, as before rules": { connectionId: "conn_github_tom", rules: [], unmatched: "allow", version: 0 },
	"a person's rules letting unmatched through": { ...OPEN_RULES, connectionId: "conn_github_tom" },
};

describe("a connection's policy line", () => {
	for (const [name, rules] of Object.entries(SETS)) {
		it(`says what the decision and the dry run answer: ${name}`, async () => {
			const line = accessPolicyLine(http(rules), { now: FIXTURE_NOW });
			const columns = said(line);
			const source = createRulesScenario({
				connections: () => CONNECTIONS,
				viewer: VIEWER,
				wait: async (value) => value(),
				initial: { conn_github_tom: rules },
			});
			for (const [column, requests] of Object.entries(REQUESTS)) {
				const answer = columns[column];
				expect(answer, `${line}: ${column}`).toBeDefined();
				if (answer === "vary") continue;
				for (const [method, path] of requests) {
					const decided = decideConnectionRules(
						rules,
						{ agentId: "triage", sessionId: "ses_other" },
						{ kind: "http", method, host: HOST, path },
						FIXTURE_NOW,
					);
					expect(decided.action, `${line}: ${method} ${path}`).toBe(answer);
					const tried = await source.dryRun("conn_github_tom", {
						method,
						url: `https://${HOST}${path}`,
						audience: "private",
						agentId: "triage",
					});
					expect(tried.action, `dry run of ${method} ${path}`).toBe(answer);
				}
			}
		});
	}

	it("reads GitHub's defaults as the menu says them", () => {
		expect(accessPolicyLine(http(POLICY_RULES), { now: FIXTURE_NOW })).toBe(
			"Reads allowed, writes ask, deletes blocked",
		);
	});

	it("leaves this session's own rules to the list under it", () => {
		const line = accessPolicyLine(http(POLICY_RULES), { now: FIXTURE_NOW });
		const withoutSession = {
			...POLICY_RULES,
			rules: POLICY_RULES.rules.filter((rule) => rule.who.kind !== "session"),
		};
		expect(accessPolicyLine(http(withoutSession), { now: FIXTURE_NOW })).toBe(line);
	});

	it("says an MCP server's tool rules, and when the rules can't be read", () => {
		const linear = FIXTURE_RULES.conn_linear_support;
		expect(accessPolicyLine({ kind: "mcp", hosts: [], rules: linear }, { now: FIXTURE_NOW })).toBe(
			"2 tools have a rule, other tools ask first",
		);
		expect(
			accessPolicyLine(
				{ kind: "mcp", hosts: [], rules: { connectionId: "c", rules: [], unmatched: "allow", version: 0 } },
				{ now: FIXTURE_NOW },
			),
		).toBe("Every tool goes through");
		expect(accessPolicyLine({ kind: "http", hosts: [HOST] }, { now: FIXTURE_NOW })).toBe(
			"Its rules aren't visible to you",
		);
	});
});

describe("a session's allowances", () => {
	it("are its own session rules, oldest first", () => {
		expect(sessionAllowances(POLICY_RULES, FIXTURE_SESSION_ID).map((rule) => rule.id)).toEqual([
			"cr_tom_session_comments",
		]);
		expect(sessionAllowances(POLICY_RULES, "ses_other")).toEqual([]);
		expect(sessionAllowances(undefined, FIXTURE_SESSION_ID)).toEqual([]);
	});

	it("once revoked, leave the next matching request to ask", async () => {
		const rules = createRulesScenario({
			connections: () => CONNECTIONS,
			viewer: VIEWER,
			wait: async (value) => value(),
			initial: { conn_github_tom: POLICY_RULES },
		});
		const menu = createSessionAccessScenario({ rules, delay: 0 });
		const comment = () =>
			rules.dryRun("conn_github_tom", {
				method: "POST",
				url: "https://api.github.com/repos/tvdavies/harbour/issues/12/comments",
				audience: "private",
				sessionId: FIXTURE_SESSION_ID,
			});
		expect((await comment()).action).toBe("allow");
		const github = (await menu.connections()).find((item) => item.connection.id === "conn_github_tom");
		const [allowance] = sessionAllowances(github?.rules, menu.sessionId);
		expect(github?.canManage).toBe(true);
		await menu.revoke("conn_github_tom", allowance?.id ?? "");
		expect((await comment()).action).toBe("ask");
		const after = (await menu.connections()).find((item) => item.connection.id === "conn_github_tom");
		expect(sessionAllowances(after?.rules, menu.sessionId)).toEqual([]);
	});

	it("offer Revoke only on connections the viewer manages", async () => {
		const member = await createSessionAccessScenario({ delay: 0, viewer: MEMBER_VIEWER }).connections();
		expect(Object.fromEntries(member.map((item) => [item.connection.id, item.canManage]))).toEqual({
			conn_github_tom: true,
			conn_gmail_tom: true,
			conn_github_bot: false,
			conn_slack_org: false,
		});
	});
});

describe("the access menu with connections", () => {
	it("keeps the levels a radio menu and puts the connections beside it, not in it", () => {
		const html = renderToStaticMarkup(
			createElement(AccessPicker, {
				options: [{ id: "full-access", label: "Full access" }],
				defaultOpen: true,
				connections: createElement(SessionAccessConnections, {
					source: createSessionAccessScenario({ hang: true }),
					now: FIXTURE_NOW,
				}),
			}),
		);
		const menu = html.slice(html.indexOf('role="menu"'), html.indexOf("kt-access-connections"));
		expect(menu).toContain('role="menuitemradio"');
		expect(menu).not.toContain("Connections in this session");
		expect(html).toContain("Connections in this session");
		expect(html).toContain('aria-label="Loading its connections"');
	});
});
