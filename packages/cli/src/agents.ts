/**
 * Copy-paste setup for coding agents: Claude Code, Codex and Cursor (or any MCP client) run `kantel mcp`, the installed
 * `kantel` (kantel.dev/cli.sh, install-cli.sh, puts it in ~/.local/bin; it isn't on npm, so not `npx kantel`); pi, which has no MCP, gets
 * an AGENTS.md block telling it to use the CLI. Each snippet carries Kantel's URL, but never a key: always the
 * `$KANTEL_API_KEY` placeholder, with a scoped key suggested for the agent.
 */

/** What every snippet has where the key goes. */
export const KEY_PLACEHOLDER = "$KANTEL_API_KEY";

/** Makes a key for an agent: it can make and drive sandboxes, but not manage the account. */
export const AGENT_KEY_COMMAND = "kantel key create agent --preset agent";

/**
 * Installs `kantel` from Kantel's latest GitHub Release, without sudo, from bash, zsh or fish: kantel.dev serves
 * install-cli.sh as /cli.sh.
 */
export const INSTALL_COMMAND = "curl -fsSL https://kantel.dev/cli.sh | sh";

export const HARNESSES = ["claude", "codex", "pi", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

export const AGENTS_START = "<!-- kantel:start -->";
export const AGENTS_END = "<!-- kantel:end -->";

/** How an MCP client starts Kantel's MCP server: a program and its arguments. */
export interface McpLaunch {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * The tool timeout to give `kantel mcp` in a client, in seconds: its longest wait (an exec's 10 minute timeout, or
 * command_get's longest waitMs) and a minute to spare.
 */
export const TOOL_TIMEOUT_SECONDS = 660;

/** What the guide says about Claude Code's tool timeout. */
export const CLAUDE_TIMEOUT_NOTE = [
	"Claude Code waits for a tool call as long as MCP_TOOL_TIMEOUT says, about 28 hours when it isn't set. If",
	`you've set it lower, give Kantel its own: "timeout": ${TOOL_TIMEOUT_SECONDS * 1000} in the kantel entry of ~/.claude.json or`,
	".mcp.json.",
].join("\n");

/** What the guide says about Codex's tool timeout. */
export const CODEX_TIMEOUT_NOTE = [
	"Codex gives a tool call 60 s unless told otherwise, and Kantel's can wait up to 10 minutes, so add",
	`tool_timeout_sec = ${TOOL_TIMEOUT_SECONDS} under [mcp_servers.kantel] in ~/.codex/config.toml (codex mcp add has no flag`,
	"for it). The config.toml below has it.",
].join("\n");

/** `kantel mcp`, found on the PATH: what every snippet says when `kantel` is installed there. */
export const MCP_ON_PATH: McpLaunch = { command: "kantel", args: ["mcp"] };

/**
 * `kantel mcp` by name when `kantel` is on the PATH; otherwise this CLI by its absolute paths (`self`: Node, its flags
 * and the script), so a setup still works before ~/.local/bin is on the PATH, or in an MCP client started without it.
 */
export function mcpLaunch(onPath: boolean, self: readonly string[] | undefined): McpLaunch {
	const [command, ...rest] = self ?? [];
	if (onPath || command === undefined || rest.length === 0) return MCP_ON_PATH;
	return { command, args: [...rest, "mcp"] };
}

const shellWord = (word: string): string =>
	/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const commandLine = (launch: McpLaunch): string => [launch.command, ...launch.args].map(shellWord).join(" ");

/** Claude Code's one line. */
export function claudeSetup(url: string, launch: McpLaunch = MCP_ON_PATH): string {
	return `claude mcp add kantel -e KANTEL_URL=${url} -e KANTEL_API_KEY=${KEY_PLACEHOLDER} -- ${commandLine(launch)}`;
}

/** Codex's one line. */
export function codexSetup(url: string, launch: McpLaunch = MCP_ON_PATH): string {
	return `codex mcp add kantel --env KANTEL_URL=${url} --env KANTEL_API_KEY=${KEY_PLACEHOLDER} -- ${commandLine(launch)}`;
}

/** The same for Codex's `~/.codex/config.toml`. */
export function codexToml(url: string, launch: McpLaunch = MCP_ON_PATH): string {
	return [
		"[mcp_servers.kantel]",
		`command = ${JSON.stringify(launch.command)}`,
		`args = [${launch.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
		`env = { KANTEL_URL = ${JSON.stringify(url)}, KANTEL_API_KEY = "${KEY_PLACEHOLDER}" }`,
		`tool_timeout_sec = ${TOOL_TIMEOUT_SECONDS}`,
	].join("\n");
}

/** Cursor's `.cursor/mcp.json`, and the `mcpServers` JSON most other MCP clients read. */
export function mcpServersJson(url: string, launch: McpLaunch = MCP_ON_PATH): string {
	const env = { KANTEL_URL: url, KANTEL_API_KEY: KEY_PLACEHOLDER };
	const server = { command: launch.command, args: [...launch.args], env };
	return JSON.stringify({ mcpServers: { kantel: server } }, null, 2);
}

/** The commands an agent needs, for the AGENTS.md block and the skill alike. */
const CHEAT_SHEET = `- Create one: \`id=$(kantel new --type microvm --json | jq -r .id)\`. Without \`--type microvm\` it is an
  isolate: it starts in milliseconds but runs JavaScript only; a microVM is a full Linux with root and Docker.
- Run a command: \`kantel exec "$id" -- npm test\`. Its output and exit code are the command's (30 s limit;
  \`--timeout 0\` = no limit, following its output).
- A job you don't wait for: \`kantel exec "$id" --detach -- npm run build\` prints the command's ID; then
  \`kantel attach "$id" <command>\` follows its output, and \`kantel kill "$id" <command>\` stops it and what it
  started. It has no time limit; a host whose kantel-host predates exec-control still ends it after about 2 minutes
  on a microVM and can't kill it (\`pkill -f\` does).
- Copy files: \`kantel push "$id" .\` (git-tracked files, to /home/user/<dir>); into a sandbox that already has
  a clone of the repository (one from a snapshot), \`kantel sync "$id" --git\` sends only a patch; or
  \`kantel scp ./file "$id":/home/user/\` and \`kantel scp "$id":/home/user/out.zip .\` (\`-r\` for a directory).
- A URL for a port: \`kantel host "$id" 3000\` (private, with a token; \`--public\` for none).
- When done: \`kantel stop "$id"\`. It keeps the disk, costs nothing stopped, and \`kantel resume "$id"\`
  brings it back. Don't delete sandboxes (an agent's key can't); tell the user the IDs you made.
- Always pass the sandbox ID. \`kantel help\` lists every command; \`--json\` prints Kantel's answer as JSON.`;

/** The AGENTS.md (and CLAUDE.md) block: when to use a sandbox, and the installed `kantel` CLI. */
export const AGENTS_BLOCK = `${AGENTS_START}
## Sandboxes (Kantel)

Run builds, tests, code you don't trust, Docker and long jobs in a Kantel sandbox, never on this computer.
\`KANTEL_URL\` and \`KANTEL_API_KEY\` are set in the environment (or \`kantel login\` has been run). If \`kantel\`
isn't installed, ask the user to run \`${INSTALL_COMMAND}\`.

${CHEAT_SHEET}
${AGENTS_END}`;

/** The skill Claude Code (`.claude/skills`), Codex and pi (`.agents/skills`) load when a task needs a sandbox. */
export const SKILL_MD = `---
name: kantel
description: Run code in a Kantel sandbox (an isolate, or a microVM with root, Docker, SSH, a desktop and Chromium) instead of on this computer. Use for builds, tests, untrusted code, Docker, servers that need a public URL, browser automation and long jobs.
---

# Kantel sandboxes

Kantel gives you sandboxes through the \`kantel\` command line. \`KANTEL_URL\` and \`KANTEL_API_KEY\` are set in the
environment, or \`kantel login\` has been run; \`kantel whoami\` checks which. If \`kantel\` isn't installed, ask the user
to run \`${INSTALL_COMMAND}\`.

${CHEAT_SHEET}

## More

- Start from a saved snapshot: \`kantel new --from <name>\`; save one with \`kantel snapshot save "$id" <name>\`.
- Copies of a sandbox: \`kantel fork "$id" --count 3\`.
- A microVM's desktop or Chromium: \`kantel desktop "$id"\`, \`kantel browser "$id"\` (prints a live view URL and a CDP
  URL for Playwright's \`connectOverCDP\`).
- SSH (microVMs): \`kantel ssh "$id"\` connects; \`-- <command>\` runs one there and \`--print\` prints the ssh command
  instead. Prefer \`exec\` for commands.
- Keep it running longer: \`kantel extend "$id" 120\` (minutes from now).
- Every command and flag: \`kantel help\`, \`kantel help <command>\`.
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

/**
 * The setup for one harness, or all of them, for Kantel at `url` (its origin), with the MCP clients starting the server
 * as `launch` says.
 */
export function agentsGuide(url: string, harness: Harness | "all" = "all", launch: McpLaunch = MCP_ON_PATH): string {
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
			...(launch === MCP_ON_PATH
				? []
				: [
						"",
						"kantel isn't on your PATH, so the MCP setups below start this kantel by its full path. To have them run",
						"`kantel mcp` instead, put the directory kantel is in (install-cli.sh links it in ~/.local/bin) on your",
						"PATH and run this again.",
					]),
		].join("\n"),
	];
	const wants = (name: Harness): boolean => harness === "all" || harness === name;
	if (wants("claude")) sections.push(`Claude Code:\n\n  ${claudeSetup(url, launch)}\n\n${CLAUDE_TIMEOUT_NOTE}`);
	if (wants("codex")) {
		sections.push(
			[
				"Codex:",
				"",
				`  ${codexSetup(url, launch)}`,
				"",
				CODEX_TIMEOUT_NOTE,
				"",
				`Or all of it in ~/.codex/config.toml, with the key in place of ${KEY_PLACEHOLDER}:`,
				"",
				indent(codexToml(url, launch)),
			].join("\n"),
		);
	}
	if (wants("pi")) {
		sections.push(
			[
				"pi (no MCP: it uses the CLI). Put this in AGENTS.md, or run `kantel agents --write`, and start pi with",
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
				indent(mcpServersJson(url, launch)),
				"",
				`If the client has a tool timeout, make it at least ${TOOL_TIMEOUT_SECONDS} s: a Kantel tool call can wait up to 10`,
				"minutes.",
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}
