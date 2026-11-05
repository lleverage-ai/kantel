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
export {
	booleanFlag,
	type FlagSpec,
	type FlagSpecs,
	listFlag,
	type ParsedArgs,
	parseArgs,
	stringFlag,
} from "./args.ts";
export { commandLine, type Input, type Output, type RunOptions, run, shellQuote } from "./commands.ts";
export {
	configDirectory,
	DEFAULT_URL,
	type Env,
	loadConfig,
	normaliseUrl,
	originOf,
	type ResolvedConfig,
	readStoredConfig,
	resolveConfig,
	writeStoredConfig,
} from "./config.ts";
export { CliError, UsageError } from "./errors.ts";
export { ago, fields, table, timestamp, until } from "./format.ts";
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
