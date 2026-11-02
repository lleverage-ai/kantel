/**
 * The `dynamic-worker` isolate backend (#17): #94's just-bash shell in a Dynamic Worker, one per session's workspace,
 * loaded through the Worker's `worker_loaders` binding (`LOADER`), as the Cloudflare spike ran it. Portable (no
 * `cloudflare:workers`), so the tests run it in Node with a loader that runs the isolate's code in process.
 *
 * - **One isolate per session and workspace.** The loader ID names the organisation, the session, the workspace and
 *   the bundle, so a session's commands reuse its warm isolate, no two sessions share one, and a deploy with new
 *   isolate code never reuses an old one. A fresh ID is a cold load.
 * - **The workspace crosses the isolate boundary as a capability.** Each command passes a `WorkspacePort` for that
 *   command's caller and version: list a version, read a body by digest, read under a mount. The stack wraps it as an
 *   RPC target (`expose`), so the isolate's reads are calls back into the stack object, with the caller's context,
 *   which the isolate never sees. The isolate has no bindings and no network (`globalOutbound: null`).
 * - **Changes come back in the result.** The isolate can't write; the tiered sandboxes commit what the command
 *   changed before the tool call returns, exactly as for `in-process`, so the next command, on either backend, sees it.
 * - **Cancellation.** An `AbortSignal` can't cross RPC. When the caller can cancel, the isolate polls the port's
 *   `cancelled()` and aborts the shell, which stops at its next statement, as in process; the port also refuses reads
 *   once cancelled. The caller's promise rejects with `aborted` as soon as it cancels, and whatever the isolate
 *   answers after that is dropped, so nothing is committed.
 */
import { type CallContext, KantelError, type WorkspaceId } from "@kantel/contracts";
import { createWorkspacePort, type ShellRequest } from "@kantel/sandbox/isolate";
import type { BackendExec, BackendOutput, IsolateBackend } from "@kantel/sandbox/tiered";
import { listAll, type ModedFileEntry, type StoredWorkspaces } from "@kantel/workspace/stored";
import type { IsolateExecOptions, IsolateOutcome, IsolatePort } from "./isolate/runner.ts";

/** The isolate's entry point, as the loader's stub answers it (`src/isolate/entry.ts`). */
export interface IsolateEntrypoint {
	exec(port: IsolatePort, request: ShellRequest, options?: IsolateExecOptions): Promise<IsolateOutcome>;
}

/** Loads (or finds, warm) the isolate with this ID. */
export type LoadIsolate = (id: string) => IsolateEntrypoint;

/** The isolate's code, as the Worker Loader takes it (a subset of workers-types' `WorkerLoaderWorkerCode`). */
export interface IsolateCode {
	readonly compatibilityDate: string;
	readonly compatibilityFlags: string[];
	readonly mainModule: string;
	readonly modules: Record<string, string>;
	readonly env: Record<string, never>;
	readonly globalOutbound: null;
}

/** The part of the Worker Loader binding this uses, so the tests need no Cloudflare types. */
export interface WorkerLoaderLike {
	get(id: string, code: () => Promise<IsolateCode>): { getEntrypoint(name?: string): unknown };
}

/** The isolate's compatibility date: the main Worker's (`wrangler.jsonc`). */
export const ISOLATE_COMPATIBILITY_DATE = "2026-10-01";
export const ISOLATE_ENTRYPOINT = "KantelIsolate";
const ISOLATE_MODULE = "isolate.js";
/** Listings the stack object keeps for the isolates' reads, as the in-process backend does. */
const LISTING_VERSIONS = 64;

/** A short digest of the bundle, so a deploy that changes the isolate's code never reuses an isolate running the old. */
export function bundleId(bundle: string): string {
	let hash = 2166136261;
	for (let i = 0; i < bundle.length; i += 1) hash = Math.imul(hash ^ bundle.charCodeAt(i), 16777619);
	return `${bundle.length.toString(36)}${(hash >>> 0).toString(36)}`;
}

/**
 * Isolates from the Worker Loader: the bundled `src/isolate/entry.ts` as its one module, no bindings, and no network
 * (`globalOutbound: null`: every `fetch()` in the isolate, just-bash's `curl` included, fails).
 */
export function workerLoaderIsolates(loader: WorkerLoaderLike, bundle: string): LoadIsolate {
	const code: IsolateCode = {
		compatibilityDate: ISOLATE_COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		mainModule: ISOLATE_MODULE,
		modules: { [ISOLATE_MODULE]: bundle },
		env: {},
		globalOutbound: null,
	};
	return (id) => loader.get(id, async () => code).getEntrypoint(ISOLATE_ENTRYPOINT) as IsolateEntrypoint;
}

export interface DynamicWorkerIsolateOptions {
	readonly load: LoadIsolate;
	/** Changes with the isolate's code (`bundleId`); part of every loader ID. */
	readonly bundleId: string;
	/** Makes the port passable to the isolate: an `RpcTarget` on Cloudflare. Default: as is (tests). */
	readonly expose?: (port: IsolatePort) => IsolatePort;
}

/** The loader ID of a session's isolate on one workspace. */
export function isolateId(input: {
	readonly organisationId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly bundleId: string;
}): string {
	return ["kantel-isolate", input.organisationId, input.sessionId, input.workspaceId, input.bundleId].join(":");
}

function requireNotCancelled(ctx: CallContext): void {
	if (ctx.signal?.aborted === true) throw new KantelError("aborted", "the command was cancelled");
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** `work`, or `aborted` as soon as `signal` aborts; a later answer from `work` is dropped. */
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return work;
	return new Promise<T>((resolve, reject) => {
		const cancel = () => reject(new KantelError("aborted", "the command was cancelled"));
		if (signal.aborted) cancel();
		signal.addEventListener("abort", cancel, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
	});
}

export function createDynamicWorkerIsolateBackend(
	workspaces: StoredWorkspaces,
	options: DynamicWorkerIsolateOptions,
): IsolateBackend {
	const expose = options.expose ?? ((port) => port);
	const listings = new Map<string, Promise<readonly ModedFileEntry[]>>();

	function cachedEntries(ctx: CallContext, id: WorkspaceId) {
		return (version: number): Promise<readonly ModedFileEntry[]> => {
			const key = `${ctx.organisationId}\u0000${id}\u0000${version}`;
			const cached = listings.get(key);
			if (cached !== undefined) {
				// Most recently used last.
				listings.delete(key);
				listings.set(key, cached);
				return cached;
			}
			const listing = listAll(workspaces, ctx, id, { version });
			// A failed listing is not kept, so the next command tries again.
			listing.catch(() => listings.delete(key));
			listings.set(key, listing);
			for (const oldest of listings.keys()) {
				if (listings.size <= LISTING_VERSIONS) break;
				listings.delete(oldest);
			}
			return listing;
		};
	}

	/** The command's port: the caller's reads at `version`, refused once the caller cancels, and whether it has. */
	function portFor(ctx: CallContext, id: WorkspaceId, version: number): IsolatePort {
		const inner = createWorkspacePort(workspaces, ctx, id, version, { entries: cachedEntries(ctx, id) });
		return {
			cancelled: async () => ctx.signal?.aborted === true,
			entries: async (at) => {
				requireNotCancelled(ctx);
				return inner.entries(at);
			},
			mountEntries: async (path) => {
				requireNotCancelled(ctx);
				return inner.mountEntries(path);
			},
			readBlob: async (digest) => {
				requireNotCancelled(ctx);
				return inner.readBlob(digest);
			},
			readMount: async (path) => {
				requireNotCancelled(ctx);
				return inner.readMount(path);
			},
		};
	}

	return {
		async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
			requireNotCancelled(ctx);
			const started = performance.now();
			const isolate = options.load(
				isolateId({
					organisationId: ctx.organisationId,
					sessionId: lease.sessionId,
					workspaceId: lease.workspaceId,
					bundleId: options.bundleId,
				}),
			);
			// Only plain data crosses: the request's own fields, the version and the mount points.
			const shell: ShellRequest = {
				command: typeof request.command === "string" ? request.command : [...request.command],
				baseVersion: record.head,
				mounts: record.mounts.map((mount) => ({ path: mount.path })),
				...(request.cwd === undefined ? {} : { cwd: request.cwd }),
				...(request.env === undefined ? {} : { env: { ...request.env } }),
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
			};
			const { isolate: life, ...outcome } = await untilCancelled(
				isolate.exec(expose(portFor(ctx, lease.workspaceId, record.head)), shell, {
					cancellable: ctx.signal !== undefined,
				}),
				ctx.signal,
			);
			// A cancelled command's output and changes are dropped: the caller commits nothing.
			requireNotCancelled(ctx);
			return {
				exitCode: outcome.exitCode,
				stdout: outcome.stdout,
				stderr: outcome.stderr,
				changes: outcome.changes,
				timings: {
					...outcome.timings,
					"isolate.call": round(performance.now() - started),
					// 1 when this was the isolate's first command, so it loaded cold.
					"isolate.cold": life.calls === 1 ? 1 : 0,
				},
			};
		},
	};
}
