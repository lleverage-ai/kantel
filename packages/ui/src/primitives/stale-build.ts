// Code that loads on demand (a preview's body, a page) is a chunk named by a hash of the build that made it. A tab
// opened before a deploy still asks for its build's chunks, which the new build doesn't have; and behind Cloudflare
// Access an expired sign-in turns the request into a redirect to the sign-in page. Either way the import fails, with
// words that differ by browser: Safari's "'text/html' is not a valid JavaScript MIME type", Chrome's
// "Failed to fetch dynamically imported module", Firefox's "error loading dynamically imported module".
//
// Reloading the page fixes both: it loads the new build, or goes through sign-in. `reloadForNewBuild` does it once;
// if the page fails the same way straight after, it leaves the error on screen rather than reloading in a loop.

/** Whether an error is a failed load of the page's own code, not a fault in that code. */
export function isChunkLoadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return CHUNK_LOAD_FAILURES.some((pattern) => pattern.test(message));
}

const CHUNK_LOAD_FAILURES: readonly RegExp[] = [
	/failed to fetch dynamically imported module/i,
	/error loading dynamically imported module/i,
	/importing a module script failed/i,
	/is not a valid javascript mime type/i,
	/unable to preload css/i,
	/failed to load module script/i,
];

/** Where the time of the last reload is kept, for this tab only. */
export const STALE_BUILD_RELOAD_KEY = "kantel.stale-build-reload";
/** A failure within this long of the last reload doesn't reload again. */
export const STALE_BUILD_RELOAD_WINDOW_MS = 60_000;

export interface ReloadForNewBuildOptions {
	readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
	readonly reload?: () => void;
	readonly now?: () => number;
}

/**
 * Reloads the page to pick up the current build (or sign in again), unless it did so within the last minute. Answers
 * whether it reloaded: when it didn't, the caller shows the error. Without session storage it never reloads, since
 * it couldn't tell a second failure from the first.
 */
export function reloadForNewBuild(options: ReloadForNewBuildOptions = {}): boolean {
	const storage = options.storage ?? sessionStorageOrUndefined();
	if (storage === undefined) return false;
	const now = (options.now ?? Date.now)();
	try {
		const last = Number(storage.getItem(STALE_BUILD_RELOAD_KEY) ?? "");
		if (Number.isFinite(last) && last > 0 && now - last < STALE_BUILD_RELOAD_WINDOW_MS) return false;
		storage.setItem(STALE_BUILD_RELOAD_KEY, String(now));
	} catch {
		return false;
	}
	(options.reload ?? (() => globalThis.location?.reload()))();
	return true;
}

function sessionStorageOrUndefined(): Pick<Storage, "getItem" | "setItem"> | undefined {
	try {
		return globalThis.sessionStorage ?? undefined;
	} catch {
		// A browser that refuses storage (private mode on some) throws on the property itself.
		return undefined;
	}
}
