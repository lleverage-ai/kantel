/**
 * Tool names under a namespace the gateway owns, for an upstream that would otherwise rename them.
 *
 * CLIProxyAPI, on a Claude subscription (OAuth) credential, cloaks each request as Claude Code. Part of that is renaming
 * every client tool whose name isn't already a Claude Code MCP name (`mcp__<server>__<tool>`) to an alias such as
 * `mcp__<word>_<word>__salon_browser_request`, built from random dictionary words, and renaming tool calls back on the
 * way out. The calls come back right, but the model only ever sees the aliases, so it talks about its tools by them
 * ("salon_browser_request"). CPA leaves a name that is already an MCP name alone, so the gateway sends each tool as
 * `mcp__harbour__<name>`, which the model reads as the tool's own name, and takes the namespace off every call that
 * comes back.
 *
 * Only names the namespace can carry are changed: a name that is already an MCP name, has a character outside
 * `[A-Za-z0-9_-]`, or would be longer than 64 characters with the namespace is sent as it is (CPA may alias it). The
 * declarations, the earlier calls and their results in the history all change the same way, so the model sees one name
 * per tool, and only the names this request changed are changed back.
 */
import type { Message, Tool, ToolCall, ToolReference } from "@earendil-works/pi-ai";
import type { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

type TranscriptContext = ReturnType<typeof normalizeContext>;

/** The namespace CPA-bound Messages calls carry their tool names in. */
export const HARBOUR_TOOL_NAMESPACE = "mcp__harbour__";

/** Anthropic's limit on a tool name, which CPA's MCP-name check also applies. */
const MAX_TOOL_NAME_LENGTH = 64;
/** What Claude Code counts as an MCP tool name, as CPA checks it: `mcp__`, a server, `__`, a tool. */
const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

export interface NamespacedTools {
	/** The context with every tool name the namespace can carry under it. */
	readonly context: TranscriptContext;
	/** A tool call's name as the caller declared it: without the namespace when this request added it. */
	restore(name: string): string;
}

/** Puts the tool names in `context` under `namespace`, and returns the function that takes it off the calls. */
export function namespaceToolNames(context: TranscriptContext, namespace: string): NamespacedTools {
	const restored = new Map<string, string>();
	const rename = (name: string): string => {
		if (!TOOL_NAME.test(name) || MCP_TOOL_NAME.test(name)) return name;
		const namespaced = `${namespace}${name}`;
		if (namespaced.length > MAX_TOOL_NAME_LENGTH || !MCP_TOOL_NAME.test(namespaced)) return name;
		restored.set(namespaced, name);
		return namespaced;
	};
	const tool = <T extends Tool | ToolReference>(declared: T): T => ({ ...declared, name: rename(declared.name) });
	const messages = context.messages.map((message): Message => {
		switch (message.role) {
			case "system":
				return {
					...message,
					...(message.toolsAdded === undefined ? {} : { toolsAdded: message.toolsAdded.map(tool) }),
					...(message.toolsRemoved === undefined ? {} : { toolsRemoved: message.toolsRemoved.map(tool) }),
				};
			case "assistant":
				return {
					...message,
					content: message.content.map((block) =>
						block.type === "toolCall" ? ({ ...block, name: rename(block.name) } satisfies ToolCall) : block,
					),
				};
			case "toolResult":
				return { ...message, toolName: rename(message.toolName) };
			default:
				return message;
		}
	});
	return {
		// The brand is a type-level marker only: the messages were normalised already, and only their names changed.
		context: { ...context, messages } as TranscriptContext,
		restore: (name) => restored.get(name) ?? name,
	};
}
