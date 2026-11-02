// The tools a default-profile session gets on the self-hosted gateway beyond its coding, browser and connection tools,
// as on Cloudflare (apps/cloudflare/src/stack.ts, the runtime's `tools`), each with a switch of the same name:
//
//   present_files, create_document   KANTEL_PRESENT_FILES (on unless `off`): a session on a workspace shows files and
//                                     writes documents as cards the console opens (@kantel/sandbox/present-files).
//   codemode                         KANTEL_CODEMODE (on unless `off`): a script that calls the session's other tools,
//                                     run in a QuickJS VM on a worker thread of this process, one per script
//                                     (`CodemodeSandbox`; Cloudflare runs it in a Dynamic Worker or a sandbox object).
//                                     Offered only to a session that has other tools for it to call.
//   save_program, /v1/programs       KANTEL_PROGRAMS (on unless `off`; needs code mode): saved, versioned code mode
//                                     programs run through the API with no model (@kantel/programs). Their records are
//                                     in Postgres (or memory), beside the gateway's other tables.
//   program pauses                   KANTEL_PROGRAM_WAITS (on unless `off`; needs programs): `waitForInput()` and
//                                     `agent()` in a program, and `POST /v1/programs/{id}/runs/{runId}/resume`.
//
// Cloudflare's deployment turns each of these on (apps/cloudflare/wrangler.jsonc); a local install has them on by
// default for the same reason. The runtime is built before the programs service (it needs the runtime's project access
// and sessions), so the service is reached late, as the sandboxes are.
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentProfiles, AuditSink, Clock, ProjectAccess, SessionRecord, SessionRuntime } from "@kantel/contracts";
import { KantelError } from "@kantel/contracts";
import { withProgramRunner } from "@kantel/programs/runner-model";
import { createProgramsService, type ProgramsService } from "@kantel/programs/service";
import type { ProgramStore } from "@kantel/programs/store";
import { SAVE_PROGRAM_TOOL, sessionSaveProgramTool } from "@kantel/programs/tool";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import { CODEMODE_TOOL, codemodeTool } from "@kantel/sandbox/codemode";
import { CREATE_DOCUMENT_TOOL, createDocumentTool } from "@kantel/sandbox/documents";
import { createPresentFilesTool, PRESENT_FILES_TOOL } from "@kantel/sandbox/present-files";
import type { GatewayModels } from "./components.ts";

/** The profile an `agent()` step in a program runs when it names none: the bootstrap's `assistant`. */
const PROGRAM_AGENT = "assistant";

/** A code mode script's memory, at most: a runaway script can't take the gateway's process down with it. */
export const CODEMODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

export interface SessionToolsConfig {
	readonly presentFiles: boolean;
	readonly codemode: boolean;
	readonly programs: boolean;
	readonly programWaits: boolean;
}

/** Every tool on, as a local install has them. */
export const ALL_SESSION_TOOLS: SessionToolsConfig = {
	presentFiles: true,
	codemode: true,
	programs: true,
	programWaits: true,
};

const off = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim().toLowerCase() === "off";

/** The switches from the environment: each on unless `off`; programs need code mode, and their pauses programs. */
export function sessionToolsConfig(env: NodeJS.ProcessEnv): SessionToolsConfig {
	const codemode = !off(env, "KANTEL_CODEMODE");
	const programs = codemode && !off(env, "KANTEL_PROGRAMS");
	return {
		presentFiles: !off(env, "KANTEL_PRESENT_FILES"),
		codemode,
		programs,
		programWaits: programs && !off(env, "KANTEL_PROGRAM_WAITS"),
	};
}

export interface GatewaySessionTools {
	/** The tool names the bootstrap's profiles list for these tools. */
	readonly toolNames: readonly string[];
	/** The sessions' models, with the program runner when programs are on (a program's session calls no model). */
	models<M extends GatewayModels>(models: M): M;
	/** The runtime's `tools`: `inner`'s, then these, for each session. */
	withTools(inner: SessionRuntimeOptions["tools"]): NonNullable<SessionRuntimeOptions["tools"]>;
	/** Builds the programs service, once the runtime exists. Undefined when programs are off. */
	attach(options: {
		readonly store: ProgramStore;
		readonly runtime: SessionRuntime;
		readonly profiles: AgentProfiles;
		readonly access: ProjectAccess;
		readonly audit: AuditSink;
		readonly clock?: Clock;
	}): ProgramsService | undefined;
	/** What `/v1/deployment` says each of these is. */
	readonly bindings: { readonly [name: string]: string };
}

export function gatewaySessionTools(
	config: SessionToolsConfig,
	options: {
		/** The connection calls a script made (connections.ts), shown with its result as on Cloudflare. */
		readonly connectionCalls?: (scriptCallId: string) => readonly unknown[];
		/** Where the programs' records are, for `/v1/deployment`. */
		readonly programsStore?: string;
	} = {},
): GatewaySessionTools {
	let programs: ProgramsService | undefined;
	const ready = (): ProgramsService => {
		if (programs === undefined) throw new KantelError("unavailable", "The gateway's programs are not ready");
		return programs;
	};
	const sessionCodemode = (record: SessionRecord): ToolRegistration => {
		const tool = codemodeTool({
			sandbox: new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES }),
			...(options.connectionCalls === undefined ? {} : { connectionCalls: options.connectionCalls }),
		});
		// A program run's code mode also journals its calls across pauses (@kantel/programs/journal).
		return programs === undefined ? tool : programs.codemodeFor(tool, record);
	};
	return {
		toolNames: [
			...(config.presentFiles ? [PRESENT_FILES_TOOL, CREATE_DOCUMENT_TOOL] : []),
			...(config.codemode ? [CODEMODE_TOOL] : []),
			...(config.programs ? [SAVE_PROGRAM_TOOL] : []),
		],
		models: (models) => (config.programs ? withProgramRunner(models) : models),
		withTools(inner) {
			return async (record) => {
				const own = (await inner?.(record)) ?? [];
				const present =
					config.presentFiles && record.workspaceId !== undefined
						? [createPresentFilesTool(record.workspaceId), createDocumentTool(record.workspaceId)]
						: [];
				const tools: ToolRegistration[] = [...own, ...present];
				// Code mode calls the session's other tools: a session with none has nothing for a script to do.
				if (config.codemode && tools.length > 0) tools.push(sessionCodemode(record));
				if (config.programs) tools.push(sessionSaveProgramTool(ready, record, "/v1") as unknown as ToolRegistration);
				return tools;
			};
		},
		attach(deps) {
			if (!config.programs) return undefined;
			if (programs !== undefined) throw new Error("the gateway's programs are already attached");
			const clock = deps.clock;
			programs = createProgramsService({
				store: deps.store,
				access: () => deps.access,
				runtime: () => deps.runtime,
				profiles: () => deps.profiles,
				audit: deps.audit,
				now: () => clock?.now() ?? Date.now(),
				...(config.programWaits ? { waits: true, defaultAgentId: PROGRAM_AGENT } : {}),
			});
			return programs;
		},
		bindings: {
			codemode: config.codemode ? "QuickJS on a worker thread per script" : "off",
			programs: config.programs
				? `${options.programsStore ?? "memory"}${config.programWaits ? ", with pauses" : ""}`
				: "off",
			presentFiles: config.presentFiles ? "on" : "off",
		},
	};
}
