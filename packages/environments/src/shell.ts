/**
 * A very small shell for the fakes (`fake-provider.ts`, `fake-boat.ts`): enough of bash to run what the broker and
 * the provider contract send, against an in-memory file tree. Not a sandbox and never a real one: nothing here runs
 * a process. Each line is one command; `a && b` runs `b` only when `a` succeeds.
 *
 * Understood: `export NAME='value'`, `cd DIR`, `mkdir -p DIR`, `echo [-n] WORDS`, `printf WORDS`, `pwd`,
 * `printenv NAME`, `cat FILE`, `true`, `false`, `exit N`, `sleep S` (no wait), `git worktree add …` and `git
 * clone …` (each makes its directory), and `docker …` (prints nothing). Anything else exits 127.
 */

export interface ShellFiles {
	readonly files: Map<string, Uint8Array>;
	readonly dirs: Set<string>;
}

export interface ShellResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export const HOME = "/home/user";

export function emptyTree(): ShellFiles {
	return { files: new Map(), dirs: new Set(["/", "/home", HOME, "/tmp"]) };
}

/** `path` made absolute against `cwd`, with `.` and `..` resolved. */
export function resolvePath(cwd: string, path: string): string {
	const parts = (path.startsWith("/") ? path : `${cwd}/${path}`).split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

export function makeDirs(tree: ShellFiles, path: string): void {
	let at = "";
	for (const part of path.split("/").filter(Boolean)) {
		at = `${at}/${part}`;
		tree.dirs.add(at);
	}
}

/** Splits a line into words, honouring single and double quotes. */
function words(line: string): string[] {
	const out: string[] = [];
	let word = "";
	let quote: string | undefined;
	let any = false;
	let escaped = false;
	for (const ch of line) {
		if (escaped) {
			word += ch;
			escaped = false;
		} else if (quote === undefined && ch === "\\") {
			escaped = true;
		} else if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			any = true;
		} else if (ch === " " || ch === "\t") {
			if (any || word !== "") out.push(word);
			word = "";
			any = false;
		} else word += ch;
	}
	if (any || word !== "") out.push(word);
	return out;
}

/**
 * Runs `script` in `tree` from `cwd` with `env`, which `export` changes. Returns the exit code and the output; `exit`
 * stops the script.
 */
export function runShell(
	script: string,
	tree: ShellFiles,
	options: { cwd: string; env: Record<string, string> },
): ShellResult {
	let cwd = options.cwd;
	const env = options.env;
	let stdout = "";
	let stderr = "";
	let code = 0;
	const decoder = new TextDecoder();
	const run = (argv: string[]): number | { exit: number } => {
		const [name, ...args] = argv;
		switch (name) {
			case undefined:
				return 0;
			case "export": {
				for (const arg of args) {
					const eq = arg.indexOf("=");
					if (eq > 0) env[arg.slice(0, eq)] = arg.slice(eq + 1);
				}
				return 0;
			}
			case "cd": {
				const to = resolvePath(cwd, args[0] ?? HOME);
				if (!tree.dirs.has(to)) {
					stderr += `cd: ${args[0]}: No such file or directory\n`;
					return 1;
				}
				cwd = to;
				return 0;
			}
			case "mkdir":
				for (const arg of args.filter((a) => !a.startsWith("-"))) makeDirs(tree, resolvePath(cwd, arg));
				return 0;
			case "echo": {
				const newline = args[0] !== "-n";
				stdout += `${(newline ? args : args.slice(1)).join(" ")}${newline ? "\n" : ""}`;
				return 0;
			}
			case "printf":
				stdout += args.join(" ").replaceAll("\\n", "\n");
				return 0;
			case "pwd":
				stdout += `${cwd}\n`;
				return 0;
			case "printenv": {
				const value = env[args[0] ?? ""];
				if (value === undefined) return 1;
				stdout += `${value}\n`;
				return 0;
			}
			case "cat": {
				let status = 0;
				for (const arg of args) {
					const file = tree.files.get(resolvePath(cwd, arg));
					if (file === undefined) {
						stderr += `cat: ${arg}: No such file or directory\n`;
						status = 1;
					} else stdout += decoder.decode(file);
				}
				return status;
			}
			case "true":
			case "sleep":
			case "docker":
				return 0;
			case "false":
				return 1;
			case "exit":
				return { exit: Number(args[0] ?? 0) };
			case "git": {
				// `git worktree add [-b branch] DIR [ref]` and `git clone URL DIR`: the directory, and nothing in it.
				const dir =
					args[0] === "worktree"
						? args.slice(2).find((arg, i, all) => !arg.startsWith("-") && all[i - 1] !== "-b")
						: args[2];
				if (dir !== undefined) makeDirs(tree, resolvePath(cwd, dir));
				return 0;
			}
			default:
				stderr += `bash: ${name}: command not found\n`;
				return 127;
		}
	};
	let errexit = false;
	for (const line of script.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (trimmed === "set -e") {
			errexit = true;
			continue;
		}
		for (const part of trimmed.split("&&")) {
			const result = run(words(part.trim()));
			if (typeof result === "object") return { exitCode: result.exit, stdout, stderr };
			code = result;
			if (code !== 0) break;
		}
		if (errexit && code !== 0) break;
	}
	return { exitCode: code, stdout, stderr };
}
