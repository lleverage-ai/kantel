/**
 * Copy-paste setup for coding agents: Claude Code, Codex and Cursor (or any MCP client) run `npx -y kantel mcp`; pi,
 * which has no MCP, gets an AGENTS.md block telling it to use the CLI. Each snippet carries Kantel's URL, but never a
 * key: always the `$KANTEL_API_KEY` placeholder, with a scoped key suggested for the agent.
 */

/** What every snippet has where the key goes. */
export const KEY_PLACEHOLDER = "$KANTEL_API_KEY";

/** Makes a key for an agent: it can make and drive sandboxes, but not delete them or manage the account. */
export const AGENT_KEY_COMMAND = "npx kantel key create agent --preset agent";

export const HARNESSES = ["claude", "codex", "pi", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

export const AGENTS_START = "<!-- kantel:start -->";
export const AGENTS_END = "<!-- kantel:end -->";

const MCP_COMMAND = "npx -y kantel mcp";

/** Claude Code's one line. */
export function claudeSetup(url: string): string {
	return `claude mcp add kantel -e KANTEL_URL=${url} -e KANTEL_API_KEY=${KEY_PLACEHOLDER} -- ${MCP_COMMAND}`;
}

/** Codex's one line. */
export function codexSetup(url: string): string {
	return `codex mcp add kantel --env KANTEL_URL=${url} --env KANTEL_API_KEY=${KEY_PLACEHOLDER} -- ${MCP_COMMAND}`;
}

/** The same for Codex's `~/.codex/config.toml`. */
export function codexToml(url: string): string {
	return [
		"[mcp_servers.kantel]",
		'command = "npx"',
		'args = ["-y", "kantel", "mcp"]',
		`env = { KANTEL_URL = ${JSON.stringify(url)}, KANTEL_API_KEY = "${KEY_PLACEHOLDER}" }`,
	].join("\n");
}

/** Cursor's `.cursor/mcp.json`, and the `mcpServers` JSON most other MCP clients read. */
export function mcpServersJson(url: string): string {
	const env = { KANTEL_URL: url, KANTEL_API_KEY: KEY_PLACEHOLDER };
	const server = { command: "npx", args: ["-y", "kantel", "mcp"], env };
	return JSON.stringify({ mcpServers: { kantel: server } }, null, 2);
}

/** The AGENTS.md block for an agent with no MCP, such as pi: it uses the CLI through `npx`. */
export const AGENTS_BLOCK = `${AGENTS_START}
## Sandboxes (Kantel)

Run code you don't trust, long builds and anything that needs its own machine in a Kantel sandbox, not on this one.
\`KANTEL_URL\` and \`KANTEL_API_KEY\` are set in the environment (or \`npx kantel login\` has been run).

- Create one: \`npx kantel sandbox create --json\`, and note its \`id\`. It is an isolate (starts in milliseconds,
  JavaScript only) unless you add \`--type microvm\` for a full Linux with root and Docker.
- Run a command in it: \`npx kantel exec <id> -- <cmd>\`. Its output is the command's, and so is its exit code.
- Move files: \`npx kantel files put <id> <local> <remote>\`, \`npx kantel files get <id> <remote> [local]\`.
- Give a server in it a URL: \`npx kantel port expose <id> <port>\`.
- Stop it when you are done: \`npx kantel sandbox stop <id>\`. A stopped sandbox keeps its disk and costs nothing;
  \`npx kantel sandbox resume <id>\` brings it back.

\`npx kantel help\` lists every command.
${AGENTS_END}`;

/** `existing` (an AGENTS.md, or nothing) with `block` in place of its Kantel block, or added at the end. */
export function upsertAgentsBlock(existing: string | undefined, block: string = AGENTS_BLOCK): string {
	const text = existing ?? "";
	const start = text.indexOf(AGENTS_START);
	const end = start === -1 ? -1 : text.indexOf(AGENTS_END, start);
	if (start !== -1 && end !== -1) return `${text.slice(0, start)}${block}${text.slice(end + AGENTS_END.length)}`;
	if (text.trim() === "") return `${block}\n`;
	return `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}\n`;
}

const indent = (text: string): string =>
	text
		.split("\n")
		.map((line) => (line === "" ? line : `  ${line}`))
		.join("\n");

/** The setup for one harness, or all of them, for Kantel at `url` (its origin). */
export function agentsGuide(url: string, harness: Harness | "all" = "all"): string {
	const sections: string[] = [
		[
			`Kantel for coding agents, at ${url}.`,
			"",
			"Give the agent its own scoped key (it can make and drive sandboxes, but not delete them or manage the",
			"account), and put the secret it prints in KANTEL_API_KEY:",
			"",
			`  ${AGENT_KEY_COMMAND}`,
			"  export KANTEL_API_KEY=<the secret>",
			"",
			"The commands below read the key from there; nothing here prints it.",
		].join("\n"),
	];
	const wants = (name: Harness): boolean => harness === "all" || harness === name;
	if (wants("claude")) sections.push(`Claude Code:\n\n  ${claudeSetup(url)}`);
	if (wants("codex")) {
		sections.push(
			[
				"Codex:",
				"",
				`  ${codexSetup(url)}`,
				"",
				`or in ~/.codex/config.toml, with the key in place of ${KEY_PLACEHOLDER}:`,
				"",
				indent(codexToml(url)),
			].join("\n"),
		);
	}
	if (wants("pi")) {
		sections.push(
			[
				"pi (no MCP: it uses the CLI). Put this in AGENTS.md, or run `npx kantel agents --write`, and start pi with",
				"KANTEL_URL and KANTEL_API_KEY set:",
				"",
				AGENTS_BLOCK,
			].join("\n"),
		);
	}
	if (wants("cursor")) {
		sections.push(
			[
				"Cursor (.cursor/mcp.json) and other MCP clients (their mcpServers JSON), with the key in place of",
				`${KEY_PLACEHOLDER}:`,
				"",
				indent(mcpServersJson(url)),
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}
