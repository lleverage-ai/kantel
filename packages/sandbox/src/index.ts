/**
 * Portable sandbox logic shared by every target: a small shell tokenizer and tool-to-tier routing.
 */
import type { SandboxTier, TierRoute } from "@kantel/contracts";

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

/** Programs that run the program after them (and their own options): `timeout 5 make` runs `make`. */
const WRAPPERS = new Set(["command", "env", "exec", "nice", "nohup", "time", "timeout", "xargs"]);
/** Reserved words a command follows (`if make; then ./run; fi`). */
const LEADING_KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "{"]);
/** Reserved words with no program after them, or words that are not programs (`for x in a b; do ...`). */
const OTHER_KEYWORDS = new Set(["fi", "done", "esac", "}", "for", "case", "select", "in", "function"]);

/** A heredoc's start, `<<EOF`, `<<-'EOF'` or `<< "EOF"` (not a `<<<` here-string), and its delimiter. */
const HEREDOC = /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

/** Drops heredoc bodies, which are data: the lines after a heredoc's start up to its delimiter's line. */
function withoutHeredocBodies(command: string): string {
	if (!command.includes("<<")) return command;
	const out: string[] = [];
	const pending: string[] = [];
	for (const line of command.split("\n")) {
		if (pending.length > 0) {
			if (line.replace(/^\t+/, "").trimEnd() === pending[0]) pending.shift();
			continue;
		}
		out.push(line);
		for (const match of line.matchAll(HEREDOC)) pending.push(match[2]!);
	}
	return out.join("\n");
}

/**
 * Splits out what runs inside a command: each `$(...)` and backquoted substitution (outside single quotes) comes back
 * in `inner`, replaced in `outer` by a plain word; `$((...))` arithmetic is dropped; and a subshell's or group's
 * parentheses become `;`, so `(cd sub && make)` reads as its commands. A `case` arm's `a)` reads the same way, so its
 * pattern may come back as a program: a false positive, which only sends a command to the container.
 */
function splitSubstitutions(command: string): { outer: string; inner: string[] } {
	const inner: string[] = [];
	let outer = "";
	let quote: "'" | '"' | undefined;
	let index = 0;
	/** The index just past the `)` that closes the `(` before `from`, counting nesting; the end when unclosed. */
	const closing = (from: number): number => {
		let depth = 1;
		let at = from;
		while (at < command.length && depth > 0) {
			const char = command[at]!;
			if (char === "\\") at++;
			else if (char === "(") depth++;
			else if (char === ")") depth--;
			at++;
		}
		return at;
	};
	while (index < command.length) {
		const char = command[index]!;
		if (char === "\\") {
			outer += command.slice(index, index + 2);
			index += 2;
		} else if (quote === "'") {
			if (char === "'") quote = undefined;
			outer += char;
			index++;
		} else if (char === "$" && command.startsWith("$((", index)) {
			const end = closing(index + 2);
			outer += "0";
			index = end;
		} else if (char === "$" && command[index + 1] === "(") {
			const end = closing(index + 2);
			inner.push(command.slice(index + 2, end - 1));
			outer += "_";
			index = end;
		} else if (char === "`") {
			const close = command.indexOf("`", index + 1);
			const end = close < 0 ? command.length : close;
			inner.push(command.slice(index + 1, end));
			outer += "_";
			index = end + 1;
		} else if ((char === "(" || char === ")") && quote === undefined) {
			outer += ";";
			index++;
		} else {
			if (char === "'" && quote === undefined) quote = "'";
			else if (char === '"') quote = quote === '"' ? undefined : '"';
			outer += char;
			index++;
		}
	}
	return { outer, inner };
}

/**
 * Every program a shell command may start: the first word of each simple command in a list or pipeline (after
 * `NAME=value` assignments and reserved words), for a wrapper such as `timeout` or `xargs` the program it runs too,
 * and the same inside each `$(...)`, backquote and subshell, all reduced to their basename. Redirection targets
 * (`> out`, `2>&1`) and heredoc bodies are not programs. A word still holding an expansion (`$cmd`) is skipped. An
 * argv array starts one program, `argv[0]`. It over-reports rather than misses: a host uses it to decide whether a
 * command needs more than its isolate has.
 */
export function commandPrograms(command: string | readonly string[]): string[] {
	if (typeof command !== "string") return command[0] === undefined ? [] : [basename(command[0])];
	const programs = new Set<string>();
	collectPrograms(withoutHeredocBodies(command), programs, 0);
	return [...programs];
}

/** Substitutions nest; past this depth the rest is not read. */
const MAX_NESTING = 8;

function collectPrograms(command: string, programs: Set<string>, depth: number): void {
	const { outer, inner } = splitSubstitutions(command);
	if (depth < MAX_NESTING) for (const each of inner) collectPrograms(each, programs, depth + 1);
	let start = true;
	let wrapped = false;
	let redirect = false;
	/** After `bash` or `sh`: `none`, reading its options, or the next word is its `-c` script. */
	let shell: "none" | "options" | "script" = "none";
	for (const token of tokenizeShell(outer).tokens) {
		if (token.kind === "operator") {
			// `>&2` and `2>&1`: the `&` belongs to the redirection, whose target is the next word.
			if (redirect && token.value === "&") continue;
			redirect = token.value === ">" || token.value === ">>" || token.value === "<";
			if (!redirect) {
				start = true;
				wrapped = false;
				shell = "none";
			}
			continue;
		}
		const word = token.value;
		if (redirect) {
			redirect = false;
			continue;
		}
		// `bash -c 'make && ./run'` and `sh -lc '...'` run their script's programs.
		if (shell === "script") {
			if (depth < MAX_NESTING) collectPrograms(withoutHeredocBodies(word), programs, depth + 1);
			shell = "none";
			continue;
		}
		if (shell === "options") {
			if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) shell = "script";
			else if (!word.startsWith("-")) shell = "none";
			continue;
		}
		if (!start && !wrapped) continue;
		if (start && (isAssignmentWord(word) || LEADING_KEYWORDS.has(word))) continue;
		if (start && OTHER_KEYWORDS.has(word)) {
			start = false;
			continue;
		}
		// A wrapper's options and arguments (`timeout 5`, `env -i A=b`) come before the program it runs.
		if (wrapped && (word.startsWith("-") || isAssignmentWord(word) || /^\d+(\.\d+)?[smhd]?$/.test(word))) continue;
		start = false;
		wrapped = false;
		if (/[$`()]/.test(word) || word === "" || word === "_") continue;
		const program = basename(word);
		programs.add(program);
		if (WRAPPERS.has(program)) wrapped = true;
		if (program === "bash" || program === "sh") shell = "options";
	}
}

/**
 * The first argument of a single simple command (`git status`), or undefined for anything else: a list, a pipe, a
 * redirection or a command with no argument.
 */
export function commandSubcommand(command: string | readonly string[]): string | undefined {
	if (typeof command !== "string") return command[1];
	const { tokens, problem } = tokenizeShell(command);
	if (problem !== undefined || tokens.some((token) => token.kind !== "word")) return undefined;
	const words = tokens.map((token) => token.value);
	let index = 0;
	while (index < words.length && isAssignmentWord(words[index] as string)) index++;
	return words[index + 1];
}

/**
 * Routes a tool call through a `TierRoute` table: the first row whose tool matches, and whose `programs` (when present)
 * include the command's program, wins; a row with `subcommands` also needs a single simple command whose first
 * argument is one of them. Tools no row matches run in the isolate.
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
		if (program === undefined || !row.programs.includes(program)) continue;
		if (row.subcommands === undefined) return row.tier;
		const subcommand = command === undefined ? undefined : commandSubcommand(command);
		if (subcommand !== undefined && row.subcommands.includes(subcommand)) return row.tier;
	}
	return "isolate";
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}
