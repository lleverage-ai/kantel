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
		expect(toolServerNameProblem("atlas")).toBeUndefined();
		expect(toolServerNameProblem("atlas-worker-2")).toBeUndefined();
		expect(toolServerNameProblem("Atlas")).toBeDefined();
		expect(toolServerNameProblem("atlas_worker")).toBeDefined();
		expect(toolServerNameProblem("atlas--worker")).toBeDefined();
		expect(toolServerNameProblem("-atlas")).toBeDefined();
		expect(toolServerNameProblem("")).toBeDefined();
		expect(toolServerNameProblem("a".repeat(33))).toBeDefined();
	});
});

describe("profile entries", () => {
	it("parses server entries and leaves plain names alone", () => {
		expect(parseToolServerEntry("atlas/task_outcome")).toEqual({ server: "atlas", tool: "task_outcome" });
		expect(parseToolServerEntry("atlas/*")).toEqual({ server: "atlas", tool: "*" });
		expect(parseToolServerEntry("bash")).toBeUndefined();
	});

	it("names a tool for the model as server__tool", () => {
		expect(toolServerModelName("atlas", "task_outcome")).toBe("atlas__task_outcome");
	});

	it("refuses a tool name too long for the model", () => {
		const fits = "t".repeat(TOOL_SERVER_MODEL_NAME_MAX - "atlas__".length);
		expect(toolServerEntryProblems(["bash", "atlas/*", `atlas/${fits}`])).toEqual([]);
		const problems = toolServerEntryProblems([`atlas/${fits}x`]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("at most 50");
	});

	it("refuses a bad server, an empty tool and a tool name the model can't take", () => {
		expect(toolServerEntryProblems(["Atlas/x", "atlas/", "atlas/a.b"])).toHaveLength(3);
	});

	it("matches entries and lists their servers", () => {
		expect(entriesInclude(["atlas/*"], "atlas", "anything")).toBe(true);
		expect(entriesInclude(["atlas/a"], "atlas", "a")).toBe(true);
		expect(entriesInclude(["atlas/a"], "atlas", "b")).toBe(false);
		expect(entryServers(["bash", "atlas/a", "atlas/b", "docs/*"])).toEqual(["atlas", "docs"]);
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
