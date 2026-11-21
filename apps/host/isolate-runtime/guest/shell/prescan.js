// The parse-before-run check for programs an isolate doesn't have (shell/unavailable.js). Before a command runs, the
// shell parses it with just-bash's own parser (`Bash.transform`) and looks for an unavailable program whose failure
// would fail the whole command anyway: then nothing of the command runs, and the reply says `effects: "none"`. Where
// running the command could still turn out otherwise (`git --version || echo ok`, `git log | head`, `git x; echo
// done`), or where the program is only known at run time (`bash -c`, `eval`, a name built from an expansion), the
// command runs as before, and a program it reaches is reported with `effects: "possible"`.
//
// Lleverage's isolate runs the same check, refusing a command wherever the program appears in it; Kantel refuses
// only where that can't change the command's outcome, since a command that handles a missing program (`|| true`)
// runs. The fields (`needsMicrovm`, `effects`) are the same in both.
//
// Over plain data (the AST), with nothing from just-bash imported, so it can be tested and shared on its own.

function isNode(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A word's text when it has no expansion, or undefined. */
function staticText(parts) {
	if (!Array.isArray(parts)) return undefined;
	let text = "";
	for (const part of parts) {
		if (!isNode(part)) return undefined;
		if (
			(part.type === "Literal" || part.type === "SingleQuoted" || part.type === "Escaped") &&
			typeof part.value === "string"
		) {
			text += part.value;
		} else if (part.type === "DoubleQuoted") {
			const inner = staticText(part.parts);
			if (inner === undefined) return undefined;
			text += inner;
		} else {
			// Parameter, command and arithmetic expansions, globs, braces and tildes are only known at run time.
			return undefined;
		}
	}
	return text;
}

function wordText(word) {
	return isNode(word) ? staticText(word.parts) : undefined;
}

/**
 * Commands that run the command in their arguments: options that take a value, options that take none, and how many
 * words come before the command. An option not listed (`--help`, `--version`, one this check doesn't model) means the
 * command may do something else, so it isn't treated as running the program.
 */
const WRAPPERS = new Map([
	["command", { valueOptions: [], flags: ["-p"] }],
	["env", { valueOptions: ["-u", "-C"], flags: ["-i", "-0", "--ignore-environment"], assignments: true }],
	["nohup", { valueOptions: [], flags: [] }],
	["nice", { valueOptions: ["-n"], flags: [] }],
	["time", { valueOptions: ["-f", "-o"], flags: ["-p", "-v"] }],
	["stdbuf", { valueOptions: ["-i", "-o", "-e"], flags: [] }],
	["timeout", { valueOptions: ["-s", "-k"], flags: ["--foreground", "--preserve-status", "-v"], leading: 1 }],
]);

/** Commands that run another (possibly a builtin) but whose arguments this check doesn't follow. */
const OPAQUE_WRAPPERS = new Set(["xargs", "exec", "builtin", "sudo"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The names a simple command runs, through its wrappers (`env FOO=1 timeout 5 npm i` runs env, timeout and npm), or
 * undefined when that isn't known before it runs: a name or option built from an expansion, an option this check
 * doesn't model, or a wrapper it doesn't follow.
 */
function chainOf(words) {
	const names = [];
	let index = 0;
	while (index < words.length) {
		const name = wordText(words[index]);
		if (name === undefined) return undefined;
		names.push(name);
		if (OPAQUE_WRAPPERS.has(name)) return undefined;
		const wrapper = WRAPPERS.get(name);
		if (!wrapper) return names;
		index += 1;
		let leading = wrapper.leading ?? 0;
		for (; index < words.length; index += 1) {
			const word = wordText(words[index]);
			if (word === undefined) return undefined;
			if (word === "--") {
				index += 1;
				break;
			}
			if (word.startsWith("-") && word.length > 1) {
				if (wrapper.valueOptions.includes(word)) index += 1;
				else if (!wrapper.flags.includes(word)) return undefined;
				continue;
			}
			if (wrapper.assignments && ASSIGNMENT.test(word)) {
				if (word.startsWith("PATH=")) return undefined;
				continue;
			}
			if (leading > 0) {
				leading -= 1;
				continue;
			}
			break;
		}
	}
	// A wrapper with nothing to run (`env`, `command`): it runs no program.
	return [...names, undefined];
}

/**
 * Builtins and settings that can change whether, or which, a later program runs, or end the script before it:
 * a script using any of them (directly or through a wrapper) isn't refused.
 */
const CHANGES_THE_RUN = new Set([
	"exit",
	"return",
	"exec",
	"set",
	"shopt",
	"trap",
	"alias",
	"unalias",
	"hash",
	"source",
	".",
	"eval",
	"enable",
	"builtin",
	"break",
	"continue",
]);

/** Builtins that can assign variables, PATH among them. */
const DECLARES = new Set(["export", "declare", "typeset", "readonly", "local"]);

/**
 * Whether anything in the script can stop it reaching its end, or change which program a name runs: a run-changing
 * builtin (directly or through a wrapper), PATH assigned anywhere, a command name or wrapper chain only known at run
 * time, or a syntax error the parse deferred. Also the functions the script defines, which shadow programs.
 */
function survey(script) {
	const shadowed = new Set();
	let changesTheRun = false;
	const stack = [script];
	while (stack.length > 0) {
		const value = stack.pop();
		if (Array.isArray(value)) {
			stack.push(...value);
			continue;
		}
		if (!isNode(value)) continue;
		if (value.type === "Statement" && value.deferredError) changesTheRun = true;
		if (value.type === "FunctionDef" && typeof value.name === "string") shadowed.add(value.name);
		if (value.type === "SimpleCommand") {
			for (const a of value.assignments ?? []) if (a?.name === "PATH") changesTheRun = true;
			if (value.name) {
				const words = [value.name, ...(value.args ?? [])];
				const chain = chainOf(words);
				if (!chain || chain.some((name) => name !== undefined && CHANGES_THE_RUN.has(name))) changesTheRun = true;
				if (chain?.some((name) => name !== undefined && DECLARES.has(name))) {
					for (const arg of value.args ?? []) {
						const text = wordText(arg);
						if (text === undefined || /^PATH(\+)?=/.test(text)) changesTheRun = true;
					}
				}
			}
		}
		for (const child of Object.values(value)) if (typeof child === "object" && child !== null) stack.push(child);
	}
	return { shadowed, changesTheRun };
}

/**
 * The unavailable program that makes `statements` fail whatever else happens, or undefined. The last statement must
 * be a chain of `&&` only (with any `||` a failure may be handled, or the program skipped), so it fails if any part
 * of it fails; the program must be the last command of an un-negated pipeline in it (the pipeline's status is its
 * last command's), or so inside a group or subshell there. Then the command can't succeed: refusing it changes only
 * what would have run before the program failed.
 */
function failingProgram(statements, shadowed, lookup) {
	if (!Array.isArray(statements) || statements.length === 0) return undefined;
	const statement = statements[statements.length - 1];
	if (!isNode(statement) || statement.background) return undefined;
	const operators = statement.operators ?? [];
	if (operators.some((op) => op !== "&&")) return undefined;
	for (const pipeline of statement.pipelines ?? []) {
		if (!isNode(pipeline) || pipeline.negated) continue;
		const commands = pipeline.commands ?? [];
		const last = commands[commands.length - 1];
		if (!isNode(last)) continue;
		let found;
		if (last.type === "SimpleCommand" && last.name) {
			const chain = chainOf([last.name, ...(last.args ?? [])]);
			const program = chain?.[chain.length - 1];
			// `command -v git` and the like describe a program; `command git` runs it.
			if (program !== undefined && !shadowed.has(program) && !program.includes("/")) found = lookup(program);
		} else if (last.type === "Group" || last.type === "Subshell") {
			found = failingProgram(last.body, shadowed, lookup);
		}
		if (found) return found;
	}
	return undefined;
}
/**
 * The unavailable program a parsed command would fail on, which is safe to refuse before anything runs, or
 * undefined. `lookup(name)` answers the program's `{ command, reason }` if the isolate doesn't have it.
 */
export function prescan(script, lookup) {
	if (!isNode(script)) return undefined;
	const { shadowed, changesTheRun } = survey(script);
	if (changesTheRun) return undefined;
	return failingProgram(script.statements, shadowed, lookup);
}
