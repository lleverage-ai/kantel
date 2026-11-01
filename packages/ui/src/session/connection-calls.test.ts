import type { ToolItem } from "@kantel/protocol";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CONNECTION_TOOLS, connectionCalls, SCRIPT_TOOL } from "./connection-calls-model.ts";
import { ConnectionCallsContext } from "./connection-tools.tsx";
import { GITHUB_CONNECTION, GITHUB_SESSION, GITHUB_SESSION_USES } from "./fixture-github-session.ts";
import { ToolCallChip } from "./tool-call.tsx";
import { ToolRenderersContext } from "./tool-renderer-model.ts";
import { DEFAULT_TOOL_RENDERERS } from "./tool-renderers.tsx";
import { ToolRunRow } from "./tool-run.tsx";
import { Transcript, type TranscriptProps } from "./transcript.tsx";
import { groupTranscript, type TranscriptRow } from "./transcript-model.ts";

// Session 3430cd86 (fixture-github-session.ts) as the transcript renders it with the library's registry: its 32 GitHub
// requests read as GitHub and what each did, never as "Calling connection_request" or a bare "Calling codemode", and
// every call shows once.

// The virtualiser renders no rows on a server; here every row renders, in order.
vi.mock("virtua", () => ({
	VList: ({ data, children }: { data: readonly unknown[]; children: (entry: unknown, index: number) => ReactNode }) =>
		createElement("div", null, ...data.map((entry, index) => children(entry, index))),
}));

const host = connectionCalls([GITHUB_CONNECTION], GITHUB_SESSION_USES);
const withHost = (node: ReactNode) => createElement(ConnectionCallsContext.Provider, { value: host }, node);
const render = (props: TranscriptProps, known = true) => {
	const transcript = createElement(Transcript, props);
	return renderToStaticMarkup(known ? withHost(transcript) : transcript);
};
const count = (html: string, text: string) => html.split(text).length - 1;
// A finished turn folds its work under "Worked for"; the turn under way shows it: here, the first turn as it ends.
const secondAsk = GITHUB_SESSION.findIndex((item, index) => index > 0 && item.kind === "user");
const calls = GITHUB_SESSION.filter((item): item is ToolItem => item.kind === "tool");
const requests = calls.filter((call) => CONNECTION_TOOLS.includes(call.name));
const scripts = calls.filter((call) => call.name === SCRIPT_TOOL);
const rows = (): readonly TranscriptRow[] =>
	groupTranscript(
		GITHUB_SESSION,
		undefined,
		DEFAULT_TOOL_RENDERERS.inPlace,
		(item) => DEFAULT_TOOL_RENDERERS.run(item)?.id,
	);

/** Every call in the rows, by its ID, as often as a row holds it. */
function callsInRows(list: readonly TranscriptRow[]): string[] {
	const ids: string[] = [];
	for (const row of list) {
		if (row.kind === "run" || row.kind === "tools")
			for (const step of row.items) if (step.kind === "tool") ids.push(step.id);
		if (row.kind === "call" || row.kind === "subagent") ids.push(row.item.id);
	}
	return ids;
}

/** Each run row as the transcript renders it, open. */
function runRows(known = true): string[] {
	const run = DEFAULT_TOOL_RENDERERS.run({ name: "connection_request" });
	if (run === undefined) throw new Error("No connection run");
	return rows()
		.filter((row) => row.kind === "run")
		.map((row) => {
			const node = createElement(
				ToolRenderersContext.Provider,
				{ value: DEFAULT_TOOL_RENDERERS },
				createElement(ToolRunRow, { items: row.items, run, defaultOpen: true }),
			);
			return renderToStaticMarkup(known ? withHost(node) : node);
		});
}

describe("session 3430cd86's GitHub calls", () => {
	it("has the session's 32 requests: 5 calls of their own and 27 in 8 scripts", () => {
		expect(requests).toHaveLength(5);
		expect(scripts).toHaveLength(8);
		expect(GITHUB_SESSION_USES).toHaveLength(32);
		expect(scripts.reduce((sum, script) => sum + host.scriptUses(script.callId).length, 0)).toBe(27);
	});

	it('shows no "Calling connection_request" and no bare "Calling codemode" row', () => {
		for (const known of [true, false]) {
			const html = [
				render({ items: GITHUB_SESSION.slice(0, secondAsk), working: true }, known),
				...runRows(known),
			].join("");
			expect(html).toContain("Used GitHub");
			expect(html).not.toContain("Calling connection_request");
			expect(html).not.toContain("Calling codemode");
		}
		const open = renderToStaticMarkup(
			withHost(
				createElement(
					ToolRenderersContext.Provider,
					{ value: DEFAULT_TOOL_RENDERERS },
					...calls.map((call) => createElement(ToolCallChip, { key: call.id, item: call })),
				),
			),
		);
		expect(open).not.toContain("Calling connection_request");
		expect(open).not.toContain("Calling codemode");
		expect(count(open, "Ran a script")).toBe(8);
		expect(open).toContain('Ran a script</span><span class="kt-script-requests');
		expect(open).toContain(", 9 GitHub requests");
	});

	it("puts each call in exactly one row, the connection calls in runs", () => {
		const list = rows();
		const ids = callsInRows(list);
		expect(ids.toSorted()).toEqual(calls.map((call) => call.id).toSorted());
		const runs = list.filter((row) => row.kind === "run");
		// The agent's words between requests end a run, as they end any group of calls; its thoughts stay in it.
		expect(runs.map((row) => row.run)).toEqual(["connection", "connection", "connection"]);
		const inRuns = runs.flatMap((row) => row.items.filter((step) => step.kind === "tool").map((step) => step.id));
		expect(inRuns.toSorted()).toEqual(requests.map((call) => call.id).toSorted());
	});

	it("says each run as the service, the account and how it went", () => {
		const lines = runRows()
			.map((html) => html.slice(0, html.indexOf("</button>")).replace(/<[^>]+>/g, ""))
			.join("\n");
		expect(lines).toBe(
			"Used GitHub as tvdavies, 2 requests, 1 refused\nUsed GitHub as tvdavies, 1 request\nUsed GitHub as tvdavies, 2 requests",
		);
		// Without the host's data a run still names the service, from the request's host.
		expect(runRows(false)[0]).toContain("Used GitHub</span>");
		// In the transcript, the turn's last run still says what it is doing while the turn is under way.
		const html = render({ items: GITHUB_SESSION.slice(0, secondAsk), working: true });
		expect(count(html, "kt-run-line")).toBe(2);
		expect(html).toContain("Used GitHub");
	});

	it("opens a run to its requests in words, with GitHub's refusal under the first", () => {
		const [html = ""] = runRows();
		expect(count(html, "Search pull requests: author tvdavies, created 31 Oct")).toBe(2);
		expect(html).toContain(
			"GitHub refused it: Request forbidden by administrative rules. Please make sure your request has a User-Agent header",
		);
		expect(html).toContain(">403<");
		expect(html).toContain("0 results");
	});

	it("opens a request to its line, connection, decision and response", () => {
		const call = requests.find((item) => item.output?.includes('"total_count":0'));
		if (call === undefined) throw new Error("No search");
		const html = renderToStaticMarkup(
			withHost(
				createElement(
					ToolRenderersContext.Provider,
					{ value: DEFAULT_TOOL_RENDERERS },
					createElement(ToolCallChip, { item: call, defaultOpen: true }),
				),
			),
		);
		expect(html).toContain(">api.github.com</span>");
		expect(html).toContain(">type:pr author:tvdavies created:2026-10-31<");
		expect(html).toContain('as <span class="font-medium">tvdavies</span>');
		expect(html).toContain("Default project");
		expect(html).toContain("No rule covers it, and this connection lets such requests through");
		expect(html).toContain("application/json, 79 bytes, 1.8s");
		expect(html).toContain("kt-json-viewer");
		expect(html).toContain('aria-pressed="false"');
	});

	it("opens a script to the requests it made, its code and its output", () => {
		const script = scripts.find((item) => host.scriptUses(item.callId).length === 9);
		if (script === undefined) throw new Error("No script of nine requests");
		const html = renderToStaticMarkup(
			withHost(
				createElement(
					ToolRenderersContext.Provider,
					{ value: DEFAULT_TOOL_RENDERERS },
					createElement(ToolCallChip, { item: script, defaultOpen: true }),
				),
			),
		);
		expect(html).toContain("9 GitHub requests");
		expect(html).toContain("List repositories you can access");
		expect(html).toContain("9 times");
		expect(html).toContain("The script");
		expect(html).toContain("Ran for 5.1 seconds");
	});

	it("says why a failed script failed, under its row", () => {
		const failed = scripts.filter((item) => item.status === "error");
		const html = renderToStaticMarkup(
			withHost(
				createElement(
					ToolRenderersContext.Provider,
					{ value: DEFAULT_TOOL_RENDERERS },
					...failed.map((item) => createElement(ToolCallChip, { key: item.id, item })),
				),
			),
		);
		expect(html).toContain("Error: HTTP 404 (application/json; charset=utf-8)");
		expect(html).toContain("SyntaxError: Unexpected end of JSON input");
	});
});

describe("an MCP connection call", () => {
	it("opens to the tool, its arguments as chips, and its answer", () => {
		const call: ToolItem = {
			kind: "tool",
			id: "mcp",
			callId: "toolu_mcp",
			name: "connection_call",
			label: "Calling connection_call",
			args: { connectionId: "conn_linear", tool: "list_issues", arguments: { assignee: "me", limit: 5 } },
			status: "done",
			at: 0,
			endedAt: 800,
			output: '[{"identifier":"HAR-459"}]',
		};
		const html = renderToStaticMarkup(
			createElement(
				ToolRenderersContext.Provider,
				{ value: DEFAULT_TOOL_RENDERERS },
				createElement(ToolCallChip, { item: call, defaultOpen: true }),
			),
		);
		expect(html).toContain("List issues");
		expect(html).not.toContain("Calling connection_call");
		expect(html).toContain('aria-label="Arguments"');
		expect(html).toContain(">assignee<");
		expect(html).toContain(">5<");
		expect(html).toContain("The tool answered in 800ms");
	});
});
