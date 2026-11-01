import type { ConnectionUse } from "@kantel/contracts";
import type { ToolItem } from "@kantel/protocol";
import { describe, expect, it } from "vitest";
import type { Connection } from "../connections/connections-model.ts";
import {
	callConnectionsOf,
	connectionCallLabel,
	connectionCallNote,
	connectionCalls,
	connectionRequestOf,
	connectionResultOf,
	decisionOfUse,
	labelOfUse,
	refusedCall,
	resultCount,
	runCounts,
	scriptResultOf,
	serviceMessage,
} from "./connection-calls-model.ts";
import { GITHUB_SESSION_USES } from "./fixture-github-session.ts";

const call = (fields: Partial<ToolItem> & Pick<ToolItem, "id">): ToolItem => ({
	kind: "tool",
	callId: fields.id,
	name: "connection_request",
	label: "Calling connection_request",
	args: { connectionId: "conn_1", method: "GET", url: "https://api.github.com/user/repos?per_page=5" },
	status: "done",
	at: 0,
	...fields,
});

const use = (fields: Partial<ConnectionUse>): ConnectionUse =>
	({
		id: "cu_1",
		organisationId: "org_1",
		connectionId: "conn_1",
		kind: "http",
		method: "GET",
		host: "api.github.com",
		path: "/user/repos",
		outcome: "allowed",
		at: 0,
		...fields,
	}) as ConnectionUse;

describe("connectionRequestOf", () => {
	it("reads an HTTP request from its arguments, as an object or a JSON string", () => {
		const request = connectionRequestOf(
			call({
				id: "c1",
				args: JSON.stringify({
					connectionId: "conn_1",
					method: "post",
					url: "https://api.github.com/repos/o/r/issues",
					headers: { Accept: "application/json" },
					body: '{"title":"x"}',
				}),
			}),
		);
		expect(request).toMatchObject({
			kind: "http",
			connectionId: "conn_1",
			method: "POST",
			headers: [["Accept", "application/json"]],
			body: '{"title":"x"}',
			parts: { host: "api.github.com", path: "/repos/o/r/issues" },
		});
	});

	it("reads an MCP call's tool, and words its row from the tool's name", () => {
		const item = call({ id: "c1", name: "connection_call", args: { connectionId: "conn_2", tool: "search_issues" } });
		expect(connectionRequestOf(item)).toMatchObject({ kind: "mcp", connectionId: "conn_2", tool: "search_issues" });
		expect(connectionCallLabel(item)).toBe("Search issues");
	});
});

describe("connectionResultOf", () => {
	it("reads a response's status, type and body, and what was cut", () => {
		const result = connectionResultOf(
			call({
				id: "c1",
				output: 'HTTP 200 (application/json; charset=utf-8)\n\n[{"a":1}]\n[cut: 1200 more characters]',
			}),
		);
		expect(result).toEqual({
			kind: "response",
			status: 200,
			contentType: "application/json; charset=utf-8",
			body: '[{"a":1}]',
			cut: 1200,
			notes: [],
		});
	});

	it("reads Kantel's refusals by their code, an approval's by the approval's", () => {
		expect(connectionResultOf(call({ id: "c1", status: "error", output: "refused: A rule blocks writes." }))).toEqual({
			kind: "refused",
			code: "refused",
			message: "A rule blocks writes.",
		});
		const pending = connectionResultOf(
			call({ id: "c1", status: "error", output: "refused: approval_pending: Waiting for a person." }),
		);
		expect(pending).toMatchObject({ kind: "refused", code: "approval_pending" });
		expect(refusedCall(pending)).toBe(true);
		expect(refusedCall({ kind: "refused", code: "unavailable", message: "" })).toBe(false);
	});

	it("is waiting while it runs with nothing back, and stopped when interrupted", () => {
		expect(connectionResultOf(call({ id: "c1", status: "running" }))).toEqual({ kind: "waiting" });
		expect(connectionResultOf(call({ id: "c1", status: "interrupted" }))).toEqual({ kind: "interrupted" });
	});
});

describe("connectionCallNote", () => {
	it("says why the service refused, in its own first words", () => {
		const item = call({
			id: "c1",
			status: "error",
			output:
				'HTTP 404 (application/json)\n\n{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}',
		});
		expect(connectionCallNote(item)).toBe("GitHub refused it: Not Found");
	});

	it("says a server error failed, and why Kantel sent nothing", () => {
		expect(
			connectionCallNote(call({ id: "c1", status: "error", output: "HTTP 502 (text/html)\n\n<h1>Bad gateway</h1>" })),
		).toBe("GitHub failed: Bad gateway");
		expect(connectionCallNote(call({ id: "c1", status: "error", output: "approval_denied: Denied." }))).toBe(
			"A person denied it, so nothing was sent",
		);
		expect(connectionCallNote(call({ id: "c1", output: "HTTP 200 (application/json)\n\n[]" }))).toBeUndefined();
	});
});

describe("results and messages", () => {
	it("counts a search's results and a list's items", () => {
		expect(resultCount('{"total_count":295,"items":[]}')).toBe("295 results");
		expect(resultCount("[1,2,3]")).toBe("3 items");
		expect(resultCount("plain text")).toBeUndefined();
	});

	it("keeps a service message to its first two sentences, without links", () => {
		expect(
			serviceMessage(
				"Request forbidden by administrative rules. Please make sure your request has a User-Agent header (https://docs.github.com/en/rest/overview/resources-in-the-rest-api#user-agent-required). Check https://developer.github.com for other possible causes.",
			),
		).toBe("Request forbidden by administrative rules. Please make sure your request has a User-Agent header");
	});
});

describe("runCounts", () => {
	it("counts a run's requests and failures, and whether every failure was a refusal", () => {
		const refused = call({ id: "c1", status: "error", output: "HTTP 403 (text/plain)\n\nForbidden" });
		const fine = call({ id: "c2", output: "HTTP 200 (application/json)\n\n[]" });
		const broke = call({ id: "c3", status: "error", output: "unavailable: The connection is down." });
		expect(runCounts([refused, fine])).toEqual({ count: 2, failed: 1, allRefused: true });
		expect(runCounts([refused, fine, broke])).toEqual({ count: 3, failed: 2, allRefused: false });
	});
});

describe("decisionOfUse", () => {
	it("says what decided a request", () => {
		expect(decisionOfUse(use({ decidedBy: "unmatched" }))).toMatchObject({
			badge: "Allowed",
			words: "No rule covers it, and this connection lets such requests through",
		});
		expect(decisionOfUse(use({ decidedBy: "rule" }))).toMatchObject({ words: "A rule allowed it", rule: true });
		expect(
			decisionOfUse(use({ outcome: "denied", decidedBy: "rule", reason: "Writes to main are blocked." })),
		).toMatchObject({ badge: "Refused", tone: "error", words: "Writes to main are blocked", rule: true });
		expect(decisionOfUse(use({ outcome: "held" }))).toMatchObject({ badge: "Waiting", tone: "approval" });
	});

	it("words a script's request as its operation", () => {
		expect(labelOfUse(use({}))).toBe("List repositories you can access");
		expect(labelOfUse(use({ kind: "mcp_call", tool: "create_issue" }))).toBe("Create issue");
	});
});

describe("connectionCalls", () => {
	it("finds a call's use, and a script's uses in the order it made them", () => {
		const calls = connectionCalls([], GITHUB_SESSION_USES);
		const [first] = GITHUB_SESSION_USES;
		if (first?.toolCallId === undefined) throw new Error("No use");
		const scripts = new Set(
			GITHUB_SESSION_USES.flatMap((each) => /^(.+)\/c\d+$/.exec(each.toolCallId ?? "")?.[1] ?? []),
		);
		expect(scripts.size).toBe(8);
		for (const script of scripts) {
			const steps = calls.scriptUses(script).map((each) => Number(/\/c(\d+)$/.exec(each.toolCallId ?? "")?.[1]));
			expect(steps).toEqual(steps.toSorted((a, b) => a - b));
		}
		expect(calls.useOf("toolu_unknown")).toBeUndefined();
	});

	it("names the page's connections in the viewer's words", () => {
		const viewer = {
			userId: "usr_me",
			name: "Tom Davies",
			organisation: "Acme",
			projects: [{ id: "prj_1", name: "Default" }],
			admin: false,
			host: "Kantel",
			personal: false,
		};
		const [mine, theirs] = callConnectionsOf(
			[
				{
					id: "conn_1",
					templateId: "github",
					name: "GitHub",
					kind: "oauth",
					account: "tvdavies",
					owner: { kind: "project", organisationId: "org_1", projectId: "prj_1" },
					health: "healthy",
					hosts: [],
					createdAt: 0,
				},
				{
					id: "conn_2",
					templateId: "linear",
					name: "Linear",
					kind: "oauth",
					owner: { kind: "user", organisationId: "org_1", userId: "usr_other" },
					health: "healthy",
					hosts: [],
					createdAt: 0,
				},
			] satisfies Connection[],
			viewer,
			{ people: (id) => (id === "usr_other" ? "Ada" : undefined), href: (id) => `/connections?connection=${id}` },
		);
		expect(mine).toMatchObject({ account: "tvdavies", owner: "Default project", shared: false });
		expect(theirs).toMatchObject({ owner: "Ada", shared: true, href: "/connections?connection=conn_2" });
	});
});

describe("scriptResultOf", () => {
	it("reads a completed script's wall time and output", () => {
		expect(
			scriptResultOf({ status: "done", output: 'Script completed\nWall time 0.4 seconds\nOutput:\n"HTTP 200"' }),
		).toMatchObject({ ok: true, wallTime: "0.4 seconds", output: '"HTTP 200"' });
	});

	it("reads a failed script's error", () => {
		const result = scriptResultOf({
			status: "error",
			output:
				"Script failed\nWall time 0.6 seconds\nOutput:\nScript error:\nError: HTTP 404\n\nTool calls made before the failure (they are not undone): connection_request (error)",
		});
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Error: HTTP 404");
	});
});
