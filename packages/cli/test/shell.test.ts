// The pseudo-shell's script and trailer (shell.ts); apps/cli/internal/kantel/shell_test.go checks the Go CLI's copy alike.
import { describe, expect, it } from "vitest";
import {
	applyTrailer,
	loginShellIn,
	microvmPath,
	parseExports,
	readTrailer,
	type ShellState,
	shellScript,
	shownLength,
} from "../src/shell.ts";

const MARKER = "__kantel_00ff__";

describe("the pseudo-shell's trailer", () => {
	it("reads export -p as just-bash and bash print it", () => {
		const text =
			'declare -x E=""\ndeclare -x PATH="/usr/bin"\n' +
			"declare -x X=$'a\"b\\\\c$d`e\\nnl\\x41\\101'\ndeclare -x Z\n" +
			'declare -x Q="say \\"hi\\" \\$HOME"\n';
		expect(parseExports(text)).toEqual(
			new Map([
				["E", ""],
				["PATH", "/usr/bin"],
				["X", 'a"b\\c$d`e\nnlAA'],
				["Z", ""],
				["Q", 'say "hi" $HOME'],
			]),
		);
		expect(parseExports("export X=1\n")).toBeUndefined();
	});

	it("holds back output that may be the marker's start, and stops at the marker", () => {
		expect(shownLength("hello", MARKER)).toBe(5);
		expect(shownLength("hello__kan", MARKER)).toBe(5);
		expect(shownLength(`hello${MARKER}0\n/workspace\n`, MARKER)).toBe(5);
	});

	it("carries the directory and the variables that differ from the sandbox's own", () => {
		const state: ShellState = { vars: new Map(), unset: new Set() };
		const first = readTrailer(
			`${MARKER}0\n/workspace\ndeclare -x HOME="/workspace"\ndeclare -x PWD="/workspace"\n`,
			MARKER,
		);
		expect(first).toBeDefined();
		applyTrailer(state, first ?? { status: 0, cwd: "", exports: undefined });
		const next = readTrailer(
			`out${MARKER}3\n/workspace/app\ndeclare -x A="1"\ndeclare -x PWD="/workspace/app"\n`,
			MARKER,
		);
		expect(next?.status).toBe(3);
		applyTrailer(state, next ?? { status: 0, cwd: "", exports: undefined });
		expect(state.cwd).toBe("/workspace/app");
		expect([...state.vars]).toEqual([["A", "1"]]);
		expect([...state.unset]).toEqual(["HOME"]);
		expect(shellScript("ls", MARKER, state).split("\n")).toEqual([
			"cd '/workspace/app'",
			"unset HOME",
			"export A='1'",
			"ls",
			`__kantel_status=$?; printf '%s%s\\n' '${MARKER}' "$__kantel_status"; pwd; export -p; exit "$__kantel_status"`,
		]);
		expect(readTrailer("no marker", MARKER)).toBeUndefined();
	});

	it("maps an isolate's directory to the microVM's", () => {
		expect(microvmPath(undefined)).toBe("/home/user/workspace");
		expect(microvmPath("/workspace")).toBe("/home/user/workspace");
		expect(microvmPath("/workspace/a b")).toBe("/home/user/workspace/a b");
		expect(microvmPath("/tmp")).toBe("/tmp");
		expect(loginShellIn("/home/user/it's")).toBe(
			`cd '/home/user/it'\\''s' 2>/dev/null; exec "\${SHELL:-/bin/bash}" -l`,
		);
	});
});
