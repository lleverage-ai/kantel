/**
 * What the Dynamic Worker isolate runs (`entry.ts`), kept free of `cloudflare:workers` so the tests run it in Node.
 *
 * Each command runs #94's just-bash shell (`runShell` from `@kantel/sandbox/isolate`) over a lazy, read-only view of
 * one workspace version, reached through the `WorkspacePort` the stack object passes with the command. Bodies are
 * cached by digest and listings by version for the life of the isolate: versions are immutable, and an isolate serves
 * one session's one workspace (its loader ID names both), so a version number can't mean two listings here.
 *
 * What the command changed comes back in the outcome; the stack's tiered sandboxes commit it before the tool call
 * returns, as for the in-process backend.
 *
 * Cancellation: an `AbortSignal` can't cross RPC, so for a cancellable command the runner asks the port every
 * `CANCEL_POLL_MS` whether the caller has cancelled, and aborts the shell's own signal when it has (or when the port is
 * gone). The shell then stops at its next statement and rejects with `aborted`, as in process.
 */
import { BlobCache, runShell, type ShellOutcome, type ShellRequest, type WorkspacePort } from "@kantel/sandbox/isolate";
import type { ModedFileEntry } from "@kantel/workspace/stored";

/** Listings an isolate keeps, most recently used last. */
const LISTING_VERSIONS = 16;
/** How often a cancellable command asks whether its caller has cancelled. */
export const CANCEL_POLL_MS = 50;

/** The command's port: the workspace reads, and whether the caller has cancelled. */
export interface IsolatePort extends WorkspacePort {
	cancelled(): Promise<boolean>;
}

export interface IsolateExecOptions {
	/** The caller can cancel this command, so the runner polls `port.cancelled()`. */
	readonly cancellable?: boolean;
}

export interface IsolateLife {
	/** When this isolate started (epoch milliseconds), so a caller can tell a fresh isolate from a reused one. */
	readonly bootedAt: number;
	/** Commands it has run, this one included. */
	readonly calls: number;
}

export type IsolateOutcome = ShellOutcome & { readonly isolate: IsolateLife };

export interface IsolateRunner {
	exec(port: IsolatePort, request: ShellRequest, options?: IsolateExecOptions): Promise<IsolateOutcome>;
	ping(): IsolateLife;
}

export function createIsolateRunner(now: () => number = Date.now): IsolateRunner {
	const bootedAt = now();
	let calls = 0;
	const cache = new BlobCache();
	const listings = new Map<number, readonly ModedFileEntry[]>();
	return {
		async exec(port, request, options = {}) {
			calls += 1;
			const call = calls;
			const controller = new AbortController();
			let finished = false;
			let poll: ReturnType<typeof setTimeout> | undefined;
			const check = async () => {
				let cancelled: boolean;
				try {
					cancelled = await port.cancelled();
				} catch {
					// The caller is gone: nobody will commit what the command does.
					cancelled = true;
				}
				if (cancelled) controller.abort();
				else if (!finished) poll = setTimeout(check, CANCEL_POLL_MS);
			};
			if (options.cancellable === true) poll = setTimeout(check, CANCEL_POLL_MS);
			const outcome = await runShell(port, request, {
				signal: controller.signal,
				cache,
				entries: async (version) => {
					const cached = listings.get(version);
					if (cached !== undefined) {
						listings.delete(version);
						listings.set(version, cached);
						return cached;
					}
					const entries = await port.entries(version);
					listings.set(version, entries);
					for (const oldest of listings.keys()) {
						if (listings.size <= LISTING_VERSIONS) break;
						listings.delete(oldest);
					}
					return entries;
				},
			}).finally(() => {
				finished = true;
				if (poll !== undefined) clearTimeout(poll);
			});
			return { ...outcome, isolate: { bootedAt, calls: call } };
		},
		ping: () => ({ bootedAt, calls }),
	};
}
