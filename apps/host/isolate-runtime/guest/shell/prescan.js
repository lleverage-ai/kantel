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

const basename = (name) => name.slice(name.lastIndexOf("/") + 1);

/**
 * Commands that run the command in their arguments: options that take a value, how many words come before the
 * command, and options after which the command is only known at run time.
 */
const WRAPPERS = new Map([
	["command", { valueOptions: [] }],
	["exec", { valueOptions: ["-a"] }],
	["env", { valueOptions: ["-u", "-C"], assignments: true }],
	["nohup", { valueOptions: [] }],
	["nice", { valueOptions: ["-n"] }],
	["time", { valueOptions: ["-f", "-o"] }],
	["stdbuf", { valueOptions: ["-i", "-o", "-e"] }],
	["timeout", { valueOptions: ["-s", "-k"], leading: 1 }],
	[
		"xargs",
		{ valueOptions: ["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a"], dynamicOptions: /^(?:-I|-i|-J|--replace)/ },
	],
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The program a simple command runs, looking through wrappers (`env FOO=1 npm i`, `timeout 5 git x`). Undefined when
 * it runs none (`command -v git`), when the script's own function or alias runs instead, when it names a path, or
 * when the name is only known at run time. `xargs` runs it once per input line, which may be none, so it isn't
 * certain to fail: also undefined.
 */
function programOf(words, shadowed) {
	let index = 0;
	while (index < words.length) {
		const name = wordText(words[index]);
		if (name === undefined || shadowed.has(name) || name.includes("/")) return undefined;
		const wrapper = WRAPPERS.get(name);
		if (!wrapper) return name;
		if (name === "xargs") return undefined;
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
				// `command -v` and `-V` describe a program; they don't run it.
				if (name === "command" && /^-[a-zA-Z]*[vV]/.test(word)) return undefined;
				if (wrapper.dynamicOptions?.test(word)) return undefined;
				if (wrapper.valueOptions.includes(word)) index += 1;
				continue;
			}
			if (wrapper.assignments && ASSIGNMENT.test(word)) continue;
			if (leading > 0) {
				leading -= 1;
				continue;
			}
			break;
		}
	}
	return undefined;
}

/**
 * Builtins and settings that can change whether, or which, a later program runs, or end the script before it:
 * a command using any of them isn't refused.
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

/** What the whole script defines or does that the check has to know first: functions, and run-changing builtins. */
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
		if (value.type === "FunctionDef" && typeof value.name === "string") shadowed.add(value.name);
		if (value.type === "SimpleCommand") {
			const name = value.name ? wordText(value.name) : undefined;
			if (value.name && (name === undefined || CHANGES_THE_RUN.has(name))) changesTheRun = true;
			for (const a of value.assignments ?? []) if (a?.name === "PATH") changesTheRun = true;
		}
		for (const child of Object.values(value)) if (typeof child === "object" && child !== null) stack.push(child);
	}
	return { shadowed, changesTheRun };
}

/**
 * The unavailable program that ends `statements` with its failure, or undefined: the last statement's last
 * pipeline (any earlier one's failure is handled by `||`, or the statement goes on after `;`) when every operator
 * after the program is `&&`, the pipeline isn't negated and the program is its last command; looking into groups and
 * subshells in that position.
 */
function failingProgram(statements, shadowed, lookup) {
	if (!Array.isArray(statements) || statements.length === 0) return undefined;
	const statement = statements[statements.length - 1];
	if (!isNode(statement) || statement.background) return undefined;
	const pipelines = statement.pipelines ?? [];
	const operators = statement.operators ?? [];
	// From the end: each pipeline that only `&&` follows fails the statement when it fails.
	for (let i = pipelines.length - 1; i >= 0; i -= 1) {
		if (i < pipelines.length - 1 && operators[i] !== "&&") break;
		const pipeline = pipelines[i];
		if (!isNode(pipeline) || pipeline.negated) continue;
		const commands = pipeline.commands ?? [];
		const last = commands[commands.length - 1];
		if (!isNode(last)) continue;
		let found;
		if (last.type === "SimpleCommand" && last.name) {
			const program = programOf([last.name, ...(last.args ?? [])], shadowed);
			found = program === undefined ? undefined : lookup(basename(program));
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
