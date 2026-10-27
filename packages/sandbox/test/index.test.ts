import { DEFAULT_TIER_ROUTES, type TierRoute } from "@harbour/contracts";
import { commandProgram, routeTool, tokenizeShell } from "@harbour/sandbox";
import { describe, expect, it } from "vitest";

describe("tokenizeShell", () => {
	it("splits words and operators and honours quotes and escapes", () => {
		expect(tokenizeShell(`printf '%s' "a \\"b\\"" > out\\ file && echo x>>y # comment`)).toEqual({
			tokens: [
				{ kind: "word", value: "printf" },
				{ kind: "word", value: "%s" },
				{ kind: "word", value: 'a "b"' },
				{ kind: "operator", value: ">" },
				{ kind: "word", value: "out file" },
				{ kind: "operator", value: "&&" },
				{ kind: "word", value: "echo" },
				{ kind: "word", value: "x" },
				{ kind: "operator", value: ">>" },
				{ kind: "word", value: "y" },
			],
		});
		expect(tokenizeShell("printf ''").tokens).toEqual([
			{ kind: "word", value: "printf" },
			{ kind: "word", value: "" },
		]);
	});

	it("reports expansions, globs and unterminated quotes as problems but keeps the tokens", () => {
		expect(tokenizeShell("echo $HOME").problem).toBeDefined();
		expect(tokenizeShell("cat *.md").problem).toBeDefined();
		expect(tokenizeShell("echo 'open").problem).toBe("unterminated single quote");
		expect(tokenizeShell("echo '$HOME'").problem).toBeUndefined();
		expect(tokenizeShell("git log $(x)").tokens[0]).toEqual({ kind: "word", value: "git" });
	});
});

describe("commandProgram", () => {
	it("skips leading cd steps and assignments and takes the basename", () => {
		expect(commandProgram("git status")).toBe("git");
		expect(commandProgram("cd 'my repo' && cd sub && git status")).toBe("git");
		expect(commandProgram("FOO=1 BAR='x y' bun test")).toBe("bun");
		expect(commandProgram("/usr/bin/git status")).toBe("git");
		expect(commandProgram(["/usr/local/bin/node", "x.js"])).toBe("node");
		expect(commandProgram("cd repo; git status")).toBe("cd");
		expect(commandProgram("")).toBeUndefined();
		expect(commandProgram([])).toBeUndefined();
	});
});

describe("routeTool", () => {
	it("routes with the default table", () => {
		expect(routeTool(DEFAULT_TIER_ROUTES, "bash", "git status")).toBe("container");
		expect(routeTool(DEFAULT_TIER_ROUTES, "bash", "cd x && git status")).toBe("container");
		expect(routeTool(DEFAULT_TIER_ROUTES, "bash", "cat x")).toBe("isolate");
		expect(routeTool(DEFAULT_TIER_ROUTES, "bash")).toBe("isolate");
		expect(routeTool(DEFAULT_TIER_ROUTES, "read")).toBe("isolate");
		expect(routeTool(DEFAULT_TIER_ROUTES, "mystery", "git status")).toBe("isolate");
	});

	it("lets the first matching row win", () => {
		const table: TierRoute[] = [
			{ tool: "bash", programs: ["make"], tier: "container" },
			{ tool: "bash", tier: "isolate" },
			{ tool: "bash", programs: ["git"], tier: "container" },
			{ tool: "build", tier: "container" },
		];
		expect(routeTool(table, "bash", "make all")).toBe("container");
		expect(routeTool(table, "bash", "git status")).toBe("isolate");
		expect(routeTool(table, "build")).toBe("container");
	});
});
