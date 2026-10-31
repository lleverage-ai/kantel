import { describe, expect, it } from "vitest";
import {
	entriesInclude,
	entryServers,
	parseToolServerEntry,
	replayOf,
	TOOL_SERVER_MODEL_NAME_MAX,
	toolServerEntryProblems,
	toolServerModelName,
	toolServerNameProblem,
	toolServersEnabled,
} from "../src/tool-servers.ts";

describe("the tool servers switch", () => {
	it("is on only for experimental", () => {
		expect(toolServersEnabled("experimental")).toBe(true);
		expect(toolServersEnabled(" Experimental ")).toBe(true);
		expect(toolServersEnabled("on")).toBe(false);
		expect(toolServersEnabled("")).toBe(false);
		expect(toolServersEnabled(undefined)).toBe(false);
	});
});

describe("tool server names", () => {
	it("takes lower-case slugs", () => {
		expect(toolServerNameProblem("sal")).toBeUndefined();
		expect(toolServerNameProblem("sal-worker-2")).toBeUndefined();
		expect(toolServerNameProblem("Sal")).toBeDefined();
		expect(toolServerNameProblem("sal_worker")).toBeDefined();
		expect(toolServerNameProblem("sal--worker")).toBeDefined();
		expect(toolServerNameProblem("-sal")).toBeDefined();
		expect(toolServerNameProblem("")).toBeDefined();
		expect(toolServerNameProblem("a".repeat(33))).toBeDefined();
	});
});

describe("profile entries", () => {
	it("parses server entries and leaves plain names alone", () => {
		expect(parseToolServerEntry("sal/task_outcome")).toEqual({ server: "sal", tool: "task_outcome" });
		expect(parseToolServerEntry("sal/*")).toEqual({ server: "sal", tool: "*" });
		expect(parseToolServerEntry("bash")).toBeUndefined();
	});

	it("names a tool for the model as server__tool", () => {
		expect(toolServerModelName("sal", "task_outcome")).toBe("sal__task_outcome");
	});

	it("refuses a tool name too long for the model", () => {
		const fits = "t".repeat(TOOL_SERVER_MODEL_NAME_MAX - "sal__".length);
		expect(toolServerEntryProblems(["bash", "sal/*", `sal/${fits}`])).toEqual([]);
		const problems = toolServerEntryProblems([`sal/${fits}x`]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("at most 50");
	});

	it("refuses a bad server, an empty tool and a tool name the model can't take", () => {
		expect(toolServerEntryProblems(["Sal/x", "sal/", "sal/a.b"])).toHaveLength(3);
	});

	it("matches entries and lists their servers", () => {
		expect(entriesInclude(["sal/*"], "sal", "anything")).toBe(true);
		expect(entriesInclude(["sal/a"], "sal", "a")).toBe(true);
		expect(entriesInclude(["sal/a"], "sal", "b")).toBe(false);
		expect(entryServers(["bash", "sal/a", "sal/b", "docs/*"])).toEqual(["sal", "docs"]);
	});
});

describe("replay", () => {
	it("is safe only for a read-only hint", () => {
		expect(replayOf({ readOnlyHint: true })).toBe("safe");
		expect(replayOf({ readOnlyHint: false })).toBe("unsafe");
		expect(replayOf({ idempotentHint: true })).toBe("unsafe");
		expect(replayOf(undefined)).toBe("unsafe");
	});
});
