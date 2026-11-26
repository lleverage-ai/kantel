// The parse-before-run check for programs an isolate doesn't have (shell/unavailable.js). Before a command runs, the
// shell parses it with just-bash's own parser (`Bash.transform`). When the parse shows the command can't succeed,
// because it ends on one of those programs, the shell refuses it before any of it runs, and the reply says
// `effects: "none"`: `echo a >> f && git push` leaves `f` as it was. Every other command runs as before, and a
// program it reaches is reported with `effects: "possible"`. Lleverage's isolate reports the same fields.
//
// The check refuses only what it can be sure of, because refusing a command that would have succeeded changes what
// the command does. It is sure only of a plain script: statements of pipelines of simple commands; every word plain
// text (no expansion, so nothing assigns a variable or runs at expansion time; no absolute path and no `..`, so
// nothing writes a program somewhere a name could find it); no assignment and no `{var}>` redirection; every
// command other than the program one of a few file and text commands that can't change what a name runs; and the
// program the last command of a pipeline in a final statement of `&&` alone. Then the program is the isolate's own
// stub, which fails whatever its arguments, and the command fails with it. The caller adds what the parse can't
// show: the request sets no PATH, and its working directory is in the workspace.
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

/** A word's text, when it is plain text naming nothing outside the working directory. */
function plainWord(word) {
	if (!isNode(word)) return undefined;
	const text = staticText(word.parts);
	if (text === undefined || text.startsWith("/") || text.split("/").includes("..")) return undefined;
	return text;
}

/**
 * Commands that act on files and text and nothing else: none runs another command, sets a variable or an option,
 * defines or changes what a name runs, or ends the script.
 */
const PLAIN = new Set([
	"echo",
	"cat",
	"true",
	"mkdir",
	"touch",
	"cp",
	"mv",
	"rm",
	"ls",
	"pwd",
	"head",
	"tail",
	"wc",
	"sort",
	"uniq",
	"tee",
	"grep",
	"chmod",
]);

/** A simple command's words, all plain, with no assignment and plain redirections; or undefined. */
function plainCommand(command) {
	if (!isNode(command) || command.type !== "SimpleCommand" || !command.name) return undefined;
	if ((command.assignments ?? []).length > 0) return undefined;
	for (const redirection of command.redirections ?? []) {
		if (!isNode(redirection) || redirection.fdVariable) return undefined;
		const target = redirection.target;
		if (isNode(target) && target.type === "HereDoc") {
			if (staticText(target.content?.parts) === undefined) return undefined;
		} else if (plainWord(target) === undefined) {
			return undefined;
		}
	}
	const words = [command.name, ...(command.args ?? [])].map(plainWord);
	return words.includes(undefined) ? undefined : words;
}

/**
 * The unavailable program the parsed command can't succeed past, which is safe to refuse before anything runs, or
 * undefined. `lookup(name)` answers the program's `{ command, reason }` if the isolate doesn't have it. `replaced`
 * (optional, anything with `has(name)`) names commands the embedder replaced, which aren't taken as plain.
 */
export function prescan(script, lookup, replaced) {
	if (!isNode(script) || !Array.isArray(script.statements) || script.statements.length === 0) return undefined;
	const statements = script.statements;
	let found;
	for (let s = 0; s < statements.length; s += 1) {
		const statement = statements[s];
		const last = s === statements.length - 1;
		if (!isNode(statement) || statement.background || statement.deferredError) return undefined;
		const operators = statement.operators ?? [];
		if (last && operators.some((op) => op !== "&&")) return undefined;
		for (const pipeline of statement.pipelines ?? []) {
			if (!isNode(pipeline) || pipeline.negated || pipeline.timed) return undefined;
			const commands = pipeline.commands ?? [];
			for (let c = 0; c < commands.length; c += 1) {
				const words = plainCommand(commands[c]);
				if (!words) return undefined;
				if (PLAIN.has(words[0]) && !replaced?.has(words[0])) continue;
				// The one program the check refuses on: the last command of a pipeline in the final `&&` chain.
				const program = lookup(words[0]);
				if (!program || found || !last || c !== commands.length - 1) return undefined;
				found = program;
			}
		}
	}
	return found;
}
