// Tool-to-tier routing: the tool picks the tier, not the agent. A command that
// names a real binary just-bash cannot provide runs in a container on the same
// workspace version; everything else runs in the isolate.

import type { SandboxTier } from "../../../../spike/contracts/index.ts";

/** Programs that need Linux. git reads could stay in the isolate (isomorphic-git) later; M0 escalates all git. */
export const CONTAINER_PROGRAMS = new Set([
	"git",
	"bun",
	"bunx",
	"node",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"deno",
	"gh",
	"make",
	"cargo",
	"go",
	"pip",
	"pip3",
	"uv",
	"apk",
	"apt-get",
	"python",
	"python3",
]);

/** A command can ask for the container explicitly with a leading `# harbour:container` line. */
const CONTAINER_DIRECTIVE = /^\s*#\s*harbour:container\b/;

/** The first word of every simple command in a pipeline or list, skipping env assignments. */
export function commandWords(command: string): string[] {
	const words: string[] = [];
	for (const segment of command.split(/&&|\|\||[;|&\n(){}]|`|\$\(/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
		while (tokens[0] === "time" || tokens[0] === "exec" || tokens[0] === "command" || tokens[0] === "sudo") tokens.shift();
		const first = tokens[0];
		if (first !== undefined) words.push(first.replace(/^.*\//, ""));
	}
	return words;
}

export function tierFor(command: string): SandboxTier {
	if (CONTAINER_DIRECTIVE.test(command)) return "container";
	return commandWords(command).some((word) => CONTAINER_PROGRAMS.has(word)) ? "container" : "isolate";
}
