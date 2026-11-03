/** `@kantel/cli` (published as `kantel`): the command line, its MCP server and the coding-agent setup snippets. */
export {
	AGENT_KEY_COMMAND,
	AGENTS_BLOCK,
	AGENTS_END,
	AGENTS_START,
	agentsGuide,
	claudeSetup,
	codexSetup,
	codexToml,
	HARNESSES,
	type Harness,
	KEY_PLACEHOLDER,
	mcpServersJson,
	upsertAgentsBlock,
} from "./agents.ts";
export { commandLine, type Input, type Output, type RunOptions, run, shellQuote } from "./commands.ts";
export { DEFAULT_URL, normaliseUrl, type ResolvedConfig, resolveConfig } from "./config.ts";
export {
	clipOutput,
	createMcpServer,
	INSTRUCTIONS,
	type McpServer,
	type McpServerOptions,
	PROTOCOL_VERSIONS,
	serveStdio,
	TOOL_DEFINITIONS,
	type ToolResult,
} from "./mcp.ts";
export { VERSION } from "./version.ts";
