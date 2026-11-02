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
 * object, and every session on it, until it calls one, ends or uses up its interrupt budget
 * (`CODEMODE_INTERRUPT_BUDGET`). The budget counts the whole script's computation, not the stretch since its last
 * tool call, and it is counted in interrupt polls, not time: see `src/codemode/serve.ts`.
 *
 * **Off the stack** (experimental, `KANTEL_CODEMODE_OFFLOAD=on`): each script runs instead in a `KantelCodemodeSandbox`
 * object of the separately deployed `kantel-codemode` Worker (`src/codemode/worker.ts`, bound as `CODEMODE_SANDBOXES`),
 * a new object per script, so a script that computes holds only its own object's thread and the stack keeps answering.
 * The object runs the same server with the same limits; everything else stays where it was, because only the VM moves:
 * the tools, the journal, approvals, the deadline and the abort are still the calling object's, and each tool call
 * still comes back to it over RPC, as its session's agent.
 */
import { type CodemodeRemote, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { SessionRecord } from "@kantel/contracts";
import { CODEMODE_TOOL, codemodeDescription, codemodeTool } from "@kantel/sandbox/codemode";

/** The code mode tool's name and description, shared with the self-hosted gateway (`@kantel/sandbox/codemode`). */
export { CODEMODE_TOOL, codemodeDescription };
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
	return ["kantel-codemode", input.organisationId, input.sessionId, input.bundleId].join(":");
}

/**
 * What code mode needs of the sandbox objects' namespace, typed without workers-types so Node tests can stand one in:
 * an object per name, created where the hint says.
 */
export interface CodemodeSandboxObjects<Id = unknown> {
	idFromName(name: string): Id;
	get(id: Id, options?: { locationHint?: string }): unknown;
}

/**
 * Scripts in `KantelCodemodeSandbox` objects of the sandbox Worker (`src/codemode/worker.ts`): a new object for each
 * script, named by the session's isolate ID and a random suffix, so one script computing never delays another's. Each
 * is created where `locationHint` says, beside the stack. The object keeps nothing, so nothing is left to clean up.
 */
export function objectCodemode(
	objects: CodemodeSandboxObjects,
	locationHint?: string,
	newName: () => string = () => crypto.randomUUID(),
): LoadCodemode {
	return (id) =>
		objects.get(
			objects.idFromName(`${id}:${newName()}`),
			locationHint === undefined ? undefined : { locationHint },
		) as CodemodeRemote;
}

export interface CodemodeVars {
	/** `off` turns code mode off. Anything else (the default) offers it wherever the Worker has the loader. */
	readonly KANTEL_CODEMODE?: string;
	/**
	 * Experimental: `on` runs each script in a `KantelCodemodeSandbox` object of the separately deployed sandbox Worker
	 * (`CODEMODE_SANDBOXES`) instead of a Dynamic Worker on the calling object's thread, so a script that computes doesn't
	 * hold the stack. Anything else (the default) keeps the Worker Loader.
	 */
	readonly KANTEL_CODEMODE_OFFLOAD?: string;
}

export function codemodeEnabled(vars: CodemodeVars): boolean {
	return (vars.KANTEL_CODEMODE ?? "").trim() !== "off";
}

/** Whether scripts run off the calling object, in the sandbox Worker's objects (`objectCodemode`). Off by default. */
export function codemodeOffloaded(vars: CodemodeVars): boolean {
	return (vars.KANTEL_CODEMODE_OFFLOAD ?? "").trim() === "on";
}

/** Where a Worker's scripts can run: the Worker Loader's isolates, the sandbox Worker's objects, or both. */
export interface CodemodeRemotes {
	/** The Worker Loader's isolates, when the Worker has the loader. */
	readonly loader?: () => LoadCodemode;
	/** The sandbox Worker's objects, when the Worker has the `CODEMODE_SANDBOXES` binding. */
	readonly sandboxes?: CodemodeSandboxObjects;
	readonly locationHint?: string;
	readonly warn?: (message: string) => void;
}

/**
 * Where this Worker's scripts run, or undefined when it has no code mode: the sandbox Worker's objects with
 * `KANTEL_CODEMODE_OFFLOAD=on` and the binding; otherwise the Worker Loader's isolates, as before. The switch on without
 * the binding warns and keeps the loader, so a deployment that lacks the sandbox Worker still has code mode.
 */
export function codemodeLoad(vars: CodemodeVars, remotes: CodemodeRemotes): LoadCodemode | undefined {
	if (!codemodeEnabled(vars)) return undefined;
	if (codemodeOffloaded(vars)) {
		if (remotes.sandboxes !== undefined) return objectCodemode(remotes.sandboxes, remotes.locationHint);
		(remotes.warn ?? console.warn)(
			"kantel: KANTEL_CODEMODE_OFFLOAD is on but the Worker has no CODEMODE_SANDBOXES binding; scripts run in the " +
				"Worker Loader's isolates",
		);
	}
	return remotes.loader?.();
}

export interface SessionCodemodeOptions {
	/** Called once per script, with the session's isolate ID: the remote that runs it. */
	readonly load: LoadCodemode;
	/** Changes with the isolate's code (`bundleId` in `src/dynamic-worker.ts`); part of every loader ID. */
	readonly bundleId: string;
	/**
	 * The connection calls a script made (#464), by the script's call ID, put in its result's details
	 * (`details.connectionCalls`) so the transcript shows them once their own calls are gone. Calls made before an
	 * eviction cut the script off are not among them.
	 */
	readonly connectionCalls?: (scriptCallId: string) => readonly unknown[];
}

/** A session's code mode tool: its scripts run in the session's own isolate, loaded when the first one runs. */
export function sessionCodemodeTool(options: SessionCodemodeOptions, record: SessionRecord): ToolRegistration {
	const id = codemodeIsolateId({
		organisationId: record.organisationId,
		sessionId: record.id,
		bundleId: options.bundleId,
	});
	return codemodeTool({
		sandbox: new RemoteCodemodeSandbox({ remote: () => options.load(id) }),
		...(options.connectionCalls === undefined ? {} : { connectionCalls: options.connectionCalls }),
	});
}
