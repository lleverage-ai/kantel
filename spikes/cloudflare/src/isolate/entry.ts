/**
 * The isolate tier: runs inside a Dynamic Worker, one per session, loaded through the Worker Loader. Bundled by
 * scripts/build-isolate.mjs into dist/isolate.bundle.txt; never imported by the main Worker directly.
 *
 * Each command runs in just-bash over a lazy, read-only view of one workspace version (shell.ts). What it changed comes
 * back in the result; the session's sandbox commits it before the tool call returns, so the next command, in either
 * tier, sees it.
 *
 * Network: fetch() here goes to the loader's globalOutbound, the vault. There is no other way out.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ModedFileEntry } from "../workspace.ts";
import { BlobCache, runShell, type ShellOutcome, type ShellRequest, type WorkspacePort } from "./shell.ts";

type IsolateEnv = { readonly WORKSPACE: WorkspacePort };

const bootedAt = Date.now();
let calls = 0;
const cache = new BlobCache();
/** Versions are immutable, so their listings are cached for the life of the isolate. */
const listings = new Map<number, readonly ModedFileEntry[]>();

export class HarbourIsolate extends WorkerEntrypoint<IsolateEnv> {
	async exec(request: ShellRequest): Promise<ShellOutcome & { isolate: { bootedAt: number; calls: number } }> {
		calls += 1;
		const outcome = await runShell(this.env.WORKSPACE, request, {
			cache,
			entries: async (version) => {
				const cached = listings.get(version);
				if (cached !== undefined) return cached;
				const entries = await this.env.WORKSPACE.entries(version);
				listings.set(version, entries);
				return entries;
			},
		});
		return { ...outcome, isolate: { bootedAt, calls } };
	}

	/** Liveness and reuse: when this isolate booted and how many commands it has run. */
	async ping() {
		return { bootedAt, calls };
	}
}

export default {
	fetch(): Response {
		return new Response("harbour isolate\n");
	},
};
