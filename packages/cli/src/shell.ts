/**
 * The pieces of `kantel ssh <isolate>`'s pseudo-shell that don't talk to Kantel: the script each line runs as, which
 * reports the shell's directory and exported variables after it, and reading that report back out of its output.
 * apps/cli/internal/kantel/shell.go is the Go CLI's copy; keep them alike.
 *
 * An isolate has no SSH and keeps no shell between commands, so each line is one command through the commands API. To
 * carry `cd` and `export` over to the next line, the line is followed by a trailer: a marker that can't be in the
 * output by chance, the line's exit status, `pwd` and `export -p`. The next line goes to that directory first, with the
 * exported variables that differ from the sandbox's own set again first.
 */

/** Exported variables the shell sets itself, never carried over. */
const OWN = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A marker for one session's trailers: `__kantel_` and random hex, which a command won't print by chance. */
export function shellMarker(random: Uint8Array): string {
	return `__kantel_${Buffer.from(random).toString("hex")}__`;
}

/** What the session carries from line to line. */
export interface ShellState {
	/** The directory the next line runs in; undefined before the first report, for the sandbox's default. */
	cwd?: string;
	/** The sandbox's own exported variables, from the first report: what a variable is compared with. */
	baseline?: ReadonlyMap<string, string>;
	/** Exported variables set or changed in the session. */
	vars: Map<string, string>;
	/** The sandbox's own variables unset in the session. */
	unset: Set<string>;
}

/** A copy of the state, its collections its own. */
export function cloneShellState(state: ShellState): ShellState {
	return {
		...(state.cwd === undefined ? {} : { cwd: state.cwd }),
		...(state.baseline === undefined ? {} : { baseline: new Map(state.baseline) }),
		vars: new Map(state.vars),
		unset: new Set(state.unset),
	};
}

function singleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a line runs as: the session's directory and variables set first (a directory gone since is said, and
 * the line runs in the sandbox's default), then the line on its own line, then the trailer, ending with the line's
 * own exit status. A line that ends the shell itself (`exit 3`, a syntax error) has no trailer,
 * and the session keeps what it had.
 */
export function shellScript(line: string, marker: string, state: ShellState): string {
	const before = [
		...(state.cwd === undefined ? [] : [`cd ${singleQuote(state.cwd)}`]),
		...[...state.unset].map((name) => `unset ${name}`),
		...[...state.vars].map(([name, value]) => `export ${name}=${singleQuote(value)}`),
	];
	const trailer = `__kantel_status=$?; printf '%s%s\\n' '${marker}' "$__kantel_status"; pwd; export -p; exit "$__kantel_status"`;
	return [...before, line, trailer].join("\n");
}

/** How much of `stdout` is the command's own output and can be shown: up to the marker, or short of its first part. */
export function shownLength(stdout: string, marker: string): number {
	const at = stdout.indexOf(marker);
	if (at >= 0) return at;
	// Hold back an end that may be the start of the marker, until the rest comes.
	for (let keep = Math.min(marker.length - 1, stdout.length); keep > 0; keep--) {
		if (stdout.endsWith(marker.slice(0, keep))) return stdout.length - keep;
	}
	return stdout.length;
}

/** What a line's trailer said: its exit status, the directory and the exported variables (undefined if unreadable). */
export interface Trailer {
	readonly status: number;
	readonly cwd: string;
	readonly exports: Map<string, string> | undefined;
}

/** The trailer after the marker in `stdout`, or undefined when there is none (the line ended the shell, or was cut). */
export function readTrailer(stdout: string, marker: string): Trailer | undefined {
	const at = stdout.indexOf(marker);
	if (at < 0) return undefined;
	const rest = stdout.slice(at + marker.length);
	const match = /^(\d+)\n([^\n]*)\n/.exec(rest);
	if (match === null) return undefined;
	const cwd = match[2] ?? "";
	if (!cwd.startsWith("/")) return undefined;
	return { status: Number(match[1]), cwd, exports: parseExports(rest.slice(match[0].length)) };
}

/**
 * `export -p`'s lines, `declare -x NAME="value"`, `declare -x NAME=$'value'` or `declare -x NAME`, as a map; undefined
 * when a line isn't one of those, so a shell that prints them otherwise only loses its variables, not its directory.
 */
export function parseExports(text: string): Map<string, string> | undefined {
	const vars = new Map<string, string>();
	let i = 0;
	while (i < text.length) {
		if (!text.startsWith("declare -x ", i)) return undefined;
		i += "declare -x ".length;
		const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
		if (name === undefined) return undefined;
		i += name.length;
		let value = "";
		if (text[i] === "=") {
			i++;
			const read = text.startsWith("$'", i)
				? ansiC(text, i + 2)
				: text[i] === '"'
					? doubleQuoted(text, i + 1)
					: undefined;
			if (read === undefined) return undefined;
			[value, i] = read;
		}
		if (text[i] !== "\n") return undefined;
		i++;
		vars.set(name, value);
	}
	return vars;
}

/** A `"…"` value from `from` (after the quote): its text and where it ends. */
function doubleQuoted(text: string, from: number): [string, number] | undefined {
	let out = "";
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === '"') return [out, i + 1];
		if (c === "\\" && i + 1 < text.length && '\\"$`\n'.includes(text[i + 1] ?? "")) {
			out += text[++i];
		} else out += c;
	}
	return undefined;
}

const ESCAPES: Readonly<Record<string, string>> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};

/** A `$'…'` value from `from` (after the quote): its text and where it ends. */
function ansiC(text: string, from: number): [string, number] | undefined {
	let out = "";
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === "'") return [out, i + 1];
		if (c !== "\\") {
			out += c;
			continue;
		}
		const next = text[++i];
		if (next === undefined) return undefined;
		const simple = ESCAPES[next];
		if (simple !== undefined) {
			out += simple;
			continue;
		}
		const hex = next === "x" ? /^[0-9A-Fa-f]{1,2}/.exec(text.slice(i + 1))?.[0] : undefined;
		const octal = /[0-7]/.test(next) ? /^[0-7]{1,3}/.exec(text.slice(i))?.[0] : undefined;
		if (hex !== undefined) {
			out += String.fromCharCode(Number.parseInt(hex, 16));
			i += hex.length;
		} else if (octal !== undefined) {
			out += String.fromCharCode(Number.parseInt(octal, 8));
			i += octal.length - 1;
		} else out += `\\${next}`;
	}
	return undefined;
}

/**
 * Takes in a line's trailer: the directory, and the exported variables against the sandbox's own (the first report
 * is taken as those). Answers the line's exit status as the trailer said it.
 */
export function applyTrailer(state: ShellState, trailer: Trailer): number {
	state.cwd = trailer.cwd;
	const exports = trailer.exports;
	if (exports === undefined) return trailer.status;
	for (const name of OWN) exports.delete(name);
	if (state.baseline === undefined) {
		state.baseline = exports;
		return trailer.status;
	}
	state.vars.clear();
	state.unset.clear();
	for (const [name, value] of exports) {
		if (NAME.test(name) && state.baseline.get(name) !== value) state.vars.set(name, value);
	}
	for (const name of state.baseline.keys()) if (!exports.has(name) && NAME.test(name)) state.unset.add(name);
	return trailer.status;
}

/** Where an isolate's directory is in the microVM it became: /workspace's files are in /home/user/workspace. */
export function microvmPath(cwd: string | undefined): string {
	if (cwd === undefined) return "/home/user/workspace";
	if (cwd === "/workspace" || cwd.startsWith("/workspace/")) return `/home/user${cwd}`;
	return cwd;
}

/** The remote command that starts a login shell in `dir` over SSH. */
export function loginShellIn(dir: string): string {
	return `cd ${singleQuote(dir)} 2>/dev/null; exec "\${SHELL:-/bin/bash}" -l`;
}

/** What `help` prints at the pseudo-shell's prompt. */
export const SHELL_HELP = [
	"Each line runs as one command in the sandbox, in the directory the last one left, with the variables it exported.",
	"Built-in commands:",
	"  help      This help",
	"  upgrade   Upgrade this isolate to a microVM now, then switch to SSH on it",
	"  exit      Leave (or Ctrl-D)",
	"Ctrl-C stops the command that is running.",
].join("\n");
