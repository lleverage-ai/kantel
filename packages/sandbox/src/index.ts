/**
 * Portable sandbox logic shared by every target: a small shell tokenizer and tool-to-tier routing.
 */
import type { SandboxTier, TierRoute } from "@harbour/contracts";

export type ShellOperator = "&&" | "||" | "|" | ";" | "&" | ">" | ">>" | "<";

export type ShellToken =
	| { readonly kind: "word"; readonly value: string }
	| { readonly kind: "operator"; readonly value: ShellOperator };

export interface ShellTokens {
	readonly tokens: readonly ShellToken[];
	/** The first construct this tokenizer does not model (expansions, globs, an unterminated quote), if any. */
	readonly problem?: string;
}

/**
 * Splits a `sh -c` command into words and operators, honouring single quotes, double quotes, backslashes and `#`
 * comments. Expansions (`$`, backticks), subshells and globs are kept literally and reported as `problem`, so routing
 * still sees the leading program while an interpreter can refuse what it cannot run.
 */
export function tokenizeShell(command: string): ShellTokens {
	const tokens: ShellToken[] = [];
	let problem: string | undefined;
	let word: string | undefined;
	const flush = () => {
		if (word !== undefined) tokens.push({ kind: "word", value: word });
		word = undefined;
	};
	const operator = (value: ShellOperator) => {
		flush();
		tokens.push({ kind: "operator", value });
	};
	let index = 0;
	while (index < command.length) {
		const char = command[index]!;
		const next = command[index + 1];
		if (char === " " || char === "\t") {
			flush();
			index++;
		} else if (char === "\n") {
			operator(";");
			index++;
		} else if (char === "'") {
			const end = command.indexOf("'", index + 1);
			if (end < 0) {
				problem ??= "unterminated single quote";
				word = (word ?? "") + command.slice(index + 1);
				index = command.length;
			} else {
				word = (word ?? "") + command.slice(index + 1, end);
				index = end + 1;
			}
		} else if (char === '"') {
			let value = "";
			let closed = false;
			index++;
			while (index < command.length) {
				const inner = command[index]!;
				if (inner === '"') {
					closed = true;
					index++;
					break;
				}
				if (inner === "\\" && index + 1 < command.length && '"\\$`\n'.includes(command[index + 1]!)) {
					value += command[index + 1];
					index += 2;
					continue;
				}
				if (inner === "$" || inner === "`") problem ??= `unsupported expansion ${inner}`;
				value += inner;
				index++;
			}
			if (!closed) problem ??= "unterminated double quote";
			word = (word ?? "") + value;
		} else if (char === "\\") {
			word = (word ?? "") + (next ?? "");
			index += 2;
		} else if (char === "&") {
			operator(next === "&" ? "&&" : "&");
			index += next === "&" ? 2 : 1;
		} else if (char === "|") {
			operator(next === "|" ? "||" : "|");
			index += next === "|" ? 2 : 1;
		} else if (char === ">") {
			operator(next === ">" ? ">>" : ">");
			index += next === ">" ? 2 : 1;
		} else if (char === ";" || char === "<") {
			operator(char);
			index++;
		} else if (char === "#" && word === undefined) {
			const end = command.indexOf("\n", index);
			index = end < 0 ? command.length : end;
		} else {
			if ("$`()*?".includes(char)) problem ??= `unsupported syntax ${char}`;
			word = (word ?? "") + char;
			index++;
		}
	}
	flush();
	return problem === undefined ? { tokens } : { tokens, problem };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether a word is a `NAME=value` assignment, as sh reads before a command name. */
export function isAssignmentWord(word: string): boolean {
	return ASSIGNMENT.test(word);
}

/**
 * The program a command starts: for a string, the first word after leading `cd <dir> &&` steps and `NAME=value`
 * assignments; for an argv array, `argv[0]`. Both are reduced to their basename (`/usr/bin/git` is `git`).
 */
export function commandProgram(command: string | readonly string[]): string | undefined {
	if (typeof command !== "string") return command[0] === undefined ? undefined : basename(command[0]);
	const { tokens } = tokenizeShell(command);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index]!;
		if (token.kind !== "word") return undefined;
		if (isAssignmentWord(token.value)) {
			index++;
			continue;
		}
		if (token.value !== "cd") return basename(token.value);
		const and = tokens.findIndex((candidate, at) => at > index && candidate.kind === "operator");
		if (and < 0 || tokens[and]!.value !== "&&") return "cd";
		index = and + 1;
	}
	return undefined;
}

/**
 * Routes a tool call through a `TierRoute` table: the first row whose tool matches, and whose `programs` (when present)
 * include the command's program, wins. Tools no row matches run in the isolate.
 */
export function routeTool(
	table: readonly TierRoute[],
	tool: string,
	command?: string | readonly string[],
): SandboxTier {
	const program = command === undefined ? undefined : commandProgram(command);
	for (const row of table) {
		if (row.tool !== tool) continue;
		if (row.programs === undefined) return row.tier;
		if (program !== undefined && row.programs.includes(program)) return row.tier;
	}
	return "isolate";
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
