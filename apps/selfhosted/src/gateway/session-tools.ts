// The tools a default-profile session gets on the self-hosted gateway beyond its coding, browser and connection tools,
// as on Cloudflare (apps/cloudflare/src/stack.ts, the runtime's `tools`), each with a switch of the same name:
//
//   present_files, create_document   KANTEL_PRESENT_FILES (on unless `off`): a session on a workspace shows files and
//                                     writes documents as cards the console opens (@kantel/sandbox/present-files).
//
// Cloudflare's deployment turns it on (apps/cloudflare/wrangler.jsonc); a local install has it on by default for the
// same reason.
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import { CREATE_DOCUMENT_TOOL, createDocumentTool } from "@kantel/sandbox/documents";
import { createPresentFilesTool, PRESENT_FILES_TOOL } from "@kantel/sandbox/present-files";

export interface SessionToolsConfig {
	readonly presentFiles: boolean;
}

/** Every tool on, as a local install has them. */
export const ALL_SESSION_TOOLS: SessionToolsConfig = { presentFiles: true };

const off = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim().toLowerCase() === "off";

/** The switches from the environment: each on unless `off`. */
export function sessionToolsConfig(env: NodeJS.ProcessEnv): SessionToolsConfig {
	return { presentFiles: !off(env, "KANTEL_PRESENT_FILES") };
}

export interface GatewaySessionTools {
	/** The tool names the bootstrap's profiles list for these tools. */
	readonly toolNames: readonly string[];
	/** The runtime's `tools`: `inner`'s, then these, for each session. */
	withTools(inner: SessionRuntimeOptions["tools"]): NonNullable<SessionRuntimeOptions["tools"]>;
	/** What `/v1/deployment` says each of these is. */
	readonly bindings: { readonly [name: string]: string };
}

export function gatewaySessionTools(config: SessionToolsConfig): GatewaySessionTools {
	return {
		toolNames: config.presentFiles ? [PRESENT_FILES_TOOL, CREATE_DOCUMENT_TOOL] : [],
		withTools(inner) {
			return async (record) => {
				const own = (await inner?.(record)) ?? [];
				const present =
					config.presentFiles && record.workspaceId !== undefined
						? [createPresentFilesTool(record.workspaceId), createDocumentTool(record.workspaceId)]
						: [];
				const tools: ToolRegistration[] = [...own, ...present];
				return tools;
			};
		},
		bindings: { presentFiles: config.presentFiles ? "on" : "off" },
	};
}
