import { describe, expect, it } from "vitest";
import {
	alwaysAllowRule,
	byteSize,
	hiddenCount,
	markHidden,
	readableBody,
	requestUrl,
	ruleSummary,
} from "./exact-request-model.ts";

const AGENT = { kind: "agent", agentId: "triage", sessionId: "ses_1" } as const;

describe("alwaysAllowRule", () => {
	const request = {
		kind: "http",
		method: "POST",
		host: "api.github.com",
		path: "/repos/acme/x/issues",
		connectionId: "conn_1",
	} as const;
	it("allows the same method and path for the agent, or the same MCP tool, never by body", () => {
		const rule = alwaysAllowRule({
			id: "prop_1",
			requester: { actor: AGENT, agentId: "triage", sessionId: "ses_1" },
			terms: { request } as never,
		})!;
		expect(rule).toEqual({
			who: { kind: "agent", agentId: "triage" },
			what: { kind: "endpoint", method: "POST", path: "/repos/acme/x/issues", host: "api.github.com" },
			action: "allow",
			note: "From approval prop_1",
		});
		expect(ruleSummary(rule)).toBe("POST /repos/acme/x/issues, for this agent");
		const tool = alwaysAllowRule({
			id: "prop_2",
			requester: { actor: AGENT, sessionId: "ses_1" },
			terms: { request: { ...request, kind: "mcp_call", tool: "echo" } } as never,
		})!;
		expect(tool.who).toEqual({ kind: "session", sessionId: "ses_1" });
		expect(ruleSummary(tool)).toBe("the echo tool, for this session");
		expect(alwaysAllowRule({ id: "p", requester: { actor: AGENT }, terms: {} as never })).toBe(undefined);
	});
});

describe("markHidden", () => {
	it("draws every character no one can see by name, and leaves newlines and tabs as layout", () => {
		expect(markHidden("a\u200bb\u202Ec\n\td")).toEqual([
			{ kind: "text", text: "a" },
			{ kind: "hidden", code: "U+200B", name: "ZWSP" },
			{ kind: "text", text: "b" },
			{ kind: "hidden", code: "U+202E", name: "RLO" },
			{ kind: "text", text: "c\n\td" },
		]);
		expect(markHidden("\u0000\u00a0\u{E0041}").map((run) => (run.kind === "hidden" ? run.name : run.text))).toEqual([
			"NUL",
			"NBSP",
			"U+E0041",
		]);
		expect(hiddenCount("plain text, café, 日本")).toBe(0);
		expect(hiddenCount("x\u200dy\ufeff")).toBe(2);
	});
});

describe("requestUrl", () => {
	it("writes the URL as it goes out, leaving out the scheme's default port", () => {
		const search = "s=a+b&a=1&flag";
		expect(requestUrl({ scheme: "https", host: "api.example.com", port: 443, path: "/x", search })).toBe(
			"https://api.example.com/x?s=a+b&a=1&flag",
		);
		expect(requestUrl({ scheme: "https", host: "api.example.com", port: 8443, path: "/", search: "" })).toBe(
			"https://api.example.com:8443/",
		);
	});
});

describe("readableBody", () => {
	it("formats JSON for reading and leaves anything else as sent", () => {
		expect(readableBody('{"a":1}', "application/json")).toEqual({ text: '{\n  "a": 1\n}', formatted: true });
		expect(readableBody("{not json", "application/json")).toEqual({ text: "{not json", formatted: false });
		expect(readableBody('{"a":1}', "text/plain")).toEqual({ text: '{"a":1}', formatted: false });
		expect(byteSize("é")).toBe("2 bytes");
		expect(byteSize("x".repeat(2048))).toBe("2.0 KB");
	});
});
