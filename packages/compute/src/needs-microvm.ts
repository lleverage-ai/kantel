/**
 * Whether an isolate's command failed for want of a microVM (`Command.needsMicrovm`), from what it answered, for a
 * runtime that doesn't say so itself: today's workerd isolates and the stub's just-bash. A runtime that reports
 * `needsMicrovm` (the deno_core isolate runtime) is taken at its word instead.
 *
 * Only exit 127 counts, and only for a program a microVM has: one its shell says isn't available in an isolate, or one
 * of the usual programs a Linux machine has that it says isn't found. A typo (`gti`) isn't one.
 */
import type { ExecResult } from "./backend.ts";

/** Programs a microVM on Kantel's image has and an isolate doesn't: their `command not found` asks for a microVM. */
export const MICROVM_PROGRAMS: ReadonlySet<string> = new Set([
	"apt",
	"apt-get",
	"bun",
	"cargo",
	"cc",
	"deno",
	"docker",
	"dpkg",
	"g++",
	"gcc",
	"gem",
	"gh",
	"git",
	"go",
	"html-to-markdown",
	"java",
	"make",
	"mysql",
	"node",
	"npm",
	"npx",
	"pip",
	"pip3",
	"pnpm",
	"psql",
	"python",
	"python3",
	"rsync",
	"ruby",
	"rustc",
	"scp",
	"sqlite3",
	"ssh",
	"sudo",
	"systemctl",
	"tar",
	"unzip",
	"uv",
	"wget",
	"xan",
	"yarn",
	"yq",
	"zip",
]);

const NOT_AVAILABLE =
	/(?:^|\n)(?:bash: )?([A-Za-z0-9_.+-]+): (?:command )?not available in (?:an isolate|browser environments)/;
const NOT_FOUND = /(?:^|\n)(?:bash: )?(?:line \d+: )?([A-Za-z0-9_.+-]+): command not found/;

/** The program an isolate's command needed a microVM for, and why; undefined when it didn't. */
export function needsMicrovmOf(
	result: Pick<ExecResult, "exitCode" | "stderr" | "needsMicrovm">,
): ExecResult["needsMicrovm"] {
	if (result.needsMicrovm !== undefined) return result.needsMicrovm;
	if (result.exitCode !== 127) return undefined;
	const unavailable = NOT_AVAILABLE.exec(result.stderr)?.[1];
	if (unavailable !== undefined) {
		return {
			command: unavailable,
			reason: `An isolate runs only its shell's own commands, and ${unavailable} isn't one.`,
		};
	}
	const missing = NOT_FOUND.exec(result.stderr)?.[1];
	if (missing !== undefined && MICROVM_PROGRAMS.has(missing)) {
		return { command: missing, reason: `An isolate has no ${missing}; a microVM does.` };
	}
	return undefined;
}
