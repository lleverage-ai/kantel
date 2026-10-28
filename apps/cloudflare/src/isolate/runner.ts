/**
 * What the Dynamic Worker isolate runs (`entry.ts`), kept free of `cloudflare:workers` so the tests run it in Node.
 *
 * Each command runs #94's just-bash shell (`runShell` from `@harbour/sandbox/isolate`) over a lazy, read-only view of
 * one workspace version, reached through the `WorkspacePort` the stack object passes with the command. Bodies are
 * cached by digest and listings by version for the life of the isolate: versions are immutable, and an isolate serves
 * one session's one workspace (its loader ID names both), so a version number can't mean two listings here.
 *
 * What the command changed comes back in the outcome; the stack's tiered sandboxes commit it before the tool call
 * returns, as for the in-process backend.
 */
import {
	BlobCache,
	runShell,
	type ShellOutcome,
	type ShellRequest,
	type WorkspacePort,
} from "@harbour/sandbox/isolate";
import type { ModedFileEntry } from "@harbour/workspace/stored";

/** Listings an isolate keeps, most recently used last. */
const LISTING_VERSIONS = 16;

export interface IsolateLife {
	/** When this isolate started (epoch milliseconds), so a caller can tell a fresh isolate from a reused one. */
	readonly bootedAt: number;
	/** Commands it has run, this one included. */
	readonly calls: number;
}

export type IsolateOutcome = ShellOutcome & { readonly isolate: IsolateLife };

export interface IsolateRunner {
	exec(port: WorkspacePort, request: ShellRequest): Promise<IsolateOutcome>;
	ping(): IsolateLife;
}

export function createIsolateRunner(now: () => number = Date.now): IsolateRunner {
	const bootedAt = now();
	let calls = 0;
	const cache = new BlobCache();
	const listings = new Map<number, readonly ModedFileEntry[]>();
	return {
		async exec(port, request) {
			calls += 1;
			const call = calls;
			const outcome = await runShell(port, request, {
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
			});
			return { ...outcome, isolate: { bootedAt, calls: call } };
		},
		ping: () => ({ bootedAt, calls }),
	};
}
