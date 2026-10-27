// Tool-to-tier routing: the tool picks the tier, not the agent. It uses M0-BE1's
// table (DEFAULT_TIER_ROUTES) and routing rule (routeTool: the program a
// command starts, after any `cd ... &&`), so this target routes exactly as the
// contract says. On top of that, two self-hosted escalations, both towards the
// container (which can run anything the isolate can):
// - any later command in a pipeline or list that names a container program
//   (`cat x | python3 -`), which just-bash could not run either;
// - an explicit leading `# harbour:container` line.

import { DEFAULT_TIER_ROUTES, type SandboxTier } from "../../../../packages/contracts/src/sandbox.ts";
import { routeTool } from "../../../../packages/sandbox/src/index.ts";

/** The programs the contract's table sends to the container. */
export const CONTAINER_PROGRAMS = new Set(
	DEFAULT_TIER_ROUTES.filter((row) => row.tool === "bash" && row.tier === "container").flatMap(
		(row) => row.programs ?? [],
	),
);

const CONTAINER_DIRECTIVE = /^\s*#\s*harbour:container\b/;

/** The first word of every simple command in a pipeline or list, skipping env assignments. */
export function commandWords(command: string): string[] {
	const words: string[] = [];
	for (const segment of command.split(/&&|\|\||[;|&\n(){}]|`|\$\(/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
		while (tokens[0] === "time" || tokens[0] === "exec" || tokens[0] === "command" || tokens[0] === "sudo")
			tokens.shift();
		const first = tokens[0];
		if (first !== undefined) words.push(first.replace(/^.*\//, ""));
	}
	return words;
}

export function tierFor(command: string): SandboxTier {
	if (CONTAINER_DIRECTIVE.test(command)) return "container";
	if (routeTool(DEFAULT_TIER_ROUTES, "bash", command) === "container") return "container";
	return commandWords(command).some((word) => CONTAINER_PROGRAMS.has(word)) ? "container" : "isolate";
}
