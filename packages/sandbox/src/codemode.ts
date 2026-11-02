/**
 * Code mode's tool, as every Kantel deployment offers it: Pi Durable's `codemode` (`createCodemodeTool`), with which the
 * model writes a JavaScript script that calls the session's other tools (`await tools.read({ path })`), run in a
 * QuickJS VM. Where the VM runs is the deployment's: on Cloudflare a Dynamic Worker or a sandbox object per session
 * (`RemoteCodemodeSandbox`, apps/cloudflare/src/codemode.ts); self-hosted, a worker thread per script in the gateway's
 * process (`CodemodeSandbox`, apps/selfhosted/src/gateway/codemode.ts). This is what they share:
 *
 * - **The tool** journals each script's start data and every result it got in the session's storage, so a script a
 *   restart cut off resumes where it was without running finished tool calls again. Each tool call a script makes is a
 *   nested call of the session's own tool, as its agent: the same checks, audit, approvals and lazy leases as a call the
 *   model makes itself.
 * - **The VM has no I/O.** No `fetch`, timers, modules or files: a script reaches the world only by calling one of the
 *   session's tools.
 * - **The prompt stays the user's.** Pi Durable's code mode extension adds a system prompt section listing the tools;
 *   Kantel adds no prompt of its own, so it uses the tool alone and says in the tool's own description where its tools
 *   are (`codemodeDescription`). The `models.*` globals are off: they would call model tools sessions don't have.
 */
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeTool } from "@earendil-works/pi-durable/codemode";

/** The code mode tool's name, for a profile's `tools`. */
export const CODEMODE_TOOL = CODEMODE_TOOL_NAME;

/** The last paragraph of Pi Durable's description, which points at the prompt section Kantel doesn't add. */
const SECTION_PARAGRAPH = /\n\nThe `codemode` section of the system prompt[^\n]*$/;
/** The end of the globals line about finding tools, which points at that section too. */
const SECTION_FINDS = ": find tools the `codemode` section does not list.";
/** Where a script's tools are, and what code mode is for, in place of that paragraph. */
const TOOLS_PARAGRAPH =
	"`tools` has the other tools you are offered, by the same names and with the same arguments, such as " +
	'`await tools.read({ path: "README.md" })`. `ALL_TOOLS` lists them, and `await describeTool(name)` gives one\'s ' +
	"declaration, with what it resolves to.\n\n" +
	"Use it when a task would otherwise take many tool calls or arithmetic: reading, checking or editing many files, " +
	"totalling or transforming data, a long computation, or independent calls run together with `Promise.all`. One " +
	"script replaces those calls, and its numbers are computed rather than estimated.";

/**
 * Pi Durable's code mode description, pointing at the session's tools rather than a prompt section, and saying when a
 * script is the better choice: in a local evaluation of real models, sessions that had code mode but didn't use it
 * added up numbers by hand and got them wrong.
 */
export function codemodeDescription(description: string): string {
	if (!SECTION_PARAGRAPH.test(description) || !description.includes(SECTION_FINDS)) {
		throw new Error("Pi Durable's code mode description changed: check what @kantel/sandbox/codemode replaces in it");
	}
	return description
		.replace(SECTION_FINDS, ": find and describe the tools in `tools`.")
		.replace(SECTION_PARAGRAPH, `\n\n${TOOLS_PARAGRAPH}`);
}

export interface CodemodeToolOptions {
	/** Where the session's scripts run. Building the tool starts nothing; the first script does. */
	readonly sandbox: CodemodeSandboxBase;
	/**
	 * The connection calls a script made (#464), by the script's call ID, put in its result's details
	 * (`details.connectionCalls`) so the transcript shows them once their own calls are gone. Calls made before a
	 * restart cut the script off are not among them.
	 */
	readonly connectionCalls?: (scriptCallId: string) => readonly unknown[];
}

/**
 * A session's `codemode` tool over `sandbox`. A script has no deadline unless its options line sets one
 * (`timeout_ms`); aborting the session's run stops it.
 */
export function codemodeTool(options: CodemodeToolOptions): ToolRegistration {
	const tool = createCodemodeTool({ sandbox: options.sandbox, models: false });
	const described = { ...tool, description: codemodeDescription(tool.description) };
	const taken = options.connectionCalls;
	if (taken === undefined) return described;
	return {
		...described,
		execute: async (args, api, context) => {
			const result = await tool.execute(args as Parameters<typeof tool.execute>[0], api, context);
			const calls = taken(api.callId);
			if (calls.length === 0) return result;
			const details = typeof result.details === "object" && result.details !== null ? result.details : {};
			return { ...result, details: { ...details, connectionCalls: calls } as never };
		},
	} as ToolRegistration;
}
