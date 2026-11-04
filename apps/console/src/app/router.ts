// The console's navigation, on the History API with no router library. The compute console (compute/compute-app.tsx)
// reads the path with `usePathname` and moves with `navigate`; its own pages parse the path (@kantel/ui's
// `computePath`).
//
// Query strings are kept as they are unless a path brings its own. A link's hash goes with it.

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => {
	for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
	if (listeners.size === 0) window.addEventListener("popstate", notify);
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) window.removeEventListener("popstate", notify);
	};
}

/**
 * Where `navigate` goes from `path`: `path` with its own query string, or else with `search`, the current one; a hash
 * on `path` follows the query.
 */
export function navigationTarget(path: string, search: string): string {
	const hashAt = path.indexOf("#");
	const beforeHash = hashAt === -1 ? path : path.slice(0, hashAt);
	const hash = hashAt === -1 ? "" : path.slice(hashAt);
	return beforeHash.includes("?") ? `${beforeHash}${hash}` : `${beforeHash}${search}${hash}`;
}

/**
 * Goes to `path`, keeping the query string unless `path` has its own (`/hosts?add`), less the parameters in `drop`; a
 * hash on `path` follows it. `replace` swaps the current history entry instead of adding one.
 */
export function navigate(
	path: string,
	{ replace = false, drop = [] }: { replace?: boolean; drop?: readonly string[] } = {},
): void {
	const hashAt = path.indexOf("#");
	const target = navigationTarget(path, searchWithout(location.search, drop));
	if (`${location.pathname}${location.search}${hashAt === -1 ? "" : location.hash}` === target) return;
	if (replace) history.replaceState(null, "", target);
	else history.pushState(null, "", target);
	notify();
}

/** `search` without the parameters in `names`, with its `?` when anything is left. */
export function searchWithout(search: string, names: readonly string[]): string {
	const params = new URLSearchParams(search);
	for (const name of names) params.delete(name);
	const rest = params.toString();
	return rest === "" ? "" : `?${rest}`;
}

/** The page's query string, with its `?`, following `navigate` and the browser's back and forward: a tab in it. */
export function useSearch(): string {
	return useSyncExternalStore(
		subscribe,
		() => location.search,
		() => "",
	);
}

/** The page's path, following `navigate` and the browser's back and forward. */
export function usePathname(): string {
	return useSyncExternalStore(
		subscribe,
		() => location.pathname,
		() => "/",
	);
}
