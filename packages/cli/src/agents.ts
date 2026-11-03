/**
 * Copy-paste setup for coding agents: Claude Code, Codex and Cursor (or any MCP client) run `npx -y kantel mcp`; pi,
 * which has no MCP, gets an AGENTS.md block telling it to use the CLI. Each snippet carries Kantel's URL, but never a
 * key: always the `$KANTEL_API_KEY` placeholder, with a scoped key suggested for the agent.
 */

/** What every snippet has where the key goes. */
export const KEY_PLACEHOLDER = "$KANTEL_API_KEY";

/** Makes a key for an agent: it can make and drive sandboxes, but not manage the account. */
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

/** The commands an agent needs, for the AGENTS.md block and the skill alike. */
const CHEAT_SHEET = `- Create one: \`id=$(npx kantel new --type microvm --json | jq -r .id)\`. Without \`--type microvm\` it is an
  isolate: it starts in milliseconds but runs JavaScript only; a microVM is a full Linux with root and Docker.
- Run a command: \`npx kantel exec "$id" -- npm test\`. Its output and exit code are the command's (30 s limit;
  \`--timeout 0\` = no limit, following its output).
- A server or a long job: \`npx kantel exec "$id" --detach -- npm run dev\` prints the command's ID; then
  \`npx kantel attach "$id" <command>\` follows its output, and \`npx kantel kill "$id" <command>\` stops it.
- Copy files: \`npx kantel push "$id" .\` (git-tracked files, to /home/user/<dir>), or
  \`npx kantel scp ./file "$id":/home/user/\` and \`npx kantel scp "$id":/home/user/out.zip .\` (\`-r\` for a directory).
- A URL for a port: \`npx kantel host "$id" 3000\` (private, with a token; \`--public\` for none).
- When done: \`npx kantel stop "$id"\`. It keeps the disk, costs nothing stopped, and \`npx kantel resume "$id"\`
  brings it back. Don't delete sandboxes (an agent's key can't); tell the user the IDs you made.
- Always pass the sandbox ID. \`npx kantel help\` lists every command; \`--json\` prints Kantel's answer as JSON.`;

/** The AGENTS.md (and CLAUDE.md) block: when to use a sandbox, and the CLI through `npx`. */
export const AGENTS_BLOCK = `${AGENTS_START}
## Sandboxes (Kantel)

Run builds, tests, code you don't trust, Docker and long jobs in a Kantel sandbox, never on this computer.
\`KANTEL_URL\` and \`KANTEL_API_KEY\` are set in the environment (or \`npx kantel login\` has been run).

${CHEAT_SHEET}
${AGENTS_END}`;

/** The skill Claude Code (`.claude/skills`), Codex and pi (`.agents/skills`) load when a task needs a sandbox. */
export const SKILL_MD = `---
name: kantel
description: Run code in a Kantel sandbox (an isolate, or a microVM with root, Docker, SSH, a desktop and Chromium) instead of on this computer. Use for builds, tests, untrusted code, Docker, servers that need a public URL, browser automation and long jobs.
---

# Kantel sandboxes

Kantel gives you sandboxes through the \`kantel\` command line (\`npx kantel\`). \`KANTEL_URL\` and \`KANTEL_API_KEY\`
are set in the environment, or \`npx kantel login\` has been run; \`npx kantel whoami\` checks which.

${CHEAT_SHEET}

## More

- Start from a saved snapshot: \`npx kantel new --from <name>\`; save one with \`npx kantel snapshot save "$id" <name>\`.
- Copies of a sandbox: \`npx kantel fork "$id" --count 3\`.
- A microVM's desktop or Chromium: \`npx kantel desktop "$id"\`, \`npx kantel browser "$id"\` (prints a live view URL and a
  CDP URL for Playwright's \`connectOverCDP\`).
- SSH (microVMs): \`npx kantel ssh "$id"\` connects; \`-- <command>\` runs one there and \`--print\` prints the ssh
  command instead. Prefer \`exec\` for commands.
- Keep it running longer: \`npx kantel extend "$id" 120\` (minutes from now).
- Every command and flag: \`npx kantel help\`, \`npx kantel help <command>\`.
`;

/** Where `kantel init` writes the skill, relative to a project (or the home, with `--global`). */
export const SKILL_PATHS = {
	claude: ".claude/skills/kantel/SKILL.md",
	agents: ".agents/skills/kantel/SKILL.md",
} as const;

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
