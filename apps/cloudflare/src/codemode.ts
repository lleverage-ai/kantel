/**
 * Code mode on Cloudflare: the `codemode` tool, with which the model writes a JavaScript script that calls the
 * session's other tools (`await tools.read({ path })`), run in the isolate tier: a Dynamic Worker per session, loaded
 * through the Worker's `LOADER` binding. Portable (no `cloudflare:workers`), so the tests run it in Node with a loader
 * that runs the isolate's code in process.
 *
 * - **The tool** is Pi Durable's code mode (`createCodemodeTool`): each script's start data and every result it got are
 *   journalled in the session's storage, so a script the object's eviction cut off resumes where it was without running
 *   finished tool calls again. Each tool call a script makes is a nested call of the session's own tool, as its agent:
 *   the same checks, audit, approvals and lazy leases as a call the model makes itself (`bash` leases the session's
 *   isolate on its first command, the file tools lease nothing).
 * - **The script runs in the isolate** (`src/codemode/entry.ts`, bundled by `scripts/build-isolate.ts` into
 *   `generated/codemode.bundle.txt`), in a QuickJS VM there, through pi-codemode's `RemoteCodemodeSandbox`: the stack
 *   object keeps the tools, the journal, the deadline and the abort, and the isolate only runs the VM. Each tool call
 *   comes back over Workers RPC through the `exchange` function passed with the script.
 * - **Only the tool bindings cross.** The isolate has no bindings, no secrets and no network (`env: {}`,
 *   `globalOutbound: null`), and the VM inside it has no `fetch`, timers, modules or I/O. A script reaches the world only
 *   by calling one of the session's tools.
 * - **Loaded only when used.** Building the tool loads nothing; the first script a session runs loads its isolate
 *   (the loader ID names the organisation, the session and a digest of the isolate's code), and later scripts reuse it
 *   while it is warm. A session that never runs a script never has one.
 * - **The prompt stays the user's.** Pi Durable's code mode extension adds a system prompt section listing the tools;
 *   Kantel adds no prompt of its own, so it uses the tool alone and says in the tool's own description where its
 *   tools are. The `models.*` globals are off: they would call model tools sessions don't have.
 *
 * A Dynamic Worker loaded by a Durable Object runs on that object's thread (pi-codemode measured a computing script
 * delaying the object by as long as it computed), so a script that computes without calling a tool holds the stack
 * object until it calls one or uses up its interrupt budget (`CODEMODE_INTERRUPT_BUDGET`, about 5 s).
 */
import { type CodemodeRemote, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { SessionRecord } from "@kantel/contracts";

/** The code mode tool's name, for the default profile. */
export const CODEMODE_TOOL = CODEMODE_TOOL_NAME;
export const CODEMODE_ENTRYPOINT = "KantelCodemode";
export const CODEMODE_COMPATIBILITY_DATE = "2026-10-01";
const CODEMODE_MODULE = "codemode.js";
/** The module QuickJS's WebAssembly is, as `src/codemode/entry.ts` imports it. */
export const QUICKJS_MODULE = "quickjs.wasm";

/** The code mode isolate's code, as the Worker Loader takes it (a subset of workers-types' `WorkerLoaderWorkerCode`). */
export interface CodemodeCode {
	readonly compatibilityDate: string;
	readonly compatibilityFlags: string[];
	readonly mainModule: string;
	readonly modules: Record<string, string | { readonly wasm: ArrayBuffer }>;
	readonly env: Record<string, never>;
	readonly globalOutbound: null;
}

/** The part of the Worker Loader binding this uses, so the tests need no Cloudflare types. */
export interface CodemodeLoaderLike {
	get(id: string, code: () => Promise<CodemodeCode>): { getEntrypoint(name?: string): unknown };
}

/** Loads (or finds, warm) the code mode isolate with this ID. */
export type LoadCodemode = (id: string) => CodemodeRemote;

/**
 * Isolates from the Worker Loader: the bundled `src/codemode/entry.ts` and QuickJS's WebAssembly as its two modules,
 * no bindings and no network (`globalOutbound: null`: `fetch()` and `connect()` throw).
 */
export function workerLoaderCodemode(loader: CodemodeLoaderLike, bundle: string, quickjs: ArrayBuffer): LoadCodemode {
	const code: CodemodeCode = {
		compatibilityDate: CODEMODE_COMPATIBILITY_DATE,
		compatibilityFlags: [],
		mainModule: CODEMODE_MODULE,
		modules: { [CODEMODE_MODULE]: bundle, [QUICKJS_MODULE]: { wasm: quickjs } },
		env: {},
		globalOutbound: null,
	};
	return (id) => loader.get(id, async () => code).getEntrypoint(CODEMODE_ENTRYPOINT) as CodemodeRemote;
}

/** The loader ID of a session's code mode isolate. */
export function codemodeIsolateId(input: {
	readonly organisationId: string;
	readonly sessionId: string;
	readonly bundleId: string;
}): string {
	return ["harbour-codemode", input.organisationId, input.sessionId, input.bundleId].join(":");
}

export interface CodemodeVars {
	/** `off` turns code mode off. Anything else (the default) offers it wherever the Worker has the loader. */
	readonly KANTEL_CODEMODE?: string;
}

export function codemodeEnabled(vars: CodemodeVars): boolean {
	return (vars.KANTEL_CODEMODE ?? "").trim() !== "off";
}

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
 * script is the better choice: in a local evaluation of real models, sessions that had code mode but
 * didn't use it added up numbers by hand and got them wrong.
 */
export function codemodeDescription(description: string): string {
	if (!SECTION_PARAGRAPH.test(description) || !description.includes(SECTION_FINDS)) {
		throw new Error("Pi Durable's code mode description changed: check what src/codemode.ts replaces in it");
	}
	return description
		.replace(SECTION_FINDS, ": find and describe the tools in `tools`.")
		.replace(SECTION_PARAGRAPH, `\n\n${TOOLS_PARAGRAPH}`);
}

export interface SessionCodemodeOptions {
	readonly load: LoadCodemode;
	/** Changes with the isolate's code (`bundleId` in `src/dynamic-worker.ts`); part of every loader ID. */
	readonly bundleId: string;
}

/** A session's code mode tool: its scripts run in the session's own isolate, loaded when the first one runs. */
export function sessionCodemodeTool(options: SessionCodemodeOptions, record: SessionRecord): ToolRegistration {
	const id = codemodeIsolateId({
		organisationId: record.organisationId,
		sessionId: record.id,
		bundleId: options.bundleId,
	});
	// A script has no deadline unless its options line sets one (`timeout_ms`); aborting the session's run stops it.
	const sandbox = new RemoteCodemodeSandbox({ remote: () => options.load(id) });
	const tool = createCodemodeTool({ sandbox, models: false });
	return { ...tool, description: codemodeDescription(tool.description) };
}
